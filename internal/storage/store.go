// Package storage is the transactional owner of manager metadata, not runtime files.
package storage

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/imbytecat/mihomoctl/internal/storage/db"
	_ "modernc.org/sqlite"
)

const Filename = "state.db"
const Lockfile = "state.lock"
const schemaVersion = 5

type Store struct {
	db      *sql.DB
	queries *db.Queries
	pin     *os.File
}
type Deployment struct {
	Kind          string `json:"kind"`
	Unit          string `json:"unit,omitempty"`
	ListenAddress string `json:"listenAddress,omitempty"`
}
type Identity struct {
	Protocol        int
	Public, Private [32]byte
}
type Settings struct {
	Interfaces   []string `json:"interfaces"`
	ReleaseProxy string   `json:"releaseProxy"`
}
type Controller struct {
	Enabled bool   `json:"enabled"`
	Port    int    `json:"port"`
	Secret  string `json:"secret"`
}
type Configuration struct {
	ID, URL    string
	Controller *Controller
	Dashboard  bool
}
type Pending struct {
	Previous, Next string
	WasRunning     bool
}
type Task struct {
	ID      string `json:"id"`
	Action  string `json:"action"`
	State   string `json:"state"`
	Phase   string `json:"phase"`
	Updated string `json:"updated"`
	Result  string `json:"result,omitempty"`
	Error   string `json:"error,omitempty"`
	Hash    string `json:"hash"`
}

//go:embed schema.sql
var schema string

