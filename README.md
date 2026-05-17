# RW-Node Go PaaS Starter

此分支提供两个用于在 PaaS 环境运行 `rw-node-go` 的最小启动入口，并使用自动生成的 Caddy 作为前置代理。

可以任选一个运行时启动：

```bash
npm start
```

```bash
uv run python app.py
```

启动入口只支持 Linux `x64` 和 `arm64`。`index.js` 与 `app.py` 只负责安装依赖二进制、生成配置和编排进程，不在代码里实现代理转发逻辑。启动顺序固定为先启动 Caddy，再启动 `rw-node-go`。

## 文件

- `index.js`：Node.js 启动入口，只使用 Node.js 内置模块。
- `app.py`：Python 启动入口，只使用 Python 标准库。
- `package.json`：Node.js 启动元数据。
- `pyproject.toml`：Python 启动元数据。

## 安装目录

`rw-node-go` 和 Caddy 都安装到当前工作目录下：

```text
.rw-node-go/
  bin/caddy
  bin/rw-node-go
  share/xray/geoip.dat
  share/xray/geosite.dat
  .caddy-version
  .rw-node-go-version
  conf/caddy/Caddyfile
  caddy/data/
  caddy/config/
```

当 `rw-node-go` 二进制或必需的 Xray 资源文件缺失时，启动入口会下载 `rw-node-go`。当 `CADDY_BIN` 未设置，并且 `.rw-node-go/bin/caddy` 缺失或不可执行时，启动入口会下载 Caddy。

## Caddy

启动入口优先使用 `CADDY_BIN` 指定的 Caddy 二进制路径，该路径必须存在。

如果没有设置 `CADDY_BIN`，启动入口会检查 `.rw-node-go/bin/caddy`。如果本地 Caddy 不存在，则通过 `caddyserver/caddy` 的 GitHub Releases API 获取 release 信息，按当前 Linux 架构选择官方 `tar.gz` 资产，解压出 `caddy`，复制到 `.rw-node-go/bin/caddy`，并设置权限为 `755`。

可以设置 `CADDY_VERSION` 安装指定 Caddy release tag，例如：

```text
CADDY_VERSION=v2.11.3
```

未设置 `CADDY_VERSION` 时，启动入口使用 GitHub latest release。

Caddy 子进程会使用适合 rootless PaaS 的目录：

```text
HOME=<当前工作目录>
XDG_DATA_HOME=<当前工作目录>/.rw-node-go/caddy/data
XDG_CONFIG_HOME=<当前工作目录>/.rw-node-go/caddy/config
```

生成的 `Caddyfile` 会启用本地 admin 端点：

```text
admin localhost:2019
```

同时会关闭自动 HTTPS，并使用明文 HTTP 监听业务入口：

```text
auto_https off
http://:${HTTP_FRONT_PORT}
```

## 环境变量

启动入口会保留已有环境变量。缺失变量使用以下默认值：

```text
NODE_PORT=2222
NODE_TLS_CLIENT_AUTH=none
INTERNAL_REST_PORT=61001
REQUIRE_SECRET_KEY=true
RW_NODE_DIR=<当前工作目录>
XRAY_LOCATION_ASSET=<当前工作目录>/.rw-node-go/share/xray
HTTP_FRONT_PORT=${PORT:-3000}
XHTTP_UPSTREAM_PORT=8080
WS_UPSTREAM_PORT=8880
```

可以设置 `RW_NODE_GO_VERSION` 安装指定 `x-dora/rw-node-go` release。未设置时，启动入口使用 GitHub latest release。

Caddy 相关变量：

```text
CADDY_BIN=/path/to/caddy
CADDY_VERSION=v2.11.3
```

端口校验规则：

- `HTTP_FRONT_PORT`、`NODE_PORT`、`XHTTP_UPSTREAM_PORT`、`WS_UPSTREAM_PORT` 必须是合法 TCP 端口。
- `HTTP_FRONT_PORT` 不能等于 `NODE_PORT`。

## Caddy 路由

生成的 Caddy 配置对应 PaaS 前置代理行为：

- `/health` 返回 `200`，响应体为 `ok`。
- `/xh-*` 转发到 `127.0.0.1:${XHTTP_UPSTREAM_PORT}`。
- `/ws-*` 转发到 `127.0.0.1:${WS_UPSTREAM_PORT}`。
- `/node/*` 通过 HTTPS 转发到 `127.0.0.1:${NODE_PORT}`，并跳过证书校验。
- `/vision/*` 通过 HTTPS 转发到 `127.0.0.1:${NODE_PORT}`，并跳过证书校验。
- 其它路径返回 `404`。

生成的 `Caddyfile` 会直接写入具体端口值，不依赖 Caddy 自己展开环境变量。

## 进程行为

两个启动入口都会执行以下流程：

1. 校验平台、架构和端口。
2. 确保 Caddy 已安装。
3. 确保 `rw-node-go` 已安装。
4. 生成 `.rw-node-go/conf/caddy/Caddyfile`。
5. 使用 `caddy validate --config .rw-node-go/conf/caddy/Caddyfile --adapter caddyfile` 校验配置。
6. 使用 `caddy run --config .rw-node-go/conf/caddy/Caddyfile --adapter caddyfile` 启动 Caddy。
7. 启动 `rw-node-go`。
8. 当任一子进程提前退出，或启动入口收到 `SIGINT` / `SIGTERM` 时，终止 Caddy 和 `rw-node-go`。
