// Package storage is the transactional owner of manager metadata, not runtime files.
package storage

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	_ "modernc.org/sqlite"
)

const Filename = "state.db"
const Lockfile = "state.lock"
const schemaVersion = 1

type Store struct {
	db  *sql.DB
	pin *os.File
}
type Deployment struct {
	Kind          string `json:"kind"`
	CorePath      string `json:"corePath,omitempty"`
	Unit          string `json:"unit,omitempty"`
	ListenAddress string `json:"listenAddress,omitempty"`
}
type Identity struct {
	Protocol        int
	Public, Private [32]byte
}
type Settings struct {
	GitHubProxy string   `json:"githubProxy"`
	Interfaces  []string `json:"interfaces"`
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

const schema = `
CREATE TABLE identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), protocol INTEGER NOT NULL, public_key BLOB NOT NULL CHECK(length(public_key)=32), private_key BLOB NOT NULL CHECK(length(private_key)=32));
CREATE TABLE deployment (singleton INTEGER PRIMARY KEY CHECK(singleton=1), kind TEXT NOT NULL, core_path TEXT NOT NULL, unit TEXT NOT NULL, listen_address TEXT NOT NULL);
CREATE TABLE settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1), installed INTEGER NOT NULL DEFAULT 0, github_proxy TEXT NOT NULL DEFAULT '', interfaces TEXT NOT NULL DEFAULT '', latest_task TEXT REFERENCES tasks(id));
CREATE TABLE controller (singleton INTEGER PRIMARY KEY CHECK(singleton=1), enabled INTEGER NOT NULL, port INTEGER NOT NULL, secret TEXT NOT NULL);
CREATE TABLE tasks (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, action TEXT NOT NULL, state TEXT NOT NULL, phase TEXT NOT NULL, updated TEXT NOT NULL, result TEXT NOT NULL, error TEXT NOT NULL, hash TEXT NOT NULL, fingerprint TEXT NOT NULL, request BLOB);
CREATE INDEX tasks_state ON tasks(state);
CREATE TABLE configurations (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, url TEXT NOT NULL, enabled INTEGER NOT NULL, port INTEGER NOT NULL, secret TEXT NOT NULL, dashboard INTEGER NOT NULL);
CREATE TABLE pending (singleton INTEGER PRIMARY KEY CHECK(singleton=1), previous TEXT NOT NULL, next TEXT NOT NULL REFERENCES configurations(id), was_running INTEGER NOT NULL);
CREATE TABLE dashboards (id TEXT PRIMARY KEY, version TEXT NOT NULL);
CREATE TABLE core_version (singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL, version TEXT NOT NULL);
PRAGMA user_version=1;
`

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
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err = db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	ok = true
	return &Store{db: db, pin: pin}, nil
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
	if _, err = tx.Exec("INSERT INTO identity VALUES(1,?,?,?)", id.Protocol, id.Public[:], id.Private[:]); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO deployment VALUES(1,?,?,?,?)", deployment.Kind, deployment.CorePath, deployment.Unit, deployment.ListenAddress); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO settings(singleton) VALUES(1)"); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO controller VALUES(1,?,?,?)", controller.Enabled, controller.Port, controller.Secret); err != nil {
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
	var id Identity
	var public, private []byte
	err := s.db.QueryRow("SELECT protocol,public_key,private_key FROM identity WHERE singleton=1").Scan(&id.Protocol, &public, &private)
	if err != nil {
		return id, err
	}
	if len(public) != 32 || len(private) != 32 {
		return id, errors.New("身份密钥损坏")
	}
	copy(id.Public[:], public)
	copy(id.Private[:], private)
	return id, nil
}
func (s *Store) Deployment() (Deployment, error) {
	var d Deployment
	err := s.db.QueryRow("SELECT kind,core_path,unit,listen_address FROM deployment WHERE singleton=1").Scan(&d.Kind, &d.CorePath, &d.Unit, &d.ListenAddress)
	return d, err
}
func (s *Store) Installed() (bool, error) {
	var value bool
	err := s.db.QueryRow("SELECT installed FROM settings WHERE singleton=1").Scan(&value)
	return value, err
}
func (s *Store) SetInstalled() error {
	_, err := s.db.Exec("UPDATE settings SET installed=1 WHERE singleton=1")
	return err
}
func (s *Store) Settings() (Settings, error) {
	var p Settings
	var interfaces string
	err := s.db.QueryRow("SELECT github_proxy,interfaces FROM settings WHERE singleton=1").Scan(&p.GitHubProxy, &interfaces)
	p.Interfaces = strings.Fields(interfaces)
	return p, err
}
func (s *Store) SaveSettings(p Settings) error {
	_, err := s.db.Exec("UPDATE settings SET github_proxy=?,interfaces=? WHERE singleton=1", p.GitHubProxy, strings.Join(p.Interfaces, " "))
	return err
}
func (s *Store) Controller() (Controller, error) {
	var c Controller
	err := s.db.QueryRow("SELECT enabled,port,secret FROM controller WHERE singleton=1").Scan(&c.Enabled, &c.Port, &c.Secret)
	return c, err
}
func (s *Store) SaveController(c Controller) error {
	_, err := s.db.Exec("UPDATE controller SET enabled=?,port=?,secret=? WHERE singleton=1", c.Enabled, c.Port, c.Secret)
	return err
}
func (s *Store) Configuration(id string) (Configuration, error) {
	var c Configuration
	var control Controller
	c.ID = id
	err := s.db.QueryRow("SELECT url,enabled,port,secret,dashboard FROM configurations WHERE id=?", id).Scan(&c.URL, &control.Enabled, &control.Port, &control.Secret, &c.Dashboard)
	c.Controller = &control
	return c, err
}
func (s *Store) SaveConfiguration(c Configuration) error {
	_, err := s.db.Exec("INSERT INTO configurations(id,url,enabled,port,secret,dashboard) VALUES(?,?,?,?,?,?)", c.ID, c.URL, c.Controller.Enabled, c.Controller.Port, c.Controller.Secret, c.Dashboard)
	return err
}
func (s *Store) Pending() (*Pending, error) {
	var p Pending
	err := s.db.QueryRow("SELECT previous,next,was_running FROM pending WHERE singleton=1").Scan(&p.Previous, &p.Next, &p.WasRunning)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &p, err
}
func (s *Store) SavePending(p Pending) error {
	_, err := s.db.Exec("INSERT INTO pending VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET previous=excluded.previous,next=excluded.next,was_running=excluded.was_running", p.Previous, p.Next, p.WasRunning)
	return err
}
func (s *Store) ClearPending() error { _, err := s.db.Exec("DELETE FROM pending"); return err }
func (s *Store) OldConfigurations(active string) ([]string, error) {
	rows, err := s.db.Query("SELECT id FROM configurations WHERE id<>? ORDER BY seq DESC LIMIT -1 OFFSET 2", active)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
func (s *Store) DeleteConfiguration(id string) error {
	_, err := s.db.Exec("DELETE FROM configurations WHERE id=?", id)
	return err
}
func (s *Store) SaveDashboard(id, version string) error {
	_, err := s.db.Exec("INSERT INTO dashboards VALUES(?,?)", id, version)
	return err
}
func (s *Store) Dashboard(id string) (string, error) {
	var version string
	err := s.db.QueryRow("SELECT version FROM dashboards WHERE id=?", id).Scan(&version)
	return version, err
}
func (s *Store) CoreVersion(identity string) (string, error) {
	var version string
	err := s.db.QueryRow("SELECT version FROM core_version WHERE singleton=1 AND identity=?", identity).Scan(&version)
	return version, err
}
func (s *Store) SaveCoreVersion(identity, version string) error {
	_, err := s.db.Exec("INSERT INTO core_version VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET identity=excluded.identity,version=excluded.version", identity, version)
	return err
}

const taskColumns = "id,action,state,phase,updated,result,error,hash"

func (s *Store) Task(id string) (Task, error) {
	var t Task
	err := s.db.QueryRow("SELECT "+taskColumns+" FROM tasks WHERE id=?", id).Scan(&t.ID, &t.Action, &t.State, &t.Phase, &t.Updated, &t.Result, &t.Error, &t.Hash)
	return t, err
}
func (s *Store) LatestTask() (string, error) {
	var id string
	err := s.db.QueryRow("SELECT latest_task FROM settings WHERE singleton=1 AND latest_task IS NOT NULL").Scan(&id)
	return id, err
}
func (s *Store) ClearLatest() error {
	_, err := s.db.Exec("UPDATE settings SET latest_task=NULL WHERE singleton=1")
	return err
}
func (s *Store) Fingerprint(id string) (string, error) {
	var value string
	err := s.db.QueryRow("SELECT fingerprint FROM tasks WHERE id=?", id).Scan(&value)
	return value, err
}
func (s *Store) Request(id string) ([]byte, error) {
	var value []byte
	err := s.db.QueryRow("SELECT request FROM tasks WHERE id=?", id).Scan(&value)
	return value, err
}
func (s *Store) CreateTask(t Task, fingerprint string, request []byte) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("UPDATE tasks SET state='interrupted',error='设备任务已中断',updated=? WHERE state IN ('queued','running')", t.Updated); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO tasks(id,action,state,phase,updated,result,error,hash,fingerprint,request) VALUES(?,?,?,?,?,?,?,?,?,?)", t.ID, t.Action, t.State, t.Phase, t.Updated, t.Result, t.Error, t.Hash, fingerprint, request); err != nil {
		return err
	}
	if _, err = tx.Exec("UPDATE settings SET latest_task=? WHERE singleton=1", t.ID); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) UpdateTask(t Task) error {
	result, err := s.db.Exec("UPDATE tasks SET state=?,phase=?,updated=?,result=?,error=? WHERE id=?", t.State, t.Phase, t.Updated, t.Result, t.Error, t.ID)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err == nil && n != 1 {
		return sql.ErrNoRows
	}
	return err
}
func (s *Store) PruneRequests() error {
	_, err := s.db.Exec("UPDATE tasks SET request=NULL WHERE state NOT IN ('queued','running')")
	return err
}
