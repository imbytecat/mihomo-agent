package manager

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"syscall"
	"time"
)

var coreVersionLine = regexp.MustCompile(`(?m)^Mihomo Meta ([A-Za-z0-9][A-Za-z0-9._+-]{0,127})(?:[ \t]|$)`)

func coreIdentity(info os.FileInfo) string {
	stat := info.Sys().(*syscall.Stat_t)
	return fmt.Sprintf("%x:%x:%d:%d", uint64(stat.Dev), uint64(stat.Ino), info.Size(), info.ModTime().UnixNano())
}

// The installed executable is authoritative. Cache across CLI invocations until
// its identity changes; atomic core replacement naturally invalidates this cache.
func (a *Manager) coreVersion() string {
	path := a.corePath()
	before, err := os.Stat(path)
	if err != nil || !before.Mode().IsRegular() {
		return ""
	}
	cacheKey := coreIdentity(before)
	if version, err := a.store.CoreVersion(cacheKey); err == nil {
		return version
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	output, err := a.run(ctx, path, "-v")
	if err != nil {
		return ""
	}
	match := coreVersionLine.FindSubmatch(output)
	if len(match) != 2 {
		return ""
	}
	after, err := os.Stat(path)
	if err != nil || !after.Mode().IsRegular() || cacheKey != coreIdentity(after) {
		return ""
	}
	version := string(match[1])
	// Display metadata must neither block operations nor recreate an uninstalled runtime.
	if lock, err := a.lock(); err == nil {
		defer lock.Close()
		_ = a.store.SaveCoreVersion(cacheKey, version)
	}
	return version
}
