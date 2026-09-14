package manager

import (
	"errors"
	"net/url"
	"regexp"
	"strings"

	"github.com/imbytecat/mihomo-agent/internal/storage"
)

type Settings = storage.Settings

func (a *Manager) settings() (Settings, error) {
	if err := a.openStore(); err != nil {
		return Settings{}, err
	}
	return a.store.Settings()
}

// GitHub metadata and assets use the same user-selected mirror. Subscription
// requests never pass through this function.
func (a *Manager) githubURL(address string) (string, error) {
	settings, err := a.settings()
	if err != nil {
		return "", err
	}
	prefix, err := validateURL(settings.GitHubProxy, true)
	if err != nil {
		return "", err
	}
	if prefix != "" {
		return prefix + "/" + address, nil
	}
	return address, nil
}

func validateURL(value string, githubProxy bool) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" && githubProxy {
		return "", nil
	}
	if len(value) > 8192 || strings.ContainsAny(value, "\r\n\x00") {
		return "", errors.New("地址包含无效字符或过长")
	}
	u, err := url.Parse(value)
	if err != nil || u.Hostname() == "" || u.User != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return "", errors.New("请输入有效的 HTTP(S) 地址")
	}
	if githubProxy {
		host := strings.ToLower(u.Hostname())
		if u.Scheme != "https" || u.RawQuery != "" || u.Fragment != "" || host == "github.com" || host == "api.github.com" || host == "raw.githubusercontent.com" || strings.Contains(u.Path, "/https://") || strings.Contains(u.Path, "/http://") {
			return "", errors.New("请输入无认证、无参数的 HTTPS GitHub Proxy 前缀")
		}
		return strings.TrimRight(value, "/"), nil
	}
	return value, nil
}

var ifaceName = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,14}$`)

func parseInterfaces(value string) ([]string, error) {
	value = strings.TrimSpace(value)
	if value == "" || value == "auto" {
		return []string{}, nil
	}
	var result []string
	seen := map[string]bool{}
	for _, name := range strings.Fields(strings.ReplaceAll(value, ",", " ")) {
		if !ifaceName.MatchString(name) || name == "lo" || strings.HasPrefix(name, "rmnet") || strings.HasPrefix(name, "ccmni") || strings.HasPrefix(name, "pdp") || strings.HasPrefix(name, "wwan") {
			return nil, errors.New("无效共享接口，不能选择蜂窝出口")
		}
		if !seen[name] {
			result = append(result, name)
			seen[name] = true
		}
	}
	return result, nil
}
