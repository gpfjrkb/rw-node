#!/usr/bin/env bash
# shellcheck shell=bash
[[ -n "${_RW_NODE_CLOUDFLARED_LOADED:-}" ]] && return 0
_RW_NODE_CLOUDFLARED_LOADED=1

_CLOUDFLARED_LIB_DIR="${_CLOUDFLARED_LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)}"
# shellcheck source=core.sh
[[ -n "${_RW_NODE_CORE_LOADED:-}" ]] || source "${_CLOUDFLARED_LIB_DIR}/core.sh"

cloudflare_tunnel_enabled() {
  [[ -n "${ARGO_TOKEN:-}" ]]
}

run_cloudflared_default() {
  log "starting Cloudflare Tunnel to http://localhost:$HTTP_FRONT_PORT"
  "$CLOUDFLARED_BIN" tunnel \
    --no-autoupdate \
    --protocol http2 \
    --edge-ip-version auto \
    --loglevel "$ARGO_LOG_LEVEL" \
    --tag "rw_node_port=$HTTP_FRONT_PORT" \
    run \
    --dns-resolver-addrs 1.1.1.1:53 \
    --dns-resolver-addrs 1.0.0.1:53 \
    --token "$ARGO_TOKEN" &
  cloudflared_pid=$!
  cloudflared_mode="default"
}

run_cloudflared_fixed_edge() {
  log "starting Cloudflare Tunnel with fixed edge addresses to http://localhost:$HTTP_FRONT_PORT"
  "$CLOUDFLARED_BIN" tunnel \
    --no-autoupdate \
    --protocol http2 \
    --edge-ip-version auto \
    --edge 198.41.192.167:7844 \
    --edge 198.41.192.67:7844 \
    --edge 198.41.192.57:7844 \
    --edge 198.41.192.107:7844 \
    --edge 198.41.192.27:7844 \
    --edge 198.41.192.7:7844 \
    --edge 198.41.192.227:7844 \
    --edge 198.41.192.47:7844 \
    --edge 198.41.192.37:7844 \
    --edge 198.41.192.77:7844 \
    --edge 198.41.200.13:7844 \
    --edge 198.41.200.193:7844 \
    --edge 198.41.200.33:7844 \
    --edge 198.41.200.233:7844 \
    --edge 198.41.200.53:7844 \
    --edge 198.41.200.63:7844 \
    --edge 198.41.200.113:7844 \
    --edge 198.41.200.73:7844 \
    --edge 198.41.200.43:7844 \
    --edge 198.41.200.23:7844 \
    --loglevel "$ARGO_LOG_LEVEL" \
    --tag "rw_node_port=$HTTP_FRONT_PORT" \
    run \
    --dns-resolver-addrs 1.1.1.1:53 \
    --dns-resolver-addrs 1.0.0.1:53 \
    --token "$ARGO_TOKEN" &
  cloudflared_pid=$!
  cloudflared_mode="fixed-edge"
}
