package manager

import (
	"context"
	"errors"
	"testing"

	"github.com/imbytecat/ufi-mihomo/agent/internal/platform"
	"github.com/imbytecat/ufi-mihomo/agent/internal/storage"
	"go.yaml.in/yaml/v3"
)

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
	if _, err := a.Submit(Request{ID: id, Action: "save-github-proxy", Params: Params{GitHubProxy: ptr("https://example.com")}}); err == nil {
		t.Fatal("ignored failed attachment")
	}
	job, err := a.Job(id)
	if err != nil || job.State != "failed" {
		t.Fatal(job, err)
	}
	settings, err := a.settings()
	if err != nil || settings.GitHubProxy != "" {
		t.Fatal("unhosted worker changed settings", err)
	}
	for _, data := range []string{
		`{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"update","value":"legacy"}`,
		`{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"stop","params":{"url":"https://example.com"}}`,
		`{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"save-controller","params":{"controller":{"enabled":true,"port":9090,"unknown":1}}}`,
	} {
		if _, err := DecodeRequest([]byte(data)); err == nil {
			t.Fatal("accepted malformed request")
		}
	}
}

type managedPlatform struct{ platform.Adapter }

func (p managedPlatform) Capabilities() platform.Capabilities { return platform.Capabilities{} }
func TestSystemOwnedCapabilitiesRejectBeforeTaskCreation(t *testing.T) {
	a := testAgent(t)
	a.Platform = managedPlatform{a.Platform}
	for _, action := range []string{"download", "update-agent", "boot-on", "boot-off", "save-interfaces"} {
		params := Params{}
		if action == "save-interfaces" {
			params.Interfaces = ptr("eth0")
		}
		if _, err := a.Submit(Request{Action: action, Params: params}); err == nil {
			t.Fatal("allowed unsupported action", action)
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
	row := storage.Configuration{ID: randomID(), URL: "https://example.com", Controller: ptrController(control)}
	if err := a.store.SaveConfiguration(row); err != nil {
		t.Fatal(err)
	}
	if actual, err := a.store.Configuration(row.ID); err != nil || actual.URL != row.URL || *actual.Controller != *row.Controller {
		t.Fatal("configuration metadata lost", err)
	}
}
