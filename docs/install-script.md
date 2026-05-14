# 一键脚本安装

一键脚本适合没有 Docker 的 VPS、VM 或容器环境。脚本会安装运行所需组件，生成配置，并根据环境使用 systemd 服务或前台辅助命令管理进程。

默认安装官方 JS 兼容实现。也可以通过 `--impl go` 安装非官方 [x-dora/rw-node-go](https://github.com/x-dora/rw-node-go) 实现。

## 系统要求

- Linux：Ubuntu、Debian、CentOS、RHEL、Fedora、Alpine
- x86_64 或 arm64 架构
- Root 权限
- bash 和 curl

安装器会自动补齐 git、unzip、jq、xz 等依赖，无需 Python。

## 安装官方 JS 兼容实现

交互安装：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/x-dora/rw-node/main/scripts/install.sh)
```

静默安装：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/x-dora/rw-node/main/scripts/install.sh) \
  --secret-key YOUR_SECRET_KEY \
  --port 2222
```

指定版本：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/x-dora/rw-node/2.5.2/scripts/install.sh) --version 2.5.2
```

指定 Xray-core 版本：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/x-dora/rw-node/main/scripts/install.sh) \
  --secret-key YOUR_SECRET_KEY \
  --xray-version v26.3.27
```

安装 Cloudflare Tunnel：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/x-dora/rw-node/main/scripts/install.sh) --with-cloudflared
```

安装 Cloudflare Tunnel 并写入 token：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/x-dora/rw-node/main/scripts/install.sh) \
  --with-cloudflared \
  --cloudflared-token YOUR_TUNNEL_TOKEN
```

## 安装非官方 Go 实现

Go 实现用于更小体积和更少运行时依赖。它来自 [x-dora/rw-node-go](https://github.com/x-dora/rw-node-go)，版本号跟随 `rw-node-go` 自己的 release，不是 `remnawave/node` 的 `2.x` 版本。

最简安装：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/x-dora/rw-node/main/scripts/install.sh) \
  --impl go \
  --secret-key YOUR_SECRET_KEY \
  --port 2222 \
  --node-tls-client-auth mtls
```

固定 rw-node-go 版本：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/x-dora/rw-node/main/scripts/install.sh) \
  --impl go \
  --go-version v1.0.3 \
  --secret-key YOUR_SECRET_KEY \
  --port 2222
```

需要严格兼容官方 Remnawave Node 行为时，优先使用默认的官方 JS 兼容实现。

## 安装参数

| 参数 | 描述 | 默认值 |
|------|------|--------|
| `--impl <official|go>` | 安装实现；`official` 为 JS 兼容实现，`go` 为非官方 Go 实现 | `official` |
| `--version, -v <版本>` | 指定 JS 兼容实现版本；对应 `remnawave/node` / 本仓库 release 版本 | 最新 release |
| `--go-version <版本>` | 指定 `rw-node-go` release 版本，仅 `--impl go` 有效 | 最新 `rw-node-go` release |
| `--port, -p <端口>` | 节点主 API 监听端口 | `2222` |
| `--secret-key, -k <密钥>` | Remnawave Panel 中的节点密钥；非交互安装时必填 | - |
| `--xtls-api-port <端口>` | JS 兼容实现的 Xray API 内部端口 | `61000` |
| `--internal-rest-port <端口>` | Go 实现的 Internal REST 本机端口 | `61001` |
| `--node-tls-client-auth <mtls|optional|none>` | Go 实现主 API 的 TLS 客户端证书策略；PaaS HTTPS 直连常用 `none` | `mtls` |
| `--xray-version <版本>` | 指定 JS 兼容实现安装的 Xray-core 版本 | `v26.3.27` |
| `--with-cloudflared` | 安装 Cloudflare Tunnel 二进制；有 systemd 且 token 有效时启用服务 | 关闭 |
| `--cloudflared-token <令牌>` | 写入 Cloudflare Tunnel token，并自动启用 `--with-cloudflared` | - |

## 管理命令

有 systemd 的环境：

```bash
systemctl start rw-node
systemctl stop rw-node
systemctl restart rw-node
systemctl status rw-node
journalctl -u rw-node -f
```

容器或无 systemd 环境：

```bash
rw-node-start
rw-node-stop
rw-node-status
```

通用日志命令：

```bash
xlogs
xerrors
```

## 更新和卸载

更新到最新版本：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/x-dora/rw-node/main/scripts/update.sh)
```

指定版本更新：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/x-dora/rw-node/main/scripts/update.sh) --version 2.7.0
```

非交互确认更新：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/x-dora/rw-node/main/scripts/update.sh) --yes
```

当前版本相同也重新部署：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/x-dora/rw-node/main/scripts/update.sh) --force --yes
```

卸载：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/x-dora/rw-node/main/scripts/uninstall.sh)
```

`update.sh` 仅支持 JS 兼容实现的在线更新，并会保留已有 `.env` 配置。Go 实现模式暂不走 `update.sh`，需要重新运行 `install.sh --impl go` 覆盖安装；覆盖安装会重新生成 `.env`，请提前备份自定义配置。

`uninstall.sh` 会删除安装目录、systemd 服务和本项目创建的 `/usr/local/bin` 符号链接，必须在交互终端中确认后才会执行。

## 工作目录

默认工作目录为 `/opt/rw-node`，可通过 `RW_NODE_DIR` 自定义：

```bash
RW_NODE_DIR=/data/rw-node bash <(curl -fsSL https://raw.githubusercontent.com/x-dora/rw-node/main/scripts/install.sh)
```

工作目录中保存 `.env`、启动脚本、应用构建产物、Node.js、Xray、Supervisord、运行时配置和日志。

常用环境变量：

| 变量名 | 描述 | 默认值 |
|--------|------|--------|
| `NODE_PORT` | 节点主 API 监听端口 | `2222` |
| `SECRET_KEY` | Remnawave Panel 中的节点密钥 | - |
| `XTLS_API_PORT` | JS 兼容实现的 Xray API 内部端口，不要公开 | `61000` |
| `INTERNAL_REST_PORT` | Go 实现的本机 Internal REST 端口，不要公开 | `61001` |
| `RW_NODE_DIR` | 工作目录 | `/opt/rw-node` |
| `XRAY_LOCATION_ASSET` | Xray 资源文件目录 | 脚本安装为 `${RW_NODE_DIR}/share/xray` |
| `REQUIRE_SECRET_KEY` | Go 模式是否要求 `SECRET_KEY` | `true` |
| `SUPERVISORD_USER` | JS 兼容实现 Supervisord unix socket 用户名；通常自动随机生成 | 随机 |
| `SUPERVISORD_PASSWORD` | JS 兼容实现 Supervisord unix socket 密码；通常自动随机生成 | 随机 |
| `INTERNAL_REST_TOKEN` | JS 兼容实现内部 REST token；通常自动随机生成 | 随机 |

## 注意事项

- 安装脚本需要 root 权限运行。
- 所有核心运行文件默认放在 `/opt/rw-node`。
- `XTLS_API_PORT` 和 `INTERNAL_REST_PORT` 都是内部端口，不应公开到公网。
- 默认不传 `--impl` 时安装官方 JS 兼容实现。
- `--impl go` 不安装 Node.js / Supervisord / 外部 Xray，使用 `rw-node-go` release 包。
