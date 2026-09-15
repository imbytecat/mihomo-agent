package manager

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"sync/atomic"
	"testing"
)

func TestInstalledVersionsRefreshCachedComparisonsWithoutNetwork(t *testing.T) {
	a := testAgent(t)
	a.Version = "v1.0.0"
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		versions := map[string]string{
			"/repos/imbytecat/mihomoctl/releases/latest": "v1.1.0",
			"/repos/MetaCubeX/mihomo/releases/latest":    "v1.20.0",
			"/repos/Zephyruso/zashboard/releases/latest": "v3.0.0",
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": versions[r.URL.Path], "draft": false, "prerelease": false})
	}))
	defer server.Close()
	a.httpTransport = localTransport{server.URL}
	checked, err := a.CheckUpdates(context.Background())
	if err != nil || checked.Core.State != "not-installed" || checked.Dashboard.State != "not-installed" {
		t.Fatal(checked, err)
	}
	// Simulate installing the queried core and dashboard, plus an Agent newer
	// than the cached release. Inspect must use semver, not string equality.
	a.Version = "v1.2.0"
	if err := os.WriteFile(a.corePath(), []byte("installed core"), 0700); err != nil {
		t.Fatal(err)
	}
	a.runCommand = func(_ context.Context, name string, _ ...string) ([]byte, error) {
		if name == a.corePath() {
			return []byte("Mihomo Meta 1.20.0 linux arm64"), nil
		}
		return []byte(`{"listeners":false,"network":false}`), nil
	}
	id := randomID()
	if err := os.MkdirAll(a.runtime("dashboards", id), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(a.runtime("dashboards", id, "index.html"), []byte("dashboard"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := a.store.SaveDashboard(id, "v3.0.0"); err != nil {
		t.Fatal(err)
	}
	if err := a.switchDashboard("dashboards/" + id); err != nil {
		t.Fatal(err)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	status, err := a.Inspect()
	if err != nil || status.Updates == nil {
		t.Fatal(status, err)
	}
	for _, update := range []ComponentUpdate{status.Updates.Self, status.Updates.Core, status.Updates.Dashboard} {
		if update.State != "up-to-date" || update.Current == "" {
			t.Fatal("stale comparison", update)
		}
	}
	stored, err := a.store.Updates()
	if err != nil || !reflect.DeepEqual(*stored, checked) || status.Updates.CheckedAt != checked.CheckedAt || requests.Load() != 3 {
		t.Fatal("status rewrote or repeated the network check", stored, requests.Load(), err)
	}
}

func TestCheckUpdatesComparesSemverWithoutCreatingTasks(t *testing.T) {
	a := testAgent(t)
	a.Version = "v1.9.9"
	if err := os.WriteFile(a.corePath(), []byte("installed core"), 0700); err != nil {
		t.Fatal(err)
	}
	a.runCommand = func(context.Context, string, ...string) ([]byte, error) {
		return []byte("Mihomo Meta v1.19.30 linux arm64"), nil
	}
	var invalid atomic.Bool
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		versions := map[string]string{
			"/repos/imbytecat/mihomoctl/releases/latest": "v1.10.0",
			"/repos/MetaCubeX/mihomo/releases/latest":    "v1.19.30",
			"/repos/Zephyruso/zashboard/releases/latest": "v3.26.0",
		}
		if invalid.Load() && r.URL.Path == "/repos/imbytecat/mihomoctl/releases/latest" {
			_, _ = w.Write([]byte("null"))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": versions[r.URL.Path], "draft": false, "prerelease": false})
	}))
	defer server.Close()
	a.httpTransport = localTransport{server.URL}
	result, err := a.CheckUpdates(context.Background())
	if err != nil || result.Self.State != "available" || result.Self.Latest != "v1.10.0" || result.Core.State != "up-to-date" || result.Dashboard.State != "not-installed" || result.CheckedAt == "" {
		t.Fatal(result, err)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	// A new CLI invocation reads the last check without contacting upstream.
	state, err := a.Inspect()
	if err != nil || state.Updates == nil || *state.Updates != result || requests.Load() != 3 {
		t.Fatal("update check was not persisted", state.Updates, err, requests.Load())
	}
	a.Version = "development"
	state, err = a.Inspect()
	if err != nil || state.Version != "development" || state.Updates.Self.Current != "development" || state.Updates.Self.State != "unknown" || requests.Load() != 3 {
		t.Fatal("cached comparison replaced installed version", state, err)
	}
	result, err = a.CheckUpdates(context.Background())
	if err != nil || result.Self.State != "unknown" {
		t.Fatal("unknown versions must not claim to be current", result, err)
	}
	invalid.Store(true)
	result, err = a.CheckUpdates(context.Background())
	if err != nil || result.Self.State != "error" || result.Self.Error == "" || result.Core.State != "up-to-date" {
		t.Fatal("one failed query must not discard the others", result, err)
	}
	invalid.Store(false)
	result, err = a.CheckUpdates(context.Background())
	if err != nil || result.Core.State != "up-to-date" {
		t.Fatal("release queries did not recover", result, err)
	}
	if id, _ := a.store.LatestTask(); id != "" {
		t.Fatal("an update check created a task")
	}
	if data, _ := os.ReadFile(a.corePath()); string(data) != "installed core" {
		t.Fatal("an update check changed the executable")
	}
}
