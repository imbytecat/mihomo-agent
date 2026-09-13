# Mihomo Agent

独立的 Mihomo 管理器，共用订阅、配置校验、回滚和设备任务。

- **UFI-TOOLS / Android**：通过插件管理内核、自启和热点 / USB 共享。F50 是适用设备之一，不代表所有 UFI 硬件均已验证。
- **Linux / systemd**：通过 CLI 管理已有系统部署。软件包、自启和网络规则由系统负责，见 [Linux 使用说明](docs/linux.md)。

[下载](https://github.com/imbytecat/mihomo-agent/releases/latest) · [反馈](https://github.com/imbytecat/mihomo-agent/issues)

## UFI 安装

需要 UFI-TOOLS 完整版、root / 高级功能，以及支持 TPROXY 的系统。

1. 已使用其他代理插件时，先卸载并关闭其自启。
2. 下载 `mihomo-agent-ufi.js`，在 UFI 插件管理导入、保存并刷新。
3. 安装 Mihomo Agent / 服务、Mihomo 内核，粘贴完整 YAML 订阅，点击「保存并更新」。
4. 启动代理，确认客户端能正常上网后再开启自启；需要控制面板时安装 Zashboard。

GitHub Proxy 留空直连，或填写 `https://ghfast.top` 这样的 HTTPS 前缀；失焦保存。订阅和面板设置需要明确保存并应用。订阅无需提供 API secret。

页面关闭不会取消已接收的任务。失败时查看详情；丢失响应后先刷新，不要连续提交。

## 数据与安全

设置、任务和配置版本元数据保存在私有 SQLite；YAML、运行记录、日志和二进制单独存放。**卸载删除本安装的全部设备数据，不留备份，不可恢复。** 删除 UFI 插件本身不会停止代理。

只在可信网络使用管理入口。UFI 接管 IPv4 共享流量，故障或停止期间可能直连，不提供断网保护。Linux 的私网地址绑定不等于防火墙隔离，转发、DNS 接管及故障策略仍需由系统配置。

当前提供 UFI 插件和本地 CLI，没有独立 Web 服务。自动化测试不等于 F50 实机或真实代理流量验收。

## 从源码构建

根目录是 Go 模块；`ui/` 是可选的 UFI 前端。安装 [mise](https://mise.jdx.dev/) 后：

```sh
mise install
mise exec -- make build        # .build/mihomo-agent，无需前端依赖
cd ui && bun install && bun run build  # dist/mihomo-agent-ufi.js
```
