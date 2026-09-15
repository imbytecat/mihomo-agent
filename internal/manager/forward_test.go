package manager

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestPersistedForwardingCoversAllReleasesButNotSubscriptions(t *testing.T) {
	a := testAgent(t)
	var mu sync.Mutex
	var targets []string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target := strings.TrimPrefix(r.URL.Path, "/")
		mu.Lock()
		targets = append(targets, target)
		mu.Unlock()
		if strings.HasPrefix(target, "https://api.github.com/repos/") {
			_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": "v1.2.3", "draft": false, "prerelease": false})
		} else if strings.HasPrefix(target, "https://github.com/") {
			_, _ = w.Write([]byte("verified elsewhere"))
		} else {
			http.Error(w, "unexpected forwarded URL", http.StatusBadRequest)
		}
	}))
	defer server.Close()
	if _, err := a.execute(context.Background(), Request{ID: randomID(), Action: "save-release-proxy", Params: Params{ReleaseProxy: new(server.URL + "/")}}, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	// A new CLI/worker reopens the stored setting without flags or browser state.
	a.httpTransport = server.Client().Transport
	if _, err := a.CheckUpdates(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, repo := range []string{"imbytecat/mihomoctl", "MetaCubeX/mihomo", "Zephyruso/zashboard"} {
		destination := filepath.Join(t.TempDir(), "asset")
		if err := a.fetchRelease(context.Background(), "https://github.com/"+repo+"/releases/download/v1.2.3/asset", destination, 1024); err != nil {
			t.Fatal(err)
		}
		if data, _ := os.ReadFile(destination); string(data) != "verified elsewhere" {
			t.Fatal("download bytes changed")
		}
	}
	mu.Lock()
	if len(targets) != 6 {
		t.Errorf("expected three metadata and three asset requests, got %v", targets)
	}
	mu.Unlock()
	subscription := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/subscription" {
			t.Errorf("subscription was rewritten: %s", r.URL)
		}
		_, _ = w.Write([]byte("proxies: []"))
	}))
	defer subscription.Close()
	if err := a.fetch(context.Background(), subscription.URL+"/subscription", filepath.Join(t.TempDir(), "source.yaml"), 1024); err != nil {
		t.Fatal(err)
	}
	if _, err := a.execute(context.Background(), Request{ID: randomID(), Action: "save-release-proxy", Params: Params{ReleaseProxy: new("")}}, func(string) {}); err != nil {
		t.Fatal(err)
	}
	settings, err := a.settings()
	if err != nil || settings.ReleaseProxy != "" {
		t.Fatal("could not restore direct downloads", settings, err)
	}
}
