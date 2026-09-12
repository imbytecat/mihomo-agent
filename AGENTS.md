# 开发约定

## 产品边界

- 面向中兴 F50 / UFI-TOOLS 完整版，用一个完整 mihomo YAML 订阅提供随身网关。保留用户的代理策略，只做必要网关适配。
- README 面向用户，只写安装、使用与必要提醒。开发约束维护在本文件；参数、依赖版本和目录细节以代码为准。
- 界面文案简短。镜像与接口失焦保存，订阅明确保存并应用；安装/卸载共用一个按设备状态切换的按钮。
- 使用现有库和平台能力；不添加旧插件兼容、旧核心复用或订阅转换。参考材料吸收为约束和测试后移除，不积累源码副本或调查流水账。

## 修改前定位

- 修改 UI、表单或任务恢复：先读 `src/use-gateway.ts`、`src/state.ts`、`src/ufi.ts`。浏览器只与 UFI 通信；下载、版本查询、YAML 处理和配置应用归 Go 后端。
- 修改设备任务或安装：先读 `backend/main.go`、`backend/internal/agent/jobs.go`、`operations.go` 与 `src/bootstrap.sh`。任务必须独立于浏览器存活；前端轮询只是观察，不负责串联设备执行步骤。
- 修改配置或网络：先读 `backend/internal/agent/config.go`、`runtime.go`、`network.sh`，以及对应 Go 测试和 `tests/plugin.test.ts`。shell 仅桥接 Android 网络命令，代理数据流归 mihomo。
- 修改 UFI 加载/通信协议时，核对下方官方接口来源，不根据其他插件的实现猜测。

## 必须保持的边界

- UFI 上传区公开可读，Root Shell 会记录命令/响应。订阅请求使用 libsodium sealed box，设备校验摘要后解密；明文订阅、配置和密钥不能进入公开上传文件、命令参数或响应日志。加密不替代 UFI 身份认证。
- 启动引导使用 UFI 自带 curl；安装后的 HTTP/TLS、SHA-256、解压和 YAML 处理使用 Go。保持 TLS 验证与 Android CA 支持，下载摘要缺失或不匹配时停止。
- `submit` 持有系统文件锁并把锁描述符交给独立 worker。保留任务状态用于重连和防重放；丢失提交响应后查询已知任务 ID，不盲目重交。
- UI 禁用条件只是提示，后端独立检查安装、运行和任务锁状态。保存完成或后台刷新不能覆盖更新的输入草稿。
- 原始订阅、运行配置、订阅链接同属一个配置版本；校验成功后原子切换。失败保留旧版，未完成的事务由 journal 恢复。保留已有节点、规则、DNS 上游等策略。
- 自动接管仅限识别到的共享入口，排除蜂窝及上游。启动核心前安装监听端口保护，等待 LAN 时仍保留保护；核心退出后才能撤掉保护。
- 网络资源只操作本插件拥有的链、路由和 mark；不清空系统防火墙或改全局默认路由。进程操作核对出生时间，避免 PID 复用。
- 卸载先停代理、清规则、关自启，成功后才备份运行目录。清理失败保留文件；管理程序、密钥、任务记录及卸载备份不随运行目录删除。
- 配置清理保留当前和最近两个其他版本；保留防重放记录，卸载备份不自动清理。

## 验证

前端与共享协议修改，在仓库根目录执行：

```sh
bun install --frozen-lockfile
bun run check
bun run build
bun test
```

后端修改，在 `backend/` 执行 `go test -race ./...` 与 `go vet ./...`。shell 修改额外执行：

```sh
shellcheck -x -s sh src/bootstrap.sh backend/internal/agent/network.sh
```

交互修改运行 `bun run test:ui`（需 agent-browser）；测试通过真实 DOMParser 加载生产 IIFE。开发预览 `bun run dev` 使用模拟 UFI；`tests/native.test.ts` 则把加密请求交给真实主机 Go 子进程。

网络测试使用 `tests/fake-net.sh`，不在开发机执行真实 Android 防火墙操作。自动化通过不等于 F50 验收；实机还要核对 DNS/TCP/UDP、热点/USB/蜂窝切换、自启、内核支持、策略路由与硬件卸载。只有实际验证过才能宣称实机可用。

文档调整只需核对内容、链接、引用和 diff；不因此改运行逻辑或重新发布二进制。

## 发布

- 版本和命令以 `mise.toml`、`package.json`、`tools/build-backend.ts` 与 `.github/workflows/` 为准。
- 发布使用官方 Go 工具链，可通过 `mise exec -- bun run build:release` 复现当前版本。Nix 的同版本 Go 会修改标准库路径，产生不同摘要；不能用于发行构建。
- 发布新版本时向 `build:release` 传入新的 semver。检查 `.release/` 产物并提交生成的 `backend-release.json`，随后推送匹配的 `agent-v*` 标签。不得覆盖已发布标签或资产。
- 后端版本与前端协议绑定；mihomo 核心仍按需查询最新稳定版，两者不要混淆。
- 交付发布版本前，确认 CI 测试及摘要一致性检查通过，再从公开地址下载并验证 SHA256SUMS。生产插件须保持单 JS，包含样式与加密资源，不产生额外 CDN/WASM 请求。

## UFI 接口来源

以 `http-server-version` 分支为依据：

- [API 文档](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/API_Doc.md)：Root Shell、认证与上传协议。
- [用户文档](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/User_Doc.md)：插件导入、停用和自启。
- [加载器](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/frontEnd/public/script/main.js)：DOMParser 与脚本包装。
- [请求实现](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/frontEnd/public/script/requests.js)：Root Shell 返回值；不能把 HTTP 成功当作命令成功。
- [上传实现](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/src/main/java/com/minikano/f50_sms/modules/theme/themeModule.kt)：公开 uploads 与返回的 UUID 文件名。
