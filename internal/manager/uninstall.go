package manager

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/imbytecat/mihomo-agent/internal/storage"
)

func (a *Manager) uninstall(phase func(string)) error {
	if filepath.Base(a.Root) != "mihomo-agent" {
		return errors.New("卸载目录无效")
	}
	if err := a.requireIdentity(); err != nil {
		return err
	}
	extra := a.Platform.ExtraPaths()
	for _, path := range append([]string{a.Root}, extra...) {
		if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
			return errors.New("卸载目录不能是符号链接")
		}
	}
	phase("stopping")
	if err := a.Platform.Remove(context.Background()); err != nil {
		return err
	}
	phase("removing")
	if err := a.Close(); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pin, err := storage.Exclusive(ctx, a.Root)
	if err != nil {
		return err
	}
	defer pin.Close()
	// Keep the agent and task record available if bulk deletion fails.
	for _, path := range append([]string{a.runtime()}, extra...) {
		if err := os.RemoveAll(path); err != nil {
			return err
		}
	}
	// Keep the database and execution lock until bulk file deletion has succeeded.
	entries, err := os.ReadDir(a.Root)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == "control.lock" || name == storage.Lockfile || name == storage.Filename || name == storage.Filename+"-wal" || name == storage.Filename+"-shm" || name == storage.Filename+"-journal" {
			continue
		}
		if err := os.RemoveAll(a.path(name)); err != nil {
			return err
		}
	}
	for _, name := range []string{storage.Filename + "-wal", storage.Filename + "-shm", storage.Filename + "-journal", storage.Filename, "control.lock", storage.Lockfile} {
		if err := os.Remove(a.path(name)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return os.Remove(a.Root)
}
