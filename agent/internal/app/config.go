package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/google/renameio/v2"
	"go.yaml.in/yaml/v3"
)

func adaptConfig(source []byte, control Controller, dashboard bool) ([]byte, string, error) {
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
		return nil, "", errors.New("请移除 routing-mark，避免 Android 路由冲突")
	}
	for _, key := range []string{"listeners", "tunnels"} {
		if value := config[key]; value != nil {
			if list, ok := value.([]any); !ok || len(list) != 0 {
				return nil, "", fmt.Errorf("不支持额外 %s", key)
			}
		}
	}
	config["allow-lan"] = true
	config["bind-address"] = "*"
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
	dns["listen"] = "0.0.0.0:1053"
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
		config["external-controller"] = "0.0.0.0:" + strconv.Itoa(control.Port)
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
type pendingConfig struct {
	Previous, Next string
	WasRunning     bool
}

func (a *Agent) activeGeneration() (string, error) {
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

func (a *Agent) activate(id string) error {
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

func (a *Agent) configuration() (configuration, error) {
	id, err := a.activeGeneration()
	if err != nil || id == "" {
		return configuration{}, err
	}
	var config configuration
	err = readJSON(a.runtime("configurations", id, "source.json"), &config)
	return config, err
}

func (a *Agent) recoverConfiguration() (bool, error) {
	var pending pendingConfig
	err := readJSON(a.runtime("pending.json"), &pending)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
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
	return pending.WasRunning, os.Remove(a.runtime("pending.json"))
}

func (a *Agent) configPorts() (string, error) {
	id, err := a.activeGeneration()
	if err != nil || id == "" {
		return "", errors.New("没有可用配置")
	}
	data, err := os.ReadFile(a.runtime("configurations", id, "ports"))
	return strings.TrimSpace(string(data)), err
}

func (a *Agent) SettingsJSON() ([]byte, error) {
	settings, err := a.settings()
	if err != nil {
		return nil, err
	}
	return json.Marshal(settings)
}
