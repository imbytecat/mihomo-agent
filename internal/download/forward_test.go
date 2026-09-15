package download

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestForwardOriginAndRequestBoundary(t *testing.T) {
	for _, value := range []string{"http://mirror.test", "https://user:pass@mirror.test", "https://mirror.test/path", "https://mirror.test/?token=x", "https://mirror.test/#", "https://mirror.test/?", "https://mirror.test/../", "https://mirror.test\\evil"} {
		if _, err := ForwardOrigin(value); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
	if origin, err := ForwardOrigin(" https://MIRROR.test/ "); err != nil || origin != "https://mirror.test" {
		t.Fatal(origin, err)
	}
	const upstream = "https://api.github.com/repos/o/r/releases/latest?value=a%2Fb+c&name=x%26y"
	redirect := false
	hits := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		// netnr/workers decodes the entire path once, not as query form data.
		if r.URL.Path != "/"+upstream || r.URL.RawQuery != "" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Errorf("forward changed URL or leaked credentials: %s", r.URL)
		}
		if redirect {
			http.Redirect(w, r, "https://github.com/unexpected", http.StatusFound)
			return
		}
		_, _ = io.WriteString(w, "release bytes")
	}))
	defer server.Close()
	client := server.Client()
	if err := Forward(client, server.URL); err != nil {
		t.Fatal(err)
	}
	defer client.CloseIdleConnections()
	request, _ := http.NewRequest("GET", upstream, nil)
	request.Header.Set("Authorization", "private")
	request.Header.Set("Cookie", "private=1")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if string(data) != "release bytes" || request.URL.String() != upstream || request.Header.Get("Authorization") != "private" {
		t.Fatal("request mutated or bytes corrupted")
	}
	redirect = true
	if response, err := client.Get(upstream); err == nil {
		response.Body.Close()
		t.Fatal("followed a forwarding response back to GitHub")
	}
	if _, err := client.Get("https://subscription.test/secret"); err == nil || !strings.Contains(err.Error(), "仅用于") {
		t.Fatal(err)
	}
	if hits != 2 {
		t.Fatal("unexpected outbound request", hits)
	}
}
