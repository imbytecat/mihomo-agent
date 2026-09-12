package agent

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const releaseAPI = "https://api.github.com/repos/MetaCubeX/mihomo/releases/latest"

var versionPattern = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+$`)

type release struct {
	Tag        string `json:"tag_name"`
	Draft      *bool  `json:"draft"`
	Prerelease *bool  `json:"prerelease"`
	Assets     []struct {
		Name, Digest string
		URL          string `json:"browser_download_url"`
	} `json:"assets"`
}

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
	return a.installRuntime()
}

func (a *Agent) installRuntime() error {
	if err := os.MkdirAll(a.runtime(), 0700); err != nil {
		return err
	}
	if err := atomicWrite(a.runtime("network.sh"), networkScript, 0700); err != nil {
		return err
	}
	if !regularFile(a.runtime("settings.json")) {
		if err := writeJSON(a.runtime("settings.json"), Settings{Interfaces: []string{}}); err != nil {
			return err
		}
	}
	return writeJSON(a.runtime("installed.json"), map[string]any{"protocol": Protocol, "version": a.Version})
}

func (a *Agent) execute(ctx context.Context, request Request, phase func(string)) (string, error) {
	if request.Action == "install" {
		return "服务已安装", a.installRuntime()
	}
	if !regularFile(a.runtime("installed.json")) {
		return "", errors.New("服务未安装")
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
	case "save-mirror":
		phase("saving")
		value, err := validateURL(request.Value, true)
		if err != nil {
			return "", err
		}
		settings, err := a.settings()
		if err != nil {
			return "", err
		}
		settings.Mirror = value
		return "镜像已保存", writeJSON(a.runtime("settings.json"), settings)
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
		return a.downloadCore(ctx, work, phase)
	case "update":
		return a.updateConfig(ctx, request, work, phase)
	case "start":
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
		return "自启已开启", a.setBoot(true)
	case "boot-off":
		return "自启已关闭", a.setBoot(false)
	case "uninstall":
		phase("stopping")
		if err := a.stopRuntime(); err != nil {
			return "", err
		}
		if err := a.setBoot(false); err != nil {
			return "", err
		}
		backup := a.path("backups", "runtime-"+time.Now().UTC().Format("20060102-150405")+"-"+request.ID)
		if err := os.MkdirAll(filepath.Dir(backup), 0700); err != nil {
			return "", err
		}
		if err := os.Rename(a.runtime(), backup); err != nil {
			return "", err
		}
		return "代理服务已卸载，运行文件已备份：" + backup, nil
	}
	return "", errors.New("未知任务")
}

func selectAsset(data []byte, arch string) (string, string, string, error) {
	var release release
	if json.Unmarshal(data, &release) != nil || !versionPattern.MatchString(release.Tag) || release.Draft == nil || release.Prerelease == nil || *release.Draft || *release.Prerelease {
		return "", "", "", errors.New("官方版本信息无效")
	}
	name := "mihomo-android-" + arch + "-" + release.Tag + ".gz"
	expectedURL := "https://github.com/MetaCubeX/mihomo/releases/download/" + release.Tag + "/" + name
	for _, asset := range release.Assets {
		if asset.Name != name {
			continue
		}
		digest := strings.TrimPrefix(asset.Digest, "sha256:")
		decoded, err := hex.DecodeString(digest)
		if asset.URL != expectedURL || !strings.HasPrefix(asset.Digest, "sha256:") || err != nil || len(decoded) != 32 {
			return "", "", "", errors.New("官方资产缺少有效 SHA-256")
		}
		return release.Tag, expectedURL, strings.ToLower(digest), nil
	}
	return "", "", "", errors.New("官方没有对应架构的核心")
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
	metadata := filepath.Join(work, "release.json")
	if err := a.fetch(ctx, releaseAPI, metadata, 4<<20); err != nil {
		return "", err
	}
	data, err := os.ReadFile(metadata)
	if err != nil {
		return "", err
	}
	version, address, digest, err := selectAsset(data, arch)
	if err != nil {
		return "", err
	}
	settings, err := a.settings()
	if err != nil {
		return "", err
	}
	if settings.Mirror != "" {
		address = settings.Mirror + "/" + address
	}
	phase("download")
	archive := filepath.Join(work, "core.gz")
	if err := a.fetch(ctx, address, archive, 64<<20); err != nil {
		return "", err
	}
	phase("verify")
	f, err := os.Open(archive)
	if err != nil {
		return "", err
	}
	defer f.Close()
	hash := sha256.New()
	if _, err = io.Copy(hash, f); err != nil {
		return "", err
	}
	if hex.EncodeToString(hash.Sum(nil)) != digest {
		return "", errors.New("核心 SHA-256 不匹配，拒绝安装")
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	gz, err := gzip.NewReader(f)
	if err != nil {
		return "", err
	}
	defer gz.Close()
	candidate := filepath.Join(work, "mihomo")
	out, err := os.OpenFile(candidate, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		return "", err
	}
	n, copyErr := io.Copy(out, io.LimitReader(gz, (128<<20)+1))
	syncErr := out.Sync()
	closeErr := out.Close()
	if copyErr != nil || syncErr != nil || closeErr != nil || n > 128<<20 || n < 4 {
		return "", errors.New("核心解压失败或大小无效")
	}
	if _, err = a.run(ctx, candidate, "-v"); err != nil {
		return "", errors.New("核心不能在本设备运行")
	}
	if id, _ := a.activeGeneration(); id != "" {
		if err = a.testCore(ctx, candidate, a.runtime("current", "config.yaml")); err != nil {
			return "", err
		}
	}
	phase("installing")
	if err := os.Rename(candidate, a.runtime("mihomo")); err != nil {
		return "", err
	}
	return "核心 " + version + " 已安装，校验通过", nil
}

func (a *Agent) updateConfig(ctx context.Context, request Request, work string, phase func(string)) (string, error) {
	if !regularFile(a.runtime("mihomo")) {
		return "", errors.New("请先下载核心")
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
	config, ports, err := adaptConfig(source)
	if err != nil {
		return "", err
	}
	phase("validate")
	generation := a.runtime("configurations", request.ID)
	if err = atomicWrite(filepath.Join(generation, "config.yaml"), config, 0600); err != nil {
		return "", err
	}
	if err = atomicWrite(filepath.Join(generation, "source.yaml"), source, 0600); err != nil {
		return "", err
	}
	if err = atomicWrite(filepath.Join(generation, "ports"), []byte(ports), 0600); err != nil {
		return "", err
	}
	if err = writeJSON(filepath.Join(generation, "source.json"), configuration{URL: address}); err != nil {
		return "", err
	}
	if err = a.testCore(ctx, a.runtime("mihomo"), filepath.Join(generation, "config.yaml")); err != nil {
		return "", err
	}
	previous, err := a.activeGeneration()
	if err != nil {
		return "", err
	}
	wasRunning := a.running()
	if err = writeJSON(a.runtime("pending.json"), pendingConfig{Previous: previous, Next: request.ID, WasRunning: wasRunning}); err != nil {
		return "", err
	}
	phase("applying")
	if err = a.stopRuntime(); err == nil {
		err = a.activate(request.ID)
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
			return "", fmt.Errorf("配置应用失败，恢复也失败：%v", rollbackErr)
		}
		return "", errors.New("配置应用失败，已恢复上一版本")
	}
	if err = os.Remove(a.runtime("pending.json")); err != nil {
		return "", err
	}
	return "配置已更新", nil
}
