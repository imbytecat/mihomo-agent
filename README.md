# mihomoctl

独立的 Mihomo 管理器。UFI / Android 与 Linux 共用 CLI、内核下载更新、订阅、配置校验与回滚、任务和日志；二进制由 mihomoctl 自行管理，无需通过包管理器安装 Mihomo。

- **UFI-TOOLS / Android**：提供插件界面，管理守护、自启及热点 / USB 共享。F50 是适用设备之一，不代表所有 UFI 硬件均已验证。
- **Linux**：CLI 自动安装和清理 systemd service、设置自启；网络规则由用户配置，详见 [Linux 使用说明](docs/linux.md)。

[发行版](https://github.com/imbytecat/mihomoctl/releases) · [反馈](https://github.com/imbytecat/mihomoctl/issues)

## UFI 安装

需要 UFI-TOOLS 完整版、root / 高级功能，以及支持 TPROXY 的系统。插件界面使用 Chrome / Android System WebView 153 或以上版本。

1. 已安装其他代理插件时，先在原界面卸载并关闭自启，再移除原插件。
2. 下载 `mihomoctl-ufi.js`，在 UFI 插件管理导入、保存并刷新。
3. 无法直连 GitHub 时，先填写 GitHub Proxy；再安装 mihomoctl / 服务和内核，粘贴完整 YAML 订阅，点击「保存并更新」。
4. 启动代理，确认客户端能正常上网后再开启自启；需要控制面板时安装 Zashboard。

初装查询版本与下载 mihomoctl 都使用填写的 GitHub Proxy，安装后保存到 SQLite；后续检查更新、下载 mihomoctl / Mihomo / Zashboard 共用此设置。配置镜像后不再先尝试直连 GitHub；清空前缀才恢复直连。

GitHub Proxy 必须是你信任的 HTTPS 镜像前缀，支持 `https://api.github.com/` 和 GitHub Release 文件；UFI 初装还要求镜像允许浏览器跨域请求。仅支持文件下载的服务不能用于版本查询。安装后失焦保存；订阅请求不经过这个镜像，订阅和面板设置需明确保存并应用。

镜像可以看到公开发行查询和下载；UFI 登录信息、订阅和密钥不会交给它。SHA-256 校验保留，但镜像同时提供文件与摘要时，不能代替发布者签名或防止镜像同时篡改两者。

## Linux 安装

需要 root、systemd。下载对应架构的 `mihomoctl-linux-amd64`、`mihomoctl-linux-arm64` 或 `mihomoctl-linux-armv7` 及 `SHA256SUMS`。以 AMD64 为例：

```sh
sha256sum --check --ignore-missing SHA256SUMS
chmod +x mihomoctl-linux-amd64
sudo ./mihomoctl-linux-amd64 install
```

无法直连 GitHub 时，首次安装可加 `--github-proxy https://mirror.example.com`（替换成你信任且支持 API 的镜像前缀），后续 CLI 自动沿用。

安装自动复制 mihomoctl 到 `/var/lib/mihomoctl/mihomoctl` 并注册 service；接下来通过 CLI 下载内核、保存订阅并启动。后续使用安装目录内的 mihomoctl，确保自更新生效，首次下载的安装文件可删除。同名 service 冲突时会拒绝覆盖，可用 `install --unit 自定义名称.service`。

## 两平台通用 CLI

在设备本地 **root 终端**执行，Linux 可先运行 `sudo -i`。Linux 使用以下路径；UFI 改为 `ctl=/data/mihomoctl/mihomoctl`：

```sh
ctl=/var/lib/mihomoctl/mihomoctl
"$ctl" download
```

创建权限为 `0600` 的本地 `request.json`，填入完整 YAML 订阅链接。秘密通过文件或 `--input -` 的标准输入传递，勿粘贴到 UFI 会记录内容的 Root Shell 窗口。

```json
{"url":"https://example.com/your-subscription"}
```

```sh
"$ctl" update --input request.json
"$ctl" start
"$ctl" boot-on
"$ctl" status
```

| 操作 | 命令（接在 `"$ctl"` 后） |
| --- | --- |
| 停止 / 重启 | `stop` / `restart` |
| 更新已保存的订阅 | `update` |
| 更新内核 / mihomoctl（先停止代理） | `download` / `self-update` |
| 关闭自启 | `boot-off` |
| 安装或更新 Zashboard | `download-dashboard` |
| 检查 mihomoctl / 内核 / 面板更新 | `check-updates` |
| 查看日志 / 网络诊断 | `logs` / `diagnose` |
| 卸载 mihomoctl、内核及全部数据 | `uninstall` |

插件「安装与更新」中点击「检查更新」，查看各组件当前版本、最新版本及检查时间；不会自动升级。检查结果保存在设备 SQLite，刷新页面或执行 `status` 读取上次结果，手动检查才联网；组件版本变化后重新检查。

操作默认等待完成；自动化需要立即返回时加 `--no-wait`，用 `job ID`、`job-log ID` 查询。终端或页面关闭不会取消已接收任务；重新连接后用 `status` 查看最近任务，不要重复提交。

`request.json` 仅用于传入本次参数，保存成功后可删除；后续 `update` 使用设备已保存的订阅链接。

## 数据与安全

设置、任务和配置版本元数据保存在私有 SQLite；YAML、日志和二进制单独存放。**卸载会停止代理、关闭自启并删除本安装的全部数据，不留备份，不可恢复。** Linux 同时移除本安装的 service；删除 UFI 插件本身不会停止代理。

只在可信网络使用管理入口。UFI 接管 IPv4 共享流量，故障或停止期间可能直连，不提供断网保护。Linux 默认监听回环地址；私网地址绑定不等于防火墙隔离，转发、TPROXY、DNS 接管及故障策略仍需由用户配置。mihomoctl 不修改 Linux 防火墙和路由。

当前提供 UFI 插件和本地 CLI，没有独立 Web 服务。自动化测试不等于 F50 实机或真实代理流量验收。

## 从源码构建

根目录是 Go 模块；`ui/` 是可选的 UFI 前端。mise 统一固定 Go、Bun 和开发工具版本；Bun 同时负责包管理和前端工具运行，设备上的 mihomoctl 和 Mihomo 均为独立 Go 二进制。安装 [mise](https://mise.jdx.dev/) 后：

```sh
mise install
mise exec -- just build        # .build/mihomoctl，无需前端依赖
mise exec -- just ui           # ui/dist/mihomoctl-ufi.js
mise exec -- just check        # Go、前端、Shell 和 CI 检查
mise exec -- just browser-install
mise exec -- just test-ui      # 真实浏览器回归
```

运行 `mise exec -- just` 查看全部命令；启用 mise shell 集成后可直接使用 `just`。GoReleaser 负责三架构构建、校验和发布：`just snapshot` 本地预览，`just release` 从当前 Git 标签构建且不上传；推送 `v*` 标签触发发布 CI，已有资产不会覆盖。

前端使用 Vite + Tailwind 4，Bun 负责包管理和运行时。测试统一使用 Vitest：`node` 测试项目在 Bun 上验证源码与 Go CLI 集成；Browser Mode 使用 Playwright 驱动真实 Chromium，在同源 iframe 中验证生产插件加载、交互与刷新重连。失败截图和 trace 位于 `ui/test-results/`。

源码测试可用 `cd ui && bun run test:watch` 持续运行；完整验证仍使用上面的 `just check` 和 `just test-ui`。

SQLite 查询由 sqlc 生成，仍使用 `database/sql` + 纯 Go `modernc SQLite`。修改 SQL 后运行 `just generate` 并提交生成文件；`just check` 检查生成代码是否同步，正常 Go 构建无需 sqlc。
