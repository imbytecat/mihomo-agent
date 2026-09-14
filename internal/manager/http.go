package manager

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"

	"github.com/imbytecat/mihomo-agent/internal/download"
)

func (a *Manager) deviceClient() *http.Client {
	client := download.NewClient(a.Platform.CertDirs())
	if a.httpTransport != nil {
		client.Transport = a.httpTransport
	}
	return client
}

// Every outbound request is made by the device. TLS remains verified on DNS fallback.
func (a *Manager) fetch(ctx context.Context, address, destination string, max int64) error {
	parsed, err := url.Parse(address)
	if err != nil {
		return errors.New("下载地址无效")
	}
	request, err := http.NewRequestWithContext(ctx, "GET", address, nil)
	if err != nil {
		return errors.New("下载地址无效")
	}
	request.Header.Set("User-Agent", "mihomo-agent/"+a.Version)
	client := a.deviceClient()
	defer client.CloseIdleConnections()
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
	n, err := io.Copy(f, io.LimitReader(response.Body, max+1))
	if err != nil {
		return err
	}
	if n == 0 || n > max {
		return errors.New("下载文件为空或超过大小限制")
	}
	return f.Sync()
}
