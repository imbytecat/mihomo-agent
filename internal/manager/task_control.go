package manager

import (
	"context"
	"errors"
	"github.com/imbytecat/mihomoctl/internal/redact"
	"strings"
	"time"
)

type taskContextKey struct{}
type taskControl struct {
	progress func(int64, int64, float64) error
	commit   func() error
}

func commitTask(ctx context.Context) error {
	if err := context.Cause(ctx); err != nil {
		return err
	}
	if task, ok := ctx.Value(taskContextKey{}).(taskControl); ok {
		return task.commit()
	}
	return nil
}

func cancellableAction(action string) bool {
	return action == "download" || action == "download-dashboard" || action == "self-update" || action == "update"
}

// Cancellation must not acquire control.lock: the worker holds it until cleanup.
// The SQL condition races atomically with the worker's commit boundary.
func (a *Manager) Cancel(id string) (*Job, error) {
	job, err := a.Job(id)
	if err != nil {
		return nil, err
	}
	if job.State != "queued" && job.State != "running" {
		return job, nil
	}
	ok, err := a.store.CancelTask(id)
	if err != nil {
		return nil, err
	}
	if !ok {
		latest, readErr := a.Job(id)
		if readErr == nil && latest.State != "queued" && latest.State != "running" {
			return latest, nil
		}
		return nil, errors.New("任务已进入不可取消阶段，请等待完成")
	}
	return a.Job(id)
}

func (a *Manager) watchCancellation(ctx context.Context, id string, cancel context.CancelCauseFunc) {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		job, err := a.store.Task(id)
		if err != nil {
			cancel(err)
			return
		}
		if job.CancelRequested {
			cancel(context.Canceled)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func taskError(err error) string {
	return redact.String(strings.ReplaceAll(err.Error(), context.DeadlineExceeded.Error(), "请求超时"))
}
