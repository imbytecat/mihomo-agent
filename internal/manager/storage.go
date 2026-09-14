package manager

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/imbytecat/mihomo-agent/internal/platform"
	"github.com/imbytecat/mihomo-agent/internal/storage"
)

const Protocol = 3

type Manager struct {
	Root, Version, Executable string
	Platform                  platform.Adapter
	store                     *storage.Store
	httpTransport             http.RoundTripper
	runCommand                func(context.Context, string, ...string) ([]byte, error)
}

func New(root, version string, adapter platform.Adapter) (*Manager, error) {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if filepath.Base(absolute) != "mihomo-agent" || strings.ContainsAny(absolute, "\x00\r\n") {
		return nil, errors.New("state directory must be named mihomo-agent")
	}
	if info, err := os.Lstat(absolute); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("state directory cannot be a symlink")
	}
	if adapter == nil {
		return nil, errors.New("platform adapter is required")
	}
	executable := filepath.Join(absolute, "agent")
	db, err := storage.Open(absolute)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	return &Manager{Root: absolute, Version: version, Executable: executable, Platform: adapter, store: db}, nil
}
func (a *Manager) path(parts ...string) string {
	return filepath.Join(append([]string{a.Root}, parts...)...)
}
func (a *Manager) runtime(parts ...string) string {
	return a.path(append([]string{"runtime"}, parts...)...)
}
func (a *Manager) corePath() string { return a.Platform.CorePath() }
func (a *Manager) coreInstalled() bool {
	path := a.corePath()
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0
}
func (a *Manager) lock() (*os.File, error) {
	f, err := os.OpenFile(a.path("control.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("设备正在执行其他任务")
	}
	return f, nil
}
func randomID() string {
	var id [16]byte
	rand.Read(id[:])
	return hex.EncodeToString(id[:])
}
func validID(id string) bool {
	_, err := hex.DecodeString(id)
	return len(id) == 32 && err == nil && strings.ToLower(id) == id
}
func (a *Manager) Close() error {
	if a.store == nil {
		return nil
	}
	err := a.store.Close()
	a.store = nil
	return err
}
func (a *Manager) openStore() error {
	if a.store != nil {
		return nil
	}
	s, err := storage.Open(a.Root)
	if err == nil {
		a.store = s
	}
	return err
}
func (a *Manager) identity() (keyPair, error) {
	if err := a.openStore(); err != nil {
		return keyPair{}, err
	}
	return a.store.Identity()
}
func (a *Manager) installed() bool {
	if a.store == nil {
		return false
	}
	value, err := a.store.Installed()
	return err == nil && value
}
func (a *Manager) requireIdentity() error {
	identity, err := a.identity()
	if err != nil || identity.Protocol != Protocol {
		return fmt.Errorf("Mihomo Agent 未初始化或协议不匹配")
	}
	deployment, err := a.store.Deployment()
	if err != nil || deployment != storage.Deployment(a.Platform.Config()) {
		return errors.New("平台记录不匹配")
	}
	return nil
}
