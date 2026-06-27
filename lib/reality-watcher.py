#!/usr/bin/env python3
import hashlib
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
import urllib.error

LOG_PREFIX = os.environ.get("LOG_PREFIX", "[rw-node]")
INTERNAL_REST_PORT = os.environ.get("INTERNAL_REST_PORT", "61001")
CADDY_ADMIN_SOCK = os.environ.get("CADDY_ADMIN_SOCK", "/tmp/caddy-admin.sock")
CADDY_BIN = os.environ.get("CADDY_BIN", "caddy")
REALITY_SPLIT_INTERVAL = int(os.environ.get("REALITY_SPLIT_INTERVAL", "15"))
HTTP_FRONT_PORT = os.environ.get("HTTP_FRONT_PORT", "3000")
NODE_PORT = os.environ.get("NODE_PORT", "2222")
CADDY_HTTP_PORT = os.environ.get("CADDY_HTTP_PORT", str(int(HTTP_FRONT_PORT) + 1))
XHTTP_UPSTREAM_PORT = os.environ.get("XHTTP_UPSTREAM_PORT", "8080")
WS_UPSTREAM_PORT = os.environ.get("WS_UPSTREAM_PORT", "8880")
CADDY_SITE_DIR = os.environ.get("CADDY_SITE_DIR", "")


def log(msg: str) -> None:
    print(f"{LOG_PREFIX} {msg}", flush=True)


def http_get(url: str, timeout: int = 5) -> str:
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode()


def extract_reality_config(config: dict) -> tuple[str, str]:
    inbounds = config.get("inbounds", [])
    reality_inbounds = [
        ib
        for ib in inbounds
        if ib.get("streamSettings", {}).get("security") == "reality"
    ]

    if not reality_inbounds:
        return "", ""

    port = str(reality_inbounds[0].get("port", ""))
    all_names: set[str] = set()
    for ib in reality_inbounds:
        names = (
            ib.get("streamSettings", {})
            .get("realitySettings", {})
            .get("serverNames", [])
        )
        all_names.update(names)

    if not all_names:
        return "", ""

    return port, " ".join(sorted(all_names))


def generate_layer4_block(reality_snis: str, reality_port: str) -> str:
    if reality_snis and reality_port:
        return f"""    layer4 {{
        :{HTTP_FRONT_PORT} {{
            @reality tls sni {reality_snis}
            route @reality {{
                proxy 127.0.0.1:{reality_port}
            }}
            @tls tls
            route @tls {{
                proxy 127.0.0.1:{NODE_PORT}
            }}
            route {{
                proxy 127.0.0.1:{CADDY_HTTP_PORT}
            }}
        }}
    }}"""
    return f"""    layer4 {{
        :{HTTP_FRONT_PORT} {{
            @tls tls
            route @tls {{
                proxy 127.0.0.1:{NODE_PORT}
            }}
            route {{
                proxy 127.0.0.1:{CADDY_HTTP_PORT}
            }}
        }}
    }}"""


def generate_caddy_config(reality_snis: str, reality_port: str) -> str:
    admin_line = f"admin unix/{CADDY_ADMIN_SOCK}"
    layer4 = generate_layer4_block(reality_snis, reality_port)

    return f"""\
{{
    {admin_line}
    auto_https off
    persist_config off

    log {{
        level WARN
    }}

{layer4}

    servers :{CADDY_HTTP_PORT} {{
        protocols h1
    }}
}}

http://:{CADDY_HTTP_PORT} {{
    handle /health {{
        respond "ok" 200
    }}

    handle /xh-* {{
        reverse_proxy 127.0.0.1:{XHTTP_UPSTREAM_PORT} {{
            flush_interval -1
        }}
    }}

    handle /ws-* {{
        reverse_proxy 127.0.0.1:{WS_UPSTREAM_PORT} {{
            flush_interval -1
        }}
    }}

    handle /node/* {{
        reverse_proxy https://127.0.0.1:{NODE_PORT} {{
            transport http {{
                tls_insecure_skip_verify
            }}
        }}
    }}

    handle /vision/* {{
        reverse_proxy https://127.0.0.1:{NODE_PORT} {{
            transport http {{
                tls_insecure_skip_verify
            }}
        }}
    }}

    handle {{
        root * "{CADDY_SITE_DIR}"
        try_files {{path}} {{path}}/ /index.html
        encode gzip
        file_server
    }}
}}
"""


def hash_string(s: str) -> str:
    return hashlib.md5(s.encode()).hexdigest()


def caddy_fmt(config_path: str) -> None:
    try:
        subprocess.run(
            [CADDY_BIN, "fmt", "--overwrite", config_path],
            capture_output=True,
            timeout=5,
            check=False,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass


def caddy_reload(config_path: str) -> bool:
    try:
        subprocess.run(
            [
                CADDY_BIN,
                "reload",
                "--config",
                config_path,
                "--adapter",
                "caddyfile",
                "--address",
                f"unix/{CADDY_ADMIN_SOCK}",
            ],
            capture_output=True,
            timeout=10,
            check=True,
        )
        return True
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return False


def wait_for_port(port: int, max_wait: int = 120) -> None:
    deadline = time.monotonic() + max_wait
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return
        except OSError:
            time.sleep(1)


def main() -> int:
    if len(sys.argv) < 2:
        print(
            f"{LOG_PREFIX} ERROR: reality-watcher.py requires config_path argument",
            file=sys.stderr,
        )
        return 1

    config_path = sys.argv[1]
    wait_for_port(int(INTERNAL_REST_PORT))

    prev_hash = ""
    internal_url = f"http://127.0.0.1:{INTERNAL_REST_PORT}/internal/get-config"

    while True:
        time.sleep(REALITY_SPLIT_INTERVAL)

        try:
            raw = http_get(internal_url)
            config = json.loads(raw)
        except Exception:
            continue

        if not config:
            continue

        reality_port, reality_snis = extract_reality_config(config)
        current_hash = hash_string(f"{reality_port}\n{reality_snis}")

        if current_hash == prev_hash:
            continue

        prev_hash = current_hash

        if reality_snis and reality_port:
            log(f"REALITY split detected: snis=[{reality_snis}] port={reality_port}")
        else:
            log("REALITY split cleared, reverting to default TLS routing")

        with open(config_path, "w") as f:
            f.write(generate_caddy_config(reality_snis, reality_port))

        caddy_fmt(config_path)

        if caddy_reload(config_path):
            log("Caddy reloaded with updated REALITY split config")
        else:
            log("WARN: Caddy reload failed, will retry next cycle")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
