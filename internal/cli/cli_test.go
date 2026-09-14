package cli

import (
	"bytes"
	"encoding/json"
	"github.com/imbytecat/mihomo-agent/internal/manager"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCommandsValidateArgumentsBeforeDeviceAccess(t *testing.T) {
	root := filepath.Join(t.TempDir(), "mihomo-agent")
	for _, args := range [][]string{
		{"install", "unexpected"}, {"inspect", "unexpected"}, {"check-updates", "unexpected"}, {"submit", "only-upload"},
		{"job"}, {"controller-secret"}, {"worker"}, {"supervise", "unexpected"},
		{"start"}, {"stop"}, {"boot"}, {"boot-off"},
		{"logs", "unexpected"}, {"diagnose", "unexpected"}, {"version", "unexpected"},
		{"job-log", "id", "unexpected"}, {"inspect", "--github-proxy", "https://example.com"},
		{"install", "--unknown"}, {"install", "--core", "/usr/bin/mihomo"}, {"unit"}, {"unknown"},
	} {
		cmd := New("test")
		cmd.SetArgs(append([]string{"--platform", "ufi", "--root", root}, args...))
		var output bytes.Buffer
		cmd.SetOut(&output)
		if err := cmd.Execute(); err == nil {
			t.Errorf("accepted invalid command: %v", args)
		}
		if output.Len() != 0 {
			t.Errorf("mixed usage into machine output: %s", &output)
		}
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatal("invalid arguments touched device data")
	}
}

func TestHelpAndVersionDoNotInitializeDevice(t *testing.T) {
	root := filepath.Join(t.TempDir(), "mihomo-agent")
	for _, args := range [][]string{{"--help"}, {"install", "--help"}, {"version"}, {"--version"}} {
		cmd := New("test")
		cmd.SetArgs(append([]string{"--platform", "ufi", "--root", root}, args...))
		var output bytes.Buffer
		cmd.SetOut(&output)
		if err := cmd.Execute(); err != nil {
			t.Fatal(err)
		}
		if args[0] == "version" {
			var info struct {
				Version  string
				Protocol int
			}
			if json.Unmarshal(output.Bytes(), &info) != nil || info.Version != "test" || info.Protocol != manager.Protocol {
				t.Fatal("version JSON changed", output.String())
			}
		} else if !strings.Contains(output.String(), "mihomo-agent") {
			t.Fatal("missing command help", output.String())
		}
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatal("help/version initialized device")
	}
}
