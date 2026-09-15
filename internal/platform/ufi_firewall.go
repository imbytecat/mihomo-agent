package platform

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/imbytecat/mihomoctl/internal/fsutil"
	"github.com/imbytecat/mihomoctl/internal/redact"
)

// Pin invocation paths, not symlink targets: xtables dispatches by argv[0].
type firewall struct {
	IPv4     string `json:"ipv4"`
	IPv6     string `json:"ipv6"`
	Backend  string `json:"backend"`
	Version4 string `json:"-"`
	Version6 string `json:"-"`
}

func (a *UFIAdapter) firewallVersion(ctx context.Context, path string) (string, string, error) {
	if !filepath.IsAbs(path) {
		return "", "", errors.New("防火墙程序必须使用绝对路径")
	}
	output, err := a.command(ctx, nil, path, "--version")
	if err != nil {
		return "", "", fmt.Errorf("无法读取防火墙版本 %s：%w\n%s", path, err, redact.String(string(output)))
	}
	version := strings.TrimSpace(string(output))
	for _, backend := range []string{"legacy", "nf_tables"} {
		if strings.Contains(version, "("+backend+")") {
			return backend, version, nil
		}
	}
	return "", "", fmt.Errorf("无法确认防火墙后端 %s：%s", path, version)
}

func (a *UFIAdapter) validateFirewall(ctx context.Context, f firewall) (firewall, error) {
	mode4, version4, err := a.firewallVersion(ctx, f.IPv4)
	if err != nil {
		return f, err
	}
	mode6, version6, err := a.firewallVersion(ctx, f.IPv6)
	if err != nil {
		return f, err
	}
	if mode4 != mode6 {
		return f, fmt.Errorf("IPv4/IPv6 防火墙后端不一致：%s / %s", version4, version6)
	}
	if f.Backend != "" && f.Backend != mode4 {
		return f, fmt.Errorf("防火墙后端已变化：本安装使用 %s，当前程序为 %s；请恢复原后端后再操作", f.Backend, mode4)
	}
	f.Backend, f.Version4, f.Version6 = mode4, version4, version6
	return f, nil
}

func (a *UFIAdapter) detectFirewall(ctx context.Context, lookup func(string) (string, error)) (firewall, error) {
	v4, err4 := lookup("iptables")
	v6, err6 := lookup("ip6tables")
	if err4 == nil && err6 == nil {
		return a.validateFirewall(ctx, firewall{IPv4: v4, IPv6: v6})
	}
	if err4 == nil || err6 == nil {
		return firewall{}, errors.New("系统默认 iptables/ip6tables 不成对，不能混用防火墙后端")
	}
	var candidates []firewall
	for _, suffix := range []string{"legacy", "nft"} {
		v4, err4 := lookup("iptables-" + suffix)
		v6, err6 := lookup("ip6tables-" + suffix)
		if err4 != nil || err6 != nil {
			continue
		}
		pair, err := a.validateFirewall(ctx, firewall{IPv4: v4, IPv6: v6})
		if err != nil {
			return firewall{}, err
		}
		candidates = append(candidates, pair)
	}
	if len(candidates) != 1 {
		return firewall{}, errors.New("没有唯一可用的防火墙后端，请配置系统默认 iptables/ip6tables；不会根据其他代理的规则自动选择")
	}
	return candidates[0], nil
}

// Creation runs under network.lock, before any owned rule is written.
func (a *UFIAdapter) firewall(ctx context.Context, create bool) (firewall, error) {
	var f firewall
	path := a.runtime("firewall.json")
	if err := fsutil.ReadJSON(path, &f); err == nil {
		if f.Backend != "legacy" && f.Backend != "nf_tables" {
			return f, errors.New("防火墙后端记录无效")
		}
		return a.validateFirewall(ctx, f)
	} else if !os.IsNotExist(err) {
		return f, err
	}
	if fsutil.RegularFile(a.runtime("network.active")) || fsutil.RegularFile(a.runtime("network.pending")) || fsutil.RegularFile(a.runtime("network.owned")) {
		return f, errors.New("已有网络规则但缺少后端记录，无法安全选择另一套防火墙；请先用创建规则的安装停止或卸载")
	}
	f, err := a.detectFirewall(ctx, exec.LookPath)
	if err == nil && create {
		err = fsutil.WriteJSON(path, f)
	}
	return f, err
}

func (a *UFIAdapter) Diagnostics(ctx context.Context) (string, error) {
	var result strings.Builder
	f, err := a.firewall(ctx, false)
	if err != nil {
		fmt.Fprintf(&result, "防火墙后端：%v\n", err)
	} else {
		fmt.Fprintf(&result, "透明代理：TProxy\n防火墙后端：%s\nIPv4：%s\n%s\nIPv6：%s\n%s\n", f.Backend, f.IPv4, f.Version4, f.IPv6, f.Version6)
	}
	if !fsutil.RegularFile(a.runtime("firewall.json")) {
		result.WriteString("后端尚未绑定；启动时才执行实际规则能力检查。\n")
	}
	text, _ := a.Environment.Diagnostics(ctx)
	result.WriteString(text)
	return result.String(), nil
}
