package agent

import (
	"errors"
	"net/url"
	"os"
	"regexp"
	"strings"
)

type Settings struct {
	Mirror     string   `json:"mirror"`
	Interfaces []string `json:"interfaces"`
}

func (a *Agent) settings() (Settings, error) {
	settings := Settings{Interfaces: []string{}}
	err := readJSON(a.runtime("settings.json"), &settings)
	if os.IsNotExist(err) {
		err = nil
	}
	return settings, err
}

func validateURL(value string, mirror bool) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" && mirror {
		return "", nil
	}
	if len(value) > 8192 || strings.ContainsAny(value, "\r\n\x00") {
		return "", errors.New("地址包含无效字符或过长")
	}
	u, err := url.Parse(value)
	if err != nil || u.Hostname() == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return "", errors.New("请输入有效的 HTTP(S) 地址")
	}
	if mirror {
		if u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Hostname() == "github.com" || u.Hostname() == "api.github.com" || strings.Contains(u.Path, "/https://") {
			return "", errors.New("请输入无认证、无参数的 HTTPS 镜像前缀")
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
