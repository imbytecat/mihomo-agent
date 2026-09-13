package download

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

type fallbackTransport struct{ primary, fallback http.RoundTripper }

func (t *fallbackTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := t.primary.RoundTrip(request)
	if err == nil || request.Context().Err() != nil {
		return response, err
	}
	response, fallbackErr := t.fallback.RoundTrip(request.Clone(request.Context()))
	if fallbackErr != nil {
		return nil, fmt.Errorf("系统连接：%v；DNS 回退：%v", Cause(err), Cause(fallbackErr))
	}
	return response, nil
}
func (t *fallbackTransport) CloseIdleConnections() {
	for _, transport := range []http.RoundTripper{t.primary, t.fallback} {
		if closer, ok := transport.(interface{ CloseIdleConnections() }); ok {
			closer.CloseIdleConnections()
		}
	}
}

func NewClient(certDirs []string) *http.Client {
	dialer := &net.Dialer{Timeout: 8 * time.Second}
	client := httpClient(certDirs, dialer.DialContext)
	if len(certDirs) > 0 {
		client.Transport = &fallbackTransport{client.Transport, httpClient(certDirs, func(ctx context.Context, n, a string) (net.Conn, error) { return dohDial(certDirs, ctx, n, a) }).Transport}
	}
	return client
}
func trustedRoots(certDirs []string) *x509.CertPool {
	pool, _ := x509.SystemCertPool()
	if pool == nil {
		pool = x509.NewCertPool()
	}
	// A static Linux binary does not search Android's trust directories by default.
	for _, directory := range certDirs {
		entries, _ := os.ReadDir(directory)
		for _, entry := range entries {
			if data, err := os.ReadFile(filepath.Join(directory, entry.Name())); err == nil {
				pool.AppendCertsFromPEM(data)
			}
		}
	}
	return pool
}

func httpClient(certDirs []string, dial func(context.Context, string, string) (net.Conn, error)) *http.Client {
	return &http.Client{Transport: &http.Transport{
		Proxy: nil, DialContext: dial, TLSClientConfig: &tls.Config{RootCAs: trustedRoots(certDirs), MinVersion: tls.VersionTLS12},
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

func dohDial(certDirs []string, ctx context.Context, network, address string) (net.Conn, error) {
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
		client := httpClient(certDirs, func(ctx context.Context, network, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, network, net.JoinHostPort(provider.ip, "443"))
		})
		defer client.CloseIdleConnections()
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
	}
	return nil, fmt.Errorf("无法解析或连接 %s", host)
}

func Cause(err error) error {
	var requestError *url.Error
	if errors.As(err, &requestError) {
		return requestError.Err
	}
	return err
}
