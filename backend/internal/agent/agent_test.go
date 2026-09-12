package agent

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"
	"golang.org/x/crypto/nacl/box"
)

type localHTTP struct{ address string }

func (client localHTTP) Do(request *http.Request) (*http.Response, error) {
	target, _ := url.Parse(client.address)
	copy := request.Clone(request.Context())
	u := *request.URL
	u.Scheme = target.Scheme
	u.Host = target.Host
	copy.URL = &u
	return http.DefaultClient.Do(copy)
}

// A real child process exercises descriptor handoff without running ARM or firewall code.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "worker" {
		flags := flag.NewFlagSet("worker", flag.ExitOnError)
		root := flags.String("root", "", "")
		uploads := flags.String("uploads", "", "")
		_ = flags.Parse(os.Args[2:])
		a, err := New(*root, *uploads, "test")
		if err != nil {
			os.Exit(2)
		}
		if address := os.Getenv("UFI_TEST_HTTP"); address != "" {
			a.httpClient = localHTTP{address}
		}
		if err = a.Worker(flags.Arg(0)); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func testAgent(t *testing.T) *Agent {
	t.Helper()
	base := t.TempDir()
	root := filepath.Join(base, "ufi-mihomo")
	uploads := filepath.Join(base, "uploads")
	if err := os.Mkdir(uploads, 0700); err != nil {
		t.Fatal(err)
	}
	a, err := New(root, uploads, "test")
	if err != nil {
		t.Fatal(err)
	}
	a.BootPath = filepath.Join(base, "boot.sh")
	if err = a.Install(); err != nil {
		t.Fatal(err)
	}
	a.runCommand = func(context.Context, string, ...string) ([]byte, error) {
		return []byte(`{"listeners":false,"network":false}`), nil
	}
	return a
}

func sealRequest(t *testing.T, a *Agent, request Request) (string, string, []byte) {
	t.Helper()
	var key keyPair
	if err := readJSON(a.path("identity.json"), &key); err != nil {
		t.Fatal(err)
	}
	plain, _ := json.Marshal(request)
	data, err := box.SealAnonymous(nil, plain, &key.Public, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	id := randomID()
	name := id[:8] + "-" + id[8:12] + "-" + id[12:16] + "-" + id[16:20] + "-" + id[20:] + ".bin"
	if err = atomicWrite(filepath.Join(a.Uploads, name), data, 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	return name, hex.EncodeToString(digest[:]), data
}

func waitJob(t *testing.T, a *Agent, id string) *Job {
	t.Helper()
	for i := 0; i < 100; i++ {
		job, err := a.Job(id)
		if err != nil {
			t.Fatal(err)
		}
		if job.State != "queued" && job.State != "running" {
			return job
		}
		time.Sleep(30 * time.Millisecond)
	}
	t.Fatal("job did not finish")
	return nil
}

func TestEncryptedSubmissionAndDurableCompletion(t *testing.T) {
	a := testAgent(t)
	request := Request{ID: randomID(), Action: "save-mirror", Value: "https://mirror.example"}
	name, digest, data := sealRequest(t, a, request)
	if bytes.Contains(data, []byte(request.Value)) {
		t.Fatal("request is not encrypted")
	}
	job, err := a.Submit(name, digest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(a.Uploads, name)); !os.IsNotExist(err) {
		t.Fatal("staging file not consumed")
	}
	finished := waitJob(t, a, job.ID)
	if finished.State != "succeeded" {
		t.Fatalf("%+v", finished)
	}
	settings, _ := a.settings()
	if settings.Mirror != request.Value {
		t.Fatal(settings)
	}
	if err = atomicWrite(filepath.Join(a.Uploads, name), data, 0600); err != nil {
		t.Fatal(err)
	}
	repeated, err := a.Submit(name, digest)
	if err != nil || repeated.ID != job.ID || repeated.State != "succeeded" {
		t.Fatalf("replay: %+v %v", repeated, err)
	}
}

func TestTaskRetainsLockAfterSubmitterReturns(t *testing.T) {
	a := testAgent(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(entered); <-release; _, _ = w.Write([]byte(`{}`)) }))
	defer server.Close()
	t.Setenv("UFI_TEST_HTTP", server.URL)
	_ = atomicWrite(a.runtime("mihomo"), []byte("fixture"), 0700)
	name, digest, _ := sealRequest(t, a, Request{ID: randomID(), Action: "update", Value: server.URL})
	job, err := a.Submit(name, digest)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not request metadata")
	}
	if lock, err := a.lock(); err == nil {
		lock.Close()
		t.Fatal("worker lost the inherited lock")
	}
	close(release)
	finished := waitJob(t, a, job.ID)
	if finished.State != "failed" || finished.Phase != "subscription" {
		t.Fatalf("%+v", finished)
	}
}

