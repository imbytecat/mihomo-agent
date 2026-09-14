// Package platform owns operating-system integration, never subscription policy or jobs.
package platform

import (
	"context"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"

	"github.com/imbytecat/mihomoctl/internal/host"
	"github.com/imbytecat/mihomoctl/internal/storage"
)

const UFI = "ufi"
const Linux = "linux"

type Config storage.Deployment
type Capabilities struct {
	Interfaces bool `json:"interfaces"`
	Capture    bool `json:"capture"`
}
type State struct {
	Running    bool
	Supervisor bool
	Listeners  bool
	Network    bool
	Capture    bool
	Boot       bool
}
type Policy struct{ Bind, DNS, Controller string }
type StartOptions struct{ Interfaces []string }
type Adapter interface {
	Config() Config
	Capabilities() Capabilities
	CorePath() string
	Policy() Policy
	ExtraPaths() []string
	CertDirs() []string
	Prepare() error
	Inspect(context.Context) (State, error)
	Start(context.Context, StartOptions) error
	Stop(context.Context) error
	SetBoot(context.Context, bool) error
	Remove(context.Context) error
	AttachTask(context.Context, int, string) error
}
type Supervisor interface{ Supervise() error }
type Runner func(context.Context, []*os.File, string, ...string) ([]byte, error)
type Environment struct {
	Root, Executable string
	Run              Runner
}

func (e Environment) path(parts ...string) string {
	return filepath.Join(append([]string{e.Root}, parts...)...)
}
func (e Environment) runtime(parts ...string) string {
	return e.path(append([]string{"runtime"}, parts...)...)
}
func (e Environment) CorePath() string { return e.runtime("mihomo") }
func (e Environment) command(ctx context.Context, files []*os.File, name string, args ...string) ([]byte, error) {
	if e.Run != nil {
		return e.Run(ctx, files, name, args...)
	}
	return host.Command(ctx, files, name, args...)
}
func DefaultKind() string {
	if _, err := os.Stat("/system/bin/sh"); err == nil {
		return UFI
	}
	return Linux
}
func DefaultRoot(kind string) string {
	if kind == UFI {
		return "/data/mihomoctl"
	}
	return "/var/lib/mihomoctl"
}

var unitName = regexp.MustCompile(`^[A-Za-z0-9_.@-]+[.]service$`)

func (c Config) Validate() error {
	switch c.Kind {
	case UFI:
		if c.Unit != "" || c.ListenAddress != "" {
			return errors.New("UFI 不接受 Linux 平台参数")
		}
	case Linux:
		if !unitName.MatchString(c.Unit) {
			return errors.New("Linux 需要有效 systemd service 名称")
		}
		ip, err := netip.ParseAddr(c.ListenAddress)
		if err != nil || !ip.Is4() || !(ip.IsLoopback() || ip.IsPrivate()) {
			return errors.New("Linux 监听地址必须是本机回环或 IPv4 私网地址")
		}
	default:
		return errors.New("不支持的平台")
	}
	return nil
}
func Load(root string, requested Config) (Config, error) {

	var saved Config
	db, err := storage.Open(root)
	if err == nil {
		defer db.Close()
		value, e := db.Deployment()
		if e != nil {
			return saved, e
		}
		saved = Config(value)
		if requested.Kind != "" && requested.Kind != saved.Kind {
			return saved, errors.New("安装平台不能更改")
		}
		if requested.Unit != "" && requested.Unit != saved.Unit || requested.ListenAddress != "" && requested.ListenAddress != saved.ListenAddress {
			return saved, errors.New("安装参数不能更改，请先卸载")
		}
		return saved, saved.Validate()
	} else if !os.IsNotExist(err) {
		return saved, err
	}
	if requested.Kind == "" {
		requested.Kind = DefaultKind()
	}
	if requested.Kind == Linux {
		if requested.Unit == "" {
			requested.Unit = "mihomoctl-core.service"
		}
		if requested.ListenAddress == "" {
			requested.ListenAddress = "127.0.0.1"
		}
	}
	return requested, requested.Validate()
}
func New(config Config, env Environment) (Adapter, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	if config.Kind == UFI {
		return NewUFI(env), nil
	}
	return NewSystemd(config, env), nil
}
