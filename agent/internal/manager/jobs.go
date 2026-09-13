package manager

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"github.com/imbytecat/ufi-mihomo/agent/internal/redact"
	"github.com/imbytecat/ufi-mihomo/agent/internal/storage"
	"golang.org/x/crypto/nacl/box"
)

type Job = storage.Task

func (a *Manager) taskPath(id string, file string) string { return a.path("tasks", id, file) }
func (a *Manager) writeJob(job *Job) error {
	if err := a.openStore(); err != nil {
		return err
	}
	job.Updated = time.Now().UTC().Format(time.RFC3339Nano)
	return a.store.UpdateTask(*job)
}

// Submit is the same durable acceptance path for local CLI and decrypted UFI intents.
func (a *Manager) Submit(request Request) (*Job, error) {
	if request.ID == "" {
		request.ID = randomID()
	}
	if err := a.requireIdentity(); err != nil {
		return nil, err
	}
	if err := a.authorize(request); err != nil {
		return nil, err
	}
	key, err := a.identity()
	if err != nil {
		return nil, err
	}
	plain, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	sealed, err := box.SealAnonymous(nil, plain, &key.Public, rand.Reader)
	if err != nil {
		return nil, err
	}
	return a.accept(request, sealed)
}
func (a *Manager) SubmitSealed(sealed []byte) (*Job, error) {
	if err := a.requireIdentity(); err != nil {
		return nil, err
	}
	request, err := a.decrypt(sealed)
	if err != nil {
		return nil, err
	}
	if err := a.authorize(request); err != nil {
		return nil, err
	}
	return a.accept(request, sealed)
}
func (a *Manager) accept(request Request, sealed []byte) (*Job, error) {
	key, err := a.identity()
	if err != nil {
		return nil, err
	}
	plain, _ := json.Marshal(request)
	mac := hmac.New(sha256.New, key.Private[:])
	mac.Write(plain)
	fingerprint := hex.EncodeToString(mac.Sum(nil))
	sum := sha256.Sum256(sealed)
	digest := hex.EncodeToString(sum[:])
	lock, err := a.lock()
	if err != nil {
		return nil, err
	}
	defer lock.Close()

	existing, e := a.store.Task(request.ID)
	if e == nil {
		previous, e := a.store.Fingerprint(request.ID)
		if e != nil || previous != fingerprint {
			return nil, errors.New("任务 ID 冲突")
		}
		return &existing, nil
	}
	if !errors.Is(e, sql.ErrNoRows) {
		return nil, e
	}
	job := &Job{ID: request.ID, Action: request.Action, State: "queued", Phase: "accepted", Hash: digest, Updated: time.Now().UTC().Format(time.RFC3339Nano)}
	if err := a.store.CreateTask(*job, fingerprint, sealed); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(a.jobDir(job.ID), 0700); err != nil {
		return nil, err
	}
	log, err := os.OpenFile(a.taskPath(job.ID, "log.txt"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	defer log.Close()
	cmd := exec.Command(a.Executable, "worker", "--root", a.Root, job.ID)
	gate, release, e := os.Pipe()
	if e != nil {
		return nil, e
	}
	defer gate.Close()
	defer release.Close()
	cmd.ExtraFiles = []*os.File{lock, gate}
	cmd.Stdin = nil
	cmd.Stdout = log
	cmd.Stderr = log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err = cmd.Start(); err != nil {
		job.State = "failed"
		job.Error = "无法启动设备任务"
		_ = a.writeJob(job)
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err = a.Platform.AttachTask(ctx, cmd.Process.Pid, job.ID); err == nil {
		_, err = release.Write([]byte{1})
	}
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		job.State = "failed"
		job.Error = "无法托管设备任务"
		_ = a.writeJob(job)
		return nil, err
	}
	_ = cmd.Process.Release()
	return job, nil // The worker inherited the locked descriptor; browser lifetime is irrelevant.
}

func (a *Manager) Job(id string) (*Job, error) {
	if !validID(id) {
		return nil, errors.New("invalid task id")
	}
	if err := a.requireIdentity(); err != nil {
		return nil, err
	}
	job, err := a.store.Task(id)
	if err != nil {
		return nil, errors.New("任务不存在")
	}
	if job.State == "running" || job.State == "queued" {
		if lock, err := a.lock(); err == nil {
			defer lock.Close()
			// Re-read after acquiring the lock: the worker may just have finished.
			if job, err = a.store.Task(id); err != nil {
				return nil, err
			}
			if job.State == "running" || job.State == "queued" {
				job.State = "interrupted"
				job.Error = "设备任务已中断，请检查当前状态后重试"
				if err = a.writeJob(&job); err != nil {
					return nil, err
				}
			}
		}
	}
	return &job, nil
}

func (a *Manager) Worker(id string) (err error) {
	if !validID(id) {
		return errors.New("invalid task id")
	}
	gate := os.NewFile(4, "task-start-gate")
	if gate == nil {
		return errors.New("missing task gate")
	}
	info, e := gate.Stat()
	if e != nil || info.Mode()&os.ModeNamedPipe == 0 {
		return errors.New("invalid task gate")
	}
	var signal [1]byte
	n, e := gate.Read(signal[:])
	gate.Close()
	if e != nil || n != 1 || signal[0] != 1 {
		return errors.New("task launcher did not release worker")
	}
	lock := os.NewFile(3, "inherited-control-lock")
	if lock == nil {
		return errors.New("missing task lock")
	}
	defer lock.Close()
	actual, err := lock.Stat()
	expected, e := os.Stat(a.path("control.lock"))
	if err != nil || e != nil || !os.SameFile(actual, expected) {
		return errors.New("invalid task lock")
	}
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return err
	}
	job, err := a.store.Task(id)
	if err != nil {
		return err
	}
	if job.State != "queued" {
		return errors.New("任务不能重复执行")
	}
	defer func() {
		if err != nil {
			job.State = "failed"
			job.Error = redact.String(err.Error())
			_ = a.writeJob(&job)
		}
	}()
	sealed, err := a.store.Request(id)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(sealed)
	if hex.EncodeToString(sum[:]) != job.Hash {
		return errors.New("任务文件校验失败")
	}
	request, err := a.decrypt(sealed)
	if err != nil || request.ID != id || request.Action != job.Action {
		return errors.New("任务内容不匹配")
	}
	job.State = "running"
	job.Phase = "preparing"
	if err = a.writeJob(&job); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	phase := func(value string) {
		job.Phase = value
		_ = a.writeJob(&job)
		fmt.Println(time.Now().Format(time.RFC3339), value)
	}
	result, runErr := a.execute(ctx, request, phase)
	if request.Action == "uninstall" && runErr == nil {
		return nil // Never recreate a deleted installation to write a completion record.
	}
	if runErr != nil {
		job.State = "failed"
		job.Error = redact.String(runErr.Error())
		fmt.Println(job.Error)
	} else {
		job.State = "succeeded"
		job.Result = result
		job.Phase = "done"
	}
	if err := a.writeJob(&job); err != nil {
		return err
	}
	a.pruneTaskFiles()
	return nil
}

func (a *Manager) latestJob() *Job {
	id, err := a.store.LatestTask()
	if err != nil {
		return nil
	}
	job, _ := a.Job(id)
	return job
}

func (a *Manager) readJobLog(id string) string {
	if !validID(id) {
		return ""
	}
	data, _ := os.ReadFile(a.taskPath(id, "log.txt"))
	if len(data) > 24*1024 {
		data = data[len(data)-24*1024:]
	}
	return redact.String(string(data))
}

func (a *Manager) jobDir(id string) string { return filepath.Join(a.Root, "tasks", id) }

func (a *Manager) JobLog(id string) (string, error) {
	if _, err := a.Job(id); err != nil {
		return "", err
	}
	return a.readJobLog(id), nil
}
