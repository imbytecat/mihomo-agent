# UFI Mihomo

中兴 F50 / UFI-TOOLS 完整版的单订阅代理网关插件。Bun + React + TypeScript 开发，Vite 库模式生成一个可导入的 JS；设备运行 mihomo 与 Android Shell，不需要 Bun/Node。

## 使用

```sh
bun install --frozen-lockfile
bun run dev
```

开发预览为 `http://127.0.0.1:5173/`，支持 React 热更新。它使用模拟 UFI 接口，不执行设备命令。可用 `?state=missing-core`、`missing-config`、`ready`、`running`、`locked` 切换初始状态；默认未安装服务。

```sh
bun run check
bun run build
bun test
```

1. 停用其他透明代理服务与自启，避免网络规则冲突。
2. UFI 开启高级功能，在插件管理导入 `dist/ufi-mihomo.js`，提交保存并刷新页面。
3. 展开 Mihomo，按「继续设置」引导，在「设置」的服务行点击「安装」。同一个按钮在安装后变为「卸载」；核心是否已下载单独显示，不用核心缺失推断服务未安装。
4. 按需填写下载镜像，点击「下载核心」：查询 MetaCubeX/mihomo 最新稳定版，按设备 ABI 下载 Android ARM64/ARMv7 核心，验证该版本 SHA-256 后解压、检查版本再安装。版本查询完成并启动后台下载后，关闭网页不会中断安装；失败保留原核心。目前仅支持这两种设备架构。
5. 默认自动识别热点 / USB 共享入口，无需找接口名。已有的手动接口会保留；想切回自动，在「设置」清空共享接口并离开输入框，自动保存。
6. 填写返回完整 mihomo YAML 的订阅链接，点击「保存并更新」→「启动代理」。该动作先保存当前链接，再下载、校验并应用配置。已有订阅时输入框留空，点击「更新订阅」使用已保存链接；没有独立的保存订阅按钮。服务运行中更新会重启，停止状态更新只保存配置。
7. 实测 Wi-Fi / USB 客户端 DNS、TCP、UDP 正常后，在主面板打开「开机自启」开关。开关直接显示开启/关闭状态；缺少核心或配置时不能开启。关闭网页不影响运行。

更新插件 JS 后，停止代理，再到右上角「更多操作」点「更新服务文件」，完成后需手动启动。服务更新与安装/卸载是独立动作。前端与服务脚本需使用同一版本；不提供旧版协议兼容、旧核心复用、ZIP 导入或第三方插件迁移。

界面按服务、核心、配置、订阅、进程、自启和设备锁状态控制操作。缺核心时禁用启动、重启、订阅更新和开启自启；缺配置时引导更新订阅。运行时可保存订阅链接和下载镜像，但替换核心、修改共享接口前需停止服务。操作失败后重新读取状态，不会将所有按钮一律启用。状态未知时只保留刷新和诊断，每次修改操作前也会重新检查状态。

安装/卸载按钮在检测中或失败时显示「检测中 / 状态未知」并禁用，不将异常当作未安装。仅安装目录不存在时判定未安装；目录存在但脚本缺失、目录为符号链接、状态查询失败时暂停修改操作。点击安装前再次查询，若服务已被其他操作安装则中止，不隐式改做更新或卸载。

「卸载服务」需确认：停止服务、清理本插件规则并关闭自启后，把 `/data/ufi-mihomo/` 移到 `/data/ufi-mihomo.uninstalled-<时间>-<PID>`，保留核心、配置、订阅和日志备份。停止或清理失败就中止，文件不移除。备份可手动移回原目录恢复；不再需要时自行清理备份目录。卸载不会删除旧猫猫的数据，也不会自动删除 UFI 中保存的插件界面；如不再使用，请在 UFI 插件管理中移除界面。直接停用/删除页面插件不会停止后台代理。

## 官方来源与国内下载

