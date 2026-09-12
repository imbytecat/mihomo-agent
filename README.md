# UFI Mihomo

中兴 F50 / UFI-TOOLS 完整版的单订阅 TProxy 网关。React + TypeScript + Vite 构建单个插件 JS；Go 在设备上负责下载、配置与运行管理，不依赖 clashctl、Node 或 Bun。

## 使用

1. 停用其他透明代理及其自启。旧版 Shell 插件需先通过旧界面卸载，本版不迁移或复用旧文件。
2. UFI 开启高级功能，导入 `dist/ufi-mihomo.js`，提交保存并刷新。
3. 在「设置」按需填写下载镜像，然后点击「安装」。后端从本仓库 Release 下载，校验后安装。
4. 点击「下载核心」，设备查询并安装 mihomo 官方最新稳定版。
5. 粘贴完整 YAML 订阅，点击「保存并更新」，完成后启动代理。
6. 测试 Wi-Fi / USB 客户端的 DNS、TCP、UDP 后，再打开「开机自启」。

默认自动识别热点与 USB 共享接口，无需手填。特殊固件可在停止代理后手动设置接口。

镜像与接口失焦自动保存，失败显示重试；安装前可填写草稿。下载/启动使用点击时的设置，并由设备保存。订阅必须明确点击「保存并更新」；只有新配置校验、应用成功，才替换已保存的链接。输入框留空时更新原订阅。

设备接收任务后，关闭网页不会取消任务；重连可查看进度及结果。未确认提交或通信失败时，先刷新状态，不要连续重复提交。设备通过文件锁串行执行修改，界面状态只是提示，后端仍会独立校验。

更新插件后，停止代理，在更多菜单点击「更新设备组件」。后端版本随插件协议固定，mihomo 核心始终按需获取最新稳定版，不会在运行或开机时自动升级。

卸载会停止代理、清理本插件规则、关闭自启，并把运行目录移到 `/data/ufi-mihomo/backups/`。清理失败则中止，不移动文件。管理程序、设备密钥、任务记录和备份保留，方便查看结果；不再使用时另行在 UFI 移除界面。直接删除页面插件不会停止代理。

## 下载与错误

浏览器只访问 UFI。GitHub 版本查询、核心和订阅下载、SHA-256、解压及 YAML 处理均在 F50 完成。初次安装用 UFI 自带 curl 下载 Go 程序；之后 HTTP/TLS 由 Go 实现。设备仍需 Android 的 shell、ip、iptables/ip6tables 和基础命令，Go 不能替代内核 TProxy 能力。

镜像格式为 HTTPS 下载代理前缀，例如 `https://ghfast.top`，留空直连。假设前缀为 `https://download.example`，实际请求：

```text
https://download.example/https://github.com/MetaCubeX/mihomo/releases/download/<版本>/<文件>.gz
```

同一前缀用于本仓库后端 Release 和 mihomo 核心文件，不用于订阅，也不代理 GitHub API。代理必须支持该路径并原样返回文件；jsDelivr 的 /gh/ 不能直接分发 Release 二进制。没有内置公共镜像，不保证示例服务可用。

后端按同一次官方 API 响应选择版本、架构和 SHA-256，摘要缺失或不匹配即停止，不绕过校验。设备 TLS 始终验证证书，并加载 Android CA 目录；系统解析失败时尝试经过 TLS 校验的 DoH。DNS 回退不能解决 GitHub IP 被阻断或 API 限流。

顶部任务状态及通知提供详情，包含执行阶段、设备错误与任务 ID。浏览器的 `Failed to fetch` 只可能涉及管理连接/上传，不再表示浏览器正在下载核心。设备错误会明确标出主机或 HTTP 状态，返回日志前隐藏 URL 和常见密钥字段。

## 配置与网络边界

订阅须是完整 mihomo YAML，不转换节点列表或合并订阅。保留节点、策略组、规则、DNS 上游、Geo URL 和嗅探策略；仅适配网关字段：

| 字段 | 运行值 |
| --- | --- |
| tproxy-port | 7894 |
| allow-lan / bind-address | true / * |
| tun.enable | false |
| dns.enable / dns.listen | true / 0.0.0.0:1053 |
| ipv6 / dns.ipv6 | false / false |

拒绝固定出口 interface-name、非零 routing-mark、额外 listeners/tunnels 等绕过网关管理的配置。已有控制 API 要求设置 secret；不自动创建 API 或仪表盘。资源相对路径基于 `/data/ufi-mihomo/runtime/`。

设备下载订阅 → 解析 → mihomo -t 校验 → 切换配置目录。原始订阅、运行配置、订阅链接同属一个版本，原子切换；失败保留旧版，未完成的切换在下一次操作/启动时恢复。运行中更新会重启代理，provider 的周期更新由 mihomo 管理。

