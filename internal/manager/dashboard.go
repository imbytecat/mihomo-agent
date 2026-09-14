package manager

import (
	"archive/zip"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/imbytecat/mihomoctl/internal/download"
	"github.com/imbytecat/mihomoctl/internal/fsutil"

	"github.com/google/renameio/v2"
)

type DashboardStatus struct {
	Installed bool   `json:"installed"`
	Ready     bool   `json:"ready"`
	Version   string `json:"version"`
}

func (a *Manager) dashboard() DashboardStatus {
	var state DashboardStatus
	target, err := os.Readlink(a.runtime("dashboard"))
	if err != nil || !strings.HasPrefix(target, "dashboards/") || !validID(strings.TrimPrefix(target, "dashboards/")) {
		return state
	}
	if !fsutil.RegularFile(a.runtime("dashboard", "index.html")) {
		return state
	}
	state.Version, _ = a.store.Dashboard(strings.TrimPrefix(target, "dashboards/"))
	state.Installed = state.Version != ""
	if config, err := a.configuration(); err == nil {
		state.Ready = state.Installed && config.Dashboard && config.Controller != nil && config.Controller.Enabled
	}
	return state
}

func extractDashboard(archive, destination string) (string, error) {
	r, err := zip.OpenReader(archive)
	if err != nil {
		return "", err
	}
	defer r.Close()
	if len(r.File) > 4096 {
		return "", errors.New("面板文件数量超限")
	}
	var total uint64
	for _, f := range r.File {
		if !filepath.IsLocal(f.Name) || strings.Contains(f.Name, "\\") || f.Mode()&os.ModeSymlink != 0 || (!f.Mode().IsRegular() && !f.FileInfo().IsDir()) {
			return "", errors.New("面板压缩包包含不安全路径或文件")
		}
		path := filepath.Join(destination, f.Name)
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(path, 0700); err != nil {
				return "", err
			}
			continue
		}
		total += f.UncompressedSize64
		if f.UncompressedSize64 > 16<<20 || total > 64<<20 {
			return "", errors.New("面板解压大小超限")
		}
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return "", err
		}
		input, err := f.Open()
		if err != nil {
			return "", err
		}
		output, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			input.Close()
			return "", err
		}
		n, copyErr := io.Copy(output, io.LimitReader(input, (16<<20)+1))
		syncErr := output.Sync()
		closeErr := output.Close()
		input.Close()
		if copyErr != nil || syncErr != nil || closeErr != nil || n > 16<<20 {
			return "", errors.New("面板解压失败")
		}
	}
	for _, root := range []string{destination, filepath.Join(destination, "dist")} {
		if fsutil.RegularFile(filepath.Join(root, "index.html")) {
			return root, nil
		}
	}
	return "", errors.New("面板压缩包缺少 index.html")
}

func (a *Manager) switchDashboard(target string) error {
	if target == "" {
		err := os.Remove(a.runtime("dashboard"))
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if !strings.HasPrefix(target, "dashboards/") || !validID(strings.TrimPrefix(target, "dashboards/")) {
		return errors.New("面板目录无效")
	}
	return renameio.Symlink(target, a.runtime("dashboard"))
}

func (a *Manager) downloadDashboard(ctx context.Context, request Request, work string, phase func(string)) (string, error) {
	phase("release")
	release, err := a.latestRelease(ctx, "Zephyruso", "zashboard")
	if err != nil {
		return "", err
	}
	version, address, digest, err := release.asset("Zephyruso/zashboard", "dist-no-fonts.zip")
	if err != nil {
		return "", err
	}
	phase("download")
	archive := filepath.Join(work, "dashboard.zip")
	if err := a.fetch(ctx, address, archive, 16<<20); err != nil {
		return "", err
	}
	phase("verify")
	file, err := os.Open(archive)
	if err != nil {
		return "", err
	}
	defer file.Close()
	if err := download.VerifySHA256(file, digest); err != nil {
		return "", err
	}
	root, err := extractDashboard(archive, filepath.Join(work, "dashboard"))
	if err != nil {
		return "", err
	}
	if err := a.store.SaveDashboard(request.ID, version); err != nil {
		return "", err
	}
	phase("installing")
	previous, err := os.Readlink(a.runtime("dashboard"))
	if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	if err := os.MkdirAll(a.runtime("dashboards"), 0700); err != nil {
		return "", err
	}
	if err := os.Rename(root, a.runtime("dashboards", request.ID)); err != nil {
		return "", err
	}
	defer func() {
		if target, _ := os.Readlink(a.runtime("dashboard")); target != "dashboards/"+request.ID {
			_ = os.RemoveAll(a.runtime("dashboards", request.ID))
		}
	}()
	if err := a.switchDashboard("dashboards/" + request.ID); err != nil {
		return "", err
	}
	config, err := a.configuration()
	if err == nil && config.URL != "" && !config.Dashboard {
		control, controlErr := a.controller()
		if controlErr != nil {
			err = controlErr
		} else if control.Enabled {
			var source []byte
			source, err = os.ReadFile(a.runtime("current", "source.yaml"))
			if err == nil {
				err = a.applyConfig(ctx, request.ID, source, config.URL, control, phase)
			}
		}
	}
	if err != nil {
		if restore := a.switchDashboard(previous); restore != nil {
			return "", errors.New("面板安装失败，恢复目录失败")
		}
		return "", err
	}
	entries, _ := os.ReadDir(a.runtime("dashboards"))
	for _, entry := range entries {
		if entry.IsDir() && validID(entry.Name()) && entry.Name() != request.ID {
			_ = os.RemoveAll(a.runtime("dashboards", entry.Name()))
		}
	}
	return "Zashboard " + version + " 已安装", nil
}
