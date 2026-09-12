package app

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
)

func (a *Agent) Install() error {
	if err := a.initIdentity(); err != nil {
		return err
	}
	lock, err := a.lock()
	if err != nil {
		return err
	}
	defer lock.Close()
	if a.running() {
		return errors.New("请先停止代理")
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	data, err := os.ReadFile(self)
	if err != nil {
		return err
	}
	if err = atomicWrite(a.path("agent"), data, 0700); err != nil {
		return err
	}
	if err := a.installRuntime(); err != nil {
		return err
	}
	_ = os.Remove(a.path("latest-task"))
	return nil
}

func (a *Agent) installRuntime() error {
	if err := os.MkdirAll(a.runtime(), 0700); err != nil {
		return err
	}
	if err := atomicWrite(a.runtime("network.sh"), networkScript, 0700); err != nil {
		return err
	}
	settings, err := a.settings()
	if err != nil {
		return err
	}
	settings.GitHubProxy, err = validateURL(a.InitialGitHubProxy, true)
	if err != nil {
		return err
	}
	if err := writeJSON(a.runtime("settings.json"), settings); err != nil {
		return err
	}
	if err := a.ensureController(); err != nil {
		return err
	}
	return writeJSON(a.runtime("installed.json"), map[string]any{"protocol": Protocol})
}

func (a *Agent) execute(ctx context.Context, request Request, phase func(string)) (string, error) {
	if request.Action == "uninstall" {
		return "Mihomo 服务已卸载", a.uninstall(phase)
	}
	if request.Action == "install" {
		if a.running() || regularFile(a.runtime("installed.json")) {
			return "", errors.New("Mihomo 服务已安装，请刷新状态")
		}
		a.InitialGitHubProxy = request.Value
		return "Mihomo 服务已安装", a.installRuntime()
	}
	if !regularFile(a.runtime("installed.json")) {
		return "", errors.New("Mihomo 服务未安装")
	}
	resume, err := a.recoverConfiguration()
	if err != nil {
		return "", err
	}
	if resume && request.Action != "stop" && request.Action != "uninstall" {
		if err = a.startRuntime(ctx); err != nil {
			return "", err
		}
	}
	work := a.taskPath(request.ID, "work")
	if err = os.MkdirAll(work, 0700); err != nil {
		return "", err
	}
	defer os.RemoveAll(work)
	switch request.Action {
	case "save-github-proxy":
		phase("saving")
		value, err := validateURL(request.Value, true)
		if err != nil {
			return "", err
		}
		settings, err := a.settings()
		if err != nil {
			return "", err
		}
		settings.GitHubProxy = value
		return "GitHub Proxy 已保存", writeJSON(a.runtime("settings.json"), settings)
	case "save-interfaces":
		phase("saving")
		if a.running() {
			return "", errors.New("请先停止代理")
		}
		value, err := parseInterfaces(request.Value)
		if err != nil {
			return "", err
		}
		settings, err := a.settings()
		if err != nil {
			return "", err
		}
		settings.Interfaces = value
		return "接口已保存", writeJSON(a.runtime("settings.json"), settings)
	case "download":
		if a.running() {
			return "", errors.New("请先停止代理")
		}
		githubProxy, err := validateURL(request.Value, true)
		if err != nil {
			return "", err
		}
		settings, err := a.settings()
		if err != nil {
			return "", err
		}
		settings.GitHubProxy = githubProxy
		if err = writeJSON(a.runtime("settings.json"), settings); err != nil {
			return "", err
		}
		return a.downloadCore(ctx, work, phase)
	case "update":
		return a.updateConfig(ctx, request, work, phase)
	case "save-controller":
		return a.saveController(ctx, request, phase)
	case "update-agent":
		return a.updateAgent(ctx, work, phase)
	case "download-dashboard":
		return a.downloadDashboard(ctx, request, work, phase)
	case "start":
		if a.running() {
			return "", errors.New("代理已运行")
		}
		if request.Value != "" {
			value, err := parseInterfaces(request.Value)
			if err != nil {
				return "", err
			}
			settings, err := a.settings()
			if err != nil {
				return "", err
			}
			settings.Interfaces = value
			if err = writeJSON(a.runtime("settings.json"), settings); err != nil {
				return "", err
			}
		}
		phase("starting")
		return "代理已启动", a.startRuntime(ctx)
	case "stop":
		phase("stopping")
		return "代理已停止", a.stopRuntime()
	case "restart":
		phase("stopping")
		if err := a.stopRuntime(); err != nil {
			return "", err
		}
		phase("starting")
		return "代理已重启", a.startRuntime(ctx)
	case "boot-on":
		return "开机启动已开启", a.setBoot(true)
	case "boot-off":
		return "开机启动已关闭", a.setBoot(false)
	}
	return "", errors.New("未知任务")
}

func (a *Agent) downloadCore(ctx context.Context, work string, phase func(string)) (string, error) {
	if a.running() {
		return "", errors.New("请先停止代理")
	}
	arch := ""
	switch runtime.GOARCH {
	case "arm64":
		arch = "arm64-v8"
	case "arm":
		arch = "armv7"
	default:
		return "", errors.New("仅支持 ARM64 / ARMv7 设备")
	}
	phase("release")
	r, err := a.latestRelease(ctx, "MetaCubeX", "mihomo")
	if err != nil {
		return "", err
	}
	version, address, digest, err := r.asset("MetaCubeX/mihomo", "mihomo-android-"+arch+"-"+r.GetTagName()+".gz")
	if err != nil {
		return "", err
	}
	settings, err := a.settings()
	if err != nil {
		return "", err
	}
	if settings.GitHubProxy != "" {
		address = settings.GitHubProxy + "/" + address
	}
	phase("download")
	archive := filepath.Join(work, "core.gz")
	if err := a.fetch(ctx, address, archive, 64<<20); err != nil {
		return "", err
	}
	phase("verify")
	if err = a.installCore(ctx, archive, work, digest, phase); err != nil {
		return "", err
	}
	return "内核 " + version + " 已安装，校验通过", nil
}

func (a *Agent) installCore(ctx context.Context, archive, work, digest string, phase func(string)) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	hash := sha256.New()
	if _, err = io.Copy(hash, f); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != digest {
		return errors.New("内核 SHA-256 不匹配，拒绝安装")
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	candidate := filepath.Join(work, "mihomo")
	out, err := os.OpenFile(candidate, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		return err
	}
	n, copyErr := io.Copy(out, io.LimitReader(gz, (128<<20)+1))
	syncErr := out.Sync()
	closeErr := out.Close()
	if copyErr != nil || syncErr != nil || closeErr != nil || n > 128<<20 || n < 4 {
		return errors.New("内核解压失败或大小无效")
	}
	if _, err = a.run(ctx, candidate, "-v"); err != nil {
		return errors.New("内核不能在本设备运行")
	}
	if id, _ := a.activeGeneration(); id != "" {
		if err = a.testCore(ctx, candidate, a.runtime("current", "config.yaml")); err != nil {
			return err
		}
	}
	phase("installing")
	return os.Rename(candidate, a.runtime("mihomo"))
}

func (a *Agent) updateConfig(ctx context.Context, request Request, work string, phase func(string)) (string, error) {
	if !regularFile(a.runtime("mihomo")) {
		return "", errors.New("请先安装 Mihomo 内核")
	}
	current, err := a.configuration()
	if err != nil {
		return "", err
	}
	address := current.URL
	if request.Value != "" {
		address = request.Value
	}
	address, err = validateURL(address, false)
	if err != nil {
		return "", err
	}
	phase("subscription")
	sourcePath := filepath.Join(work, "source.yaml")
	if err = a.fetch(ctx, address, sourcePath, 4<<20); err != nil {
		return "", err
	}
	source, err := os.ReadFile(sourcePath)
	if err != nil {
		return "", err
	}
	control, err := a.controller()
	if err != nil {
		return "", err
	}
	if err = a.applyConfig(ctx, request.ID, source, address, control, phase); err != nil {
		return "", err
	}
	return "配置已更新", nil
}

func (a *Agent) applyConfig(ctx context.Context, id string, source []byte, address string, control Controller, phase func(string)) error {
	phase("adapt")
	dashboard := a.dashboard().Installed
	config, ports, err := adaptConfig(source, control, dashboard)
	if err != nil {
		return err
	}
	phase("validate")
	generation := a.runtime("configurations", id)
	if err = atomicWrite(filepath.Join(generation, "config.yaml"), config, 0600); err != nil {
		return err
	}
	if err = atomicWrite(filepath.Join(generation, "source.yaml"), source, 0600); err != nil {
		return err
	}
	if err = atomicWrite(filepath.Join(generation, "ports"), []byte(ports), 0600); err != nil {
		return err
	}
	apiPort := 0
	if control.Enabled {
		apiPort = control.Port
	}
	if err = atomicWrite(filepath.Join(generation, "api-port"), []byte(strconv.Itoa(apiPort)), 0600); err != nil {
		return err
	}
	if err = writeJSON(filepath.Join(generation, "source.json"), configuration{URL: address, Controller: &control, Dashboard: dashboard && control.Enabled}); err != nil {
		return err
	}
	if err = a.testCore(ctx, a.runtime("mihomo"), filepath.Join(generation, "config.yaml")); err != nil {
		return err
	}
	previous, err := a.activeGeneration()
	if err != nil {
		return err
	}
	wasRunning := a.running()
	if err = writeJSON(a.runtime("pending.json"), pendingConfig{Previous: previous, Next: id, WasRunning: wasRunning}); err != nil {
		return err
	}
	phase("applying")
	if err = a.stopRuntime(); err == nil {
		err = a.activate(id)
	}
	if err == nil && wasRunning {
		err = a.startRuntime(ctx)
	}
	if err != nil {
		phase("rollback")
		resume, rollbackErr := a.recoverConfiguration()
		if rollbackErr == nil && resume {
			rollbackErr = a.startRuntime(ctx)
		}
		if rollbackErr != nil {
			return fmt.Errorf("配置应用失败，恢复也失败：%v", rollbackErr)
		}
		return errors.New("配置应用失败，已恢复上一版本")
	}
	if err = os.Remove(a.runtime("pending.json")); err != nil {
		return err
	}
	return nil
}
