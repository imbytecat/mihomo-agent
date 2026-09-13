package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Enabled only in an isolated Linux CI runner; never mutates the developer's host.
func TestSystemdDeployment(t *testing.T) {
	if os.Getenv("MIHOMO_SYSTEMD_TEST") != "1" {
		t.Skip("requires isolated systemd CI runner")
	}
	if runtime.GOOS != "linux" || os.Geteuid() != 0 {
		t.Fatal("integration requires root on Linux")
	}
	agent, fixture := os.Getenv("MIHOMO_TEST_AGENT"), os.Getenv("MIHOMO_TEST_CORE")
	if !filepath.IsAbs(agent) || !filepath.IsAbs(fixture) {
		t.Fatal("explicit fixture paths required")
	}
	base, err := os.MkdirTemp("/var/lib", "mihomo-agent-ci-")
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "mihomo-agent")
	core := filepath.Join(base, "core")
	data, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(core, data, 0700); err != nil {
		t.Fatal(err)
	}
	name := filepath.Base(base) + ".service"
	unitPath := filepath.Join("/etc/systemd/system", name)
	var tasks []string
	hold := make(chan struct{})
	var release sync.Once
	t.Cleanup(func() {
		release.Do(func() { close(hold) })
		for _, id := range tasks {
			_ = exec.Command("systemctl", "stop", "mihomo-agent-task-"+id+".scope").Run()
		}
		_ = exec.Command("systemctl", "stop", name).Run()
		_ = exec.Command("systemctl", "disable", name).Run()
		_ = os.Remove(unitPath)
		_ = exec.Command("systemctl", "daemon-reload").Run()
		_ = os.RemoveAll(base)
	})
	run := func(input string, args ...string) ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		cmd := exec.CommandContext(ctx, agent, append([]string{"--root", root}, args...)...)
		cmd.Stdin = strings.NewReader(input)
		return cmd.CombinedOutput()
	}
	output, err := run("", "--platform", "linux", "unit", "--core", core, "--unit", name)
	if err != nil {
		t.Fatalf("unit: %s %v", output, err)
	}
	if err = os.WriteFile(unitPath, output, 0644); err != nil {
		t.Fatal(err)
	}
	if output, err = exec.Command("systemctl", "daemon-reload").CombinedOutput(); err != nil {
		t.Fatalf("reload: %s %v", output, err)
	}
	if output, err = run("", "--platform", "linux", "install", "--core", core, "--unit", name); err != nil {
		t.Fatalf("install: %s %v", output, err)
	}
	var source atomic.Value
	source.Store("proxies: []\nrules: [MATCH,DIRECT]\n")
	var first atomic.Bool
	first.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if first.CompareAndSwap(true, false) {
			<-hold
		}
		_, _ = w.Write([]byte(source.Load().(string)))
	}))
	defer func() { release.Do(func() { close(hold) }); server.Close() }()
	payload, _ := json.Marshal(map[string]string{"url": server.URL + "/?token=private-fixture"})
	output, err = run(string(payload), "task", "update", "--input", "-")
	if err != nil {
		t.Fatalf("submit: %s %v", output, err)
	}
	var task struct{ ID, State string }
	if err = json.Unmarshal(output, &task); err != nil {
		t.Fatal(err)
	}
	tasks = append(tasks, task.ID)
	if output, err = exec.Command("systemctl", "show", "--property=ActiveState", "--value", "mihomo-agent-task-"+task.ID+".scope").CombinedOutput(); err != nil || strings.TrimSpace(string(output)) != "active" {
		t.Fatalf("task did not survive its caller: %s %v", output, err)
	}
	release.Do(func() { close(hold) })
	for i := 0; i < 100; i++ {
		output, err = run("", "job", task.ID)
		if err != nil {
			t.Fatalf("job: %s %v", output, err)
		}
		_ = json.Unmarshal(output, &task)
		if task.State == "succeeded" {
			break
		}
		if task.State == "failed" {
			t.Fatalf("job failed: %s", output)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if task.State != "succeeded" {
		t.Fatal("detached task did not finish")
	}
	if output, err = run("", "task", "start", "--wait"); err != nil {
		t.Fatalf("start: %s %v", output, err)
	}
	output, err = run("", "inspect")
	if err != nil {
		t.Fatalf("inspect: %s %v", output, err)
	}
	var state struct {
		Running, Listeners, Network, Capture bool
		Platform                             string
	}
	_ = json.Unmarshal(output, &state)
	if !state.Running || !state.Listeners || state.Capture || state.Network || state.Platform != "linux" {
		t.Fatalf("incorrect managed status: %s", output)
	}
	previous, err := os.Readlink(filepath.Join(root, "runtime/current"))
	if err != nil {
		t.Fatal(err)
	}
	source.Store("proxies: []\nfixture-exit: true\n")
	if output, err = run("{}", "task", "update", "--input", "-", "--wait"); err == nil {
		t.Fatalf("bad runtime config accepted: %s", output)
	}
	if current, _ := os.Readlink(filepath.Join(root, "runtime/current")); current != previous {
		t.Fatal("rollback lost previous config")
	}
	output, err = run("", "inspect")
	if err != nil {
		t.Fatal(string(output), err)
	}
	_ = json.Unmarshal(output, &state)
	if !state.Running || !state.Listeners {
		t.Fatal("rollback did not restore service")
	}
	if output, err = run("", "task", "download", "--wait"); err == nil {
		t.Fatal("download overwrote system core")
	}
	if output, err = run("", "task", "uninstall", "--wait"); err == nil {
		t.Fatal("deleted state referenced by system unit")
	}
	if output, err = exec.Command("systemctl", "stop", name).CombinedOutput(); err != nil {
		t.Fatal(string(output), err)
	}
	if err = os.Remove(unitPath); err != nil {
		t.Fatal(err)
	}
	if output, err = exec.Command("systemctl", "daemon-reload").CombinedOutput(); err != nil {
		t.Fatal(string(output), err)
	}
	if output, err = run("", "task", "uninstall", "--wait"); err != nil {
		t.Fatalf("uninstall: %s %v", output, err)
	}
	if _, err = os.Stat(root); !os.IsNotExist(err) {
		t.Fatal("uninstall left state")
	}
	if _, err = os.Stat(core); err != nil {
		t.Fatal("uninstall touched system-owned core")
	}
}