默认不依赖他人插件包、下载网盘或 clashctl。每次点击安装时，由管理浏览器查询 [MetaCubeX/mihomo 最新稳定版 API](https://api.github.com/repos/MetaCubeX/mihomo/releases/latest)，从同一次响应获取版本、对应架构资产及 SHA-256 `digest`，然后交给设备后台下载。不会在开机或运行中自动升级；无需修改源码跟进版本。查询失败、缺少资产或摘要则停止，保留原核心。

管理浏览器需能访问 `api.github.com`；核心下载镜像只代理设备的 Release 文件下载，不代理版本查询。API 限流或不可达时会明确报错，不静默退回旧版本或跳过校验。

GitHub 直连困难时，可填写自己管理的 Cloudflare Worker 或可信下载代理前缀。假设前缀为 `https://download.example/`，实际请求为：

镜像地址可在安装服务前填写为草稿。服务安装后，离开输入框或按 Enter 自动保存；字段显示保存中、已保存或失败重试。没有延迟写入或单独的保存按钮。下载核心会等待已排队的保存，并再次读取点击时的字段快照，确保保存成功后才使用它下载。下载失败不会撤销已保存的镜像；保存失败则保留草稿。再次打开页面会从设备读取。

自动保存时仍可继续输入，较早请求完成不会覆盖新输入。操作和自动保存通过 PQueue 串行执行，避免失焦保存导致紧随其后的按钮点击被吞掉。离开有未保存草稿或待完成保存的页面时使用浏览器原生提醒。共享接口同样失焦保存，但运行期间不可修改；「启动代理」也会确保当前接口设置已保存。

例如 `https://ghfast.top` 是支持的前缀格式，末尾 `/` 可省略；此示例不保证第三方服务的实时可用性。不能把完整 GitHub 文件链接当作镜像前缀，直连 GitHub 应留空。

```text
https://download.example/https://github.com/MetaCubeX/mihomo/releases/download/<版本>/mihomo-android-arm64-v8-<版本>.gz
```

这是明确的 URL 前缀协议，并非任意 Cloudflare 地址都能使用。代理必须支持该路径且原样返回 Release 文件；无论是否经过镜像，都必须通过同一 SHA-256 校验。没有默认添加第三方公共代理，也没有自动部署 Worker。下载镜像不会用于订阅。

jsDelivr 的 `/gh/` 分发 Git 仓库文件，不能直接代理 GitHub Release 核心二进制。Geo 数据则可在你自己的订阅生成端按需配置；插件不会覆盖已有 `geox-url`：

```yaml
geox-url:
  geoip: https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat
  geosite: https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat
  mmdb: https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country.mmdb
  asn: https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/GeoLite2-ASN.mmdb
```

这些 Geo 链接跟随上游 `release` 分支，不使用核心安装时的 Release 摘要校验；具体网络可达性需在 F50 验证。不使用 Geo 规则就不需要这些数据。

核心只从官方 Release 下载，可选择下载镜像；没有手动导入或旧插件复用入口。订阅与规则全部由你自己的完整 YAML 提供。

## 配置边界

保存原始订阅 `subscription.yaml`，实际运行 `config.yaml`；上一次配置保存为 `config.previous.yaml`。保留节点、策略组、规则、DNS 上游和嗅探策略，仅适配以下字段：

| 字段 | 运行值 |
| --- | --- |
| `tproxy-port` | `7894` |
| `allow-lan` / `bind-address` | `true` / `*` |
| `tun.enable` | `false` |
| `dns.enable` / `dns.listen` | `true` / `0.0.0.0:1053` |
| `ipv6` / `dns.ipv6` | `false` / `false` |

不支持节点列表、Base64 节点订阅或多订阅转换。拒绝固定出口 `interface-name`、非零 `routing-mark`、额外 `listeners/tunnels`，避免绕过本插件网络管理。控制 API 如已启用，要求订阅设置 `secret`；不会自动创建 API 或安装仪表盘。订阅中资源路径应相对 `/data/ufi-mihomo/`，不再沿用旧插件的 `WebUI/` 路径。

更新流程：设备 curl 下载 → 浏览器解析并做上述适配 → 本机 mihomo `-t` 校验 → 原子替换。相同配置不重启，校验失败保留旧配置，运行中更新后启动失败则恢复上一版。核心、provider 或 Geo 数据下载仍受 F50 的联网情况影响。整个订阅首版只手动更新；YAML 中 provider 自带的更新间隔继续由 mihomo 管理。

## F50 网络与恢复

自动模式结合启用接口的私有 IPv4 地址、常见 F50 Wi-Fi/USB/网桥名称与所有路由表中的 IPv4/IPv6 默认出口识别入口，排除蜂窝、VPN 与已知上游 Wi-Fi。每 10 秒重新检测；热点/USB 消失时撤销规则并保持核心等待，重新出现后恢复接管，不因没有热点而反复重启核心。

这是针对 F50 常见命名的识别策略，不是通用 Android tethering API。未知固件命名、特殊网段、没有默认路由的 Wi-Fi 上游等情况仍需实机核对；识别不出时显示等待，不扩大到所有接口。「高级设置」保留手动覆盖与网络诊断。

只接管指定 LAN 入口的 IPv4 TCP/UDP，以及 TCP/UDP 53 DNS；回避本机和保留地址。不接管 F50 自身发起的请求。通过独立 iptables 链、路由表 `2026`、优先级 `9000`、mark 位 `0x40000000` 实现 TProxy；不清空系统防火墙、不改 Android 默认路由。已存在同名链或目标路由表/优先级会拒绝首次接管。

指定 LAN 的 IPv6 转发会被拒绝，使客户端回落 IPv4，不改蜂窝接口 IPv6。核心退出后撤掉接管规则，以 2–60 秒退避重启；运行中每 10 秒检查接管入口和策略路由是否仍在，丢失则尝试重建。恢复期间及停止后由原系统网络直连，不是断网保护模式；客户端缓存的 fake-IP 可能需要重新解析。

接管前检查 DNS 1053、TProxy 7894 的 TCP/UDP 监听，并通过核心文件描述符关联 socket inode，避免把其他进程占用端口当作就绪。启动要求同一核心连续 5 秒监听正常；有共享入口时还要求接管规则存在。PID 操作核对核心可执行路径和守护进程命令，避免误杀复用 PID 的其他程序。

规则更新先构建未使用的 A/B 链，再切换四个入口链的跳转；任一步失败会切回旧入口。每个跳转替换是原子的，但 IPv4/IPv6 和多个表之间不是一个内核原子事务。旧入口消失或成为上游时先撤掉旧接管；启动失败或无旧规则可恢复时清理本插件规则。只保留本插件的活动状态与切换标记，不快照/覆盖整个系统防火墙。

界面区分缺核心/配置、核心退出、监听未就绪、等待共享网络、规则未就绪及本地运行就绪。未检测控制 API 与外网可用性，不把本地就绪描述成完整链路健康。查看日志时先在设备侧隐藏 HTTP(S) 地址及常见密钥字段，再返回 UFI，避免敏感内容进入 UFI Root Shell 的响应日志；原始设备日志仍应视为私密文件。

核心日志约 1 MiB、服务日志约 256 KiB 时清空，仅保留短窗口。进程与规则就绪检查不等于实际代理链路健康。尚未验证 F50 实机内核能力、Android 策略路由冲突、rp_filter 及共享流量硬件卸载；热点/USB/蜂窝切换需要实测，不能仅凭「运行中」认定网关可用。没有自动改全局硬件卸载或系统网络参数。

恢复命令（UFI Root Shell / ADB root）：

```sh
sh /data/ufi-mihomo/service.sh boot-off
sh /data/ufi-mihomo/service.sh stop
```

仅支持一个管理页面同时操作；不要从多个浏览器同时安装或更新。设备侧启停/应用操作有进程锁，浏览器上传与下载的整个多步过程不是跨浏览器事务。

## UFI 接口依据

核对日期：2026-09-12，`http-server-version` 分支。

- [官方 API 文档](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/API_Doc.md)：Root Shell 最长 100 秒、multipart 上传、公开 uploads 路径、认证方式。
- [官方用户文档 §13](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/User_Doc.md)：JS/HTML 文本插件导入、提交保存、停用语义。
- [前端加载器](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/frontEnd/public/script/main.js)：DOMParser 提取 script，产物使用 IIFE 和参考插件的 script 包装，防止重复挂载。
- [Root Shell 前端](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/frontEnd/public/script/requests.js) 与 [后端](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/src/main/java/com/minikano/f50_sms/modules/advanced/advancedToolsModule.kt)：以源码的字符串 `result` 为准，包装子 Shell、显式返回退出码；不把 HTTP 成功当作命令成功。
- [上传实现](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/src/main/java/com/minikano/f50_sms/modules/theme/themeModule.kt)：返回 `/uploads/<UUID>.<ext>`，导入后转移到权限为 0700 的私有目录并清理上传副本。
- 本地 `ref/猫猫_TProxy_1.3.js` 提供 UI 接口、核心位置、自启入口参考；用户提供 ZIP 中的 `Clash.Service` 只是 `clashctl` Go 二进制的兼容入口，其内部网络行为未当作已验证源码复用。

插件内容和 uploads 在 UFI 中公开可读，因此不把订阅或 secret 编译进插件、不输出完整 YAML 到 Root Shell 日志。配置传输仍使用 UFI 的公开上传通道和随机临时文件，正常完成后立即删除；浏览器中断可能留下副本。应仅在可信局域网使用 UFI，不将管理端口暴露公网。

## 验证

`bun run check`、`bun run build`、`bun test`；Shell 静态检查：`shellcheck -x -s sh scripts/service.sh scripts/network.sh`。测试覆盖配置保留、命令注入边界、配置和规则切换回滚、路由冲突、监听 socket 归属、PID 复用、日志脱敏、自动接口识别、核心摘要拒绝、按钮权限、卸载备份与产物包装。

`bun tests/preview.ts` 在 `127.0.0.1:3007` 启动模拟 UFI 页面，用真实 DOMParser 加载构建产物，所有设备命令均为模拟，不执行本机 Shell。可用于浏览器检查导入、设置与更新流程，不能替代 F50 联网验收。

安装 `agent-browser` 后，可运行 `bun run test:ui` 自动验证生产产物：失焦后立即下载、保存期间继续编辑、失败重试、首次安装、订阅保存并应用、自启、更多菜单和卸载确认。使用独立浏览器会话和临时本地端口，不访问 F50。

## 界面与运行层

使用 React 管理设备状态，React Hook Form 管输入与校验，PQueue 管串行操作，Radix Dropdown Menu 管更多菜单，Lucide React 提供按需导入的图标，Tailwind CSS 3 构建手机卡片布局。关闭 preflight，卡片样式限定在 `#ufi-mihomo`；弹层单独限定选择器。日常只展示状态与启停、订阅和自启，安装、镜像与接口放在「设置」，日志、诊断和维护放在更多菜单。

镜像和共享接口失焦保存，订阅明确保存并应用。自动保存成功仅更新字段状态，失败提供重试；显式操作由 Sonner 在顶部反馈。面板展开且页面可见时每 15 秒刷新状态，已有操作时跳过；后台刷新不弹成功通知。日志/诊断在原生对话框打开，其他操作错误可点通知中的「详情」查看。所有组件随插件打包，无额外 CDN 请求。

Vite 用于 React 开发热更新与生产打包；生产为 IIFE，React、图标、CSS 和设备 Shell 脚本全部嵌入 `dist/ufi-mihomo.js`，不会依赖额外 JS/CSS 文件或 CDN。开发模拟器不会进入生产插件。最终仍通过 UFI 的 `<script>` 包装加载，不能把普通 Vite SPA 的 `index.html` 直接当作插件上传。

设备侧的启停、下载、保活和网络规则由 Shell 实现，不依赖 clashctl。Go 更适合复杂状态管理、多固件适配和网络事件监听；目前单设备需求沿用 Shell。两者均只管理核心，不承担代理数据流，改用 Go 本身不会提升 mihomo 吞吐。TUN 的 `auto-detect-interface` 主要识别出口，不等于替插件判断 TProxy 应接管哪些共享入口；TProxy 与 TUN 的实际性能需在设备上测量。

## 原插件 clashctl 来源调查

对用户提供的 ZIP 仅静态读取，未执行二进制：

- ARM64 / ARMv7 均为 Go 1.25.5 编译的 Linux ELF，模块 `clashgo`，入口 `clashgo/cmd/clashctl`，依赖 mihomo `v1.19.29`。
- 构建提交 `6fd320c8186b78c10d97a01531eb5af3bf2dbcb8`，时间 `2026-07-26T12:02:51Z`，`vcs.modified=true`，意味着构建包含未提交修改。
- 普通符号表已剥离，Go 运行时仍保留 `installTProxy`、`localIPv4`、`configure`、`superviseCore` 等函数名，以及 `internal/app/firewall.go`、`network.go`、`supervisor.go` 等路径。函数名不能单独证明具体接口识别算法。
- 未在公开 GitHub 检索中定位到对应提交。`nelvko/clash-for-linux-install` 的 clashctl 是 Shell 实现；同名 `liuguangzhong/clashgo` 的目录和依赖也不匹配。grep.app 查询受到限流。
- 结论为「尚未定位到对应公开源码」，不是「已证明闭源」。引用 mihomo 开源依赖不等于整个 clashctl 的源码已公开。