func connect(root string) (*Store, error) {
	pin, err := os.OpenFile(filepath.Join(root, Lockfile), os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(pin.Fd()), syscall.LOCK_SH|syscall.LOCK_NB); err != nil {
		pin.Close()
		return nil, errors.New("状态数据库正在卸载")
	}
	ok := false
	defer func() {
		if !ok {
			pin.Close()
		}
	}()
	path := filepath.Join(root, Filename)
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("状态数据库必须是普通文件")
	}
	u := url.URL{Scheme: "file", Path: path}
	query := u.Query()
	query.Set("mode", "rw")
	for _, pragma := range []string{"busy_timeout(3000)", "foreign_keys(ON)", "synchronous(FULL)", "cache_size(-2048)"} {
		query.Add("_pragma", pragma)
	}
	u.RawQuery = query.Encode()
	conn, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	conn.SetMaxOpenConns(1)
	if err = conn.Ping(); err != nil {
		conn.Close()
		return nil, err
	}
	ok = true
	return &Store{db: conn, queries: db.New(conn), pin: pin}, nil
}
func Open(root string) (*Store, error) {
	s, err := connect(root)
	if err != nil {
		return nil, err
	}
	var version int
	if err = s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != schemaVersion {
		s.Close()
		return nil, errors.New("状态数据库版本不匹配")
	}
	return s, nil
}
func Initialize(root string, id Identity, deployment Deployment, controller Controller) error {
	lock, err := os.OpenFile(filepath.Join(root, Lockfile), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	if err = lock.Close(); err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(root, Filename), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	s, err := connect(root)
	if err != nil {
		return err
	}
	defer s.Close()
	if _, err = s.db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(schema); err != nil {
		return err
	}
	q := s.queries.WithTx(tx)
	ctx := context.Background()
	if err = q.CreateIdentity(ctx, db.CreateIdentityParams{Protocol: id.Protocol, PublicKey: id.Public[:], PrivateKey: id.Private[:]}); err != nil {
		return err
	}
	if err = q.CreateDeployment(ctx, db.CreateDeploymentParams(deployment)); err != nil {
		return err
	}
	if err = q.CreateSettings(ctx); err != nil {
		return err
	}
	if err = q.CreateController(ctx, db.CreateControllerParams(controller)); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	_, err = s.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
	return err
}
func (s *Store) Close() error {
	if s == nil {
		return nil
	}
	if err := s.db.Close(); err != nil {
		return err
	}
	if s.pin != nil {
		err := s.pin.Close()
		s.pin = nil
		return err
	}
	return nil
}

// Pin all supported readers until Close; removal waits until none can create WAL files.
func Exclusive(ctx context.Context, root string) (*os.File, error) {
	file, err := os.OpenFile(filepath.Join(root, Lockfile), os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	for {
		if err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err == nil {
			return file, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			file.Close()
			return nil, err
		}
		select {
		case <-ctx.Done():
			file.Close()
			return nil, ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}
func (s *Store) Identity() (Identity, error) {
	value, err := s.queries.Identity(context.Background())
	var id Identity
	if err != nil {
		return id, err
	}
	if len(value.PublicKey) != 32 || len(value.PrivateKey) != 32 {
		return id, errors.New("身份密钥损坏")
	}
	id.Protocol = value.Protocol
	copy(id.Public[:], value.PublicKey)
	copy(id.Private[:], value.PrivateKey)
	return id, nil
}
func (s *Store) Deployment() (Deployment, error) {
	value, err := s.queries.Deployment(context.Background())
	return Deployment(value), err
}
func (s *Store) Installed() (bool, error) {
	return s.queries.Installed(context.Background())
}
func (s *Store) SetInstalled() error {
	return s.queries.SetInstalled(context.Background())
}
func (s *Store) Settings() (Settings, error) {
	value, err := s.queries.Settings(context.Background())
	return Settings{Interfaces: strings.Fields(value.Interfaces), ReleaseProxy: value.ReleaseProxy}, err
}
func (s *Store) SaveSettings(p Settings) error {
	return s.queries.SaveSettings(context.Background(), db.SaveSettingsParams{Interfaces: strings.Join(p.Interfaces, " "), ReleaseProxy: p.ReleaseProxy})
}
func (s *Store) Controller() (Controller, error) {
	value, err := s.queries.Controller(context.Background())
	return Controller(value), err
}
func (s *Store) SaveController(c Controller) error {
	return s.queries.SaveController(context.Background(), db.SaveControllerParams(c))
}
func (s *Store) Configuration(id string) (Configuration, error) {
	value, err := s.queries.Configuration(context.Background(), id)
	return Configuration{ID: value.ID, URL: value.URL, Controller: &Controller{Enabled: value.Enabled, Port: value.Port, Secret: value.Secret}, Dashboard: value.Dashboard}, err
}
func (s *Store) SaveConfiguration(c Configuration) error {
	return s.queries.SaveConfiguration(context.Background(), db.SaveConfigurationParams{ID: c.ID, URL: c.URL, Enabled: c.Controller.Enabled, Port: c.Controller.Port, Secret: c.Controller.Secret, Dashboard: c.Dashboard})
}
func (s *Store) Pending() (*Pending, error) {
	value, err := s.queries.Pending(context.Background())
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	p := Pending(value)
	return &p, err
}
func (s *Store) SavePending(p Pending) error {
	return s.queries.SavePending(context.Background(), db.SavePendingParams(p))
}
func (s *Store) ClearPending() error { return s.queries.ClearPending(context.Background()) }
func (s *Store) OldConfigurations(active string) ([]string, error) {
	return s.queries.OldConfigurations(context.Background(), active)
}
func (s *Store) DeleteConfiguration(id string) error {
	return s.queries.DeleteConfiguration(context.Background(), id)
}
func (s *Store) SaveDashboard(id, version string) error {
	return s.queries.SaveDashboard(context.Background(), db.SaveDashboardParams{ID: id, Version: version})
}
func (s *Store) Dashboard(id string) (string, error) {
	return s.queries.Dashboard(context.Background(), id)
}
func (s *Store) CoreVersion(identity string) (string, error) {
	return s.queries.CoreVersion(context.Background(), identity)
}
func (s *Store) SaveCoreVersion(identity, version string) error {
	return s.queries.SaveCoreVersion(context.Background(), db.SaveCoreVersionParams{Identity: identity, Version: version})
}
func (s *Store) Task(id string) (Task, error) {
	value, err := s.queries.Task(context.Background(), id)
	return Task(value), err
}
func (s *Store) LatestTask() (string, error) {
	value, err := s.queries.LatestTask(context.Background())
	return value.String, err
}
func (s *Store) ClearLatest() error { return s.queries.ClearLatest(context.Background()) }
func (s *Store) Fingerprint(id string) (string, error) {
	return s.queries.Fingerprint(context.Background(), id)
}
func (s *Store) Request(id string) ([]byte, error) {
	return s.queries.Request(context.Background(), id)
}
func (s *Store) CreateTask(t Task, fingerprint string, request []byte) error {
	if t.State != "queued" && t.State != "running" {
		request = nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	q := s.queries.WithTx(tx)
	ctx := context.Background()
	if err = q.InterruptTasks(ctx, db.InterruptTasksParams{Updated: t.Updated, Error: "设备任务已中断"}); err != nil {
		return err
	}
	if err = q.InsertTask(ctx, db.InsertTaskParams{ID: t.ID, Action: t.Action, State: t.State, Phase: t.Phase, Updated: t.Updated, Result: t.Result, Error: t.Error, Hash: t.Hash, Fingerprint: fingerprint, Request: request}); err != nil {
		return err
	}
	if err = q.SetLatestTask(ctx, sql.NullString{String: t.ID, Valid: true}); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) UpdateTask(t Task) error {
	n, err := s.queries.UpdateTask(context.Background(), db.UpdateTaskParams{State: t.State, Phase: t.Phase, Updated: t.Updated, Result: t.Result, Error: t.Error, ID: t.ID})
	if err == nil && n != 1 {
		return sql.ErrNoRows
	}
	return err
}

type ComponentUpdate struct {
	Current string `json:"current"`
	Latest  string `json:"latest"`
	State   string `json:"state"`
	Error   string `json:"error,omitempty"`
}
type Updates struct {
	CheckedAt string          `json:"checkedAt"`
	Self      ComponentUpdate `json:"self"`
	Core      ComponentUpdate `json:"core"`
	Dashboard ComponentUpdate `json:"dashboard"`
}

func (s *Store) Updates() (*Updates, error) {
	value, err := s.queries.Updates(context.Background())
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &Updates{
		CheckedAt: value.CheckedAt,
		Self:      ComponentUpdate{Current: value.SelfCurrent, Latest: value.SelfLatest, State: value.SelfState, Error: value.SelfError},
		Core:      ComponentUpdate{Current: value.CoreCurrent, Latest: value.CoreLatest, State: value.CoreState, Error: value.CoreError},
		Dashboard: ComponentUpdate{Current: value.DashboardCurrent, Latest: value.DashboardLatest, State: value.DashboardState, Error: value.DashboardError},
	}, err
}
func (s *Store) SaveUpdates(u Updates) error {
	return s.queries.SaveUpdates(context.Background(), db.SaveUpdatesParams{
		CheckedAt:   u.CheckedAt,
		SelfCurrent: u.Self.Current, SelfLatest: u.Self.Latest, SelfState: u.Self.State, SelfError: u.Self.Error,
		CoreCurrent: u.Core.Current, CoreLatest: u.Core.Latest, CoreState: u.Core.State, CoreError: u.Core.Error,
		DashboardCurrent: u.Dashboard.Current, DashboardLatest: u.Dashboard.Latest, DashboardState: u.Dashboard.State, DashboardError: u.Dashboard.Error,
	})
}
