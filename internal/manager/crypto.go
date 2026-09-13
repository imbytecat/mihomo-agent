package manager

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"

	"github.com/imbytecat/mihomo-agent/internal/storage"

	"golang.org/x/crypto/nacl/box"
)

type keyPair = storage.Identity

func (a *Manager) initIdentity() error {
	if err := a.requireIdentity(); err == nil {
		return nil
	}
	entries, err := os.ReadDir(a.Root)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if len(entries) != 0 {
		return errors.New("目录包含未受管理的数据，请先卸载原服务；不会覆盖现有文件")
	}
	public, private, err := box.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(a.Root), 0700); err != nil {
		return err
	}
	temporary, err := os.MkdirTemp(filepath.Dir(a.Root), ".mihomo-init-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)

	if err = storage.Initialize(temporary, keyPair{Protocol: Protocol, Public: *public, Private: *private}, storage.Deployment(a.Platform.Config()), storage.Controller{Enabled: true, Port: 9090, Secret: newSecret()}); err != nil {
		return err
	}
	if err = os.Rename(temporary, a.Root); err != nil {
		return err
	}
	return a.openStore()

}

func (a *Manager) PublicKey() (string, error) {
	key, err := a.identity()
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(key.Public[:]), nil
}

func (a *Manager) decrypt(data []byte) (Request, error) {
	var request Request
	key, err := a.identity()
	if err != nil {
		return request, err
	}
	plain, ok := box.OpenAnonymous(nil, data, &key.Public, &key.Private)
	if !ok {
		return request, errors.New("请求解密失败")
	}
	return DecodeRequest(plain)
}
