package platform

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	systemdbus "github.com/coreos/go-systemd/v22/dbus"
	"github.com/godbus/dbus/v5"
	"github.com/imbytecat/mihomo-agent/internal/host"
)

type Bus interface {
	GetAllPropertiesContext(context.Context, string) (map[string]any, error)
	StartUnitContext(context.Context, string, string, chan<- string) (int, error)
	StopUnitContext(context.Context, string, string, chan<- string) (int, error)
	StartTransientUnitContext(context.Context, string, string, []systemdbus.Property, chan<- string) (int, error)
	LinkUnitFilesContext(context.Context, []string, bool, bool) ([]systemdbus.LinkUnitFileChange, error)
	EnableUnitFilesContext(context.Context, []string, bool, bool) (bool, []systemdbus.EnableUnitFileChange, error)
	DisableUnitFilesContext(context.Context, []string, bool) ([]systemdbus.DisableUnitFileChange, error)
	ReloadContext(context.Context) error
	Close()
}
type systemBus struct{ *systemdbus.Conn }

func (b *systemBus) GetAllPropertiesContext(ctx context.Context, name string) (map[string]any, error) {
	units, err := b.ListUnitsByNamesContext(ctx, []string{name})
	if err != nil {
		return nil, err
	}
	if len(units) != 1 {
		return nil, errors.New("systemd 未返回唯一的 unit")
	}
	unit := units[0]
	if unit.LoadState == "not-found" && unit.ActiveState == "inactive" {
		return map[string]any{"Id": unit.Name, "LoadState": unit.LoadState, "ActiveState": unit.ActiveState, "MainPID": uint32(0), "ControlPID": uint32(0)}, nil
	}
	return b.Conn.GetAllPropertiesContext(ctx, name)
}

type SystemdAdapter struct {
	Environment
	deployment Config
	Connect    func(context.Context) (Bus, error)
	Ready      func(int) bool
	interval   time.Duration
}

func NewSystemd(config Config, env Environment) *SystemdAdapter {
	return &SystemdAdapter{Environment: env, deployment: config, Connect: func(ctx context.Context) (Bus, error) {
		connection, err := systemdbus.NewSystemConnectionContext(ctx)
		if err != nil {
			return nil, err
		}
		return &systemBus{connection}, nil
	}, Ready: host.Listeners, interval: time.Second}
}
func (a *SystemdAdapter) Config() Config { return a.deployment }
func (a *SystemdAdapter) Capabilities() Capabilities {
	return Capabilities{}
}
func (a *SystemdAdapter) Policy() Policy {
	return Policy{a.deployment.ListenAddress, a.deployment.ListenAddress, "127.0.0.1"}
}
func (a *SystemdAdapter) ExtraPaths() []string { return nil }
func (a *SystemdAdapter) CertDirs() []string   { return nil }

// Match the effective command, not the unit filename or a marker comment.
type unitExec struct {
	Path                                                       string
	Args                                                       []string
	IgnoreFailure                                              bool
	StartRealtime, StartMonotonic, ExitRealtime, ExitMonotonic uint64
	PID                                                        uint32
	Code, Status                                               int32
}

