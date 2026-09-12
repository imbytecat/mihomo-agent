package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type Job struct {
	ID      string `json:"id"`
	Action  string `json:"action"`
	State   string `json:"state"`
	Phase   string `json:"phase"`
	Updated string `json:"updated"`
	Result  string `json:"result,omitempty"`
	Error   string `json:"error,omitempty"`
	Hash    string `json:"hash"`
}

func (a *Agent) taskPath(id string, file string) string { return a.path("tasks", id, file) }
func (a *Agent) writeJob(job *Job) error {
	job.Updated = time.Now().UTC().Format(time.RFC3339Nano)
	return writeJSON(a.taskPath(job.ID, "state.json"), job)
}

func (a *Agent) Submit(name, digest string) (*Job, error) {
	if err := a.requireIdentity(); err != nil {
		return nil, err
	}
	request, sealed, err := a.claimRequest(name, digest)
	if err != nil {
		return nil, err
	}
	lock, err := a.lock()
	if err != nil {
		return nil, err
	}
	defer lock.Close()
	var existing Job
	if readJSON(a.taskPath(request.ID, "state.json"), &existing) == nil {
		if existing.Hash != digest {
			return nil, errors.New("任务 ID 冲突")
		}
		return &existing, nil
	}
	job := &Job{ID: request.ID, Action: request.Action, State: "queued", Phase: "accepted", Hash: digest}
	if err = atomicWrite(a.taskPath(job.ID, "request.bin"), sealed, 0600); err != nil {
		return nil, err
	}
	if err = a.writeJob(job); err != nil {
		return nil, err
	}
	if err = atomicWrite(a.path("latest-task"), []byte(job.ID), 0600); err != nil {
		return nil, err
	}
	log, err := os.OpenFile(a.taskPath(job.ID, "log.txt"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	defer log.Close()
	cmd := exec.Command(a.path("agent"), "worker", "--root", a.Root, "--uploads", a.Uploads, job.ID)
	cmd.ExtraFiles = []*os.File{lock}
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
	_ = cmd.Process.Release()
	return job, nil // The worker inherited the locked descriptor; browser lifetime is irrelevant.
}

func (a *Agent) Job(id string) (*Job, error) {
	if !validID(id) {
		return nil, errors.New("invalid task id")
	}
	var job Job
	if err := readJSON(a.taskPath(id, "state.json"), &job); err != nil {
		return nil, errors.New("任务不存在")
	}
	if job.State == "running" || job.State == "queued" {
		if lock, err := a.lock(); err == nil {
			defer lock.Close()
			// Re-read after acquiring the lock: the worker may just have finished.
			if err = readJSON(a.taskPath(id, "state.json"), &job); err != nil {
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

func (a *Agent) Worker(id string) error {
	if !validID(id) {
		return errors.New("invalid task id")
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
	var job Job
	if err = readJSON(a.taskPath(id, "state.json"), &job); err != nil {
		return err
	}
	if job.State != "queued" {
		return errors.New("任务不能重复执行")
	}
	sealed, err := os.ReadFile(a.taskPath(id, "request.bin"))
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
	if runErr != nil {
		job.State = "failed"
		job.Error = sanitize(runErr.Error())
		fmt.Println(job.Error)
	} else {
		job.State = "succeeded"
		job.Result = result
		job.Phase = "done"
	}
	return a.writeJob(&job)
}

func (a *Agent) latestJob() *Job {
	data, err := os.ReadFile(a.path("latest-task"))
	if err != nil {
		return nil
	}
	job, _ := a.Job(strings.TrimSpace(string(data)))
	return job
}

func (a *Agent) readJobLog(id string) string {
	if !validID(id) {
		return ""
	}
	data, _ := os.ReadFile(a.taskPath(id, "log.txt"))
	if len(data) > 24*1024 {
		data = data[len(data)-24*1024:]
	}
	return sanitize(string(data))
}

func (a *Agent) jobDir(id string) string { return filepath.Join(a.Root, "tasks", id) }

func (a *Agent) JobLog(id string) (string, error) {
	if _, err := a.Job(id); err != nil {
		return "", err
	}
	return a.readJobLog(id), nil
}
