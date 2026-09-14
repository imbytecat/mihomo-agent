package platform

import (
	"context"
	"errors"
	"os"
	"time"

	"github.com/imbytecat/mihomoctl/internal/fsutil"
)

func (a *SystemdAdapter) unitPath() string { return a.path(a.deployment.Unit) }

// The private source file and effective systemd properties both prove ownership.
func (a *SystemdAdapter) checkUnitFile() error {
	info, err := os.Lstat(a.unitPath())
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("mihomoctl unit 文件必须是普通文件")
	}
	want, err := a.Unit()
	if err != nil {
		return err
	}
	data, err := os.ReadFile(a.unitPath())
	if err != nil {
		return err
	}
	if string(data) != want {
		return errors.New("mihomoctl unit 文件已被外部修改")
	}
	return nil
}

func (a *SystemdAdapter) Prepare() error {
	if err := a.checkAddress(); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	bus, err := a.Connect(ctx)
	if err != nil {
		return err
	}
	defer bus.Close()
	if _, err = a.properties(ctx, bus); err != nil {
		return err
	}
	if err = a.checkUnitFile(); os.IsNotExist(err) {
		var content string
		content, err = a.Unit()
		if err == nil {
			err = fsutil.AtomicWrite(a.unitPath(), []byte(content), 0600)
		}
	}
	if err != nil {
		return err
	}
	// force=false preserves any conflicting system-owned unit or mask.
	if _, err = bus.LinkUnitFilesContext(ctx, []string{a.unitPath()}, false, false); err != nil {
		return err
	}
	if err = bus.ReloadContext(ctx); err != nil {
		return err
	}
	p, err := a.properties(ctx, bus)
	if err != nil {
		return err
	}
	if p["LoadState"] != "loaded" {
		return errors.New("mihomoctl systemd unit 未加载")
	}
	return nil
}

func (a *SystemdAdapter) SetBoot(ctx context.Context, enabled bool) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	bus, err := a.Connect(ctx)
	if err != nil {
		return err
	}
	defer bus.Close()
	if _, err = a.properties(ctx, bus); err != nil {
		return err
	}
	if err = a.checkUnitFile(); err != nil {
		return err
	}
	if enabled {
		_, _, err = bus.EnableUnitFilesContext(ctx, []string{a.unitPath()}, false, false)
	} else {
		_, err = bus.DisableUnitFilesContext(ctx, []string{a.deployment.Unit}, false)
		if err == nil {
			// Disable also removes the link of units outside systemd's search path.
			_, err = bus.LinkUnitFilesContext(ctx, []string{a.unitPath()}, false, false)
		}
	}
	if err != nil {
		return err
	}
	if err = bus.ReloadContext(ctx); err != nil {
		return err
	}
	p, err := a.properties(ctx, bus)
	if err != nil {
		return err
	}
	if p["LoadState"] != "loaded" || a.state(p).Boot != enabled {
		return errors.New("systemd 自启设置未生效")
	}
	return nil
}

func (a *SystemdAdapter) Remove(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	bus, err := a.Connect(ctx)
	if err != nil {
		return err
	}
	defer bus.Close()
	// A prior attempt may have deleted the source before daemon-reload failed.
	// Refresh stale properties before checking the identity of a now-missing link.
	if _, err = os.Lstat(a.unitPath()); os.IsNotExist(err) {
		if err = bus.ReloadContext(ctx); err != nil {
			return err
		}
	}
	if err := a.Stop(ctx); err != nil {
		return err
	}
	if _, err = a.properties(ctx, bus); err != nil {
		return err
	}
	if err = a.checkUnitFile(); err == nil {
		// Keep the persistent link discoverable until runtime links are disabled.
		for _, runtime := range []bool{true, false} {
			if _, err = bus.DisableUnitFilesContext(ctx, []string{a.deployment.Unit}, runtime); err != nil {
				return err
			}
		}
		if err = os.Remove(a.unitPath()); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	// A previous attempt may have removed the source before reload failed.
	if err = bus.ReloadContext(ctx); err != nil {
		return err
	}
	p, err := a.properties(ctx, bus)
	if err != nil {
		return err
	}
	if p["LoadState"] != "not-found" || a.state(p).Running {
		return errors.New("systemd unit 仍引用本安装，拒绝删除数据")
	}
	return nil
}
