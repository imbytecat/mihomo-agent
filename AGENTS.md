# 开发约定

## 产品边界

- 面向中兴 F50 / UFI-TOOLS 完整版，用一个完整 mihomo YAML 订阅提供随身网关。保留用户的代理策略，只做必要网关适配。
- README 面向用户，只写安装、使用与必要提醒。开发约束维护在本文件；参数、依赖版本和目录细节以代码为准。
- 界面文案简短。GitHub Proxy 与接口失焦保存，订阅明确保存并应用。程序行统一使用「安装 / 更新」；Mihomo 服务使用「安装 / 卸载」。
- 库优先：通用能力先查已安装依赖及成熟第三方库，适用就直接采用，不另写简化框架。标准库已完整覆盖的加密、JSON、URL、文件与网络原语直接复用；自写代码只保留业务规则与必要适配，并说明不能交给库的原因。
- 不添加旧插件兼容、旧核心复用或订阅转换。参考材料吸收为约束和测试后移除，不积累源码副本或调查流水账。

## 修改前定位

统一术语：Mihomo Agent 是设备端管理程序；Mihomo 内核负责代理流量；Zashboard 是控制面板；Mihomo 服务是安装与运行整体，没有独立版本；GitHub Proxy 是下载代理，不是镜像。CLI 仅指调用方式，不能代替程序名。

- 修改 UI：入口 `src/index.tsx` 只负责挂载；`src/App.tsx` 组合 `src/components/` 的功能分区。组件样式写 Tailwind className，CSS 只留宿主隔离与主题变量；弹窗和菜单挂到独立的作用域 portal，避免宿主裁切。
- 修改表单或任务恢复：先读 `src/use-gateway.ts`、`src/state.ts`、`src/ufi.ts`。浏览器只与 UFI 通信；下载、版本查询、YAML 处理和配置应用归 Mihomo Agent。
- 修改设备任务或安装：先读 `agent/main.go`、`agent/internal/app/jobs.go`、`operations.go` 与 `src/bootstrap.sh`。任务必须独立于浏览器存活；前端轮询只是观察，不负责串联设备执行步骤。
- 修改配置或网络：先读 `agent/internal/app/config.go`、`runtime.go`、`network.sh`，以及对应 Go 测试和 `tests/plugin.test.ts`。shell 仅桥接 Android 网络命令，代理数据流归 mihomo。
- 修改控制面板：先读 `agent/internal/app/controller.go`、`dashboard.go`。本机管理设置覆盖订阅中的控制 API/UI 字段；配置版本同时保存有效密钥和端口，保持失败回滚的一致性。密钥查看使用浏览器临时公钥加密响应；Dashboard 链接不携带密钥。
- 修改 UFI 加载/通信协议时，核对下方官方接口来源，不根据其他插件的实现猜测。

## 库与适配边界

- CLI 的子命令、参数数量、选项、帮助和补全交给 Cobra；参数校验先于设备访问。机器命令继续输出 JSON，错误不能混入 usage 文本。加密任务 action 分发是设备业务，不是另一套 CLI。
- 原子文件和符号链接替换交给 renameio。暂存文件须在目标目录且初始权限私有；权限设置失败仅对 Android 公共自启文件容忍 EPERM/EOPNOTSUPP。不要使用默认保留旧权限的便捷写入覆盖密钥文件。
- 进程 stat 解析交给 procfs，PID 与出生时间匹配仍是本插件的所有权规则。跨进程锁必须继承同一个文件描述符；不能换成在提交进程退出时主动解锁的包装库。
- 浏览器 HTTP 交给 ky，shell 参数转义交给 shell-quote，上传响应校验交给 Zod，串行操作交给 p-queue。ky 关闭自动重试，丢失响应后只能观察原任务，不能重发上传或任务提交。
- DoH 使用 net/http 与 x/net/dnsmessage；固定引导 IP、Android CA、取消、HTTPS 重定向限制和响应大小上限属于必需适配。替代客户端必须全部满足这些约束。压缩包使用 archive/zip、compress/gzip，路径、类型和解压限额检查保留在调用处。

## 必须保持的边界

