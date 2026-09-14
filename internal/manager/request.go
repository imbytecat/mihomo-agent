package manager

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

type ControllerInput struct {
	Enabled *bool   `json:"enabled"`
	Port    int     `json:"port"`
	Secret  *string `json:"secret,omitempty"`
	Reset   bool    `json:"reset,omitempty"`
}
type Params struct {
	URL         string           `json:"url,omitempty"`
	GitHubProxy *string          `json:"githubProxy,omitempty"`
	Interfaces  *string          `json:"interfaces,omitempty"`
	Controller  *ControllerInput `json:"controller,omitempty"`
}
type Request struct {
	ID     string `json:"id"`
	Action string `json:"action"`
	Params Params `json:"params"`
}

func DecodeRequest(data []byte) (Request, error) {
	var req Request
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if len(data) > 48*1024 || decoder.Decode(&req) != nil {
		return req, errors.New("请求格式无效")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return req, errors.New("请求只能包含一个 JSON 对象")
	}
	return req, req.validate()
}
func (r Request) validate() error {
	if !validID(r.ID) {
		return errors.New("无效任务 ID")
	}
	p := r.Params
	allowProxy, allowInterfaces, allowURL, allowController := false, false, false, false
	switch r.Action {
	case "install", "download", "download-dashboard", "self-update":
		allowProxy = true
	case "save-github-proxy":
		allowProxy = true
		if p.GitHubProxy == nil {
			return errors.New("缺少 GitHub Proxy 参数")
		}
	case "save-interfaces":
		allowInterfaces = true
		if p.Interfaces == nil {
			return errors.New("缺少共享接口参数")
		}
	case "start":
		allowInterfaces = true
	case "update":
		allowURL = true
	case "save-controller":
		allowController = true
		if p.Controller == nil || p.Controller.Enabled == nil {
			return errors.New("缺少控制面板参数")
		}
	case "stop", "restart", "boot-on", "boot-off", "uninstall":
	default:
		return errors.New("未知设备操作")
	}
	if p.GitHubProxy != nil && !allowProxy || p.Interfaces != nil && !allowInterfaces || p.URL != "" && !allowURL || p.Controller != nil && !allowController {
		return errors.New("该操作不接受这些参数")
	}
	return nil
}
func (a *Manager) authorize(r Request) error {
	if err := r.validate(); err != nil {
		return err
	}
	if (r.Action == "save-interfaces" || r.Params.Interfaces != nil) && !a.Platform.Capabilities().Interfaces {
		return errors.New("共享网络由系统配置管理")
	}
	return nil
}
