package agent

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

func trustedRoots() *x509.CertPool {
	pool, _ := x509.SystemCertPool()
	if pool == nil {
		pool = x509.NewCertPool()
	}
	// A static Linux binary does not search Android's trust directories by default.
	for _, directory := range []string{"/system/etc/security/cacerts", "/apex/com.android.conscrypt/cacerts"} {
		entries, _ := os.ReadDir(directory)
		for _, entry := range entries {
			if data, err := os.ReadFile(filepath.Join(directory, entry.Name())); err == nil {
				pool.AppendCertsFromPEM(data)
			}
		}
	}
	return pool
}

func httpClient(dial func(context.Context, string, string) (net.Conn, error)) *http.Client {
	return &http.Client{Transport: &http.Transport{
		Proxy: nil, DialContext: dial, TLSClientConfig: &tls.Config{RootCAs: trustedRoots(), MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout: 12 * time.Second, ResponseHeaderTimeout: 20 * time.Second, IdleConnTimeout: 30 * time.Second,
	}, CheckRedirect: func(request *http.Request, previous []*http.Request) error {
		if len(previous) >= 10 {
			return errors.New("too many redirects")
		}
		if request.URL.Scheme != "https" && (request.URL.Scheme != "http" || previous[0].URL.Scheme == "https") {
			return errors.New("unsafe redirect")
		}
		return nil
	}}
}

func dohDial(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	dialer := &net.Dialer{Timeout: 8 * time.Second}
	if net.ParseIP(host) != nil {
		return dialer.DialContext(ctx, network, address)
	}
	name, err := dnsmessage.NewName(host + ".")
	if err != nil {
		return nil, err
	}
	for _, provider := range []struct{ host, ip string }{{"dns.alidns.com", "223.5.5.5"}, {"cloudflare-dns.com", "1.1.1.1"}} {
		client := httpClient(func(ctx context.Context, network, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, network, net.JoinHostPort(provider.ip, "443"))
		})
		for _, kind := range []dnsmessage.Type{dnsmessage.TypeA, dnsmessage.TypeAAAA} {
			query := dnsmessage.Message{Header: dnsmessage.Header{RecursionDesired: true}, Questions: []dnsmessage.Question{{Name: name, Type: kind, Class: dnsmessage.ClassINET}}}
			wire, _ := query.Pack()
			request, _ := http.NewRequestWithContext(ctx, "POST", "https://"+provider.host+"/dns-query", bytes.NewReader(wire))
			request.Header.Set("Content-Type", "application/dns-message")
			response, e := client.Do(request)
			if e != nil {
				continue
			}
			data, e := io.ReadAll(io.LimitReader(response.Body, 65536))
			response.Body.Close()
			if e != nil || response.StatusCode != 200 {
				continue
			}
			var answer dnsmessage.Message
			if answer.Unpack(data) != nil || answer.RCode != dnsmessage.RCodeSuccess {
				continue
			}
			for _, resource := range answer.Answers {
				var ip net.IP
				switch body := resource.Body.(type) {
				case *dnsmessage.AResource:
					ip = net.IP(body.A[:])
				case *dnsmessage.AAAAResource:
					ip = net.IP(body.AAAA[:])
				}
				if ip != nil {
					if connection, e := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port)); e == nil {
						return connection, nil
					}
				}
			}
		}
		client.CloseIdleConnections()
	}
	return nil, fmt.Errorf("无法解析或连接 %s", host)
}

// Every outbound request is made by the device. TLS remains verified on DNS fallback.
func (a *Agent) fetch(ctx context.Context, address, destination string, max int64) error {
	parsed, err := url.Parse(address)
	if err != nil {
		return errors.New("下载地址无效")
	}
	request, err := http.NewRequestWithContext(ctx, "GET", address, nil)
	if err != nil {
		return errors.New("下载地址无效")
	}
	request.Header.Set("User-Agent", "ufi-mihomo-agent/"+a.Version)
	var response *http.Response
	if a.httpClient != nil {
		response, err = a.httpClient.Do(request)
	} else {
		dialer := &net.Dialer{Timeout: 8 * time.Second}
		client := httpClient(dialer.DialContext)
		defer client.CloseIdleConnections()
		response, err = client.Do(request)
		if err != nil && ctx.Err() == nil {
			fallback := httpClient(dohDial)
			defer fallback.CloseIdleConnections()
			response, err = fallback.Do(request.Clone(ctx))
		}
	}
	if err != nil {
		var requestError *url.Error
		if errors.As(err, &requestError) {
			err = requestError.Err
		}
		return fmt.Errorf("设备访问 %s 失败：%w", parsed.Hostname(), err)
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
