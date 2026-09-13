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
	Close()
}
type systemBus struct{ *systemdbus.Conn }

func (b *systemBus) GetAllPropertiesContext(ctx context.Context, name string) (map[string]any, error) {
	properties, err := b.Conn.GetAllPropertiesContext(ctx, name)
	if err == nil {
		return properties, nil
	}
	var missing dbus.Error
	if !errors.As(err, &missing) || (missing.Name != "org.freedesktop.systemd1.NoSuchUnit" && missing.Name != "org.freedesktop.DBus.Error.UnknownObject") {
		return nil, err
	}
	loader, e := dbus.ConnectSystemBus()
	if e != nil {
		return nil, e
	}
	defer loader.Close()
	var path dbus.ObjectPath
	if e = loader.Object("org.freedesktop.systemd1", "/org/freedesktop/systemd1").CallWithContext(ctx, "org.freedesktop.systemd1.Manager.LoadUnit", 0, name).Store(&path); e != nil {
		var absent dbus.Error
		if errors.As(e, &absent) && absent.Name == "org.freedesktop.systemd1.NoSuchUnit" {
			return map[string]any{"Id": name, "LoadState": "not-found", "ActiveState": "inactive", "MainPID": uint32(0), "ControlPID": uint32(0)}, nil
		}
		return nil, e
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
func (a *SystemdAdapter) Config() Config             { return a.deployment }
func (a *SystemdAdapter) Capabilities() Capabilities { return Capabilities{} }
func (a *SystemdAdapter) CorePath() string           { return a.deployment.CorePath }
func (a *SystemdAdapter) Policy() Policy {
	return Policy{a.deployment.ListenAddress, a.deployment.ListenAddress, "127.0.0.1"}
}
func (a *SystemdAdapter) ExtraPaths() []string { return nil }
func (a *SystemdAdapter) CertDirs() []string   { return nil }
func (a *SystemdAdapter) SetBoot(context.Context, bool) error {
	return errors.New("开机启动由系统配置管理")
}

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
	real, err := filepath.EvalSymlinks(a.CorePath())
	if err != nil {
		return nil, err
	}
	executable, err := filepath.EvalSymlinks(starts[0].Path)
	if err != nil || real != executable {
		return nil, errors.New("systemd 内核路径不匹配")
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
func (a *SystemdAdapter) Prepare() error {
	info, err := os.Stat(a.CorePath())
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
		return errors.New("请先由系统安装可执行的 Mihomo 内核")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
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
		return errors.New("请先配置 systemd unit")
	}
	return a.checkAddress()
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
func (a *SystemdAdapter) Remove(ctx context.Context) error {
	bus, err := a.Connect(ctx)
	if err != nil {
		return err
	}
	defer bus.Close()
	p, err := a.properties(ctx, bus)
	if err != nil {
		return err
	}
	if p["LoadState"] != "not-found" || a.state(p).Running {
		return errors.New("请先停止并移除系统中的 Mihomo unit，再卸载 Agent 数据")
	}
	return nil
}
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
