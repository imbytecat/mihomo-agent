package platform

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	systemdbus "github.com/coreos/go-systemd/v22/dbus"
	"github.com/coreos/go-systemd/v22/unit"
	"github.com/imbytecat/mihomo-agent/internal/fsutil"
)

type fakeBus struct {
	properties    map[string]any
	calls         []string
	result        string
	fail          bool
	scopePID      uint32
	unitPath      string
	linked        bool
	failOperation string
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
func (b *fakeBus) LinkUnitFilesContext(_ context.Context, files []string, runtime, force bool) ([]systemdbus.LinkUnitFileChange, error) {
	b.calls = append(b.calls, "link")
	if b.failOperation == "link" || force || runtime || len(files) != 1 || files[0] != b.unitPath {
		return nil, errors.New("link refused")
	}
	b.linked = true
	return nil, nil
}
func (b *fakeBus) EnableUnitFilesContext(_ context.Context, files []string, runtime, force bool) (bool, []systemdbus.EnableUnitFileChange, error) {
	b.calls = append(b.calls, "enable")
	if b.failOperation == "enable" || force || runtime || len(files) != 1 || files[0] != b.unitPath {
		return false, nil, errors.New("enable refused")
	}
	b.linked = true
	b.properties["UnitFileState"] = "enabled"
	return true, nil, nil
}
func (b *fakeBus) DisableUnitFilesContext(_ context.Context, _ []string, _ bool) ([]systemdbus.DisableUnitFileChange, error) {
	b.calls = append(b.calls, "disable")
	if b.failOperation == "disable" {
		return nil, errors.New("disable refused")
	}
	b.linked = false
	b.properties["UnitFileState"] = "disabled"
	return nil, nil
}
func (b *fakeBus) ReloadContext(context.Context) error {
	b.calls = append(b.calls, "reload")
	if b.failOperation == "reload" {
		return errors.New("reload refused")
	}
	b.properties["LoadState"] = "not-found"
	if _, err := os.Stat(b.unitPath); err == nil && b.linked {
		b.properties["LoadState"] = "loaded"
	}
	return nil
}

func systemdFixture(t *testing.T) (*SystemdAdapter, *fakeBus) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "mihomo-agent")
	config := Config{Kind: Linux, Unit: "mihomo-agent-core.service", ListenAddress: "127.0.0.1"}
	p := NewSystemd(config, Environment{Root: root})
	core := p.CorePath()
	if err := fsutil.AtomicWrite(core, []byte("fixture"), 0700); err != nil {
		t.Fatal(err)
	}
	content, err := p.Unit()
	if err != nil {
		t.Fatal(err)
	}
	if err = fsutil.AtomicWrite(p.unitPath(), []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	b := &fakeBus{result: "done", unitPath: p.unitPath(), linked: true, properties: map[string]any{
		"Id": config.Unit, "LoadState": "loaded", "FragmentPath": p.unitPath(), "DropInPaths": []string{},
		"WorkingDirectory": p.runtime(), "PrivateNetwork": false, "KillMode": "control-group", "MainPID": uint32(0), "ControlPID": uint32(0),
		"ActiveState": "inactive", "SubState": "dead", "UnitFileState": "enabled",
		"ExecStart": []unitExec{{Path: core, Args: []string{core, "-d", p.runtime(), "-f", p.runtime("current", "config.yaml")}}},
	}}
	p.Connect = func(context.Context) (Bus, error) { return b, nil }
	p.Ready = func(pid int) bool { return pid == 123 }
	p.interval = time.Millisecond
	return p, b
}
func TestSystemdManagedLifecycle(t *testing.T) {
	p, b := systemdFixture(t)
	// Installation and inspection must work before the first core download.
	if err := os.Remove(p.CorePath()); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(p.unitPath()); err != nil {
		t.Fatal(err)
	}
	b.linked = false
	b.properties["LoadState"] = "not-found"
	b.properties["UnitFileState"] = "disabled"
	if err := p.Prepare(); err != nil {
		t.Fatal(err)
	}
	if c := p.Capabilities(); !c.CoreInstall || !c.AgentUpdate || !c.Autostart || c.Capture || c.Interfaces {
		t.Fatal("incorrect managed capabilities", c)
	}
	if state, err := p.Inspect(context.Background()); err != nil || state.Running {
		t.Fatal("could not inspect before first download", state, err)
	}
	if err := fsutil.AtomicWrite(p.CorePath(), []byte("fixture"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := p.Start(context.Background(), StartOptions{}); err != nil {
		t.Fatal(err)
	}
	state, err := p.Inspect(context.Background())
	if err != nil || !state.Running || !state.Listeners || state.Capture || state.Network {
		t.Fatal(state, err)
	}
	for _, enabled := range []bool{true, false, true} {
		if err := p.SetBoot(context.Background(), enabled); err != nil {
			t.Fatal(err)
		}
		if !b.linked || p.state(b.properties).Boot != enabled {
			t.Fatal("autostart lost unit link or did not change")
		}
	}
	if err := p.Remove(context.Background()); err != nil {
		t.Fatal(err)
	}
	if b.linked || b.properties["LoadState"] != "not-found" || p.state(b.properties).Running {
		t.Fatal("removed data before stopping and unlinking unit")
	}
	if _, err := os.Stat(p.unitPath()); !os.IsNotExist(err) {
		t.Fatal("left unit source", err)
	}
	if err := p.Remove(context.Background()); err != nil {
		t.Fatal("cleanup cannot be retried", err)
	}
	if err := p.AttachTask(context.Background(), 123, "abcdef"); err != nil || b.scopePID != 123 {
		t.Fatal("worker not attached to scope", err)
	}
}
func TestSystemdRefusesForeignOrUnknownUnits(t *testing.T) {
	for _, mutation := range []func(*fakeBus){
		func(b *fakeBus) { b.properties["Id"] = "ssh.service" },
		func(b *fakeBus) { delete(b.properties, "FragmentPath") },
		func(b *fakeBus) { b.properties["FragmentPath"] = "/etc/systemd/system/foreign.service" },
		func(b *fakeBus) { b.properties["DropInPaths"] = []string{"/etc/systemd/system/override.conf"} },
		func(b *fakeBus) { _ = os.WriteFile(b.unitPath, []byte("foreign content"), 0600) },
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
		if err := p.Prepare(); err == nil {
			t.Fatal("installed over an unverified unit")
		}
		if err := p.SetBoot(context.Background(), true); err == nil {
			t.Fatal("enabled an unverified unit")
		}
		if err := p.Remove(context.Background()); err == nil {
			t.Fatal("removed an unverified unit")
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

func TestSystemdManagedCleanupFailureCanBeRetried(t *testing.T) {
	for _, operation := range []string{"disable", "reload"} {
		t.Run(operation, func(t *testing.T) {
			p, b := systemdFixture(t)
			b.failOperation = operation
			if err := p.Remove(context.Background()); err == nil {
				t.Fatal("ignored systemd cleanup failure")
			}
			if data, err := os.ReadFile(p.CorePath()); err != nil || string(data) != "fixture" {
				t.Fatal("deleted runtime data on cleanup failure", err)
			}
			b.failOperation = ""
			if err := p.Remove(context.Background()); err != nil {
				t.Fatal("cleanup retry failed", err)
			}
		})
	}
}

func TestSystemdManagedInstallAndBootFailures(t *testing.T) {
	for _, operation := range []string{"link", "reload", "enable", "disable"} {
		t.Run(operation, func(t *testing.T) {
			p, b := systemdFixture(t)
			b.failOperation = operation
			var err error
			switch operation {
			case "link", "reload":
				err = p.Prepare()
			case "enable":
				err = p.SetBoot(context.Background(), true)
			case "disable":
				err = p.SetBoot(context.Background(), false)
			}
			if err == nil {
				t.Fatal("reported success after D-Bus failure")
			}
			b.failOperation = ""
			if err := p.Prepare(); err != nil {
				t.Fatal("install retry failed", err)
			}
		})
	}
}
func TestPlatformSelectionAndListenPolicy(t *testing.T) {
	for _, value := range []string{"0.0.0.0", "8.8.8.8", "::1", "not-an-address"} {
		c := Config{Kind: Linux, Unit: "mihomo-agent-core.service", ListenAddress: value}
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
	p.Root = filepath.Join(t.TempDir(), "${MIHOMO_UNSET} % path", "mihomo-agent")
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
	if values["Service/KillMode"] != "control-group" || values["Service/WorkingDirectory"] != strings.ReplaceAll(p.runtime(), "%", "%%") || !strings.Contains(values["Service/ExecStart"], "config.yaml") {
		t.Fatal("unit does not bind the managed deployment")
	}
	if !strings.HasPrefix(values["Service/ExecStart"], ":") || !strings.Contains(values["Service/ExecStart"], "${MIHOMO_UNSET} %% path") {
		t.Fatal("unit permits environment or specifier expansion in paths")
	}
}