- UFI 上传区公开可读，Root Shell 会记录命令/响应。订阅请求使用 libsodium sealed box，设备校验摘要后解密；明文订阅、配置和密钥不能进入公开上传文件、命令参数或响应日志。加密不替代 UFI 身份认证。
- 启动引导使用 UFI 自带 curl；安装后的 HTTP/TLS、SHA-256、解压和 YAML 处理使用 Go。保持 TLS 验证与 Android CA 支持，下载摘要缺失或不匹配时停止。
- `submit` 持有系统文件锁并把锁描述符交给独立 worker。保留任务状态用于重连和防重放；丢失提交响应后查询已知任务 ID，不盲目重交。
- UI 禁用条件只是提示，后端独立检查安装、运行和任务锁状态。保存完成或后台刷新不能覆盖更新的输入草稿。
- 概览中的运行状态与设备任务状态分开；任务详情和运行日志对应各自内容。开机启动属于运行设置；API 参数明确保存并应用，保持原有普通偏好的失焦保存。
- 原始订阅、运行配置、订阅链接同属一个配置版本；校验成功后原子切换。失败保留旧版，未完成的事务由 journal 恢复。保留已有节点、规则、DNS 上游等策略。
- 自动接管仅限识别到的共享入口，排除蜂窝及上游。启动核心前安装监听端口保护，等待 LAN 时仍保留保护；核心退出后才能撤掉保护。
- 网络资源只操作本插件拥有的链、路由和 mark；不清空系统防火墙或改全局默认路由。进程操作核对出生时间，避免 PID 复用。
- 卸载先停代理、清规则、关自启，再删除整个安装目录和引导临时目录，包括 Agent、密钥、任务记录及旧备份。清理失败报错；成功后不得为写任务结果重新创建目录。前端以两个目录确实消失确认卸载完成。
- 运行期间保留配置回滚版本和防重放记录；完整卸载时一并删除。不要增加自动卸载备份或旧命名别名。

## 验证

前端与共享协议修改，在仓库根目录执行：

```sh
bun install --frozen-lockfile
bun run check
bun run build
bun test
```

Agent 修改，在 `agent/` 执行 `go test -race ./...` 与 `go vet ./...`。shell 修改额外执行：

```sh
shellcheck -x -s sh src/bootstrap.sh agent/internal/app/network.sh
```

交互修改运行 `bun run test:ui`（需 agent-browser）；测试通过真实 DOMParser 加载生产 IIFE。开发预览 `bun run dev` 使用模拟 UFI；`tests/native.test.ts` 则把加密请求交给真实主机 Go 子进程。

网络测试使用 `tests/fake-net.sh`，不在开发机执行真实 Android 防火墙操作。自动化通过不等于 F50 验收；实机还要核对 DNS/TCP/UDP、热点/USB/蜂窝切换、自启、内核支持、策略路由与硬件卸载。只有实际验证过才能宣称实机可用。

文档调整只需核对内容、链接、引用和 diff；不因此改运行逻辑或重新发布二进制。

## 发布

- 版本和命令以 `mise.toml`、`package.json`、`tools/build-agent.ts` 与 `.github/workflows/` 为准。
- 发布使用官方 Go 工具链，可通过 `mise exec -- bun run build:release` 复现当前版本。Nix 的同版本 Go 会修改标准库路径，产生不同摘要；不能用于发行构建。
- 发布新版本时向 `build:release` 传入新的 semver。检查 `.release/` 产物并提交生成的 `agent-bootstrap.json`，随后推送匹配的 `agent-v*` 标签。不得覆盖已发布标签或资产。
- `agent-bootstrap.json` 是初次安装的信任锚，不用于运行时更新比较。GitHub API 使用 go-github，版本比较使用 semver，Agent 原子替换使用 go-selfupdate/update；保持 Android CA、DNS 回退、摘要校验及协议检查。代理给出的二进制不能仅凭同一代理提供的哈希被信任。
- 交付发布版本前，确认 CI 测试及摘要一致性检查通过，再从公开地址下载并验证 SHA256SUMS。生产插件须保持单 JS，包含样式与加密资源，不产生额外 CDN/WASM 请求。

## UFI 接口来源

以 `http-server-version` 分支为依据：

- [API 文档](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/API_Doc.md)：Root Shell、认证与上传协议。
- [用户文档](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/User_Doc.md)：插件导入、停用和自启。
- [加载器](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/frontEnd/public/script/main.js)：DOMParser 与脚本包装。
- [请求实现](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/frontEnd/public/script/requests.js)：Root Shell 返回值；不能把 HTTP 成功当作命令成功。
- [上传实现](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/src/main/java/com/minikano/f50_sms/modules/theme/themeModule.kt)：公开 uploads 与返回的 UUID 文件名。
