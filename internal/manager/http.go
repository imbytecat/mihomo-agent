package manager

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/imbytecat/mihomoctl/internal/download"
)

func (a *Manager) deviceClient() *http.Client {
	client := download.NewClient(a.Platform.CertDirs())
	if a.httpTransport != nil {
		client.Transport = a.httpTransport
	}
	return client
}

func (a *Manager) releaseClient() (*http.Client, error) {
	settings, err := a.settings()
	if err != nil {
		return nil, err
	}
	client := a.deviceClient()
	if err := download.Forward(client, settings.ReleaseProxy); err != nil {
		return nil, err
	}
	return client, nil
}

func (a *Manager) fetchRelease(ctx context.Context, address, destination string, max int64) error {
	client, err := a.releaseClient()
	if err != nil {
		return err
	}
	return a.fetchWithClient(ctx, client, address, destination, max)
}

// Every outbound request is made by the device. TLS remains verified on DNS fallback.
func (a *Manager) fetch(ctx context.Context, address, destination string, max int64) error {
	return a.fetchWithClient(ctx, a.deviceClient(), address, destination, max)
}
func (a *Manager) fetchWithClient(ctx context.Context, client *http.Client, address, destination string, max int64) error {
	defer client.CloseIdleConnections()
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	const idleLimit = 45 * time.Second
	idle := time.AfterFunc(idleLimit, func() {
		cancel(errors.New("下载连续 45 秒未收到数据，请检查网络或发行转发地址后重试"))
	})
	defer idle.Stop()
	parsed, err := url.Parse(address)
	if err != nil {
		return errors.New("下载地址无效")
	}
	request, err := http.NewRequestWithContext(ctx, "GET", address, nil)
	if err != nil {
		return errors.New("下载地址无效")
	}
	request.Header.Set("User-Agent", "mihomoctl/"+a.Version)
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("设备访问 %s 失败：%w", parsed.Hostname(), download.Cause(err))
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("设备访问 %s：HTTP %d", parsed.Hostname(), response.StatusCode)
	}
	if response.ContentLength > max {
		return errors.New("下载文件超过大小限制")
	}
	f, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	task, _ := ctx.Value(taskContextKey{}).(taskControl)
	total := response.ContentLength
	if total < 0 {
		total = 0
	}
	transfer := &transferReader{Reader: response.Body, idle: idle, limit: idleLimit, report: task.progress, total: total, started: time.Now()}
	if task.progress != nil {
		if err := task.progress(0, transfer.total, 0); err != nil {
			return err
		}
	}
	n, err := io.Copy(f, io.LimitReader(transfer, max+1))
	idle.Stop()
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	err = transfer.flush(err)
	if err != nil {
		return err
	}
	if n == 0 || n > max {
		return errors.New("下载文件为空或超过大小限制")
	}
	return f.Sync()
}