自动入口识别结合常见 F50 LAN 名称、私有 IPv4 和所有路由表的出口，排除蜂窝、VPN 与上游 Wi-Fi。每 5 秒检查共享网络，接口消失时撤规则并等待。未知命名可手动覆盖，不会扩大接管到所有接口。

仅接管 LAN 的 IPv4 TCP/UDP 和 DNS，不接管 F50 自身流量。使用独立链、路由表 2026、优先级 9000、mark 位 0x40000000；不清空系统规则或改默认路由。同名资源已存在时拒绝首次接管。指定 LAN 的 IPv6 转发被拒绝，客户端回落 IPv4。

设备守护进程管理 mihomo，并调用小型 shell 桥接 Android 网络命令。监听检查关联核心 socket inode，进程记录包含 Linux 启动时间以防 PID 复用。规则使用 A/B 链切换；多个表之间不构成内核原子事务。停止/故障恢复期间系统可能直连，**不是断网保护模式**。

尚无 F50 实机验收。内核模块、Android 策略路由、rp_filter、硬件卸载与 Wi-Fi/USB/蜂窝切换仍需上机测试；界面“运行中”不等于外网代理链路已测通。

## 安全与目录

UFI 的上传区及 Root Shell 日志不是私密通道。浏览器用 libsodium sealed box 加密操作请求，Go 校验摘要并解密；订阅明文不会进入命令参数或公开上传文件。密钥和配置保存在设备私有目录，读取状态不回传订阅链接。

这不是 UFI 的身份认证替代品：公钥加密不验证发件人，Root Shell 仍依赖 UFI 登录授权。仅在可信局域网使用 UFI，不向公网暴露管理端口；管理页面被篡改时不保证安全。

```text
/data/ufi-mihomo/
  agent, identity.json, control.lock
  tasks/<id>/{request.bin,state.json,log.txt}
  runtime/{mihomo,settings.json,network.sh,current}
  runtime/configurations/<id>/{source.yaml,config.yaml,source.json,ports}
  backups/runtime-<时间>-<id>/
/data/ufi-mihomo-bootstrap/jobs/<id>/
/sdcard/ufi_tools_boot.sh
```

停止/禁用自启优先使用界面。设备 Root Shell 紧急停止守护进程可发送 TERM 给经过核对的 supervisor PID；不要直接删除文件或清空系统防火墙。

## 开发与验证

```sh
bun install --frozen-lockfile
bun run dev
bun run check
bun run build
bun test
bun run test:ui
cd backend
go test -race ./...
go vet ./...
```

UI 测试需安装 agent-browser。开发预览使用模拟 UFI，不执行主机网络命令。支持 ?state=missing-core、missing-config、ready、running；模拟任务按完成时间持久化，刷新可观察结果。

Vite 库模式输出一个 IIFE JS，React、样式、图标、加密库随插件打包，不额外下载 CDN/WASM 文件。Bun 仅用于开发；设备端不运行前端工具链。Go 管理任务进程按需退出，只有代理启用时存在守护进程，不新增 HTTP 服务。

测试覆盖前端→Go 加密互通、真实子进程任务、配置保存/失败回退、锁交接、网络规则回滚、接口识别、监听归属、输入校验和实际产物的 UI 操作。模拟内核与主机测试不替代 F50 实测。

## UFI 依据

核对 http-server-version 分支：

- [API 文档](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/API_Doc.md)
- [用户文档](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/User_Doc.md)
- [插件加载器](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/frontEnd/public/script/main.js)
- [Root Shell](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/frontEnd/public/script/requests.js)
- [上传实现](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/src/main/java/com/minikano/f50_sms/modules/theme/themeModule.kt)

## 原插件 clashctl 来源调查

对用户提供的 ZIP 仅静态读取，未执行二进制：

- ARM64 / ARMv7 均为 Go 1.25.5 编译的 Linux ELF，模块 `clashgo`，入口 `clashgo/cmd/clashctl`，依赖 mihomo `v1.19.29`。
- 构建提交 `6fd320c8186b78c10d97a01531eb5af3bf2dbcb8`，时间 `2026-07-26T12:02:51Z`，`vcs.modified=true`，意味着构建包含未提交修改。
- 普通符号表已剥离，Go 运行时仍保留 `installTProxy`、`localIPv4`、`configure`、`superviseCore` 等函数名，以及 `internal/app/firewall.go`、`network.go`、`supervisor.go` 等路径。函数名不能单独证明具体接口识别算法。
- 未在公开 GitHub 检索中定位到对应提交。`nelvko/clash-for-linux-install` 的 clashctl 是 Shell 实现；同名 `liuguangzhong/clashgo` 的目录和依赖也不匹配。grep.app 查询受到限流。
- 结论为「尚未定位到对应公开源码」，不是「已证明闭源」。引用 mihomo 开源依赖不等于整个 clashctl 的源码已公开。