func TestUnmanagedDataAndInvalidRequestsArePreserved(t *testing.T) {
	root := filepath.Join(t.TempDir(), "ufi-mihomo")
	_ = os.Mkdir(root, 0700)
	_ = os.WriteFile(filepath.Join(root, "keep"), []byte("data"), 0600)
	a, _ := New(root, t.TempDir(), "test")
	if a.Install() == nil {
		t.Fatal("overwrote unmanaged directory")
	}
	if data, _ := os.ReadFile(filepath.Join(root, "keep")); string(data) != "data" {
		t.Fatal("data changed")
	}
	a = testAgent(t)
	name, _, _ := sealRequest(t, a, Request{ID: randomID(), Action: "save-mirror", Value: "https://example.com"})
	if _, err := a.Submit(name, strings.Repeat("0", 64)); err == nil {
		t.Fatal("accepted invalid digest")
	}
	if _, err := a.Submit("../outside.bin", strings.Repeat("0", 64)); err == nil {
		t.Fatal("accepted traversal")
	}
	if _, err := os.Stat(filepath.Join(a.Uploads, name)); err != nil {
		t.Fatal("deleted unverified staging file")
	}
}

func TestConfigPolicyPreservedAndFailedValidationDoesNotCommit(t *testing.T) {
	source := []byte("proxies: []\nproxy-groups: [{name: choice, type: select, proxies: [DIRECT]}]\nrules: [MATCH,choice]\ndns: {nameserver: [https://223.5.5.5/dns-query], enhanced-mode: fake-ip}\n")
	encoded, ports, err := adaptConfig(source)
	if err != nil {
		t.Fatal(err)
	}
	var before, after map[string]any
	_ = yaml.Unmarshal(source, &before)
	_ = yaml.Unmarshal(encoded, &after)
	for _, key := range []string{"proxies", "proxy-groups", "rules"} {
		if !reflect.DeepEqual(before[key], after[key]) {
			t.Fatal("policy changed", key)
		}
	}
	if ports != "7894,1053" || after["dns"].(map[string]any)["enhanced-mode"] != "fake-ip" {
		t.Fatal(ports, after)
	}
	a := testAgent(t)
	_ = atomicWrite(a.runtime("mihomo"), []byte("test fixture"), 0700)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(source) }))
	defer server.Close()
	a.httpClient = server.Client()
	id := randomID()
	work := a.jobDir(id)
	_ = os.MkdirAll(work, 0700)
	if _, err = a.updateConfig(context.Background(), Request{ID: id, Value: server.URL}, work, func(string) {}); err != nil {
		t.Fatal(err)
	}
	first, _ := a.activeGeneration()
	if first != id {
		t.Fatal(first)
	}
	a.runCommand = func(context.Context, string, ...string) ([]byte, error) {
		return []byte("password: secret"), errors.New("invalid")
	}
	next := randomID()
	nextWork := a.jobDir(next)
	_ = os.MkdirAll(nextWork, 0700)
	if _, err = a.updateConfig(context.Background(), Request{ID: next, Value: server.URL}, nextWork, func(string) {}); err == nil {
		t.Fatal("accepted invalid config")
	}
	if current, _ := a.activeGeneration(); current != first {
		t.Fatal("replaced active configuration")
	}
	config, _ := a.configuration()
	if config.URL != server.URL {
		t.Fatal("subscription changed")
	}
}

