package platform

import (
	"context"
	"errors"
	"github.com/coreos/go-systemd/v22/unit"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	systemdbus "github.com/coreos/go-systemd/v22/dbus"
)

type fakeBus struct {
	properties map[string]any
	calls      []string
	result     string
	fail       bool
	scopePID   uint32
}

func (b *fakeBus) Close() {}
func (b *fakeBus) GetAllPropertiesContext(context.Context, string) (map[string]any, error) {
	if b.fail {
		return nil, errors.New("bus unavailable")
	}
	return b.properties, nil
}
func (b *fakeBus) StartUnitContext(_ context.Context, _ string, _ string, ch chan<- string) (int, error) {
	b.calls = append(b.calls, "start")
	b.properties["ActiveState"] = "active"
	b.properties["SubState"] = "running"
	b.properties["MainPID"] = uint32(123)
	ch <- b.result
	return 1, nil
}
func (b *fakeBus) StopUnitContext(_ context.Context, _ string, _ string, ch chan<- string) (int, error) {
	b.calls = append(b.calls, "stop")
	b.properties["ActiveState"] = "inactive"
	b.properties["SubState"] = "dead"
	b.properties["MainPID"] = uint32(0)
	b.properties["ControlPID"] = uint32(0)
	ch <- b.result
	return 2, nil
}
func (b *fakeBus) StartTransientUnitContext(_ context.Context, name, mode string, properties []systemdbus.Property, ch chan<- string) (int, error) {
	b.calls = append(b.calls, name)
	for _, p := range properties {
		if p.Name == "PIDs" {
			b.scopePID = p.Value.Value().([]uint32)[0]
		}
	}
	ch <- b.result
	return 3, nil
}
func systemdFixture(t *testing.T) (*SystemdAdapter, *fakeBus) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "mihomo-agent")
	core := filepath.Join(t.TempDir(), "mihomo")
	if err := os.WriteFile(core, []byte("fixture"), 0700); err != nil {
		t.Fatal(err)
	}
	config := Config{Kind: Linux, CorePath: core, Unit: "mihomo-agent-core.service", ListenAddress: "127.0.0.1"}
	p := NewSystemd(config, Environment{Root: root})
	b := &fakeBus{result: "done", properties: map[string]any{
		"Id": config.Unit, "LoadState": "loaded", "FragmentPath": "/etc/systemd/system/mihomo-agent-core.service",
		"WorkingDirectory": p.runtime(), "PrivateNetwork": false, "KillMode": "control-group", "MainPID": uint32(0), "ControlPID": uint32(0),
		"ActiveState": "inactive", "SubState": "dead", "UnitFileState": "enabled",
		"ExecStart": []unitExec{{Path: core, Args: []string{core, "-d", p.runtime(), "-f", p.runtime("current", "config.yaml")}}},
	}}
	p.Connect = func(context.Context) (Bus, error) { return b, nil }
	p.Ready = func(pid int) bool { return pid == 123 }
	p.interval = time.Millisecond
	return p, b
}
func TestSystemdLifecycleAndExternalOwnership(t *testing.T) {
	p, b := systemdFixture(t)
	if err := p.Prepare(); err != nil {
		t.Fatal(err)
	}
	if c := p.Capabilities(); c.CoreInstall || c.AgentUpdate || c.Autostart || c.Capture {
		t.Fatal("claimed system-owned resources")
	}
	if err := p.Start(context.Background(), StartOptions{}); err != nil {
		t.Fatal(err)
	}
	state, err := p.Inspect(context.Background())
	if err != nil || !state.Running || !state.Listeners || state.Capture || state.Network {
		t.Fatal(state, err)
	}
	if err := p.SetBoot(context.Background(), false); err == nil {
		t.Fatal("mutated external autostart")
	}
	if err := p.Remove(context.Background()); err == nil {
		t.Fatal("deleted data still referenced by a unit")
	}
	if err := p.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	b.properties["UnitFileState"] = "disabled"
	if err := p.Remove(context.Background()); err == nil {
		t.Fatal("disabled units still reference deployment")
	}
	b.properties["LoadState"] = "not-found"
	if err := p.Remove(context.Background()); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(p.CorePath()); string(data) != "fixture" {
		t.Fatal("changed external core")
	}
	if err := p.AttachTask(context.Background(), 123, "abcdef"); err != nil || b.scopePID != 123 {
		t.Fatal("worker not attached to scope", err)
	}
}
func TestSystemdRefusesForeignOrUnknownUnits(t *testing.T) {
	for _, mutation := range []func(*fakeBus){
		func(b *fakeBus) { b.properties["Id"] = "ssh.service" },
		func(b *fakeBus) { delete(b.properties, "FragmentPath") },
		func(b *fakeBus) { b.properties["WorkingDirectory"] = "/another-installation" },
		func(b *fakeBus) { b.properties["PrivateNetwork"] = true },
		func(b *fakeBus) { b.properties["KillMode"] = "process" },
		func(b *fakeBus) { delete(b.properties, "MainPID") },
		func(b *fakeBus) { b.properties["RootDirectory"] = "/foreign" },
		func(b *fakeBus) { b.properties["BindReadOnlyPaths"] = []string{"/foreign:/data"} },
		func(b *fakeBus) {
			b.properties["ExecStart"] = []unitExec{{Path: "/bin/sh", Args: []string{"sh", "-c", "mihomo"}}}
		},
		func(b *fakeBus) {
			exec := b.properties["ExecStart"].([]unitExec)
			exec[0].Args[4] = "/foreign/config.yaml"
		},
		func(b *fakeBus) { b.fail = true },
	} {
		p, b := systemdFixture(t)
		mutation(b)
		if err := p.Start(context.Background(), StartOptions{}); err == nil {
			t.Fatal("started an unverified unit")
		}
		if err := p.Stop(context.Background()); err == nil {
			t.Fatal("stopped an unverified unit")
		}
		if len(b.calls) != 0 {
			t.Fatal("mutated before verifying ownership")
		}
	}
}
func TestSystemdJobFailureAndReadinessTimeout(t *testing.T) {
	p, b := systemdFixture(t)
	b.result = "failed"
	if err := p.Start(context.Background(), StartOptions{}); err == nil {
		t.Fatal("ignored failed job")
	}
	p, b = systemdFixture(t)
	p.Ready = func(int) bool { return false }
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := p.Start(ctx, StartOptions{}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	if state := p.state(b.properties); state.Running {
		t.Fatal("startup failure left the core running")
	}
	b.properties["ActiveState"] = "inactive"
	b.properties["MainPID"] = uint32(0)
	b.properties["ControlPID"] = uint32(456)
	if state := p.state(b.properties); !state.Running {
		t.Fatal("ignored outstanding control process")
	}
}
func TestPlatformSelectionAndListenPolicy(t *testing.T) {
	for _, value := range []string{"0.0.0.0", "8.8.8.8", "::1", "not-an-address"} {
		c := Config{Kind: Linux, CorePath: "/usr/bin/mihomo", Unit: "mihomo-agent-core.service", ListenAddress: value}
		if c.Validate() == nil {
			t.Fatal("accepted unsafe listen address", value)
		}
	}
	p, _ := systemdFixture(t)
	p.deployment.ListenAddress = "192.168.255.254"
	if p.checkAddress() == nil {
		t.Fatal("accepted address not on this host")
	}
	if policy := p.Policy(); policy.Controller != "127.0.0.1" || policy.Bind == "*" {
		t.Fatal("exposed controller or wildcard listeners")
	}
}

func TestUnitUsesLibrarySerialization(t *testing.T) {
	p, _ := systemdFixture(t)
	text, err := p.Unit()
	if err != nil {
		t.Fatal(err)
	}
	options, err := unit.Deserialize(strings.NewReader(text))
	if err != nil {
		t.Fatal(err)
	}
	values := map[string]string{}
	for _, option := range options {
		values[option.Section+"/"+option.Name] = option.Value
	}
	if values["Service/KillMode"] != "control-group" || values["Service/WorkingDirectory"] != p.runtime() || !strings.Contains(values["Service/ExecStart"], "config.yaml") {
		t.Fatal("unit does not bind the managed deployment")
	}
}
