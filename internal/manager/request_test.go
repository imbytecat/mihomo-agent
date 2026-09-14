package manager

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/imbytecat/mihomoctl/internal/platform"
	"github.com/imbytecat/mihomoctl/internal/storage"
	"go.yaml.in/yaml/v3"
)

func TestInvalidInstallParamsDoNotInitializeState(t *testing.T) {
	root := filepath.Join(t.TempDir(), "mihomoctl")
	a, err := testManager(root)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if err := a.Install("http://invalid.example"); err == nil {
		t.Fatal("accepted insecure mirror")
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatal("invalid install created state", err)
	}
}

func TestOldProtocolIsRejectedWithoutMigration(t *testing.T) {
	root := filepath.Join(t.TempDir(), "mihomoctl")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := storage.Initialize(root, storage.Identity{Protocol: Protocol - 1}, storage.Deployment{Kind: "ufi"}, storage.Controller{}); err != nil {
		t.Fatal(err)
	}
	a, err := testManager(root)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if _, err := a.Inspect(); err == nil {
		t.Fatal("accepted old status protocol")
	}
	if _, err := a.Submit(Request{Action: "stop"}); err == nil {
		t.Fatal("accepted task for old protocol")
	}
	if err := a.Install(""); err == nil {
		t.Fatal("installed over old protocol")
	}
	if identity, err := a.store.Identity(); err != nil || identity.Protocol != Protocol-1 {
		t.Fatal("migrated old protocol", err)
	}
}

type failedLauncher struct {
	platform.Adapter
	manager *Manager
}

func (p failedLauncher) AttachTask(context.Context, int, string) error {
	settings, err := p.manager.settings()
	if err != nil || settings.GitHubProxy != "" {
		return errors.New("worker ran before attachment")
	}
	return errors.New("scope refused")
}
func TestWorkerGateAndTypedRequests(t *testing.T) {
	a := testAgent(t)
	a.Platform = failedLauncher{Adapter: a.Platform, manager: a}
	id := randomID()
	if _, err := a.Submit(Request{ID: id, Action: "save-github-proxy", Params: Params{GitHubProxy: new("https://example.com")}}); err == nil {
		t.Fatal("ignored failed attachment")
	}
	job, err := a.Job(id)
	if err != nil || job.State != "failed" {
		t.Fatal(job, err)
	}
	if data, err := a.store.Request(id); err != nil || len(data) != 0 {
		t.Fatal("failed launcher retained request", err)
	}
	settings, err := a.settings()
	if err != nil || settings.GitHubProxy != "" {
		t.Fatal("unhosted worker changed settings", err)
	}
	for _, data := range []string{
		`{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"update","unknown":"field"}`,
		`{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"update","value":"https://example.com"}`,
		`{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"update","params":{"value":"https://example.com"}}`,
		`{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"stop","params":{"url":"https://example.com"}}`,
		`{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"stop","params":{"url":""}}`,
		`{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"stop","params":{"URL":""}}`,
		`{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"stop","params":{"githubProxy":null}}`,
		`{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"stop","params":{"interfaces":null}}`,
		`{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"stop","params":{"controller":null}}`,
		`{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"save-controller","params":{"controller":{"enabled":true,"port":9090,"unknown":1}}}`,
	} {
		if _, err := DecodeRequest([]byte(data)); err == nil {
			t.Fatal("accepted malformed request")
		}
	}
}

func TestTaskPreparationFailureIsTerminal(t *testing.T) {
	a := testAgent(t)
	if err := os.WriteFile(a.path("tasks"), []byte("blocked"), 0600); err != nil {
		t.Fatal(err)
	}
	id := randomID()
	if _, err := a.Submit(Request{ID: id, Action: "stop"}); err == nil {
		t.Fatal("ignored task directory failure")
	}
	job, err := a.store.Task(id)
	if err != nil || job.State != "failed" {
		t.Fatal("launcher left accepted task queued", job, err)
	}
	if data, err := a.store.Request(id); err != nil || len(data) != 0 {
		t.Fatal("failed preparation retained request", err)
	}
}

type systemNetworkPlatform struct{ platform.Adapter }

func (p systemNetworkPlatform) Capabilities() platform.Capabilities { return platform.Capabilities{} }
func TestSystemOwnedInterfacesRejectBeforeTaskCreation(t *testing.T) {
	a := testAgent(t)
	a.Platform = systemNetworkPlatform{a.Platform}
	for _, action := range []string{"save-interfaces", "start"} {
		if _, err := a.Submit(Request{Action: action, Params: Params{Interfaces: new("eth0")}}); err == nil {
			t.Fatal("allowed unmanaged network configuration", action)
		}
	}
	if id, err := a.store.LatestTask(); err == nil || id != "" {
		t.Fatal("unsupported action created a task")
	}
}
func TestLinuxConfigurationIsExplicitlyBound(t *testing.T) {
	a := testAgent(t)
	control, _ := a.controller()
	source := []byte("proxies: []\nbind-address: '*'\ndns: {listen: '0.0.0.0:1053'}\n")
	encoded, _, err := adaptConfig(source, control, false, platform.Policy{Bind: "192.168.10.2", DNS: "192.168.10.2", Controller: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := yaml.Unmarshal(encoded, &config); err != nil {
		t.Fatal(err)
	}
	if config["bind-address"] != "192.168.10.2" || config["external-controller"] != "127.0.0.1:9090" || config["dns"].(map[string]any)["listen"] != "192.168.10.2:1053" {
		t.Fatal("Linux binding policy not applied")
	}
	for _, extra := range []string{"ss-config: 'unsafe'", "vmess-config: 'unsafe'", "tuic-server: {enable: true}", "iptables: {enable: true}"} {
		if _, _, err := adaptConfig(append(source, []byte(extra+"\n")...), control, false, ufiPolicy); err == nil {
			t.Fatal("accepted an unmanaged listener or network owner", extra)
		}
	}
	row := storage.Configuration{ID: randomID(), URL: "https://example.com", Controller: new(storage.Controller(control))}
	if err := a.store.SaveConfiguration(row); err != nil {
		t.Fatal(err)
	}
	if actual, err := a.store.Configuration(row.ID); err != nil || actual.URL != row.URL || *actual.Controller != *row.Controller {
		t.Fatal("configuration metadata lost", err)
	}
}
