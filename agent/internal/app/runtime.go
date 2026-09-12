package app

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

//go:embed network.sh
var networkScript []byte

type processRecord struct {
	PID   int
	Start string
}

func processStart(pid int) string {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return ""
	}
	end := strings.LastIndex(string(data), ")")
	if end < 0 {
		return ""
	}
	fields := strings.Fields(string(data[end+1:]))
	if len(fields) < 20 || fields[0] == "Z" {
		return ""
	}
	return fields[19]
}

func (a *Agent) process(name string) (*os.Process, bool) {
	var record processRecord
	if readJSON(a.runtime(name+".json"), &record) != nil || record.PID < 2 || record.Start == "" || processStart(record.PID) != record.Start {
		return nil, false
	}
	process, err := os.FindProcess(record.PID)
	return process, err == nil && process.Signal(syscall.Signal(0)) == nil
}

func (a *Agent) alive(name string) bool {
	process, alive := a.process(name)
	if process != nil {
		process.Release()
	}
	return alive
}
func (a *Agent) running() bool { return a.alive("core") || a.alive("supervisor") }

func (a *Agent) run(ctx context.Context, name string, args ...string) ([]byte, error) {
	if a.runCommand != nil {
		return a.runCommand(ctx, name, args...)
	}
	return commandOutput(ctx, nil, name, args...)
}

func commandOutput(ctx context.Context, files []*os.File, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.ExtraFiles = files
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 2 * time.Second
	return cmd.CombinedOutput()
}

func (a *Agent) network(ctx context.Context, action string) error {
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
	var output []byte
	if a.runCommand != nil {
		output, err = a.run(ctx, "/system/bin/sh", a.runtime("network.sh"), a.runtime(), action)
	} else {
		output, err = commandOutput(ctx, []*os.File{lock}, "/system/bin/sh", a.runtime("network.sh"), a.runtime(), action)
	}
	if err != nil {
		return fmt.Errorf("网络规则 %s 失败：%s", action, sanitize(string(output)))
	}
	return nil
}

func (a *Agent) testCore(ctx context.Context, core, config string) error {
	output, err := a.run(ctx, core, "-t", "-d", a.runtime(), "-f", config)
	if err != nil {
		fmt.Println(sanitize(string(output)))
		return errors.New("内核配置校验失败")
	}
	return nil
}

func (a *Agent) stopProcess(name string) error {
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

func (a *Agent) stopRuntime() error {
	if err := a.stopProcess("supervisor"); err != nil {
		return err
	}
	if err := a.stopProcess("core"); err != nil {
		return err
	}
	if regularFile(a.runtime("network.owned")) {
		if err := a.network(context.Background(), "stop"); err != nil {
			return err
		}
	}
	return nil
}

func (a *Agent) startRuntime(ctx context.Context) error {
	if a.alive("supervisor") {
		return errors.New("代理已运行")
	}
	if !regularFile(a.runtime("mihomo")) {
		return errors.New("内核未安装")
	}
	if id, err := a.activeGeneration(); err != nil || id == "" {
		return errors.New("配置未就绪")
	}
	if err := a.testCore(ctx, a.runtime("mihomo"), a.runtime("current", "config.yaml")); err != nil {
		return err
	}
	if err := a.stopRuntime(); err != nil {
		return err
	}
	if err := atomicWrite(a.runtime("network.sh"), networkScript, 0700); err != nil {
		return err
	}
	log, err := os.OpenFile(a.runtime("supervisor.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer log.Close()
	cmd := exec.Command(a.path("agent"), "supervise", "--root", a.Root)
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
			_ = a.stopRuntime()
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
	_ = a.stopRuntime()
	return errors.New("代理启动未就绪，请查看日志")
}

func (a *Agent) Supervise() error {
	if err := a.requireIdentity(); err != nil {
		return err
	}
	lock, err := os.OpenFile(a.runtime("supervisor.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("守护进程已运行")
	}
	if err = writeJSON(a.runtime("supervisor.json"), processRecord{os.Getpid(), processStart(os.Getpid())}); err != nil {
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
		err = writeJSON(a.runtime("core.json"), processRecord{cmd.Process.Pid, processStart(cmd.Process.Pid)})
		if err == nil {
			err = atomicWrite(a.runtime("core.pid"), []byte(strconv.Itoa(cmd.Process.Pid)), 0600)
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
				settings, e := a.settings()
				if e == nil {
					e = atomicWrite(a.runtime("interfaces"), []byte(strings.Join(settings.Interfaces, " ")), 0600)
				}
				if e == nil {
					e = a.network(ctx, "sync")
				}
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

var secretLine = regexp.MustCompile(`(?i)(password|secret|token|authorization|uuid|private.key)[\s"=:]`)
var addressPattern = regexp.MustCompile(`[a-zA-Z][a-zA-Z0-9+.-]*://[^\s"<>]+`)

func sanitize(text string) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		line = addressPattern.ReplaceAllString(line, "[URL hidden]")
		if secretLine.MatchString(line) {
			line = "[sensitive log line hidden]"
		}
		lines[i] = line
	}
	return strings.Join(lines, "\n")
}

func (a *Agent) bootLine() string {
	return "'" + strings.ReplaceAll(a.path("agent"), "'", "'\\''") + "' boot # ufi-mihomo"
}
func (a *Agent) setBoot(enabled bool) error {
	if enabled {
		if !regularFile(a.runtime("mihomo")) {
			return errors.New("内核未安装")
		}
		if id, _ := a.activeGeneration(); id == "" {
			return errors.New("配置未就绪")
		}
	}
	data, err := os.ReadFile(a.BootPath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	var lines []string
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) != a.bootLine() {
			lines = append(lines, line)
		}
	}
	if enabled {
		lines = append(lines, a.bootLine())
	}
	return atomicWrite(a.BootPath, []byte(strings.TrimRight(strings.Join(lines, "\n"), "\n")+"\n"), 0644)
}

func (a *Agent) Logs() (string, error) {
	var result strings.Builder
	if job := a.latestJob(); job != nil {
		result.WriteString("任务 " + job.Action + " / " + job.Phase + "\n" + a.readJobLog(job.ID) + "\n")
	}
	for _, name := range []string{"supervisor.log", "core.log"} {
		if data, err := os.ReadFile(a.runtime(name)); err == nil {
			if len(data) > 24*1024 {
				data = data[len(data)-24*1024:]
			}
			result.WriteString(name + "\n" + sanitize(string(data)) + "\n")
		}
	}
	return result.String(), nil
}

func (a *Agent) Diagnose() (string, error) {
	var result strings.Builder
	for _, args := range [][]string{{"-o", "-4", "addr", "show"}, {"-4", "rule", "show"}, {"-4", "route", "show", "table", "all"}, {"-6", "route", "show", "table", "all"}} {
		output, err := a.run(context.Background(), "ip", args...)
		fmt.Fprintf(&result, "ip %s\n%s\n", strings.Join(args, " "), sanitize(string(output)))
		if err != nil {
			fmt.Fprintf(&result, "失败：%v\n", err)
		}
	}
	return result.String(), nil
}
