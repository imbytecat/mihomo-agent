package download

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
)

// ForwardOrigin accepts the public HTTPS origin hosting netnr/workers cors.js.
func ForwardOrigin(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	u, err := url.Parse(value)
	if err != nil || len(value) > 2048 || strings.ContainsAny(value, "\\\r\n\t\x00") || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(value, "#") {
		return "", errors.New("转发地址必须是 HTTPS 域名，不含路径、参数或凭据")
	}
	return "https://" + strings.ToLower(u.Host), nil
}

type forwardTransport struct {
	base   http.RoundTripper
	origin string
}

func (t *forwardTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.Scheme != "https" || (request.URL.Host != "api.github.com" && request.URL.Host != "github.com") {
		return nil, errors.New("转发仅用于 GitHub 发行请求")
	}
	address, err := url.Parse(t.origin + "/" + url.PathEscape(request.URL.String()))
	if err != nil {
		return nil, err
	}
	forwarded := request.Clone(request.Context())
	forwarded.URL, forwarded.Host = address, ""
	forwarded.Header.Del("Authorization")
	forwarded.Header.Del("Cookie")
	return t.base.RoundTrip(forwarded)
}

func (t *forwardTransport) CloseIdleConnections() {
	if closer, ok := t.base.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}

// Forward configures a dedicated public release client; subscription clients stay direct.
func Forward(client *http.Client, origin string) error {
	origin, err := ForwardOrigin(origin)
	if err != nil || origin == "" {
		return err
	}
	client.Transport = &forwardTransport{base: client.Transport, origin: origin}
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return errors.New("转发服务必须在服务端完成重定向")
	}
	return nil
}
