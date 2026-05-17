#!/usr/bin/env python3
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path


PREFIX = "[python-starter]"
REPO = "x-dora/rw-node-go"
CADDY_REPO = "caddyserver/caddy"
CWD = Path.cwd()
INSTALL_DIR = CWD / ".rw-node-go"
BIN_DIR = INSTALL_DIR / "bin"
ASSET_DIR = INSTALL_DIR / "share" / "xray"
CONF_DIR = INSTALL_DIR / "conf" / "caddy"
CADDY_DATA_DIR = INSTALL_DIR / "caddy" / "data"
CADDY_CONFIG_DIR = INSTALL_DIR / "caddy" / "config"
APP_BIN = BIN_DIR / "rw-node-go"
CADDY_BIN = BIN_DIR / "caddy"
VERSION_FILE = INSTALL_DIR / ".rw-node-go-version"
CADDY_VERSION_FILE = INSTALL_DIR / ".caddy-version"
CADDYFILE = CONF_DIR / "Caddyfile"

caddy_process = None
app_process = None
shutting_down = False


def log(message: str) -> None:
    print(f"{PREFIX} {message}", flush=True)


def fail(message: str) -> None:
    raise RuntimeError(message)


def run(command, args, env=None, cwd=CWD, inherit=False):
    kwargs = {
        "cwd": cwd,
        "env": env or os.environ.copy(),
        "text": True,
    }
    if inherit:
        kwargs["stdout"] = None
        kwargs["stderr"] = None
    else:
        kwargs["capture_output"] = True

    result = subprocess.run([command, *args], **kwargs)
    if result.returncode != 0:
        output = ""
        if not inherit:
            output = "\n".join(part for part in [result.stdout, result.stderr] if part).strip()
        suffix = f":\n{output}" if output else ""
        fail(f"{command} {' '.join(args)} failed{suffix}")
    return result


def ensure_linux() -> None:
    if sys.platform != "linux":
        fail(f"unsupported platform: {sys.platform}; only Linux x64/arm64 is supported")


def detect_asset_name() -> str:
    machine = platform.machine().lower()
    if machine in {"x86_64", "amd64"}:
        return "rw-node-go-linux-64.tar.gz"
    if machine in {"aarch64", "arm64"}:
        return "rw-node-go-linux-arm64-v8a.tar.gz"
    fail(f"unsupported architecture: {machine}; only x64/arm64 is supported")


def detect_caddy_asset_suffix() -> str:
    machine = platform.machine().lower()
    if machine in {"x86_64", "amd64"}:
        return "_linux_amd64.tar.gz"
    if machine in {"aarch64", "arm64"}:
        return "_linux_arm64.tar.gz"
    fail(f"unsupported architecture: {machine}; only x64/arm64 is supported")


def is_port(value: str) -> bool:
    return value.isdigit() and 1 <= int(value) <= 65535


def build_env():
    env = os.environ.copy()
    env.setdefault("NODE_PORT", "2222")
    env.setdefault("NODE_TLS_CLIENT_AUTH", "none")
    env.setdefault("INTERNAL_REST_PORT", "61001")
    env.setdefault("REQUIRE_SECRET_KEY", "true")
    env.setdefault("RW_NODE_DIR", str(CWD))
    env.setdefault("XRAY_LOCATION_ASSET", str(ASSET_DIR))
    env.setdefault("HTTP_FRONT_PORT", env.get("PORT", "3000"))
    env.setdefault("XHTTP_UPSTREAM_PORT", "8080")
    env.setdefault("WS_UPSTREAM_PORT", "8880")
    return env


def build_caddy_env(env):
    caddy_env = env.copy()
    caddy_env["HOME"] = str(CWD)
    caddy_env["XDG_DATA_HOME"] = str(CADDY_DATA_DIR)
    caddy_env["XDG_CONFIG_HOME"] = str(CADDY_CONFIG_DIR)
    return caddy_env


