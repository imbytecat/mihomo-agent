# Linux / systemd

Agent 管订阅、配置版本、任务和运行操作；Mihomo 程序、systemd unit、自启及网络规则由系统管理。不会覆盖 Nix store 或自动配置旁路网络。

## 安装

需要 root、systemd，以及系统安装的 Mihomo。以下以 AMD64、内核路径 /usr/bin/mihomo 为例；其他架构使用对应 Release 文件。

```sh
sudo install -m 0755 mihomo-agent-linux-amd64 /usr/local/bin/mihomo-agent
mihomo-agent --platform linux unit --core /usr/bin/mihomo > mihomo-agent-core.service
sudo install -m 0644 mihomo-agent-core.service /etc/systemd/system/mihomo-agent-core.service
sudo systemctl daemon-reload
sudo mihomo-agent --platform linux install --core /usr/bin/mihomo
```

若已有同名 unit，不要覆盖；生成和安装时均通过 --unit 指定独立名称。NixOS 应通过系统声明部署软件包和相同的 unit，不能直接写入系统托管文件。

创建权限为 0600 的 request.json，填入完整 YAML 订阅链接：

```json
{"url":"https://example.com/your-subscription"}
```

```sh
sudo mihomo-agent task update --input request.json --wait
sudo mihomo-agent task start --wait
sudo systemctl enable mihomo-agent-core.service
sudo mihomo-agent inspect
```

秘密通过文件或 --input - 的标准输入传递，不放在命令行参数。去掉 --wait 会立即返回任务 ID；用 job ID、job-log ID 查询。页面或终端断开不取消已接收的任务。

## 监听与面板

默认只监听 127.0.0.1。LAN 使用时，首次生成 unit 和安装时都传 --listen-address 本机私网IPv4。地址绑定不等于入口隔离：转发、TPROXY、DNS 接管、IPv6 和故障策略仍需配置系统防火墙。

API 固定绑定本机回环地址。需要 Zashboard 时执行 task download-dashboard --wait，并通过 SSH 转发访问；可用 task save-controller --input 文件 设置自己选择的密钥：

```json
{"controller":{"enabled":true,"port":9090,"secret":"your-key"}}
```

本平台不会显示“已接管网络”，也不能通过 Agent 更新系统软件包或修改自启。

## 卸载

先停用并从系统配置移除对应 unit，执行 daemon-reload，再运行：

```sh
sudo mihomo-agent task uninstall --wait
```

删除 Agent 私有状态目录中的全部数据，不保留备份；系统中的 Mihomo、Agent 二进制和防火墙规则不属于这个目录，按系统部署方式移除。
