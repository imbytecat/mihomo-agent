package manager

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"

	"github.com/imbytecat/mihomo-agent/internal/storage"

	"golang.org/x/crypto/nacl/box"
)

type Controller struct {
	Enabled bool   `json:"enabled"`
	Port    int    `json:"port"`
	Secret  string `json:"secret"`
}

type ControllerStatus struct {
	Enabled bool `json:"enabled"`
	Port    int  `json:"port"`
	Applied bool `json:"applied"`
}

func newSecret() string {
	var key [32]byte
	if _, err := rand.Read(key[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(key[:])
}

func (c Controller) validate() error {
	if c.Port < 1024 || c.Port > 65535 || c.Port == 7894 || c.Port == 1053 {
		return errors.New("API 端口须为 1024–65535，且不能占用代理或 DNS 端口")
	}
	if c.Secret == "" {
		return errors.New("API 密钥不能为空")
	}
	for _, char := range c.Secret {
		if char < 33 || char > 126 {
			return errors.New("API 密钥包含无法用于 HTTP 鉴权的字符")
		}
	}
	return nil
}

func (a *Manager) controller() (Controller, error) {
	if err := a.requireIdentity(); err != nil {
		return Controller{}, err
	}
	config, err := a.configuration()
	if err != nil {
		return Controller{}, err
	}
	if config.Controller != nil {
		return *config.Controller, config.Controller.validate()
	}
	stored, err := a.store.Controller()
	value := Controller(stored)
	if err != nil {
		return value, err
	}
	return value, value.validate()
}

func (a *Manager) saveController(ctx context.Context, request Request, phase func(string)) (string, error) {
	input := request.Params.Controller
	if input == nil || input.Enabled == nil {
		return "", errors.New("控制面板设置无效")
	}
	value, err := a.controller()
	if err != nil {
		return "", err
	}
	value.Enabled, value.Port = *input.Enabled, input.Port
	if input.Reset {
		value.Secret = newSecret()
	} else if input.Secret != nil {
		value.Secret = *input.Secret
	}
	if err := value.validate(); err != nil {
		return "", err
	}
	phase("saving")
	config, err := a.configuration()
	if err != nil {
		return "", err
	}
	if config.URL == "" {
		return "面板设置已保存", a.store.SaveController(storage.Controller(value))
	}
	if config.Controller != nil && value == *config.Controller && config.Dashboard == (value.Enabled && a.dashboard().Installed) {
		return "面板设置未改变", nil
	}
	source, err := os.ReadFile(a.runtime("current", "source.yaml"))
	if err != nil {
		return "", err
	}
	if err = a.applyConfig(ctx, request.ID, source, config.URL, value, phase); err != nil {
		return "", err
	}
	return "面板设置已应用", nil
}

// Only ciphertext crosses UFI's logged root-shell response. The browser owns the recipient key.
func (a *Manager) ControllerSecret(recipient string) (string, error) {
	key, err := base64.StdEncoding.DecodeString(recipient)
	if err != nil || len(key) != 32 {
		return "", errors.New("浏览器公钥无效")
	}
	value, err := a.controller()
	if err != nil {
		return "", err
	}
	var public [32]byte
	copy(public[:], key)
	sealed, err := box.SealAnonymous(nil, []byte(value.Secret), &public, rand.Reader)
	return base64.StdEncoding.EncodeToString(sealed), err
}
