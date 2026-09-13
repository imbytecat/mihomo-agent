# 开发约定

## 定位与范围

- 产品是独立 Mihomo 管理器。UFI-TOOLS / Android 和 Linux / systemd 是两个平台；F50 只是设备实例。代理数据流始终由 Mihomo 处理。
- 库优先：通用能力先查现有依赖和成熟库；适用就采用。自写代码限于业务规则、所有权检查和必要平台适配。不要另写简化框架或兼容旧协议。
- README 面向用户并保持简短；Linux 操作说明在 docs/linux.md。开发决策维护于本文件，不保留 ref 源码或研究流水账。
- 本仓修改不授权操作用户现有 NixOS 网关。独立 Web、任意操作系统、自动 Linux 防火墙部署不在当前范围。

## 修改前定位

- 设备入口：agent/cmd/mihomo-agent 只处理进程入口，agent/internal/cli 用 Cobra 装配平台、CLI 和 UFI 上传 Adapter。机器响应是 JSON；错误不得混入 usage。
- 共享 Module：agent/internal/manager 管请求校验、持久任务、订阅、下载校验、配置事务与回滚。CLI 与解密后的 UFI 请求都调用 Submit；不能依赖浏览器串联关键步骤。
- 平台 Module：agent/internal/platform 管 UFI 守护 / 网络桥接及 systemd 运行时。Adapter 配置由数据库持久化，worker、boot、supervise 都重新读取；已有安装不能通过环境或旗标换平台。
- 存储 Module：agent/internal/storage 使用 database/sql + modernc SQLite，拥有类型化状态表；YAML、日志和运行文件留在文件系统。fsutil、host、download、redact 是共享基础实现。
- 前端：ui/src/transport/ufi 只处理 UFI 通信和引导；gateway.ts 处理任务观察与展示；use-gateway.ts 管草稿和交互；components/ 管视图。CSS 仅留主题与宿主隔离，其余用 Tailwind className。
- 修改加载协议时核对下方 UFI 官方来源；没有文档保证的行为不能从其他插件推断。

## 必须保持的约束

- UFI uploads 公开可读，Root Shell 会记录命令和响应。请求使用 libsodium sealed box；上传先校验文件类型、大小和摘要，再交给 Manager。明文订阅、配置、密钥不能进入公开文件、命令参数或响应日志。
- 本地 CLI 的秘密通过 JSON 文件 / stdin 传入，不通过 argv。结构化 params 拒绝未知字段与不适用参数；不保留旧 value 字段或嵌套 JSON。
- 密钥读取仍通过浏览器临时公钥加密响应。Dashboard 链接不携带密钥。SQLite 不是整库加密，私有目录、0600 数据库和秘密脱敏仍必需。
- Submit 持有 control.lock，将锁描述符传给 worker。worker 先等待启动 gate；Linux 必须先进入 systemd scope 再放行，setsid 不能替代 cgroup 托管。
- 接收任务时，状态、密文、HMAC 防重放摘要和最新任务指针在同一 SQLite 事务提交。相同语义请求重新加密后仍识别同一 ID；不同内容复用 ID 必须拒绝。
- 请求密文在完成后清理，防重放记录保留。丢失响应后只查询原 ID；ky 和任务提交都禁止自动重发。
- SQLite 连接从 Open 到 Close 持有 state.lock 共享锁；卸载关闭自己的连接后取得独占锁，排空观察者并阻止新 WAL/SHM 创建。普通 Open 使用 mode=rw，不能创建缺失数据库。
- 卸载先完成平台清理，再删除文件，最后删除数据库和锁。成功后不能再写任务状态；前端以安装目录和平台额外目录确实消失确认完成。失败不能假报成功，不留卸载备份。
- 原始 YAML、运行 YAML 和元数据同属一个配置版本。先校验，再记录 journal，切换 current，重启并验证；失败恢复完整旧版本。SQLite 事务不能替代文件 / 进程回滚。
- 保存完成、后台刷新、任务重连不能覆盖用户更新的草稿。运行状态和任务状态分开，完成提示不常驻首页。

## 平台所有权

