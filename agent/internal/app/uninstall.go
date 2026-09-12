package app

import (
	"errors"
	"os"
	"path/filepath"
)

func (a *Agent) uninstall(phase func(string)) error {
	if filepath.Base(a.Root) != "ufi-mihomo" {
		return errors.New("卸载目录无效")
	}
	if err := a.requireIdentity(); err != nil {
		return err
	}
	bootstrap := a.Root + "-bootstrap"
	for _, path := range []string{a.Root, bootstrap} {
		if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
			return errors.New("卸载目录不能是符号链接")
		}
	}
	phase("stopping")
	if err := a.stopRuntime(); err != nil {
		return err
	}
	if err := a.setBoot(false); err != nil {
		return err
	}
	phase("removing")
	// Keep the agent and task record available if bulk deletion fails.
	for _, path := range []string{a.runtime(), a.path("backups"), bootstrap} {
		if err := os.RemoveAll(path); err != nil {
			return err
		}
	}
	// Last step removes the executing agent, keys, caches and task records too.
	return os.RemoveAll(a.Root)
}