func (a *SystemdAdapter) properties(ctx context.Context, bus Bus) (map[string]any, error) {
	p, err := bus.GetAllPropertiesContext(ctx, a.deployment.Unit)
	if err != nil {
		return nil, err
	}
	if p["Id"] != a.deployment.Unit {
		return nil, errors.New("systemd unit 身份不匹配")
	}
	if p["LoadState"] == "not-found" {
		return p, nil
	}
	for _, name := range []string{"RootDirectory", "RootImage", "BindPaths", "BindReadOnlyPaths", "TemporaryFileSystem", "ExtensionImages", "ExtensionDirectories", "NetworkNamespacePath"} {
		value := p[name]
		if value == nil {
			continue
		}
		v := reflect.ValueOf(value)
		if (v.Kind() == reflect.String || v.Kind() == reflect.Slice) && v.Len() == 0 {
			continue
		}
		return nil, fmt.Errorf("不支持会改变路径或网络含义的 systemd 属性：%s", name)
	}
	fragment, hasFragment := p["FragmentPath"].(string)
	_, hasPID := p["MainPID"].(uint32)
	_, hasControlPID := p["ControlPID"].(uint32)
	if p["LoadState"] != "loaded" || !hasFragment || !filepath.IsAbs(fragment) || !hasPID || !hasControlPID || p["KillMode"] != "control-group" || p["WorkingDirectory"] != a.runtime() || p["PrivateNetwork"] != false {
		return nil, errors.New("systemd unit 未按部署约定配置")
	}
	var starts []unitExec
	if dbus.Store([]any{p["ExecStart"]}, &starts) != nil || len(starts) != 1 {
		return nil, errors.New("无法验证 systemd ExecStart")
	}
	// Linked units expose the systemd search-path link as FragmentPath.
	// File identity accepts that link without accepting an external copy.
	loaded, loadedErr := os.Stat(fragment)
	owned, ownedErr := os.Stat(a.unitPath())
	if loadedErr != nil || ownedErr != nil || !os.SameFile(loaded, owned) || starts[0].Path != a.CorePath() {
		return nil, errors.New("systemd unit 不属于本安装")
	}
	if drops, ok := p["DropInPaths"].([]string); !ok || len(drops) != 0 {
		return nil, errors.New("Agent 托管的 systemd unit 不接受 drop-in")
	}
	if err := a.checkUnitFile(); err != nil {
		return nil, err
	}
	argv := starts[0].Args
	if len(argv) != 5 || argv[0] != starts[0].Path || argv[1] != "-d" || argv[2] != a.runtime() || argv[3] != "-f" || argv[4] != a.runtime("current", "config.yaml") {
		return nil, errors.New("systemd 必须只运行本安装目录的配置")
	}
	return p, nil
}
func (a *SystemdAdapter) checkAddress() error {
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		return err
	}
	for _, address := range addresses {
		ip, _, e := net.ParseCIDR(address.String())
		if e == nil && ip.String() == a.deployment.ListenAddress {
			return nil
		}
	}
	return errors.New("Linux 监听地址不在本机接口上")
}
func (a *SystemdAdapter) state(p map[string]any) State {
	pid, _ := p["MainPID"].(uint32)
	controlPID, _ := p["ControlPID"].(uint32)
	active, _ := p["ActiveState"].(string)
	running := active == "active" || active == "activating" || active == "deactivating" || active == "reloading" || pid != 0 || controlPID != 0
	unitFile, _ := p["UnitFileState"].(string)
	return State{Running: running, Supervisor: active == "active" && p["SubState"] == "running", Listeners: pid > 1 && a.Ready(int(pid)), Boot: unitFile == "enabled" || unitFile == "enabled-runtime"}
}
func (a *SystemdAdapter) Inspect(ctx context.Context) (State, error) {
	bus, err := a.Connect(ctx)
	if err != nil {
		return State{}, err
	}
	defer bus.Close()
	p, err := a.properties(ctx, bus)
	if err != nil {
		return State{}, err
	}
	return a.state(p), nil // Capture/network are intentionally not claimed: the OS owns them.
}
func waitSystemd(ctx context.Context, ch <-chan string) error {
	select {
	case result := <-ch:
		if result != "done" {
			return fmt.Errorf("systemd 任务未完成：%s", result)
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (a *SystemdAdapter) change(ctx context.Context, start bool) (resultErr error) {
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	bus, err := a.Connect(ctx)
	if err != nil {
		return err
	}
	defer bus.Close()
	p, err := a.properties(ctx, bus)
	if err != nil {
		return err
	}
	if p["LoadState"] != "loaded" {
		if !start && !a.state(p).Running {
			return nil
		}
		return errors.New("systemd unit 未加载")
	}
	if start {
		if err := a.checkAddress(); err != nil {
			return err
		}
	}
	issued := false
	defer func() {
		if start && issued && resultErr != nil {
			cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			resultErr = errors.Join(resultErr, a.change(cleanup, false))
		}
	}()
	done := make(chan string, 1)
	if start {
		issued = true
		_, err = bus.StartUnitContext(ctx, a.deployment.Unit, "replace", done)
	} else {
		_, err = bus.StopUnitContext(ctx, a.deployment.Unit, "replace", done)
	}
	if err != nil {
		return err
	}
	if err = waitSystemd(ctx, done); err != nil {
		return err
	}
	stable := 0
	for {
		p, err = a.properties(ctx, bus)
		if err != nil {
			return err
		}
		s := a.state(p)
		if !start && !s.Running {
			return nil
		}
		if start && s.Supervisor && s.Listeners {
			stable++
		} else {
			stable = 0
		}
		if start && stable >= 5 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(a.interval):
		}
	}
}
func (a *SystemdAdapter) Start(ctx context.Context, _ StartOptions) error { return a.change(ctx, true) }
func (a *SystemdAdapter) Stop(ctx context.Context) error                  { return a.change(ctx, false) }
func (a *SystemdAdapter) AttachTask(ctx context.Context, pid int, id string) error {
	bus, err := a.Connect(ctx)
	if err != nil {
		return err
	}
	defer bus.Close()
	done := make(chan string, 1)
	_, err = bus.StartTransientUnitContext(ctx, "mihomo-agent-task-"+id+".scope", "fail", []systemdbus.Property{
		systemdbus.PropDescription("Mihomo Agent task"), systemdbus.PropSlice("system.slice"),
		{Name: "PIDs", Value: dbus.MakeVariant([]uint32{uint32(pid)})},
		{Name: "CollectMode", Value: dbus.MakeVariant("inactive-or-failed")},
	}, done)
	if err != nil {
		return err
	}
	return waitSystemd(ctx, done)
}
func (a *SystemdAdapter) Journal(ctx context.Context) (string, error) {
	bus, err := a.Connect(ctx)
	if err != nil {
		return "", err
	}
	defer bus.Close()
	if _, err = a.properties(ctx, bus); err != nil {
		return "", err
	}
	output, err := a.command(ctx, nil, "journalctl", "--unit", a.deployment.Unit, "--no-pager", "--lines=100", "--output=short")
	return strings.TrimSpace(string(output)), err
}