- UFI 使用自己的链、mark 和路由，不清空系统防火墙或全局路由。启动内核前建立监听保护；等待 LAN 时仍保留保护，内核退出后才撤掉。
- UFI 自动接口识别只接受共享入口，排除蜂窝、上游和 VPN；未知固件保留手动接口配置。能力标识不保证任意硬件已支持 TPROXY。
- Linux 使用 go-systemd 的 D-Bus 客户端和 unit 序列化；只控制绑定的系统 unit。核对有效 Id、ExecStart / argv、WorkingDirectory、KillMode 和命名空间设置，而非仅凭文件名。
- Linux 核心和 Agent 由系统包管理；自启、网络也是系统所有。相关动作在后端拒绝，不只禁用按钮。先移除引用配置的 systemd unit，才能卸载 Agent 状态。
- Linux 默认 loopback；显式 LAN 地址必须是本机 IPv4 私网地址。管理 API 仍绑定 loopback，额外 listeners / tunnels 不接受。私网地址绑定不证明入口隔离；network/capture 不得虚报就绪。
- systemd 启动提交或健康检查失败时，用新的有界 context 验证并停止本 unit，再进行配置回滚。不能遗留一次失败启动创建的监听。
- 不把 NixOS 的故障策略套到 UFI，也不反向套用。系统拥有的文件、unit、软件包和网络规则不能由卸载顺带删除。

## 库与验证

- Cobra 管 CLI；renameio 管原子文件和符号链接替换；procfs 管进程解析；SQLite 管状态；go-github、semver、go-selfupdate/update 管发行信息和校验替换。
- renameio 暂存必须同文件系统且初始私有，不沿用旧文件权限覆盖密钥。Android 公共自启文件的 chmod 可容忍 EPERM/EOPNOTSUPP，其余情况必须报错。
- DoH 使用 net/http 与 x/net/dnsmessage，保留引导 IP、Android CA、取消、HTTPS 重定向限制与响应上限。解压使用标准库，调用方保留路径、类型和大小限制。
- modernc.org/libc 必须与所用 modernc.org/sqlite 的 go.mod 匹配；保持 CGO_ENABLED=0 和 ARM64 / ARMv7 / AMD64 构建。
- 根目录运行 bun run check、bun run build、bun test；agent/ 运行 go test -race ./... 和 go vet ./...。桥接脚本运行 shellcheck -x -s sh ui/src/transport/ufi-bootstrap.sh agent/internal/platform/network_ufi.sh。
- 交互修改运行 bun run test:ui，用真实 DOMParser 加载生产 IIFE。native.test.ts 验证 Bun → Go；platform 测试替换 D-Bus；真实 systemd 验证仅在隔离 CI runner 通过 MIHOMO_SYSTEMD_TEST 显式启用。
- CI systemd fixture 只监听 loopback 测试端口，不发送代理流量或改路由 / 防火墙。不得把它描述为真实网关流量验证。

## 发布

- 使用官方 Go，通过 mise exec go@1.26.7 -- bun run build:release <version> 构建。Nix 修改标准库路径，同版本编译器也会产生不同摘要。
- 构建命令、资产和版本以 tools/build-agent.ts、package.json、mise.toml 与 workflows 为准；协议从 Go 程序读取。提交生成的 agent-bootstrap.json，再推送对应 agent-v* 标签，不能覆盖已发布标签或资产。
- agent-bootstrap.json 仅为 UFI 初装信任锚，不参与正常版本比较；不能只信任同一下载代理同时提供的文件与摘要。
- 发布前通过 Check 和 Release CI；从公开地址下载所有资产，校验 SHA256SUMS 并与本地构建对比。插件保持单 JS，不增加 CDN / WASM 请求。
- v0.4 使用新目录和协议，不迁移 v0.3 状态。升级说明要求先在旧界面完成卸载；不得引入旧路径或旧协议别名。

## UFI 官方来源

以 http-server-version 分支为准：

- [API](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/API_Doc.md)：Root Shell、认证、上传。
- [用户文档](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/User_Doc.md)：插件导入、自启。
- [加载器](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/frontEnd/public/script/main.js)：DOMParser 和脚本包装。
- [请求实现](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/frontEnd/public/script/requests.js)：HTTP 成功不等于命令成功。
- [上传实现](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/src/main/java/com/minikano/f50_sms/modules/theme/themeModule.kt)：公开 uploads。
