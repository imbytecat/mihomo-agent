package agent

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"

	"golang.org/x/crypto/nacl/box"
)

type keyPair struct {
	Protocol        int `json:"protocol"`
	Public, Private [32]byte
}
type Request struct {
	ID     string `json:"id"`
	Action string `json:"action"`
	Value  string `json:"value,omitempty"`
}

var uploadName = regexp.MustCompile(`^[a-fA-F0-9-]{36}\.bin$`)

func (a *Agent) initIdentity() error {
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
	temporary, err := os.MkdirTemp(filepath.Dir(a.Root), ".ufi-init-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)
	if err = writeJSON(filepath.Join(temporary, "identity.json"), keyPair{Protocol, *public, *private}); err != nil {
		return err
	}
	return os.Rename(temporary, a.Root)
}

func (a *Agent) PublicKey() (string, error) {
	var key keyPair
	if err := readJSON(a.path("identity.json"), &key); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(key.Public[:]), nil
}

// The public UFI upload area carries only a sealed box. No subscription secrets.
func (a *Agent) claimRequest(name, digest string) (Request, []byte, error) {
	var request Request
	if !uploadName.MatchString(name) || len(digest) != 64 {
		return request, nil, errors.New("invalid upload reference")
	}
	path := filepath.Join(a.Uploads, name)
	if !regularFile(path) {
		return request, nil, errors.New("上传请求不是普通文件")
	}
	f, err := os.Open(path)
	if err != nil {
		return request, nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 64*1024+1))
	if err != nil || len(data) > 64*1024 {
		return request, nil, errors.New("请求过大或无法读取")
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != digest {
		return request, nil, errors.New("请求校验失败")
	}
	request, err = a.decrypt(data)
	if err != nil {
		return request, nil, err
	}
	if err := os.Remove(path); err != nil {
		return request, nil, err
	}
	return request, data, nil
}

func (a *Agent) decrypt(data []byte) (Request, error) {
	var key keyPair
	var request Request
	if err := readJSON(a.path("identity.json"), &key); err != nil {
		return request, err
	}
	plain, ok := box.OpenAnonymous(nil, data, &key.Public, &key.Private)
	if !ok {
		return request, errors.New("请求解密失败")
	}
	if err := json.Unmarshal(plain, &request); err != nil || !validID(request.ID) {
		return request, errors.New("请求格式无效")
	}
	switch request.Action {
	case "install", "download", "update", "start", "stop", "restart", "boot-on", "boot-off", "uninstall", "save-mirror", "save-interfaces", "save-controller", "download-dashboard":
	default:
		return request, errors.New("未知设备操作")
	}
	return request, nil
}
