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
	"github.com/google/go-github/v91/github"
	"github.com/imbytecat/mihomoctl/internal/fsutil"
)

type release struct {
	TagName    string                 `json:"tag_name"`
	Draft      *bool                  `json:"draft"`
	Prerelease *bool                  `json:"prerelease"`
	Assets     []*github.ReleaseAsset `json:"assets"`
}

func releaseVersion(tag string) (*semver.Version, error) {
	return semver.StrictNewVersion(strings.TrimPrefix(tag, "v"))
}

func (r release) validate() error {
	version, err := releaseVersion(r.TagName)
	if err != nil || version.Prerelease() != "" || r.Draft == nil || r.Prerelease == nil || *r.Draft || *r.Prerelease {
		return errors.New("官方版本信息无效")
	}
	return nil
}

func (r release) asset(repo, name string) (string, string, string, error) {
	expectedURL := "https://github.com/" + repo + "/releases/download/" + r.TagName + "/" + name
	for _, asset := range r.Assets {
		if asset.GetName() != name {
			continue
		}
		digest := strings.TrimPrefix(asset.GetDigest(), "sha256:")
		decoded, err := hex.DecodeString(digest)
		if asset.GetBrowserDownloadURL() != expectedURL || !strings.HasPrefix(asset.GetDigest(), "sha256:") || err != nil || len(decoded) != 32 {
			return "", "", "", errors.New("官方资产缺少有效 SHA-256")
		}
		return r.TagName, expectedURL, strings.ToLower(digest), nil
	}
	return "", "", "", errors.New("官方版本缺少所需文件")
}

func (a *Manager) latestRelease(ctx context.Context, owner, repo string) (release, error) {
	client := a.deviceClient()
	defer client.CloseIdleConnections()
	api, err := github.NewClient(github.WithHTTPClient(client), github.WithUserAgent("mihomoctl/"+a.Version))
	if err != nil {
		return release{}, err
	}
	request, err := api.NewRequest(ctx, "GET", fmt.Sprintf("repos/%s/%s/releases/latest", owner, repo), nil)
	if err != nil {
		return release{}, err
	}
	// Preserve required wire fields: the SDK's release booleans now default to false.
	var r release
	if _, err := api.Do(request, &r); err != nil {
		return release{}, fmt.Errorf("查询 %s/%s 版本失败：%w", owner, repo, err)
	}
	return r, r.validate()
}

func (a *Manager) updateAgent(ctx context.Context, work string, phase func(string)) (string, error) {
	if a.running() {
		return "", errors.New("请先停止代理")
	}
	phase("release")
	r, err := a.latestRelease(ctx, "imbytecat", "mihomoctl")
	if err != nil {
		return "", err
	}
	latest, _ := releaseVersion(r.TagName)
	current, err := releaseVersion(a.Version)
	if err != nil {
		return "", errors.New("当前 mihomoctl 版本无效，请重新安装")
	}
	if !latest.GreaterThan(current) {
		return "mihomoctl 已是最新版本", nil
	}
	arch := runtime.GOARCH
	if arch == "arm" {
		arch = "armv7"
	}
	_, address, digest, err := r.asset("imbytecat/mihomoctl", "mihomoctl-linux-"+arch)
	if err != nil {
		return "", err
	}
	phase("download")
	path := filepath.Join(work, "mihomoctl")
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
		return "", errors.New("mihomoctl SHA-256 不匹配，拒绝安装")
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
		return "", errors.New("mihomoctl 不可用或协议已变化，请更新插件后重新安装")
	}
	actual, err := releaseVersion(info.Version)
	if err != nil || !actual.Equal(latest) {
		return "", errors.New("mihomoctl 版本与发布信息不符")
	}
	phase("installing")
	// ponytail: keep the verified bytes (at most 32 MiB); stream a verified staging
	// file if that bound becomes too large. Never reread the probed candidate path.
	if err := fsutil.AtomicWrite(a.Executable, data, 0700); err != nil {
		return "", err
	}
	return "mihomoctl v" + latest.String() + " 已更新", nil
}
