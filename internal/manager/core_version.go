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

type coreVersionCache struct {
	Version        string
	Device, Inode  uint64
	Size, Modified int64
}

func coreIdentity(info os.FileInfo) coreVersionCache {
	stat := info.Sys().(*syscall.Stat_t)
	return coreVersionCache{Device: uint64(stat.Dev), Inode: uint64(stat.Ino), Size: info.Size(), Modified: info.ModTime().UnixNano()}
}

// The installed executable is authoritative. Cache across CLI invocations until
// its identity changes; atomic core replacement naturally invalidates this cache.
func (a *Manager) coreVersion() string {
	path := a.corePath()
	before, err := os.Stat(path)
	if err != nil || !before.Mode().IsRegular() {
		return ""
	}
	identity := coreIdentity(before)
	cacheKey := fmt.Sprintf("%x:%x:%d:%d", identity.Device, identity.Inode, identity.Size, identity.Modified)
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
	if err != nil || !after.Mode().IsRegular() || identity != coreIdentity(after) {
		return ""
	}
	identity.Version = string(match[1])
	// Display metadata must neither block operations nor recreate an uninstalled runtime.
	if lock, err := a.lock(); err == nil {
		defer lock.Close()
		_ = a.store.SaveCoreVersion(cacheKey, identity.Version)
	}
	return identity.Version
}
