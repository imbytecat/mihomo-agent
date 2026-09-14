package manager

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/imbytecat/mihomo-agent/internal/platform"

	"github.com/google/renameio/v2"
	"go.yaml.in/yaml/v3"
)

func adaptConfig(source []byte, control Controller, dashboard bool, policy platform.Policy) ([]byte, string, error) {
	if err := control.validate(); err != nil {
		return nil, "", err
	}
	decoder := yaml.NewDecoder(bytes.NewReader(source))
	var config map[string]any
	if err := decoder.Decode(&config); err != nil || config == nil {
		return nil, "", errors.New("订阅必须是有效的完整 YAML 配置")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, "", errors.New("订阅只能包含一个 YAML 文档")
	}
	if config["proxies"] == nil && config["proxy-providers"] == nil {
		return nil, "", errors.New("订阅没有 proxies 或 proxy-providers")
	}
	if value := config["interface-name"]; value != "" && value != nil {
		return nil, "", errors.New("不支持配置项 interface-name")
	}
	if value := config["routing-mark"]; value != nil && value != 0 {
		return nil, "", errors.New("请移除 routing-mark，避免平台路由冲突")
	}
	for _, key := range []string{"listeners", "tunnels"} {
		if value := config[key]; value != nil {
			if list, ok := value.([]any); !ok || len(list) != 0 {
				return nil, "", fmt.Errorf("不支持额外 %s", key)
			}
		}
	}
	for _, key := range []string{"ss-config", "vmess-config"} {
		if value := config[key]; value != nil && value != "" {
			return nil, "", fmt.Errorf("不支持额外入站 %s", key)
		}
	}
	for _, key := range []string{"tuic-server", "iptables"} {
		if value := config[key]; value != nil {
			options, ok := value.(map[string]any)
			if !ok {
				return nil, "", fmt.Errorf("%s 必须是映射", key)
			}
			if enabled := options["enable"]; enabled != nil && enabled != false {
				return nil, "", fmt.Errorf("不支持由订阅启用 %s", key)
			}
		}
	}
	config["allow-lan"] = true
	config["bind-address"] = policy.Bind
	config["tproxy-port"] = 7894
	config["ipv6"] = false
	for _, key := range []string{"dns", "tun"} {
		if config[key] == nil {
			config[key] = map[string]any{}
		}
		if _, ok := config[key].(map[string]any); !ok {
			return nil, "", fmt.Errorf("%s 必须是映射", key)
		}
	}
	config["tun"].(map[string]any)["enable"] = false
	dns := config["dns"].(map[string]any)
	dns["enable"] = true
	dns["listen"] = net.JoinHostPort(policy.DNS, "1053")
	dns["ipv6"] = false
	ports := []int{7894, 1053}
	for _, key := range []string{"mixed-port", "port", "socks-port", "redir-port"} {
		if config[key] == nil {
			continue
		}
		port, ok := config[key].(int)
		if !ok || port < 0 || port > 65535 {
			return nil, "", fmt.Errorf("%s 无效", key)
		}
		if port != 0 {
			if control.Enabled && port == control.Port {
				return nil, "", errors.New("API 端口与代理监听端口冲突")
			}
			ports = append(ports, port)
		}
	}
	// Management belongs to the device, independently of subscription policy.
	for _, key := range []string{"external-controller", "external-controller-tls", "external-controller-unix", "external-controller-pipe", "external-doh-server", "external-controller-cors", "external-ui", "external-ui-name", "external-ui-url", "secret"} {
		delete(config, key)
	}
	if control.Enabled {
		config["external-controller"] = net.JoinHostPort(policy.Controller, strconv.Itoa(control.Port))
		config["secret"] = control.Secret
		if dashboard {
			config["external-ui"] = "dashboard"
		}
		ports = append(ports, control.Port)
	}
	seen := map[int]bool{}
	var protected []string
	for _, port := range ports {
		if !seen[port] {
			seen[port] = true
			protected = append(protected, strconv.Itoa(port))
		}
	}
	encoded, err := yaml.Marshal(config)
	return encoded, strings.Join(protected, ","), err
}

type configuration struct {
	URL        string      `json:"url"`
	Controller *Controller `json:"controller,omitempty"`
	Dashboard  bool        `json:"dashboard,omitempty"`
}

func (a *Manager) activeGeneration() (string, error) {
	target, err := os.Readlink(a.runtime("current"))
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	id := strings.TrimPrefix(target, "configurations/")
	if target != "configurations/"+id || !validID(id) {
		return "", errors.New("配置指针无效")
	}
	return id, nil
}

func (a *Manager) activate(id string) error {
	if id == "" {
		err := os.Remove(a.runtime("current"))
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if !validID(id) {
		return errors.New("配置 ID 无效")
	}
	return renameio.Symlink(filepath.Join("configurations", id), a.runtime("current"))
}

func (a *Manager) configuration() (configuration, error) {
	id, err := a.activeGeneration()
	if err != nil || id == "" {
		return configuration{}, err
	}
	value, err := a.store.Configuration(id)
	if err != nil {
		return configuration{}, err
	}
	control := Controller(*value.Controller)
	return configuration{URL: value.URL, Controller: &control, Dashboard: value.Dashboard}, nil
}

func (a *Manager) recoverConfiguration() (bool, error) {
	pending, err := a.store.Pending()
	if err != nil {
		return false, err
	}
	if pending == nil {
		return false, nil
	}
	if pending.Previous != "" && !validID(pending.Previous) || !validID(pending.Next) {
		return false, errors.New("配置事务损坏")
	}
	if err := a.stopRuntime(); err != nil {
		return false, err
	}
	if err := a.activate(pending.Previous); err != nil {
		return false, err
	}
	return pending.WasRunning, a.store.ClearPending()
}
