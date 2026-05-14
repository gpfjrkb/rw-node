# PaaS HTTPS 直连

PaaS 镜像适合 Render、Koyeb、Railway、Fly.io 等只提供 HTTP/HTTPS 回源端口的平台。它在容器内启动 HAProxy HTTP 前置，把平台 HTTPS 域名收到的请求按路径转发到本机不同服务。

推荐镜像：

```text
ghcr.io/x-dora/rw-node:latest-paas
```

非官方 Go 实现镜像：

```text
ghcr.io/x-dora/rw-node:latest-go-paas
```

## 推荐链路

```text
Remnawave Panel
  -> https://<paas-domain>
  -> PaaS HTTP(S)
  -> HAProxy:${PORT:-3000}
  -> /node/* 或 /vision/*
  -> 127.0.0.1:NODE_PORT
```

PaaS 前置通常无法透传 Remnawave Node 原本使用的客户端证书，因此 PaaS HTTPS 直连推荐在节点环境变量中设置：

```text
NODE_TLS_CLIENT_AUTH=none
```

同时，Remnawave Panel 需要信任 PaaS HTTPS 域名的公共证书链。做法是在 Panel 端数据库中找到 `keygen` 记录，把 PaaS HTTPS 域名证书链对应的 Root CA 追加到 `ca_cert` 字段。

仓库提供了一个常见免费/托管平台 Root CA 参考包：[`config/certs/free-provider-root-ca-bundle.pem`](../config/certs/free-provider-root-ca-bundle.pem)。具体包含哪些 Root CA，见 [PaaS Root CA 参考](../config/certs/README.md)。

如果 PaaS 使用自定义域名证书、私有 CA、企业代理证书或特殊区域证书链，需要额外追加实际链路对应的 Root CA。不要把节点自签证书当作 PaaS HTTPS 域名的 Root CA 使用。

## 快速示例

```bash
docker run -d \
  --name rw-node-paas \
  -e SECRET_KEY=YOUR_SECRET_KEY \
  -e NODE_PORT=2222 \
  -e NODE_TLS_CLIENT_AUTH=none \
  -e XTLS_API_PORT=61000 \
  ghcr.io/x-dora/rw-node:latest-paas
```

Go 实现 PaaS 示例：

```bash
docker run -d \
  --name rw-node-go-paas \
  -e SECRET_KEY=YOUR_SECRET_KEY \
  -e NODE_PORT=2222 \
  -e NODE_TLS_CLIENT_AUTH=none \
  -e INTERNAL_REST_PORT=61001 \
  ghcr.io/x-dora/rw-node:latest-go-paas
```

Remnawave Panel 中节点地址填写 PaaS 提供的 HTTPS 域名，例如：

```text
https://rw-node.example-paas.app
```

## HAProxy 路由规则

PaaS 镜像默认启动 HAProxy HTTP 前置，监听 `${PORT:-3000}`。当 PaaS 提供 HTTP/HTTPS 回源端口时，可以用同一个公网端口按路径分流到本机服务：

```text
PaaS HTTP(S) -> HAProxy:${PORT:-3000} -> /xh-*     -> 127.0.0.1:8080
PaaS HTTP(S) -> HAProxy:${PORT:-3000} -> /ws-*     -> 127.0.0.1:8880
PaaS HTTP(S) -> HAProxy:${PORT:-3000} -> /node/*   -> 127.0.0.1:NODE_PORT (HTTPS, verify none)
PaaS HTTP(S) -> HAProxy:${PORT:-3000} -> /vision/* -> 127.0.0.1:NODE_PORT (HTTPS, verify none)
PaaS HTTP(S) -> HAProxy:${PORT:-3000} -> /health   -> 200 ok
```

`/xh-*` 和 `/ws-*` 表示路径分别以 `/xh-` 和 `/ws-` 开头，例如 `/xh-a`、`/xh-test`、`/ws-a`。HAProxy 到 Xray 使用明文 HTTP，不做 HTTPS upstream。

