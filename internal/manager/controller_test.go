package manager

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/imbytecat/mihomoctl/internal/fsutil"
	"github.com/imbytecat/mihomoctl/internal/platform"

	"go.yaml.in/yaml/v3"
	"golang.org/x/crypto/nacl/box"
)

type canceledStart struct {
	platform.Adapter
	cancel  context.CancelFunc
	starts  int
	running bool
}

func (p *canceledStart) Inspect(context.Context) (platform.State, error) {
	return platform.State{Running: p.running}, nil
}
func (p *canceledStart) Stop(context.Context) error { p.running = false; return nil }
func (p *canceledStart) Start(ctx context.Context, _ platform.StartOptions) error {
	p.starts++
	if p.starts == 1 {
		p.cancel()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	p.running = true
	return nil
}

func TestCanceledConfigApplyRestoresRunningGeneration(t *testing.T) {
	a := testAgent(t)
	if err := fsutil.AtomicWrite(a.corePath(), []byte("fixture"), 0700); err != nil {
		t.Fatal(err)
	}
	control, _ := a.controller()
	source := []byte("proxies: []\n")
	previous := randomID()
	if err := a.applyConfig(context.Background(), previous, source, "https://old.invalid", control, func(string) {}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := &canceledStart{Adapter: a.Platform, cancel: cancel, running: true}
	a.Platform = p
	control.Port = 9191
	if err := a.applyConfig(ctx, randomID(), source, "https://new.invalid", control, func(string) {}); err == nil {
		t.Fatal("reported success after canceled start")
	}
	if active, err := a.activeGeneration(); err != nil || active != previous || !p.running || p.starts != 2 {
		t.Fatal("failed to restore running generation", active, p.running, p.starts, err)
	}
	if current, err := a.configuration(); err != nil || current.URL != "https://old.invalid" || current.Controller.Port != 9090 {
		t.Fatal("rollback lost configuration metadata", err)
	}
}

func TestDeviceControllerOverridesSubscriptionWithoutSecret(t *testing.T) {
	a := testAgent(t)
	control, err := a.controller()
	if err != nil || len(control.Secret) != 64 {
		t.Fatal("missing generated secret", err)
	}
	source := []byte("proxies: []\nrules: [MATCH,DIRECT]\nexternal-controller: 127.0.0.1:9999\nexternal-ui: old-ui\n")
	config, ports, err := adaptConfig(source, control, false, ufiPolicy)
	if err != nil {
		t.Fatal(err)
	}
	var data map[string]any
	_ = yaml.Unmarshal(config, &data)
	if data["secret"] != control.Secret || data["external-controller"] != "0.0.0.0:9090" || data["external-ui"] != nil || !strings.Contains(ports, "9090") {
		t.Fatal("management settings not applied")
	}
	control.Enabled = false
	config, ports, err = adaptConfig(source, control, true, ufiPolicy)
	if err != nil || strings.Contains(string(config), "external-") || strings.Contains(ports, "9090") {
		t.Fatal("disabled API still exposed")
	}
	control.Enabled = true
	if _, _, err = adaptConfig(append(source, []byte("mixed-port: 9090\n")...), control, false, ufiPolicy); err == nil {
		t.Fatal("accepted port collision")
	}
	public, private, _ := box.GenerateKey(rand.Reader)
	encoded, err := a.ControllerSecret(base64.StdEncoding.EncodeToString(public[:]))
	if err != nil {
		t.Fatal(err)
	}
	sealed, _ := base64.StdEncoding.DecodeString(encoded)
	plain, ok := box.OpenAnonymous(nil, sealed, public, private)
	if !ok || string(plain) != control.Secret || strings.Contains(encoded, control.Secret) {
		t.Fatal("secret transport failed")
	}
	status, err := a.Inspect()
	output, _ := json.Marshal(status)
	if err != nil || bytes.Contains(output, []byte(control.Secret)) {
		t.Fatal("inspect leaked secret")
	}
}

func TestControllerSecretHasNoLengthPolicy(t *testing.T) {
	for _, secret := range []string{"a", "123", strings.Repeat("x", 300)} {
		if err := (Controller{Enabled: true, Port: 9090, Secret: secret}).validate(); err != nil {
			t.Fatalf("rejected a valid key of length %d: %v", len(secret), err)
		}
	}
	for _, secret := range []string{"", "invalid\r\nheader", "invalid\x00header"} {
		if err := (Controller{Enabled: true, Port: 9090, Secret: secret}).validate(); err == nil {
			t.Fatal("accepted empty or malformed authentication key")
		}
	}
}

func TestControllerSettingsCommitWithConfigAndRollbackOnFailure(t *testing.T) {
	a := testAgent(t)
	_ = fsutil.AtomicWrite(a.runtime("mihomo"), []byte("fixture"), 0700)
	control, _ := a.controller()
	source := []byte("proxies: []\nrules: [MATCH,DIRECT]\n")
	if err := a.applyConfig(context.Background(), randomID(), source, "https://fixture.invalid", control, func(string) {}); err != nil {
		t.Fatal(err)
	}
	request := Request{ID: randomID(), Params: Params{Controller: &ControllerInput{Enabled: new(true), Port: 9191, Reset: true}}}
	if _, err := a.saveController(context.Background(), request, func(string) {}); err != nil {
		t.Fatal(err)
	}
	current, _ := a.controller()
	if current.Port != 9191 || current.Secret == control.Secret {
		t.Fatal("settings not committed")
	}
	active, _ := a.activeGeneration()
	a.runCommand = func(context.Context, string, ...string) ([]byte, error) { return nil, errors.New("invalid config") }
	request.ID = randomID()
	request.Params.Controller = &ControllerInput{Enabled: new(false), Port: 9292}
	if _, err := a.saveController(context.Background(), request, func(string) {}); err == nil {
		t.Fatal("accepted invalid config")
	}
	after, _ := a.controller()
	if next, _ := a.activeGeneration(); next != active || after != current {
		t.Fatal("failed save changed active settings")
	}
}

func TestDashboardArchiveRejectsTraversalAndSymlinks(t *testing.T) {
	for _, test := range []struct {
		name  string
		mode  os.FileMode
		valid bool
	}{
		{"dist/index.html", 0600, true}, {"../index.html", 0600, false}, {"/index.html", 0600, false}, {"index.html", os.ModeSymlink | 0600, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			var data bytes.Buffer
			writer := zip.NewWriter(&data)
			header := &zip.FileHeader{Name: test.name}
			header.SetMode(test.mode)
			file, _ := writer.CreateHeader(header)
			_, _ = file.Write([]byte("fixture"))
			_ = writer.Close()
			dir := t.TempDir()
			archive := filepath.Join(dir, "ui.zip")
			_ = os.WriteFile(archive, data.Bytes(), 0600)
			_, err := extractDashboard(archive, filepath.Join(dir, "ui"))
			if (err == nil) != test.valid {
				t.Fatal("unexpected archive verdict", err)
			}
		})
	}
}

func TestDashboardInstallVerifiesAndAppliesLocalUI(t *testing.T) {
	a := testAgent(t)
	_ = fsutil.AtomicWrite(a.runtime("mihomo"), []byte("fixture"), 0700)
	control, _ := a.controller()
	if err := a.applyConfig(context.Background(), randomID(), []byte("proxies: []\nrules: [MATCH,DIRECT]\n"), "https://subscription.invalid", control, func(string) {}); err != nil {
		t.Fatal(err)
	}
	var data bytes.Buffer
	writer := zip.NewWriter(&data)
	file, _ := writer.Create("dist/index.html")
	_, _ = file.Write([]byte("dashboard fixture"))
	_ = writer.Close()
	sum := sha256.Sum256(data.Bytes())
	version, tampered := "v3.26.0", false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/latest") {
			_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": version, "draft": false, "prerelease": false, "assets": []map[string]string{{
				"name": "dist-no-fonts.zip", "browser_download_url": "https://github.com/Zephyruso/zashboard/releases/download/" + version + "/dist-no-fonts.zip", "digest": "sha256:" + hex.EncodeToString(sum[:]),
			}}})
		} else if tampered {
			_, _ = w.Write([]byte("tampered"))
		} else {
			_, _ = w.Write(data.Bytes())
		}
	}))
	defer server.Close()
	a.httpTransport = localTransport{server.URL}
	install := func() error {
		_, err := a.downloadDashboard(context.Background(), Request{ID: randomID()}, t.TempDir(), func(string) {})
		return err
	}
	if err := install(); err != nil {
		t.Fatal(err)
	}
	if state := a.dashboard(); !state.Installed || !state.Ready || state.Version != version {
		t.Fatal(state)
	}
	config, _ := os.ReadFile(a.runtime("current", "config.yaml"))
	if !bytes.Contains(config, []byte("external-ui: dashboard")) {
		t.Fatal("UI not exposed in managed config")
	}
	previous, _ := os.Readlink(a.runtime("dashboard"))
	tampered = true
	if err := install(); err == nil {
		t.Fatal("accepted invalid dashboard digest")
	}
	if target, _ := os.Readlink(a.runtime("dashboard")); target != previous {
		t.Fatal("replaced UI on failure")
	}
	tampered, version = false, "v3.26.1"
	a.runCommand = func(context.Context, string, ...string) ([]byte, error) {
		t.Fatal("UI update restarted the proxy")
		return nil, nil
	}
	if err := install(); err != nil {
		t.Fatal(err)
	}
	if a.dashboard().Version != version {
		t.Fatal("UI version not updated")
	}
}
