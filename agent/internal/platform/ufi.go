package platform

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/imbytecat/ufi-mihomo/agent/internal/fsutil"
	"github.com/imbytecat/ufi-mihomo/agent/internal/host"
	"github.com/imbytecat/ufi-mihomo/agent/internal/redact"
)

//go:embed network_ufi.sh
var networkScript []byte

const UFIUploads = "/data/data/com.minikano.f50_sms/files/uploads"

type UFIAdapter struct {
	Environment
	BootPath string
}

func NewUFI(env Environment) *UFIAdapter {
	return &UFIAdapter{Environment: env, BootPath: "/sdcard/ufi_tools_boot.sh"}
}
func (a *UFIAdapter) Config() Config             { return Config{Kind: UFI} }
func (a *UFIAdapter) Capabilities() Capabilities { return Capabilities{true, true, true, true, true} }
func (a *UFIAdapter) CorePath() string           { return a.runtime("mihomo") }
func (a *UFIAdapter) Policy() Policy             { return Policy{"*", "0.0.0.0", "0.0.0.0"} }
func (a *UFIAdapter) ExtraPaths() []string       { return []string{a.Root + "-bootstrap"} }
func (a *UFIAdapter) CertDirs() []string {
	return []string{"/system/etc/security/cacerts", "/apex/com.android.conscrypt/cacerts"}
}
func (a *UFIAdapter) Prepare() error {
	return fsutil.AtomicWrite(a.runtime("network.sh"), networkScript, 0700)
}
func (a *UFIAdapter) AttachTask(context.Context, int, string) error { return nil }
func (a *UFIAdapter) Remove(ctx context.Context) error {
	if err := a.Stop(ctx); err != nil {
		return err
	}
	return a.SetBoot(ctx, false)
}
func (a *UFIAdapter) Inspect(ctx context.Context) (State, error) {
	s := State{Running: a.running(), Supervisor: a.alive("supervisor"), Capture: fsutil.RegularFile(a.runtime("network.active")) || fsutil.RegularFile(a.runtime("network.pending"))}
	if data, err := os.ReadFile(a.BootPath); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.TrimSpace(line) == a.BootLine() {
				s.Boot = true
			}
		}
	} else if !os.IsNotExist(err) {
		return s, err
	}
	output, err := a.command(ctx, nil, "/system/bin/sh", a.runtime("network.sh"), a.runtime(), "inspect")
	if err == nil {
		var n struct{ Listeners, Network bool }
		if json.Unmarshal(output, &n) == nil {
			s.Listeners = n.Listeners
			s.Network = n.Network
		}
	}
	return s, nil
}
func (a *UFIAdapter) process(name string) (*os.Process, bool) {
	var record host.Record
	if fsutil.ReadJSON(a.runtime(name+".json"), &record) != nil || record.PID < 2 || record.Start == "" || host.Start(record.PID) != record.Start {
		return nil, false
	}
	process, err := os.FindProcess(record.PID)
	return process, err == nil && process.Signal(syscall.Signal(0)) == nil
}

func (a *UFIAdapter) alive(name string) bool {
	process, alive := a.process(name)
	if process != nil {
		process.Release()
	}
	return alive
}
func (a *UFIAdapter) running() bool { return a.alive("core") || a.alive("supervisor") }

