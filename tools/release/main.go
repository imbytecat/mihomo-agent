// Release builds run from the repository root using the official Go toolchain.
package main

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/Masterminds/semver/v3"
	"github.com/imbytecat/mihomo-agent/internal/manager"
)

type asset struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}

func validVersion(version string) bool {
	v, err := semver.StrictNewVersion(strings.TrimPrefix(version, "v"))
	return err == nil && version == "v"+v.String() && v.Prerelease() == "" && v.Metadata() == ""
}

func main() {
	version := flag.String("version", "", "stable release tag, e.g. v0.5.0")
	flag.Parse()
	if !validVersion(*version) || flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "Invalid release version; use vMAJOR.MINOR.PATCH")
		os.Exit(1)
	}
	if err := build(*version); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func build(version string) error {
	// Pin every compiler option that can affect bootstrap hashes across hosts.
	env := append(os.Environ(), "GOTOOLCHAIN="+runtime.Version(), "GOENV=off", "GOWORK=off", "GOFLAGS=", "GOEXPERIMENT=", "GOFIPS140=off", "CGO_ENABLED=0", "GOAMD64=v1", "GOARM64=v8.0")
	probe := exec.Command("go", "env", "GOROOT")
	probe.Env = env
	root, err := probe.Output()
	if err != nil {
		return fmt.Errorf("locate official Go: %w", err)
	}
	if strings.Contains(string(root), "/nix/store/") {
		return errors.New("release requires official Go: mise exec -- just release " + version)
	}
	if err := os.MkdirAll(".release", 0755); err != nil {
		return err
	}
	manifest := struct {
		Version  string           `json:"version"`
		Protocol int              `json:"protocol"`
		Assets   map[string]asset `json:"assets"`
	}{version, manager.Protocol, make(map[string]asset)}
	var sums strings.Builder
	for _, target := range []struct{ name, arch, arm string }{
		{"arm64", "arm64", ""}, {"armv7", "arm", "7"}, {"amd64", "amd64", ""},
	} {
		name := "mihomo-agent-linux-" + target.name
		cmd := exec.Command("go", "build", "-trimpath", "-buildvcs=false", "-ldflags", "-s -w -buildid= -X main.version="+version, "-o", filepath.Join(".release", name), "./cmd/mihomo-agent")
		cmd.Env = append(env, "GOOS=linux", "GOARCH="+target.arch, "GOARM="+target.arm)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("build %s: %w", name, err)
		}
		data, err := os.ReadFile(filepath.Join(".release", name))
		if err != nil {
			return err
		}
		digest := fmt.Sprintf("%x", sha256.Sum256(data))
		manifest.Assets[target.name] = asset{"https://github.com/imbytecat/mihomo-agent/releases/download/" + version + "/" + name, digest}
		fmt.Fprintf(&sums, "%s  %s\n", digest, name)
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile("ui/agent-bootstrap.json", append(data, '\n'), 0644); err != nil {
		return err
	}
	plugin := exec.Command("bun", "run", "build")
	plugin.Dir = "ui"
	plugin.Stdout, plugin.Stderr = os.Stdout, os.Stderr
	if err := plugin.Run(); err != nil {
		return fmt.Errorf("build UFI plugin: %w", err)
	}
	const name = "mihomo-agent-ufi.js"
	data, err = os.ReadFile(filepath.Join("ui/dist", name))
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(".release", name), data, 0644); err != nil {
		return err
	}
	fmt.Fprintf(&sums, "%x  %s\n", sha256.Sum256(data), name)
	if err := os.WriteFile(".release/SHA256SUMS", []byte(sums.String()), 0644); err != nil {
		return err
	}
	fmt.Printf("Release %s built in .release/; UFI bootstrap manifest updated.\n", version)
	return nil
}
