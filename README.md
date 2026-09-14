# Mihomo Agent

独立的 Mihomo 管理器。UFI / Android 与 Linux 共用 CLI、内核下载更新、订阅、配置校验与回滚、任务和日志；二进制由 Agent 自行管理，无需通过包管理器安装 Mihomo。

- **UFI-TOOLS / Android**：提供插件界面，管理守护、自启及热点 / USB 共享。F50 是适用设备之一，不代表所有 UFI 硬件均已验证。
- **Linux**：CLI 自动安装和清理 systemd service、设置自启；网络规则由用户配置，详见 [Linux 使用说明](docs/linux.md)。

[下载](https://github.com/imbytecat/mihomo-agent/releases/latest) · [反馈](https://github.com/imbytecat/mihomo-agent/issues)

## UFI 安装

需要 UFI-TOOLS 完整版、root / 高级功能，以及支持 TPROXY 的系统。插件界面使用 Chrome / Android System WebView 111 或以上版本。

1. 已安装其他代理插件时，先在原界面卸载并关闭自启，再移除原插件。
2. 下载 `mihomo-agent-ufi.js`，在 UFI 插件管理导入、保存并刷新。
3. 安装 Mihomo Agent / 服务、Mihomo 内核，粘贴完整 YAML 订阅，点击「保存并更新」。
4. 启动代理，确认客户端能正常上网后再开启自启；需要控制面板时安装 Zashboard。

GitHub Proxy 留空直连，或填写 `https://ghfast.top` 这样的 HTTPS 前缀；失焦保存。订阅和面板设置需要明确保存并应用。订阅无需提供 API secret。

## Linux 安装

需要 root、systemd。下载对应架构的 `mihomo-agent-linux-amd64`、`mihomo-agent-linux-arm64` 或 `mihomo-agent-linux-armv7` 及 `SHA256SUMS`。以 AMD64 为例：

```sh
sha256sum --check --ignore-missing SHA256SUMS
chmod +x mihomo-agent-linux-amd64
sudo ./mihomo-agent-linux-amd64 install
```

安装自动复制 Agent 到 `/var/lib/mihomo-agent/agent` 并注册 service；接下来通过 CLI 下载内核、保存订阅并启动。后续使用安装目录内的 Agent，确保自更新生效，首次下载的安装文件可删除。同名 service 冲突时会拒绝覆盖，可用 `install --unit 自定义名称.service`。

## 两平台通用 CLI

在设备本地 **root 终端**执行，Linux 可先运行 `sudo -i`。Linux 使用以下路径；UFI 改为 `agent=/data/mihomo-agent/agent`：

```sh
agent=/var/lib/mihomo-agent/agent
"$agent" task download --wait
```

创建权限为 `0600` 的本地 `request.json`，填入完整 YAML 订阅链接。秘密通过文件或 `--input -` 的标准输入传递，勿粘贴到 UFI 会记录内容的 Root Shell 窗口。

```json
{"url":"https://example.com/your-subscription"}
```

```sh
"$agent" task update --input request.json --wait
"$agent" task start --wait
"$agent" task boot-on --wait
"$agent" inspect
```

| 操作 | 命令（接在 `"$agent"` 后） |
| --- | --- |
| 停止 / 重启 | `task stop --wait` / `task restart --wait` |
| 更新已保存的订阅 | `task update --wait` |
| 更新内核 / Agent（先停止代理） | `task download --wait` / `task update-agent --wait` |
| 关闭自启 | `task boot-off --wait` |
| 安装或更新 Zashboard | `task download-dashboard --wait` |
| 查看日志 / 网络诊断 | `logs` / `diagnose` |
| 卸载 Agent、内核及全部数据 | `task uninstall --wait` |

去掉 `--wait` 会立即返回任务 ID，用 `job ID`、`job-log ID` 查询。终端或页面关闭不会取消已接收任务；丢失响应后查询原 ID，不要重复提交。

## 数据与安全

设置、任务和配置版本元数据保存在私有 SQLite；YAML、日志和二进制单独存放。**卸载会停止代理、关闭自启并删除本安装的全部数据，不留备份，不可恢复。** Linux 同时移除本安装的 service；删除 UFI 插件本身不会停止代理。

只在可信网络使用管理入口。UFI 接管 IPv4 共享流量，故障或停止期间可能直连，不提供断网保护。Linux 默认监听回环地址；私网地址绑定不等于防火墙隔离，转发、TPROXY、DNS 接管及故障策略仍需由用户配置。Agent 不修改 Linux 防火墙和路由。

当前提供 UFI 插件和本地 CLI，没有独立 Web 服务。自动化测试不等于 F50 实机或真实代理流量验收。

## 从源码构建

根目录是 Go 模块；`ui/` 是可选的 UFI 前端。mise 固定 Go、Bun、Node 和开发工具版本；Node 用于 Vitest 测试，设备上的 Agent 和 Mihomo 均无需 JS 运行时。安装 [mise](https://mise.jdx.dev/) 后：

```sh
mise install
mise exec -- just build        # .build/mihomo-agent，无需前端依赖
mise exec -- just ui           # ui/dist/mihomo-agent-ufi.js
mise exec -- just check        # Go、前端、Shell 和 CI 检查
mise exec -- just browser-install
mise exec -- just test-ui      # 真实浏览器回归
```

运行 `mise exec -- just` 查看全部命令；启用 mise shell 集成后可直接使用 `just`。发布构建使用 `mise exec -- just release vX.Y.Z`。

前端使用 Vite + Tailwind 4，Bun 负责包管理和脚本。测试统一使用 Vitest：Node 项目验证源码与 Go CLI 集成；Browser Mode 使用 Playwright 驱动真实 Chromium，在同源 iframe 中验证生产插件加载、交互与刷新重连。失败截图和 trace 位于 `ui/test-results/`。

源码测试可用 `cd ui && bun run test:watch` 持续运行；完整验证仍使用上面的 `just check` 和 `just test-ui`。
