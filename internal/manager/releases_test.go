package manager

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"testing"

	"github.com/imbytecat/mihomoctl/internal/platform"
)

type releasePlatform struct {
	platform.Adapter
	kind string
}

func (p releasePlatform) Config() platform.Config { return platform.Config{Kind: p.kind} }

func TestCoreTargets(t *testing.T) {
	for _, tt := range []struct{ kind, arch, target, assetArch string }{
		{platform.UFI, "arm64", "android", "arm64-v8"},
		{platform.UFI, "arm", "android", "armv7"},
		{platform.Linux, "amd64", "linux", "amd64-compatible"},
		{platform.Linux, "arm64", "linux", "arm64"},
		{platform.Linux, "arm", "linux", "armv7"},
		{platform.UFI, "amd64", "", ""},
		{platform.Linux, "386", "", ""},
		{"unknown", "arm64", "", ""},
	} {
		target, arch, err := coreTarget(tt.kind, tt.arch)
		if target != tt.target || arch != tt.assetArch || (err != nil) != (tt.target == "") {
			t.Fatalf("%s/%s: %s/%s %v", tt.kind, tt.arch, target, arch, err)
		}
	}
}

func TestCoreDownloadUsesPlatformAssetAndVerifiedReplacement(t *testing.T) {
	for _, kind := range []string{platform.UFI, platform.Linux} {
		t.Run(kind, func(t *testing.T) {
			target, arch, err := coreTarget(kind, runtime.GOARCH)
			if err != nil {
				t.Skip("core is not published for this host architecture")
			}
			a := testAgent(t)
			a.Platform = releasePlatform{a.Platform, kind}
			if err := os.WriteFile(a.corePath(), []byte("old core"), 0700); err != nil {
				t.Fatal(err)
			}
			var archive bytes.Buffer
			gz := gzip.NewWriter(&archive)
			_, _ = gz.Write([]byte("verified core"))
			if err := gz.Close(); err != nil {
				t.Fatal(err)
			}
			sum := sha256.Sum256(archive.Bytes())
			digest := hex.EncodeToString(make([]byte, 32))
			name := "mihomo-" + target + "-" + arch + "-v1.2.3.gz"
			if err := a.applyDownloadSettings(new("https://mirror.invalid/cache")); err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Host != "mirror.invalid" {
					http.Error(w, "direct GitHub blocked", 403)
					return
				}
				path := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/cache/https://api.github.com"), "/cache/https://github.com")
				switch path {
				case "/repos/MetaCubeX/mihomo/releases/latest":
					_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": "v1.2.3", "draft": false, "prerelease": false, "assets": []map[string]string{{"name": name, "browser_download_url": "https://github.com/MetaCubeX/mihomo/releases/download/v1.2.3/" + name, "digest": "sha256:" + digest}}})
				case "/MetaCubeX/mihomo/releases/download/v1.2.3/" + name:
					_, _ = w.Write(archive.Bytes())
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			a.httpTransport = localTransport{server.URL}
			probes := 0
			a.runCommand = func(_ context.Context, name string, _ ...string) ([]byte, error) {
				if name != "/system/bin/sh" {
					probes++
				}
				return []byte(`{"listeners":false,"network":false}`), nil
			}
			if _, err = a.downloadCore(context.Background(), t.TempDir(), func(string) {}); err == nil || probes != 0 {
				t.Fatal("executed unverified core", err)
			}
			if data, _ := os.ReadFile(a.corePath()); string(data) != "old core" {
				t.Fatal("changed core on failed verification")
			}
			digest = hex.EncodeToString(sum[:])
			if _, err = a.downloadCore(context.Background(), t.TempDir(), func(string) {}); err != nil {
				t.Fatal(err)
			}
			if data, _ := os.ReadFile(a.corePath()); string(data) != "verified core" || probes != 1 {
				t.Fatal("verified core was not installed")
			}
		})
	}
}

func TestReleaseVersionRejectsProductPrefixes(t *testing.T) {
	if _, err := releaseVersion("agent-v1.2.3"); err == nil {
		t.Fatal("accepted a product-prefixed tag")
	}
	for _, tag := range []string{"v1.2.3", "1.2.3"} {
		if _, err := releaseVersion(tag); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAgentUpdateUsesSemverAndVerifiedGitHubAsset(t *testing.T) {
	a := testAgent(t)
	a.Version = "v1.10.0"
	_ = os.WriteFile(a.path("mihomoctl"), []byte("previous agent"), 0700)
	payload := []byte("new agent fixture")
	sum := sha256.Sum256(payload)
	tag, digest, downloads, probes := "v1.9.9", hex.EncodeToString(sum[:]), 0, 0
	arch := runtime.GOARCH
	if arch == "arm" {
		arch = "armv7"
	}
	name := "mihomoctl-linux-" + arch
	if err := a.applyDownloadSettings(new("https://mirror.invalid/cache")); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "mirror.invalid" {
			http.Error(w, "direct GitHub blocked", 403)
			return
		}
		if r.URL.Path == "/cache/https://api.github.com/repos/imbytecat/mihomoctl/releases/latest" {
			_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": tag, "draft": false, "prerelease": false, "assets": []map[string]string{{"name": name, "browser_download_url": "https://github.com/imbytecat/mihomoctl/releases/download/" + tag + "/" + name, "digest": "sha256:" + digest}}})
		} else {
			downloads++
			_, _ = w.Write(payload)
		}
	}))
	defer server.Close()
	a.httpTransport = localTransport{server.URL}
	a.runCommand = func(_ context.Context, name string, _ ...string) ([]byte, error) {
		if name == "/system/bin/sh" {
			return []byte(`{"listeners":false,"network":false}`), nil
		}
		probes++
		// Installation must use the verified bytes, even if the probed path changes.
		if err := os.WriteFile(name, []byte("changed after verification"), 0700); err != nil {
			t.Fatal(err)
		}
		return json.Marshal(map[string]any{"version": "v1.11.0", "protocol": Protocol})
	}
	if _, err := a.updateAgent(context.Background(), t.TempDir(), func(string) {}); err != nil || downloads != 0 {
		t.Fatal("semver comparison failed", err)
	}
	tag = "v1.11.0"
	// Validly formatted but wrong digest must fail before the new executable runs.
	digest = hex.EncodeToString(make([]byte, 32))
	if _, err := a.updateAgent(context.Background(), t.TempDir(), func(string) {}); err == nil || probes != 0 {
		t.Fatal("executed unverified update")
	}
	if data, _ := os.ReadFile(a.path("mihomoctl")); string(data) != "previous agent" {
		t.Fatal("changed executable on failure")
	}
	digest = hex.EncodeToString(sum[:])
	previous, err := os.Open(a.Executable)
	if err != nil {
		t.Fatal(err)
	}
	defer previous.Close()
	if _, err := a.updateAgent(context.Background(), t.TempDir(), func(string) {}); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(a.path("mihomoctl")); string(data) != string(payload) || probes != 1 {
		t.Fatal("verified update not installed")
	}
	if data, err := io.ReadAll(previous); err != nil || string(data) != "previous agent" {
		t.Fatal("update modified the old executable inode", err)
	}
	if info, err := os.Stat(a.Executable); err != nil || info.Mode().Perm() != 0700 {
		t.Fatal("updated executable is not private and executable", err)
	}
	entries, _ := os.ReadDir(a.Root)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".mihomoctl") {
			t.Fatal("update left temporary files or backups", entry.Name())
		}
	}
}

func TestReleaseRequiresExplicitStableFlags(t *testing.T) {
	for _, data := range []string{
		`null`,
		`{"tag_name":"v1.2.3"}`,
		`{"tag_name":"v1.2.3","draft":null,"prerelease":false}`,
		`{"tag_name":"v1.2.3","draft":false,"prerelease":null}`,
		`{"tag_name":"v1.2.3","draft":true,"prerelease":false}`,
	} {
		if _, err := parseRelease([]byte(data)); err == nil {
			t.Fatal("accepted incomplete or unstable release", data)
		}
	}
}
