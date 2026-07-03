#!/bin/bash

set -euo pipefail

#######################################
# RW-Node 启动脚本 (Go-only bare-metal)
#######################################

WORK_DIR="${RW_NODE_DIR:-/opt/rw-node}"
APP_BIN="${WORK_DIR}/bin/rw-node-go"
CADDY_BIN="${CADDY_BIN:-${WORK_DIR}/bin/caddy}"
CADDY_CONF_DIR="${WORK_DIR}/conf/caddy"
CADDY_SITE_DIR="${CADDY_SITE_DIR:-${WORK_DIR}/www}"
CADDY_DEFAULT_SITE_DIR="${CADDY_DEFAULT_SITE_DIR:-${WORK_DIR}/default-www}"
RW_NODE_LIB_DIR="${RW_NODE_LIB_DIR:-${WORK_DIR}/lib}"
XRAY_LOCATION_ASSET="${XRAY_LOCATION_ASSET:-${WORK_DIR}/share/xray}"
LOG_PREFIX="[rw-node]"

# shellcheck source=../lib/core.sh
source "${RW_NODE_LIB_DIR}/core.sh"
# shellcheck source=../lib/caddy.sh
source "${RW_NODE_LIB_DIR}/caddy.sh"

# ── 目录初始化 ─────────────────────────────────────────────
mkdir -p "${WORK_DIR}/bin" "${WORK_DIR}/logs" "${WORK_DIR}/run" \
         "${WORK_DIR}/conf" "${WORK_DIR}/share/xray" "${CADDY_CONF_DIR}"

# ── 清理上一次运行遗留的运行时文件 ──────────────────────────
rm -f "${WORK_DIR}/run"/*.sock 2>/dev/null || true
rm -f "${WORK_DIR}/run"/*.pid 2>/dev/null || true
rm -f /tmp/caddy-http.sock /tmp/caddy-admin.sock 2>/dev/null || true

# ── 加载环境变量 ───────────────────────────────────────────
load_env_file "${WORK_DIR}/.env"

# ── 设置默认值 ─────────────────────────────────────────────
# 裸金属环境默认不启用 Caddy HTTP 前置（与 Docker 默认 true 不同）
NODE_PORT="${NODE_PORT:-2222}"
NODE_TLS_CLIENT_AUTH="${NODE_TLS_CLIENT_AUTH:-mtls}"
INTERNAL_REST_PORT="${INTERNAL_REST_PORT:-61001}"
REQUIRE_SECRET_KEY="${REQUIRE_SECRET_KEY:-true}"
RW_NODE_DIR="${WORK_DIR}"
HTTP_FRONT_ENABLED="${HTTP_FRONT_ENABLED:-false}"
HTTP_FRONT_PORT="${HTTP_FRONT_PORT:-${PORT:-3000}}"
CADDY_HTTP_SOCK="${CADDY_HTTP_SOCK:-/tmp/caddy-http.sock}"
XHTTP_UPSTREAM_PORT="${XHTTP_UPSTREAM_PORT:-8080}"
WS_UPSTREAM_PORT="${WS_UPSTREAM_PORT:-8880}"
CADDY_INDEX_PAGE="${CADDY_INDEX_PAGE:-${CADDYIndexPage:-mikutap}}"
REALITY_SPLIT_ENABLED="${REALITY_SPLIT_ENABLED:-true}"
REALITY_SPLIT_INTERVAL="${REALITY_SPLIT_INTERVAL:-15}"

export NODE_PORT NODE_TLS_CLIENT_AUTH INTERNAL_REST_PORT REQUIRE_SECRET_KEY
export RW_NODE_DIR XRAY_LOCATION_ASSET

# ── 参数校验 ───────────────────────────────────────────────
if [[ -z "${SECRET_KEY:-}" ]]; then
    fail "SECRET_KEY is required"
fi

if [[ ! -x "${APP_BIN}" ]]; then
    fail "rw-node-go binary not found: ${APP_BIN}"
fi

if ! is_port "${NODE_PORT}"; then
    fail "NODE_PORT must be a valid TCP port"
fi

if [[ ! -f "${XRAY_LOCATION_ASSET}/geoip.dat" || ! -f "${XRAY_LOCATION_ASSET}/geosite.dat" ]]; then
    log "WARNING: geoip.dat/geosite.dat missing in ${XRAY_LOCATION_ASSET}"
    log "Xray routing rules referencing geoip:*/geosite:* will fail to load."
    log "Re-run install.sh or place the files manually."
fi

# ── 进程管理 ───────────────────────────────────────────────
app_pid=""
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

    if [[ -n "${caddy_pid}" ]] && kill -0 "${caddy_pid}" 2>/dev/null; then
        kill "${caddy_pid}" 2>/dev/null || true
    fi

    wait 2>/dev/null || true
    rm -f "${WORK_DIR}/run/rw-node.pid" 2>/dev/null || true
}

trap terminate INT TERM

# ── 启动信息 ───────────────────────────────────────────────
log "Starting rw-node-go..."
log "Work directory: ${WORK_DIR}"
log "NODE_PORT: ${NODE_PORT}"
log "NODE_TLS_CLIENT_AUTH: ${NODE_TLS_CLIENT_AUTH}"
log "INTERNAL_REST_PORT: ${INTERNAL_REST_PORT}"
log "XRAY_LOCATION_ASSET: ${XRAY_LOCATION_ASSET}"
log "HTTP_FRONT_ENABLED: ${HTTP_FRONT_ENABLED}"

# ── 写入 PID 文件 ─────────────────────────────────────────
echo "$$" > "${WORK_DIR}/run/rw-node.pid"

# ── 启动 Caddy HTTP 前置（可选）─────────────────────────────
if [[ "${HTTP_FRONT_ENABLED}" == "true" ]]; then
    start_caddy_front
elif [[ "${HTTP_FRONT_ENABLED}" != "false" ]]; then
    fail "HTTP_FRONT_ENABLED must be true or false"
fi

# ── 启动 rw-node-go ───────────────────────────────────────
cd "${WORK_DIR}"
"${APP_BIN}" &
app_pid=$!

# ── 启动 REALITY 动态分流 watcher（可选）─────────────────────
if [[ "${HTTP_FRONT_ENABLED}" == "true" && "${REALITY_SPLIT_ENABLED}" == "true" ]]; then
    start_reality_watcher "${CADDY_CONF_DIR}/Caddyfile" &
    watcher_pid=$!
fi

# ── 等待子进程 ─────────────────────────────────────────────
if [[ -n "${caddy_pid}" ]]; then
    set +e
    wait -n "${app_pid}" "${caddy_pid}"
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