`/node/*` 和 `/vision/*` 会转发到本机 `NODE_PORT` 的 HTTPS 服务，并跳过 upstream 证书校验，以兼容节点自签证书。

除 `/health`、`/xh-*`、`/ws-*`、`/node/*`、`/vision/*` 之外的路径会直接返回 404。`/xh`、`/xh/abc`、`/ws`、`/ws/abc` 不会匹配前置规则。

`HTTP_FRONT_ENABLED=false` 时不会启动 HAProxy 分流，只会在 PaaS 下发了 `PORT` 且该端口不等于 `NODE_PORT` 时启动一个简单 HTTP health server。这种模式不能承载 `/xh-*`、`/ws-*` 或 Panel API 转发。

## 环境变量

必填环境变量：

| 变量名 | 描述 | 示例 |
|--------|------|------|
| `SECRET_KEY` | Remnawave Panel 中的节点密钥 | `YOUR_SECRET_KEY` |

常用可选环境变量：

| 变量名 | 默认值 | 描述 |
|--------|--------|------|
| `NODE_PORT` | `2222` | rw-node 容器内 HTTPS 监听端口 |
| `NODE_TLS_CLIENT_AUTH` | `mtls` | PaaS HTTPS 直连推荐设置为 `none`，避免 PaaS/HAProxy 前置无法透传客户端证书导致 Panel 连接失败 |
| `XTLS_API_PORT` | `61000` | Xray API 内部端口，不要公开 |
| `INTERNAL_REST_PORT` | `61001` | Go 实现镜像的本机 internal REST 端口，不要公开 |
| `PORT` | - | PaaS 下发的 HTTP 回源端口；HAProxy 优先监听该端口 |
| `HTTP_FRONT_ENABLED` | `true` | 是否启动 HAProxy HTTP 前置；设为 `false` 时回退为简单 health server |
| `HTTP_FRONT_PORT` | `${PORT:-3000}` | HAProxy HTTP 前置监听端口，通常不需要手动设置 |
| `XHTTP_UPSTREAM_PORT` | `8080` | `/xh-` 前缀流量转发到的本机 xhttp 明文 HTTP 端口 |
| `WS_UPSTREAM_PORT` | `8880` | `/ws-` 前缀流量转发到的本机 WebSocket 明文 HTTP 端口 |
| `RW_NODE_APP_DIR` | `/opt/rw-node` | PaaS 镜像内应用文件目录，通常不要修改 |

## xhttp / WebSocket 路径

如果使用 HAProxy HTTP 前置承载 xhttp/ws 流量，客户端或面板下发的 xhttp/ws 配置应填写 PaaS 提供的 HTTP/HTTPS 域名和单个公网端口，并用不同路径前缀区分协议。

- xhttp inbound 默认转发到本机 `8080` 明文 HTTP。
- ws inbound 默认转发到本机 `8880` 明文 HTTP。
- 只有以 `/xh-` 或 `/ws-` 开头的路径会被转发。

## 常见问题

### Panel 无法连接节点

优先检查三点：

1. Remnawave Panel 中节点地址是否填写 PaaS 提供的 HTTPS 域名。
2. 节点环境变量是否设置了 `NODE_TLS_CLIENT_AUTH=none`。
3. Panel 数据库 `keygen.ca_cert` 字段是否包含该 HTTPS 域名证书链对应的 Root CA。

### `application entrypoint is missing`

优先检查 PaaS 是否把持久化卷挂载到了 `/opt/rw-node` 并覆盖了镜像内应用文件。

PaaS 镜像默认会从 `/opt/rw-node` 读取应用文件。不要把空卷挂载到这个路径，也不要把 `RW_NODE_DIR` 指向不包含 `dist/`、`node_modules/` 的目录。

### 端口是否需要公开

PaaS 场景通常只公开平台分配的 HTTP/HTTPS 入口端口。

`XTLS_API_PORT` 和 `INTERNAL_REST_PORT` 都是内部端口，不应通过 Docker、VPS 防火墙或 PaaS 入站公开。