def validate_ports(env) -> None:
    for name in ["HTTP_FRONT_PORT", "NODE_PORT", "XHTTP_UPSTREAM_PORT", "WS_UPSTREAM_PORT"]:
        if not is_port(env[name]):
            fail(f"{name} must be a valid TCP port")

    if env["HTTP_FRONT_PORT"] == env["NODE_PORT"]:
        fail("HTTP_FRONT_PORT must differ from NODE_PORT")


def http_get_json(url: str):
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "rw-node-go-starter",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def download_file(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "rw-node-go-starter"})
    with urllib.request.urlopen(request, timeout=300) as response, destination.open("wb") as file:
        shutil.copyfileobj(response, file)


def resolve_caddy_release():
    version = os.environ.get("CADDY_VERSION")
    if version:
        url = f"https://api.github.com/repos/{CADDY_REPO}/releases/tags/{version}"
    else:
        url = f"https://api.github.com/repos/{CADDY_REPO}/releases/latest"

    release = http_get_json(url)
    if not release.get("tag_name") or not isinstance(release.get("assets"), list):
        fail("unable to resolve Caddy release assets")
    return release


def find_caddy_download_url(release) -> str:
    suffix = detect_caddy_asset_suffix()
    for asset in release["assets"]:
        name = asset.get("name", "")
        download_url = asset.get("browser_download_url")
        if name.startswith("caddy_") and name.endswith(suffix) and download_url:
            return download_url
    fail(f"Caddy {release['tag_name']} does not provide a supported Linux asset for {platform.machine()}")


def ensure_caddy() -> str:
    caddy_bin = os.environ.get("CADDY_BIN")
    if caddy_bin:
        if not Path(caddy_bin).exists():
            fail(f"CADDY_BIN does not exist: {caddy_bin}")
        return caddy_bin

    if CADDY_BIN.exists() and os.access(CADDY_BIN, os.X_OK):
        log("Caddy already installed; skipping download")
        return str(CADDY_BIN)

    release = resolve_caddy_release()
    url = find_caddy_download_url(release)
    asset_name = url.rsplit("/", 1)[-1]
    tmp_dir = INSTALL_DIR / "tmp"
    archive = tmp_dir / asset_name
    stage_dir = tmp_dir / "caddy-stage"

    log(f"installing Caddy {release['tag_name']}")
    shutil.rmtree(tmp_dir, ignore_errors=True)
    stage_dir.mkdir(parents=True, exist_ok=True)
    BIN_DIR.mkdir(parents=True, exist_ok=True)

    download_file(url, archive)
    with tarfile.open(archive, "r:gz") as tar:
        tar.extractall(stage_dir)

    staged_bin = stage_dir / "caddy"
    if not staged_bin.exists():
        fail("Caddy release asset is missing caddy")

    shutil.copy2(staged_bin, CADDY_BIN)
    CADDY_BIN.chmod(0o755)
    CADDY_VERSION_FILE.write_text(f"{release['tag_name']}\n", encoding="utf-8")
    shutil.rmtree(tmp_dir, ignore_errors=True)
    return str(CADDY_BIN)


def resolve_rw_node_go_version() -> str:
    version = os.environ.get("RW_NODE_GO_VERSION")
    if version:
        return version

    release = http_get_json(f"https://api.github.com/repos/{REPO}/releases/latest")
    tag_name = release.get("tag_name")
    if not tag_name:
        fail("unable to resolve latest rw-node-go release")
    return tag_name


def has_rw_node_go_install() -> bool:
    return (
        APP_BIN.exists()
        and (ASSET_DIR / "geoip.dat").exists()
        and (ASSET_DIR / "geosite.dat").exists()
    )