func (a *UFIAdapter) network(ctx context.Context, action string) error {
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	lock, err := os.OpenFile(a.runtime("network.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	for syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
	output, err := a.command(ctx, []*os.File{lock}, "/system/bin/sh", a.runtime("network.sh"), a.runtime(), action)
	if err != nil {
		return fmt.Errorf("网络规则 %s 失败：%s", action, redact.String(string(output)))
	}
	return nil
}

func (a *UFIAdapter) stopProcess(name string) error {
	p, alive := a.process(name)
	if p != nil {
		defer p.Release()
	}
	if !alive {
		return nil
	}
	if err := p.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	for i := 0; i < 50; i++ {
		time.Sleep(100 * time.Millisecond)
		q, live := a.process(name)
		if q != nil {
			q.Release()
		}
		if !live {
			return nil
		}
	}
	if err := p.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	for i := 0; i < 50; i++ {
		if !a.alive(name) {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errors.New("进程未退出，保留网络保护")
}

func (a *UFIAdapter) Stop(_ context.Context) error {
	if err := a.stopProcess("supervisor"); err != nil {
		return err
	}
	if err := a.stopProcess("core"); err != nil {
		return err
	}
	if fsutil.RegularFile(a.runtime("network.owned")) {
		if err := a.network(context.Background(), "stop"); err != nil {
			return err
		}
	}
	return nil
}

func (a *UFIAdapter) Start(ctx context.Context, options StartOptions) error {
	if err := fsutil.AtomicWrite(a.runtime("interfaces"), []byte(strings.Join(options.Interfaces, " ")), 0600); err != nil {
		return err
	}
	if err := a.Stop(context.Background()); err != nil {
		return err
	}
	if err := fsutil.AtomicWrite(a.runtime("network.sh"), networkScript, 0700); err != nil {
		return err
	}
	log, err := os.OpenFile(a.runtime("supervisor.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer log.Close()
	cmd := exec.Command(a.Executable, "supervise", "--root", a.Root)
	cmd.Stdout = log
	cmd.Stderr = log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err = cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	stable := 0
	for i := 0; i < 20; i++ {
		select {
		case <-ctx.Done():
			_ = a.Stop(context.Background())
			return ctx.Err()
		case <-time.After(time.Second):
		}
		if a.network(ctx, "ready") == nil {
			stable++
		} else {
			stable = 0
		}
		if stable >= 5 {
			return nil
		}
	}
	_ = a.Stop(context.Background())
	return errors.New("代理启动未就绪，请查看日志")
}

func (a *UFIAdapter) Supervise() error {
	lock, err := os.OpenFile(a.runtime("supervisor.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("守护进程已运行")
	}
	if err = fsutil.WriteJSON(a.runtime("supervisor.json"), host.Record{PID: os.Getpid(), Start: host.Start(os.Getpid())}); err != nil {
		return err
	}
	defer os.Remove(a.runtime("supervisor.json"))
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	delay := time.Second
	for ctx.Err() == nil {
		// Protect listeners even before the hotspot exists; no core starts unguarded.
		if err := a.network(ctx, "prepare"); err != nil {
			return err
		}
		log, err := os.OpenFile(a.runtime("core.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if err != nil {
			return err
		}
		cmd := exec.Command(a.runtime("mihomo"), "-d", a.runtime(), "-f", a.runtime("current", "config.yaml"))
		cmd.Stdout = log
		cmd.Stderr = log
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if err = cmd.Start(); err != nil {
			log.Close()
			return err
		}
		err = fsutil.WriteJSON(a.runtime("core.json"), host.Record{PID: cmd.Process.Pid, Start: host.Start(cmd.Process.Pid)})
		if err == nil {
			err = fsutil.AtomicWrite(a.runtime("core.pid"), []byte(strconv.Itoa(cmd.Process.Pid)), 0600)
		}
		if err != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			log.Close()
			return err
		}
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		ticker := time.NewTicker(5 * time.Second)
		started := time.Now()
		alive := true
		for alive {
			select {
			case <-ctx.Done():
				_ = a.stopProcess("core")
				<-done
				if err := a.network(context.Background(), "stop"); err != nil {
					ticker.Stop()
					log.Close()
					return err
				}
				alive = false
			case err := <-done:
				fmt.Println("core exited:", err)
				alive = false
			case <-ticker.C:
				e := a.network(ctx, "sync")
				if e != nil {
					fmt.Println(e)
					// Unknown guard state must not leave a public proxy listening.
					_ = cmd.Process.Kill()
				}
				if info, e := log.Stat(); e == nil && info.Size() > 1<<20 {
					_ = log.Truncate(0)
				}
				if info, e := os.Stat(a.runtime("supervisor.log")); e == nil && info.Size() > 256<<10 {
					_ = os.Truncate(a.runtime("supervisor.log"), 0)
				}
			}
		}
		ticker.Stop()
		log.Close()
		_ = a.network(context.Background(), "stop")
		_ = os.Remove(a.runtime("core.json"))
		_ = os.Remove(a.runtime("core.pid"))
		if time.Since(started) > time.Minute {
			delay = time.Second
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(delay):
		}
		if delay < 30*time.Second {
			delay *= 2
		}
	}
	return nil
}

func (a *UFIAdapter) BootLine() string {
	return "'" + strings.ReplaceAll(a.path("agent"), "'", "'\\''") + "' boot --root '" + strings.ReplaceAll(a.Root, "'", "'\\''") + "' # mihomo-agent"
}
func (a *UFIAdapter) SetBoot(_ context.Context, enabled bool) error {
	data, err := os.ReadFile(a.BootPath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	var lines []string
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) != a.BootLine() {
			lines = append(lines, line)
		}
	}
	if enabled {
		lines = append(lines, a.BootLine())
	}
	return fsutil.AtomicWrite(a.BootPath, []byte(strings.TrimRight(strings.Join(lines, "\n"), "\n")+"\n"), 0644)
}
