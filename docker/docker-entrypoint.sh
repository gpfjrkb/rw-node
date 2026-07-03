#!/bin/bash

set -euo pipefail

APP_BIN="/usr/local/bin/rw-node-go"
WORK_DIR="${RW_NODE_DIR:-/opt/rw-node}"
CONF_DIR="${WORK_DIR}/conf"
CADDY_CONF_DIR="${CONF_DIR}/caddy"
CADDY_SITE_DIR="${CADDY_SITE_DIR:-${WORK_DIR}/www}"
CADDY_DEFAULT_SITE_DIR="${CADDY_DEFAULT_SITE_DIR:-/opt/rw-node/default-www}"
CADDY_BIN="${CADDY_BIN:-$(command -v caddy 2>/dev/null || true)}"
CADDY_ADMIN_SOCK="/tmp/caddy-admin.sock"
LOG_PREFIX="[Go PaaS]"

RW_NODE_LIB_DIR="${RW_NODE_LIB_DIR:-/usr/local/lib/rw-node}"
# shellcheck source=../lib/core.sh
source "${RW_NODE_LIB_DIR}/core.sh"
# shellcheck source=../lib/caddy.sh
source "${RW_NODE_LIB_DIR}/caddy.sh"

NODE_PORT="${NODE_PORT:-2222}"
NODE_TLS_CLIENT_AUTH="${NODE_TLS_CLIENT_AUTH:-mtls}"
INTERNAL_REST_PORT="${INTERNAL_REST_PORT:-61001}"
REQUIRE_SECRET_KEY="${REQUIRE_SECRET_KEY:-true}"
RW_NODE_DIR="${WORK_DIR}"
XRAY_LOCATION_ASSET="${XRAY_LOCATION_ASSET:-/usr/local/share/xray}"
HTTP_FRONT_ENABLED="${HTTP_FRONT_ENABLED:-true}"
HTTP_FRONT_PORT="${HTTP_FRONT_PORT:-${PORT:-3000}}"
CADDY_HTTP_SOCK="${CADDY_HTTP_SOCK:-/tmp/caddy-http.sock}"
XHTTP_UPSTREAM_PORT="${XHTTP_UPSTREAM_PORT:-8080}"
WS_UPSTREAM_PORT="${WS_UPSTREAM_PORT:-8880}"
CADDY_INDEX_PAGE="${CADDY_INDEX_PAGE:-${CADDYIndexPage:-mikutap}}"
REALITY_SPLIT_ENABLED="${REALITY_SPLIT_ENABLED:-true}"
REALITY_SPLIT_INTERVAL="${REALITY_SPLIT_INTERVAL:-15}"

app_pid=""
health_pid=""
caddy_pid=""
watcher_pid=""

terminate() {
    trap - INT TERM

    if [[ -n "${watcher_pid}" ]] && kill -0 "${watcher_pid}" 2>/dev/null; then
        kill "${watcher_pid}" 2>/dev/null || true
    fi

    if [[ -n "${app_pid}" ]] && kill -0 "${app_pid}" 2>/dev/null; then
        kill "${app_pid}" 2>/dev/null || true
    fi

    if [[ -n "${health_pid}" ]] && kill -0 "${health_pid}" 2>/dev/null; then
        kill "${health_pid}" 2>/dev/null || true
    fi

    if [[ -n "${caddy_pid}" ]] && kill -0 "${caddy_pid}" 2>/dev/null; then
        kill "${caddy_pid}" 2>/dev/null || true
    fi

    wait 2>/dev/null || true
}

start_health_server() {
    if [[ -z "${PORT:-}" ]]; then
        return 0
    fi

    if ! is_port "${PORT}"; then
        fail "PORT must be a valid TCP port"
    fi

    if [[ "${PORT}" == "${NODE_PORT}" ]]; then
        log "PORT equals NODE_PORT; skipping auxiliary HTTP health server"
        return 0
    fi

    log "Starting auxiliary HTTP health server on port ${PORT}"
    printf 'ok\n' > /tmp/index.html
    busybox httpd -f -p "0.0.0.0:${PORT}" -h /tmp &
    health_pid=$!
}

trap terminate INT TERM

if ! is_port "${NODE_PORT}"; then
    fail "NODE_PORT must be a valid TCP port"
fi

export NODE_PORT NODE_TLS_CLIENT_AUTH INTERNAL_REST_PORT REQUIRE_SECRET_KEY RW_NODE_DIR XRAY_LOCATION_ASSET

if [[ ! -x "${APP_BIN}" ]]; then
    fail "rw-node-go binary not found"
fi

mkdir -p "${WORK_DIR}"
rm -f "${CADDY_HTTP_SOCK}" "${CADDY_ADMIN_SOCK}"
if [[ "${HTTP_FRONT_ENABLED}" == "true" ]]; then
    start_caddy_front
elif [[ "${HTTP_FRONT_ENABLED}" == "false" ]]; then
    start_health_server
else
    fail "HTTP_FRONT_ENABLED must be true or false"
fi

cd "${WORK_DIR}"
"${APP_BIN}" &
app_pid=$!

if [[ "${HTTP_FRONT_ENABLED}" == "true" && "${REALITY_SPLIT_ENABLED}" == "true" ]]; then
    start_reality_watcher "${CONF_DIR}/caddy/Caddyfile" &
    watcher_pid=$!
fi

if [[ -n "${caddy_pid}" ]]; then
    set +e
    wait -n "${app_pid}" "${caddy_pid}"
    status=$?
    set -e
elif [[ -n "${health_pid}" ]]; then
    set +e
    wait -n "${app_pid}" "${health_pid}"
    status=$?
    set -e
else
    set +e
    wait "${app_pid}"
    status=$?
    set -e
fi

terminate
exit "${status}"
