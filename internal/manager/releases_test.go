package manager

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"testing"
)

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
	_ = os.WriteFile(a.path("agent"), []byte("previous agent"), 0700)
	payload := []byte("new agent fixture")
	sum := sha256.Sum256(payload)
	tag, digest, downloads, probes := "v1.9.9", hex.EncodeToString(sum[:]), 0, 0
	arch := runtime.GOARCH
	if arch == "arm" {
		arch = "armv7"
	}
	name := "mihomo-agent-linux-" + arch
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/repos/imbytecat/mihomo-agent/releases/latest" {
			_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": tag, "draft": false, "prerelease": false, "assets": []map[string]string{{"name": name, "browser_download_url": "https://github.com/imbytecat/mihomo-agent/releases/download/" + tag + "/" + name, "digest": "sha256:" + digest}}})
		} else {
			downloads++
			_, _ = w.Write(payload)
		}
	}))
	defer server.Close()
	a.httpClient = localHTTP{server.URL}
	a.runCommand = func(_ context.Context, name string, _ ...string) ([]byte, error) {
		if name == "/system/bin/sh" {
			return []byte(`{"listeners":false,"network":false}`), nil
		}
		probes++
		return []byte(`{"version":"v1.11.0","protocol":2}`), nil
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
	if data, _ := os.ReadFile(a.path("agent")); string(data) != "previous agent" {
		t.Fatal("changed executable on failure")
	}
	digest = hex.EncodeToString(sum[:])
	if _, err := a.updateAgent(context.Background(), t.TempDir(), func(string) {}); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(a.path("agent")); string(data) != string(payload) || probes != 1 {
		t.Fatal("verified update not installed")
	}
}
