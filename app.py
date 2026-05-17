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
CWD = Path.cwd()
INSTALL_DIR = CWD / ".rw-node-go"
BIN_DIR = INSTALL_DIR / "bin"
ASSET_DIR = INSTALL_DIR / "share" / "xray"
CONF_DIR = INSTALL_DIR / "conf" / "haproxy"
APP_BIN = BIN_DIR / "rw-node-go"
VERSION_FILE = INSTALL_DIR / ".rw-node-go-version"
HAPROXY_CONF = CONF_DIR / "haproxy.cfg"

haproxy_process = None
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


def validate_ports(env) -> None:
    for name in ["HTTP_FRONT_PORT", "NODE_PORT", "XHTTP_UPSTREAM_PORT", "WS_UPSTREAM_PORT"]:
        if not is_port(env[name]):
            fail(f"{name} must be a valid TCP port")

    if env["HTTP_FRONT_PORT"] == env["NODE_PORT"]:
        fail("HTTP_FRONT_PORT must differ from NODE_PORT")


def ensure_haproxy() -> str:
    haproxy_bin = os.environ.get("HAPROXY_BIN")
    if haproxy_bin:
        if not Path(haproxy_bin).exists():
            fail(f"HAPROXY_BIN does not exist: {haproxy_bin}")
        return haproxy_bin

    existing = shutil.which("haproxy")
    if existing:
        return existing

    log("haproxy not found; attempting system package install")
    if shutil.which("apk"):
        run("apk", ["add", "--no-cache", "haproxy"], inherit=True)
    elif shutil.which("apt-get"):
        run("apt-get", ["update"], inherit=True)
        run("apt-get", ["install", "-y", "haproxy"], inherit=True)
    elif shutil.which("dnf"):
        run("dnf", ["install", "-y", "haproxy"], inherit=True)
    elif shutil.which("yum"):
        run("yum", ["install", "-y", "haproxy"], inherit=True)
    else:
        fail("haproxy not found and no supported package manager was detected; install haproxy or set HAPROXY_BIN")

    installed = shutil.which("haproxy")
    if not installed:
        fail("haproxy installation finished but haproxy is still not available; install haproxy or set HAPROXY_BIN")
    return installed


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


def write_haproxy_config(env) -> None:
    CONF_DIR.mkdir(parents=True, exist_ok=True)
    HAPROXY_CONF.write_text(
        f"""global
    maxconn 1024
    nbthread 1
    log stdout format raw local0 warning

defaults
    mode http
    log global
    option dontlognull
    timeout connect 5s
    timeout client 1h
    timeout server 1h
    timeout tunnel 1h

frontend http_front
    bind *:{env["HTTP_FRONT_PORT"]}
    acl is_health path -i /health
    acl is_xh path_beg -i /xh-
    acl is_ws path_beg -i /ws-
    acl is_node_api path_beg -i /node/
    acl is_vision_api path_beg -i /vision/

    http-request return status 200 content-type text/plain string "ok\\n" if is_health
    http-request return status 404 if !is_health !is_xh !is_ws !is_node_api !is_vision_api
    use_backend xhttp_backend if is_xh
    use_backend ws_backend if is_ws
    use_backend node_api_backend if is_node_api
    use_backend node_api_backend if is_vision_api

backend xhttp_backend
    option http-no-delay
    server xhttp 127.0.0.1:{env["XHTTP_UPSTREAM_PORT"]}

backend ws_backend
    option http-server-close
    timeout tunnel 1h
    server ws 127.0.0.1:{env["WS_UPSTREAM_PORT"]}

backend node_api_backend
    option http-server-close
    server node_api 127.0.0.1:{env["NODE_PORT"]} ssl verify none
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

    for child in [app_process, haproxy_process]:
        if child and child.poll() is None:
            child.terminate()

    for child in [app_process, haproxy_process]:
        if child and child.poll() is None:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()

    raise SystemExit(code)


def handle_signal(_signum, _frame):
    terminate(0)


def main() -> None:
    global haproxy_process, app_process

    ensure_linux()
    env = build_env()
    validate_ports(env)

    haproxy_bin = ensure_haproxy()
    ensure_rw_node_go()
    write_haproxy_config(env)
    run(haproxy_bin, ["-c", "-f", str(HAPROXY_CONF)], env=env)

    log(f"starting HAProxy on port {env['HTTP_FRONT_PORT']}")
    haproxy_process = spawn_managed(haproxy_bin, ["-W", "-db", "-f", str(HAPROXY_CONF)], env)

    log("starting rw-node-go")
    app_process = spawn_managed(str(APP_BIN), [], env)

    while True:
        haproxy_status = haproxy_process.poll()
        app_status = app_process.poll()
        if haproxy_status is not None:
            log(f"haproxy exited with {haproxy_status}")
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
