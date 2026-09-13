package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/google/renameio/v2"
)

const Protocol = 1

type Agent struct {
	Root, Uploads, Version string
	httpClient             HTTPClient
	runCommand             func(context.Context, string, ...string) ([]byte, error)
	BootPath               string
	InitialGitHubProxy     string
}

func New(root, uploads, version string) (*Agent, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if filepath.Base(root) != "ufi-mihomo" {
		return nil, errors.New("state directory must be named ufi-mihomo")
	}
	if info, err := os.Lstat(root); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("state directory cannot be a symlink")
	}
	return &Agent{Root: root, Uploads: uploads, Version: version, BootPath: "/sdcard/ufi_tools_boot.sh"}, nil
}

func (a *Agent) path(parts ...string) string {
	return filepath.Join(append([]string{a.Root}, parts...)...)
}
func (a *Agent) runtime(parts ...string) string {
	return a.path(append([]string{"runtime"}, parts...)...)
}

func atomicWrite(path string, data []byte, mode os.FileMode) error {
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

func writeJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return atomicWrite(path, data, 0600)
}

func readJSON(path string, target any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func (a *Agent) lock() (*os.File, error) {
	f, err := os.OpenFile(a.path("control.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("设备正在执行其他任务")
	}
	return f, nil // Close releases flock. Do not unlock a descriptor handed to a worker.
}

func randomID() string {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(id[:])
}

func validID(id string) bool {
	_, err := hex.DecodeString(id)
	return len(id) == 32 && err == nil && strings.ToLower(id) == id
}

func regularFile(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular()
}

func (a *Agent) requireIdentity() error {
	var identity struct {
		Protocol int `json:"protocol"`
	}
	if err := readJSON(a.path("identity.json"), &identity); err != nil || identity.Protocol != Protocol {
		return fmt.Errorf("Mihomo Agent 未初始化或协议不匹配")
	}
	return nil
}
