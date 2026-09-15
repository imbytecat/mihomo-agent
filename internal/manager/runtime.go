package manager

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/imbytecat/mihomoctl/internal/fsutil"
	"github.com/imbytecat/mihomoctl/internal/host"
	"github.com/imbytecat/mihomoctl/internal/platform"
	"github.com/imbytecat/mihomoctl/internal/redact"
)

func (a *Manager) run(ctx context.Context, name string, args ...string) ([]byte, error) {
	if a.runCommand != nil {
		return a.runCommand(ctx, name, args...)
	}
	return host.Command(ctx, nil, name, args...)
}
func (a *Manager) running() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	state, err := a.Platform.Inspect(ctx)
	return err != nil || state.Running // Unknown runtime state never grants permission to replace files.
}
func (a *Manager) testCore(ctx context.Context, core, config string) error {
	output, err := a.run(ctx, core, "-t", "-d", a.runtime(), "-f", config)
	if err != nil {
		return fmt.Errorf("内核配置校验失败：%w\n%s", err, redact.String(string(output)))
	}
	return nil
}
func (a *Manager) stopRuntime() error { return a.Platform.Stop(context.Background()) }
func (a *Manager) startRuntime(ctx context.Context) error {
	if !a.coreInstalled() {
		return errors.New("内核未安装")
	}
	if id, err := a.activeGeneration(); err != nil || id == "" {
		return errors.New("配置未就绪")
	}
	if err := a.testCore(ctx, a.corePath(), a.runtime("current", "config.yaml")); err != nil {
		return err
	}
	settings, err := a.settings()
	if err != nil {
		return err
	}
	return a.Platform.Start(ctx, platform.StartOptions{Interfaces: settings.Interfaces})
}
func (a *Manager) Supervise() error {
	if err := a.requireIdentity(); err != nil {
		return err
	}
	runtime, ok := a.Platform.(platform.Supervisor)
	if !ok {
		return errors.New("该平台由系统管理进程")
	}
	return runtime.Supervise()
}
func (a *Manager) setBoot(enabled bool) error {
	if enabled {
		if !a.coreInstalled() {
			return errors.New("内核未安装")
		}
		if id, _ := a.activeGeneration(); id == "" {
			return errors.New("配置未就绪")
		}
	}
	return a.Platform.SetBoot(context.Background(), enabled)
}
func (a *Manager) Logs() (string, error) {
	if journal, ok := a.Platform.(interface {
		Journal(context.Context) (string, error)
	}); ok {
		text, err := journal.Journal(context.Background())
		return redact.String(text), err
	}
	var result strings.Builder
	for _, name := range []string{"supervisor.log", "core.log"} {
		if data, err := fsutil.ReadTail(a.runtime(name), 24*1024); err == nil {
			result.WriteString(name + "\n" + redact.String(string(data)) + "\n")
		}
	}
	return result.String(), nil
}
func (a *Manager) Diagnose() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	text, err := a.Platform.Diagnostics(ctx)
	return redact.String(text), err
}