def ensure_rw_node_go() -> None:
    if has_rw_node_go_install():
        log("rw-node-go already installed; skipping download")
        return

    asset_name = detect_asset_name()
    version = resolve_rw_node_go_version()
    url = f"https://github.com/{REPO}/releases/download/{version}/{asset_name}"
    tmp_dir = INSTALL_DIR / "tmp"
    archive = tmp_dir / asset_name
    stage_dir = tmp_dir / "stage"

    log(f"installing rw-node-go {version}")
    shutil.rmtree(tmp_dir, ignore_errors=True)
    stage_dir.mkdir(parents=True, exist_ok=True)
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    ASSET_DIR.mkdir(parents=True, exist_ok=True)

    download_file(url, archive)
    with tarfile.open(archive, "r:gz") as tar:
        tar.extractall(stage_dir)

    staged_bin = stage_dir / "rw-node-go"
    staged_geoip = stage_dir / "geoip.dat"
    staged_geosite = stage_dir / "geosite.dat"
    if not staged_bin.exists():
        fail("rw-node-go release asset is missing rw-node-go")
    if not staged_geoip.exists() or not staged_geosite.exists():
        fail("rw-node-go release asset is missing geoip.dat or geosite.dat")

    shutil.copy2(staged_bin, APP_BIN)
    APP_BIN.chmod(0o755)
    shutil.copy2(staged_geoip, ASSET_DIR / "geoip.dat")
    shutil.copy2(staged_geosite, ASSET_DIR / "geosite.dat")
    VERSION_FILE.write_text(f"{version}\n", encoding="utf-8")
    shutil.rmtree(tmp_dir, ignore_errors=True)


def write_caddyfile(env) -> None:
    CONF_DIR.mkdir(parents=True, exist_ok=True)
    CADDYFILE.write_text(
        f"""{{
    admin localhost:2019
    auto_https off
}}

http://:{env["HTTP_FRONT_PORT"]} {{
    handle /health {{
        respond "ok\\n" 200
    }}

    handle /xh-* {{
        reverse_proxy 127.0.0.1:{env["XHTTP_UPSTREAM_PORT"]}
    }}

    handle /ws-* {{
        reverse_proxy 127.0.0.1:{env["WS_UPSTREAM_PORT"]}
    }}

    handle /node/* {{
        reverse_proxy https://127.0.0.1:{env["NODE_PORT"]} {{
            transport http {{
                tls_insecure_skip_verify
            }}
        }}
    }}

    handle /vision/* {{
        reverse_proxy https://127.0.0.1:{env["NODE_PORT"]} {{
            transport http {{
                tls_insecure_skip_verify
            }}
        }}
    }}

    handle {{
        respond 404
    }}
}}
""",
        encoding="utf-8",
    )


def spawn_managed(command, args, env):
    return subprocess.Popen([command, *args], cwd=CWD, env=env)


def terminate(code=0):
    global shutting_down
    if shutting_down:
        return
    shutting_down = True

    for child in [app_process, caddy_process]:
        if child and child.poll() is None:
            child.terminate()

    for child in [app_process, caddy_process]:
        if child and child.poll() is None:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()

    raise SystemExit(code)


def handle_signal(_signum, _frame):
    terminate(0)


def main() -> None:
    global caddy_process, app_process

    ensure_linux()
    env = build_env()
    validate_ports(env)
    caddy_env = build_caddy_env(env)

    caddy_bin = ensure_caddy()
    ensure_rw_node_go()
    write_caddyfile(env)
    CADDY_DATA_DIR.mkdir(parents=True, exist_ok=True)
    CADDY_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    run(caddy_bin, ["validate", "--config", str(CADDYFILE), "--adapter", "caddyfile"], env=caddy_env)

    log(f"starting Caddy on port {env['HTTP_FRONT_PORT']}")
    caddy_process = spawn_managed(caddy_bin, ["run", "--config", str(CADDYFILE), "--adapter", "caddyfile"], caddy_env)

    log("starting rw-node-go")
    app_process = spawn_managed(str(APP_BIN), [], env)

    while True:
        caddy_status = caddy_process.poll()
        app_status = app_process.poll()
        if caddy_status is not None:
            log(f"caddy exited with {caddy_status}")
            terminate(1)
        if app_status is not None:
            log(f"rw-node-go exited with {app_status}")
            terminate(1)
        time.sleep(0.5)


signal.signal(signal.SIGINT, handle_signal)
signal.signal(signal.SIGTERM, handle_signal)

if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:
        print(f"{PREFIX} ERROR: {error}", file=sys.stderr, flush=True)
        terminate(1)