func TestIncompleteConfigTransactionRestoresPreviousGeneration(t *testing.T) {
	a := testAgent(t)
	old, next := randomID(), randomID()
	_ = os.MkdirAll(a.runtime("configurations", old), 0700)
	_ = os.MkdirAll(a.runtime("configurations", next), 0700)
	if err := a.activate(next); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(a.runtime("pending.json"), pendingConfig{Previous: old, Next: next}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.recoverConfiguration(); err != nil {
		t.Fatal(err)
	}
	if active, _ := a.activeGeneration(); active != old {
		t.Fatal(active)
	}
}

func TestInterruptedJobAndSecretRedaction(t *testing.T) {
	a := testAgent(t)
	job := Job{ID: randomID(), State: "running", Action: "update", Phase: "subscription"}
	if err := a.writeJob(&job); err != nil {
		t.Fatal(err)
	}
	result, err := a.Job(job.ID)
	if err != nil || result.State != "interrupted" {
		t.Fatal(result, err)
	}
	text := sanitize("https://host/private?token=secret\npassword: abc\nuuid=abc\nordinary message")
	if strings.Contains(text, "secret") || strings.Contains(text, "abc") || !strings.Contains(text, "ordinary message") {
		t.Fatal(text)
	}
}

func TestOfficialAssetAndCoreIntegrity(t *testing.T) {
	for _, arch := range []string{"arm64-v8", "armv7"} {
		address := "https://github.com/MetaCubeX/mihomo/releases/download/v9.8.7/mihomo-android-" + arch + "-v9.8.7.gz"
		metadata := map[string]any{"tag_name": "v9.8.7", "draft": false, "prerelease": false, "assets": []map[string]any{{
			"name": "mihomo-android-" + arch + "-v9.8.7.gz", "browser_download_url": address, "digest": "sha256:" + strings.Repeat("a", 64),
		}}}
		data, _ := json.Marshal(metadata)
		if version, url, _, err := selectAsset(data, arch); err != nil || version != "v9.8.7" || url != address {
			t.Fatal(version, url, err)
		}
		metadata["prerelease"] = true
		data, _ = json.Marshal(metadata)
		if _, _, _, err := selectAsset(data, arch); err == nil {
			t.Fatal("accepted prerelease")
		}
		metadata["prerelease"] = false
		metadata["assets"].([]map[string]any)[0]["digest"] = ""
		data, _ = json.Marshal(metadata)
		if _, _, _, err := selectAsset(data, arch); err == nil {
			t.Fatal("accepted absent digest")
		}
	}
	a := testAgent(t)
	work := t.TempDir()
	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	_, _ = gz.Write([]byte("verified fixture binary"))
	_ = gz.Close()
	archive := filepath.Join(work, "core.gz")
	_ = os.WriteFile(archive, compressed.Bytes(), 0600)
	_ = atomicWrite(a.runtime("mihomo"), []byte("previous core"), 0700)
	executed := false
	a.runCommand = func(context.Context, string, ...string) ([]byte, error) { executed = true; return nil, nil }
	if err := a.installCore(context.Background(), archive, work, strings.Repeat("0", 64), func(string) {}); err == nil || executed {
		t.Fatal("executed an unverified core")
	}
	if data, _ := os.ReadFile(a.runtime("mihomo")); string(data) != "previous core" {
		t.Fatal("replaced previous core")
	}
	digest := sha256.Sum256(compressed.Bytes())
	if err := a.installCore(context.Background(), archive, work, hex.EncodeToString(digest[:]), func(string) {}); err != nil || !executed {
		t.Fatal(err)
	}
}

func TestUninstallPreservesRuntimeOnCleanupFailure(t *testing.T) {
	a := testAgent(t)
	_ = atomicWrite(a.runtime("network.owned"), nil, 0600)
	_ = atomicWrite(a.runtime("private-data"), []byte("keep me"), 0600)
	_ = atomicWrite(a.BootPath, []byte("other-plugin start\n"+a.bootLine()+"\n"), 0644)
	a.runCommand = func(context.Context, string, ...string) ([]byte, error) { return nil, errors.New("network failure") }
	request := Request{ID: randomID(), Action: "uninstall"}
	if _, err := a.execute(context.Background(), request, func(string) {}); err == nil {
		t.Fatal("ignored failed cleanup")
	}
	if !regularFile(a.runtime("private-data")) {
		t.Fatal("removed files before cleanup")
	}
	a.runCommand = func(context.Context, string, ...string) ([]byte, error) { return nil, nil }
	if _, err := a.execute(context.Background(), request, func(string) {}); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(a.path("backups"))
	if len(entries) != 1 || !regularFile(a.path("backups", entries[0].Name(), "private-data")) || !regularFile(a.path("agent")) {
		t.Fatal("backup or management agent missing")
	}
	if data, _ := os.ReadFile(a.BootPath); string(data) != "other-plugin start\n" {
		t.Fatal("changed another plugin's boot entry")
	}
	request = Request{ID: randomID(), Action: "install", Value: "https://mirror.example"}
	if _, err := a.execute(context.Background(), request, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if settings, _ := a.settings(); settings.Mirror != request.Value {
		t.Fatal("reinstallation ignored initial mirror")
	}
	if _, err := a.execute(context.Background(), request, func(string) {}); err == nil {
		t.Fatal("reinstalled an active installation")
	}
}

func TestCleanupPreservesReplayRecordsAndActiveConfig(t *testing.T) {
	a := testAgent(t)
	active := randomID()
	_ = a.activate(active)
	for i := 0; i < 6; i++ {
		id := randomID()
		if i == 0 {
			id = active
		}
		_ = atomicWrite(a.runtime("configurations", id, "source.yaml"), []byte("fixture"), 0600)
		_ = atomicWrite(a.taskPath(id, "state.json"), []byte("{}"), 0600)
		_ = atomicWrite(a.taskPath(id, "request.bin"), []byte("fixture"), 0600)
		_ = atomicWrite(a.taskPath(id, "work/core.gz"), []byte("fixture"), 0600)
	}
	a.pruneTaskFiles()
	entries, _ := os.ReadDir(a.runtime("configurations"))
	if len(entries) != 3 || !regularFile(a.runtime("configurations", active, "source.yaml")) {
		t.Fatal("configuration retention failed")
	}
	entries, _ = os.ReadDir(a.path("tasks"))
	if len(entries) != 6 {
		t.Fatal("removed replay records")
	}
	for _, entry := range entries {
		if regularFile(a.taskPath(entry.Name(), "request.bin")) || regularFile(a.taskPath(entry.Name(), "work/core.gz")) {
			t.Fatal("staging files retained")
		}
	}
}
