package platform

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/imbytecat/mihomo-agent/internal/fsutil"
)

func TestUFIBootUsesTaskCLIWithQuotedPaths(t *testing.T) {
	root := filepath.Join(t.TempDir(), "device 'quoted'", "mihomo-agent")
	adapter := NewUFI(Environment{Root: root})
	if err := fsutil.AtomicWrite(filepath.Join(root, "agent"), []byte("#!/bin/sh\nprintf '%s\\n' \"$@\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command("sh", "-c", adapter.BootLine()).CombinedOutput()
	want := strings.Join([]string{"task", "start", "--root", root, ""}, "\n")
	if err != nil || string(output) != want {
		t.Fatalf("boot command: %q, %v", output, err)
	}
}
