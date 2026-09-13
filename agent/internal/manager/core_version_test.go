package manager

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/imbytecat/ufi-mihomo/agent/internal/fsutil"
)

func TestInstalledCoreVersionAndCacheInvalidation(t *testing.T) {
	a := testAgent(t)
	version, calls := "v1.19.30", 0
	a.runCommand = func(_ context.Context, path string, args ...string) ([]byte, error) {
		if path != a.runtime("mihomo") {
			return []byte(`{"listeners":false,"network":false}`), nil
		}
		if len(args) != 1 || args[0] != "-v" {
			t.Fatal("unexpected version probe")
		}
		calls++
		return []byte("Mihomo Meta " + version + " android arm64 with go1.26.7\nUse tags: with_gvisor\n"), nil
	}
	if a.coreVersion() != "" || calls != 0 {
		t.Fatal("probed absent core")
	}
	_ = fsutil.AtomicWrite(a.runtime("mihomo"), []byte("core-one"), 0700)
	status, err := a.Inspect()
	if err != nil || !status.Core || status.CoreVersion != version {
		t.Fatal(status.CoreVersion, err)
	}
	if a.coreVersion() != version || calls != 1 {
		t.Fatal("did not cache version")
	}
	before, _ := os.Stat(a.runtime("mihomo"))
	_ = fsutil.AtomicWrite(a.runtime("mihomo"), []byte("core-two"), 0700)
	_ = os.Chtimes(a.runtime("mihomo"), before.ModTime(), before.ModTime())
	version = "v1.19.31"
	if a.coreVersion() != version || calls != 2 {
		t.Fatal("replacement retained stale version")
	}
	_ = os.Remove(a.runtime("mihomo"))
	if a.coreVersion() != "" {
		t.Fatal("reported removed core")
	}
}

func TestCoreVersionFailureAndConcurrentReplacement(t *testing.T) {
	a := testAgent(t)
	_ = fsutil.AtomicWrite(a.runtime("mihomo"), []byte("fixture"), 0700)
	a.runCommand = func(context.Context, string, ...string) ([]byte, error) { return nil, errors.New("cannot execute") }
	status, err := a.Inspect()
	if err != nil || !status.Core || status.CoreVersion != "" {
		t.Fatal("version failure changed installation state")
	}
	a.runCommand = func(context.Context, string, ...string) ([]byte, error) {
		_ = fsutil.AtomicWrite(a.runtime("mihomo"), []byte("new fixture"), 0700)
		return []byte("Mihomo Meta v1.19.30 android arm64"), nil
	}
	if a.coreVersion() != "" {
		t.Fatal("cached mismatched executable")
	}
	a.runCommand = func(context.Context, string, ...string) ([]byte, error) {
		return []byte("Mihomo Meta alpha-g123abc linux arm64"), nil
	}
	if a.coreVersion() != "alpha-g123abc" {
		t.Fatal("version did not recover")
	}
}
