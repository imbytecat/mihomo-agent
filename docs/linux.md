# Linux

Agent 自行安装、校验和更新 Mihomo 与自身二进制，管理订阅、配置版本、任务、启停和自启。需要 root；进程托管和开机启动通过 systemd 的 D-Bus 接口完成，无需手写 service 或预装 Mihomo。

## 安装与日常操作

安装、订阅、内核更新和卸载命令见 [README](../README.md#linux-安装)。默认目录为 `/var/lib/mihomo-agent`，后续直接使用其中的 `agent`。`install` 只初始化 Agent 和 service，首次内核下载使用 `task download --wait`。

安装参数仅在首次安装时确定，后续命令从数据库读取：

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `--root` | `/var/lib/mihomo-agent` | 私有数据目录，末级名称必须为 `mihomo-agent` |
| `install --unit` | `mihomo-agent-core.service` | 独立 service 名称，已有同名服务时拒绝覆盖 |
| `install --listen-address` | `127.0.0.1` | 本机回环或 IPv4 私网地址 |
| `install --github-proxy` | 空，直连 | GitHub 下载代理 HTTPS 前缀 |

例如安装到另一目录并监听本机 LAN 地址：

```sh
sudo ./mihomo-agent-linux-amd64 --root /opt/mihomo-agent install \
  --unit mihomo-agent-lan.service --listen-address 192.168.1.2
```

自定义目录安装后，后续命令也传同一个 `--root`。下载会按架构选择官方 Linux 资产；AMD64 使用兼容版，不要求新 CPU 指令集。内核和 Agent 更新均需先执行 `task stop --wait`，成功后用 `task start --wait` 启动。

需要修改 GitHub Proxy 时，通过 `task save-github-proxy --input 文件 --wait` 传入 `{"githubProxy":"https://ghfast.top"}`，空字符串恢复直连。

## 监听与面板

默认只监听 `127.0.0.1`。LAN 地址必须实际存在于本机接口；地址绑定不等于入口隔离。转发、TPROXY、DNS 接管、IPv6 和故障策略仍需配置系统网络和防火墙，Agent 不会自动部署这些规则，也不会显示“已接管网络”。`diagnose` 使用系统 `ip` 命令读取网络信息，`logs` 通过 `journalctl` 读取 service 日志。

管理 API 固定绑定本机回环地址。需要 Zashboard 时执行 `task download-dashboard --wait`，通过 SSH 转发访问：

```sh
ssh -N -L 9090:127.0.0.1:9090 root@设备地址
```

浏览器打开 `http://127.0.0.1:9090/ui/`。使用 `task save-controller --input 文件 --wait` 设置自己的密钥，JSON 文件权限保持 `0600`：

```json
{"controller":{"enabled":true,"port":9090,"secret":"your-key"}}
```

Dashboard 链接不携带密钥，登录时输入所设置的密钥。

## 自启与卸载

配置和内核就绪后，使用 `task boot-on --wait` 开启自启，`task boot-off --wait` 关闭。Agent 在私有目录保存 service 文件，通过 systemd 注册；无需手动执行 `systemctl enable` 或 `daemon-reload`。勿修改该 service 或添加 drop-in，Agent 会拒绝操作身份或配置不符的服务。

`task uninstall --wait` 自动停止内核、关闭自启并移除 service，确认 systemd 不再引用安装目录后删除 Agent、内核及全部数据。清理失败会报错并保留尚未删除的数据，可修复原因后重试。无备份；其他服务和系统网络规则不受影响。
