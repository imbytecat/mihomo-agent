package manager

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/Masterminds/semver/v3"
	"github.com/creativeprojects/go-selfupdate/update"
	"github.com/google/go-github/v86/github"
)

type release struct{ github.RepositoryRelease }

func releaseVersion(tag string) (*semver.Version, error) {
	return semver.StrictNewVersion(strings.TrimPrefix(tag, "v"))
}

func (r release) validate() error {
	version, err := releaseVersion(r.GetTagName())
	if err != nil || version.Prerelease() != "" || r.Draft == nil || r.Prerelease == nil || r.GetDraft() || r.GetPrerelease() {
		return errors.New("官方版本信息无效")
	}
	return nil
}

func (r release) asset(repo, name string) (string, string, string, error) {
	expectedURL := "https://github.com/" + repo + "/releases/download/" + r.GetTagName() + "/" + name
	for _, asset := range r.Assets {
		if asset.GetName() != name {
			continue
		}
		digest := strings.TrimPrefix(asset.GetDigest(), "sha256:")
		decoded, err := hex.DecodeString(digest)
		if asset.GetBrowserDownloadURL() != expectedURL || !strings.HasPrefix(asset.GetDigest(), "sha256:") || err != nil || len(decoded) != 32 {
			return "", "", "", errors.New("官方资产缺少有效 SHA-256")
		}
		return r.GetTagName(), expectedURL, strings.ToLower(digest), nil
	}
	return "", "", "", errors.New("官方版本缺少所需文件")
}

func (a *Manager) latestRelease(ctx context.Context, owner, repo string) (release, error) {
	client := a.deviceClient()
	defer client.CloseIdleConnections()
	api := github.NewClient(client)
	api.UserAgent = "mihomo-agent/" + a.Version
	value, _, err := api.Repositories.GetLatestRelease(ctx, owner, repo)
	if err != nil {
		return release{}, fmt.Errorf("查询 %s/%s 版本失败：%w", owner, repo, err)
	}
	if value == nil {
		return release{}, errors.New("官方版本信息无效")
	}
	r := release{*value}
	return r, r.validate()
}

func (a *Manager) updateAgent(ctx context.Context, work string, phase func(string)) (string, error) {
	if !a.Platform.Capabilities().AgentUpdate {
		return "", errors.New("该平台不支持 Agent 更新")
	}
	if a.running() {
		return "", errors.New("请先停止代理")
	}
	phase("release")
	r, err := a.latestRelease(ctx, "imbytecat", "mihomo-agent")
	if err != nil {
		return "", err
	}
	latest, _ := releaseVersion(r.GetTagName())
	current, err := releaseVersion(a.Version)
	if err != nil {
		return "", errors.New("当前 Agent 版本无效，请重新安装")
	}
	if !latest.GreaterThan(current) {
		return "Mihomo Agent 已是最新版本", nil
	}
	arch := runtime.GOARCH
	if arch == "arm" {
		arch = "armv7"
	}
	_, address, digest, err := r.asset("imbytecat/mihomo-agent", "mihomo-agent-linux-"+arch)
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
	path := filepath.Join(work, "agent")
	if err := a.fetch(ctx, address, path, 32<<20); err != nil {
		return "", err
	}
	phase("verify")
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != digest {
		return "", errors.New("Agent SHA-256 不匹配，拒绝安装")
	}
	if err := os.Chmod(path, 0700); err != nil {
		return "", err
	}
	output, err := a.run(ctx, path, "version")
	var info struct {
		Version  string
		Protocol int
	}
	if err != nil || json.Unmarshal(output, &info) != nil || info.Protocol != Protocol {
		return "", errors.New("Agent 不可用或协议已变化，请更新插件后重新安装")
	}
	actual, err := releaseVersion(info.Version)
	if err != nil || !actual.Equal(latest) {
		return "", errors.New("Agent 版本与发布信息不符")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	checksum, _ := hex.DecodeString(digest)
	phase("installing")
	if err := update.Apply(file, update.Options{TargetPath: a.path("agent"), TargetMode: 0700, Checksum: checksum}); err != nil {
		return "", err
	}
	return "Mihomo Agent v" + latest.String() + " 已更新", nil
}
