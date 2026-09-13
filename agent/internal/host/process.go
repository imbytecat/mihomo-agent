package host

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"

	"github.com/prometheus/procfs"
)

type Record struct {
	PID   int
	Start string
}

func Start(pid int) string {
	process, err := procfs.NewProc(pid)
	if err != nil {
		return ""
	}
	stat, err := process.Stat()
	if err != nil || stat.State == "Z" {
		return ""
	}
	return strconv.FormatUint(stat.Starttime, 10)
}

func Owned(record Record) (*os.Process, bool) {
	if record.PID < 2 || record.Start == "" || Start(record.PID) != record.Start {
		return nil, false
	}
	p, err := os.FindProcess(record.PID)
	return p, err == nil && p.Signal(syscall.Signal(0)) == nil
}

func Command(ctx context.Context, files []*os.File, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.ExtraFiles = files
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 2 * time.Second
	return cmd.CombinedOutput()
}
