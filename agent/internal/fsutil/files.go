package fsutil

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"syscall"

	"github.com/google/renameio/v2"
)

func AtomicWrite(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	// Keep staging on the destination filesystem and private before writing secrets.
	f, err := renameio.NewPendingFile(path, renameio.WithTempDir(filepath.Dir(path)))
	if err != nil {
		return err
	}
	defer f.Cleanup()
	err = f.Chmod(mode)
	// Android shared storage fixes permissions; only the public boot file uses 0644.
	if mode == 0644 && (errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EOPNOTSUPP)) {
		err = nil
	}
	if err == nil {
		_, err = f.Write(data)
	}
	if err != nil {
		return err
	}
	if err = f.CloseAtomicallyReplace(); err != nil {
		return err
	}
	if dir, e := os.Open(filepath.Dir(path)); e == nil {
		defer dir.Close()
		_ = dir.Sync()
	}
	return nil
}

func WriteJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return AtomicWrite(path, data, 0600)
}

func ReadJSON(path string, target any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func RegularFile(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular()
}
