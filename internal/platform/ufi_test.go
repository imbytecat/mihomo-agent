package platform

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/imbytecat/mihomoctl/internal/fsutil"
)

func TestUFIStartupReturnsReadinessLogsAndCleanupFailure(t *testing.T) {
	root := filepath.Join(t.TempDir(), "mihomoctl")
	executable := filepath.Join(root, "mihomoctl")
	if err := fsutil.AtomicWrite(executable, []byte("#!/bin/sh\necho 'supervisor failed: TPROXY unavailable'\necho 'token=private-value'\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := fsutil.AtomicWrite(filepath.Join(root, "runtime", "core.log"), []byte("stale unrelated failure\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := fsutil.AtomicWrite(filepath.Join(root, "runtime", "network.owned"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	stops := 0
	a := NewUFI(Environment{Root: root, Executable: executable, Run: func(_ context.Context, _ []*os.File, _ string, args ...string) ([]byte, error) {
		if args[len(args)-1] == "stop" {
			stops++
			if stops > 1 {
				return []byte("cleanup route failed"), errors.New("exit status 1")
			}
			return nil, nil
		}
		return []byte("required listeners missing"), errors.New("exit status 1")
	}})
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	err := a.Start(ctx, StartOptions{})
	if err == nil {
		t.Fatal("failed startup reported success")
	}
	for _, reason := range []string{"required listeners missing", "TPROXY unavailable", "cleanup route failed"} {
		if !strings.Contains(err.Error(), reason) {
			t.Errorf("lost startup evidence %q: %v", reason, err)
		}
	}
	for _, hidden := range []string{"private-value", "stale unrelated failure"} {
		if strings.Contains(err.Error(), hidden) {
			t.Errorf("leaked secret or stale evidence: %v", err)
		}
	}
}

func TestUFIBootUsesTaskCLIWithQuotedPaths(t *testing.T) {
	root := filepath.Join(t.TempDir(), "device 'quoted'", "mihomoctl")
	adapter := NewUFI(Environment{Root: root})
	if err := fsutil.AtomicWrite(filepath.Join(root, "mihomoctl"), []byte("#!/bin/sh\nprintf '%s\\n' \"$@\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command("sh", "-c", adapter.BootLine()).CombinedOutput()
	want := strings.Join([]string{"start", "--no-wait", "--root", root, ""}, "\n")
	if err != nil || string(output) != want {
		t.Fatalf("boot command: %q, %v", output, err)
	}
}
