# RW-Node Go PaaS Starter

This branch contains two minimal starters for running `rw-node-go` with a generated HAProxy front end.

Use either runtime:

```bash
npm start
```

```bash
uv run python app.py
```

The starters only support Linux `x64` and `arm64`. They do not implement proxy logic themselves; they install or locate HAProxy, generate `.rw-node-go/conf/haproxy/haproxy.cfg`, start HAProxy first, then start `rw-node-go`.

## Files

- `index.js`: Node.js starter using only built-in modules.
- `app.py`: Python starter using only the standard library.
- `package.json`: Node startup metadata.
- `pyproject.toml`: Python startup metadata.

## Install Layout

`rw-node-go` is installed under the current working directory:

```text
.rw-node-go/
  bin/rw-node-go
  share/xray/geoip.dat
  share/xray/geosite.dat
  .rw-node-go-version
  conf/haproxy/haproxy.cfg
```

The starters download `rw-node-go` only when the binary or required Xray asset files are missing.

## HAProxy

The starters first use `HAPROXY_BIN` when set, then search `PATH` for `haproxy`.

If HAProxy is missing, they try to install it with the detected package manager:

- Alpine: `apk add --no-cache haproxy`
- Debian/Ubuntu: `apt-get update && apt-get install -y haproxy`
- Fedora/RHEL/CentOS: `dnf install -y haproxy`, or `yum install -y haproxy`

If the process lacks permission or no supported package manager is present, install HAProxy yourself or set `HAPROXY_BIN`.

## Environment

Existing environment variables are preserved. Missing values use these defaults:

```text
NODE_PORT=2222
NODE_TLS_CLIENT_AUTH=none
INTERNAL_REST_PORT=61001
REQUIRE_SECRET_KEY=true
RW_NODE_DIR=<current working directory>
XRAY_LOCATION_ASSET=<current working directory>/.rw-node-go/share/xray
HTTP_FRONT_PORT=${PORT:-3000}
XHTTP_UPSTREAM_PORT=8080
WS_UPSTREAM_PORT=8880
```

Set `RW_NODE_GO_VERSION` to install a specific `x-dora/rw-node-go` release. When it is unset, the starters use the latest GitHub release.

## HAProxy Routes

The generated HAProxy config matches the PaaS front-end behavior:

- `/health` returns `200` with `ok`.
- `/xh-*` forwards to `127.0.0.1:${XHTTP_UPSTREAM_PORT}`.
- `/ws-*` forwards to `127.0.0.1:${WS_UPSTREAM_PORT}`.
- `/node/*` forwards to `127.0.0.1:${NODE_PORT}` over HTTPS with `ssl verify none`.
- `/vision/*` forwards to `127.0.0.1:${NODE_PORT}` over HTTPS with `ssl verify none`.
- All other paths return `404`.

`HTTP_FRONT_PORT` must be different from `NODE_PORT`.

## Process Behavior

Both starters:

1. Validate platform and ports.
2. Ensure HAProxy is available.
3. Ensure `rw-node-go` is installed.
4. Generate and validate the HAProxy config with `haproxy -c`.
5. Start HAProxy.
6. Start `rw-node-go`.
7. Terminate both child processes when either exits or when the starter receives `SIGINT` or `SIGTERM`.
