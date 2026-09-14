// Package cli composes the shared manager with a platform and a calling transport.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/imbytecat/mihomo-agent/internal/manager"
	"github.com/imbytecat/mihomo-agent/internal/platform"
	ufitransport "github.com/imbytecat/mihomo-agent/internal/transport/ufi"
	"github.com/spf13/cobra"
)

func New(version string) *cobra.Command {
	var root string
	var config platform.Config
	var githubProxy, uploads, input, id string
	var wait bool
	command := &cobra.Command{Use: "mihomo-agent", Short: "Manage Mihomo independently of its user interface", Version: version, SilenceUsage: true, SilenceErrors: true}
	command.PersistentFlags().StringVar(&root, "root", "", "State directory (platform default when omitted)")
	command.PersistentFlags().StringVar(&config.Kind, "platform", "", "Platform: ufi or linux (saved deployment when installed)")
	open := func() (*manager.Manager, error) {
		directory := root
		if directory == "" {
			kind := config.Kind
			if kind == "" {
				kind = platform.DefaultKind()
			}
			directory = platform.DefaultRoot(kind)
		}
		directory, err := filepath.Abs(directory)
		if err != nil {
			return nil, err
		}
		deployment, err := platform.Load(directory, config)
		if err != nil {
			return nil, err
		}
		executable := filepath.Join(directory, "agent")
		adapter, err := platform.New(deployment, platform.Environment{Root: directory, Executable: executable})
		if err != nil {
			return nil, err
		}
		return manager.New(directory, version, adapter)
	}
	command.AddCommand(&cobra.Command{Use: "version", Short: "Print version and protocol as JSON", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]any{"version": version, "protocol": manager.Protocol})
	}})
	for _, entry := range []struct {
		use, short string
		args       cobra.PositionalArgs
		hidden     bool
		run        func(*cobra.Command, *manager.Manager, []string) (any, error)
	}{
		{"install", "Initialize this platform deployment", cobra.NoArgs, false, func(_ *cobra.Command, m *manager.Manager, _ []string) (any, error) {
			return map[string]any{"ok": true, "executable": m.Executable}, m.Install(githubProxy)
		}},
		{"inspect", "Print platform, capabilities and runtime state", cobra.NoArgs, false, func(_ *cobra.Command, m *manager.Manager, _ []string) (any, error) { return m.Inspect() }},
		{"check-updates", "Check official component releases and cache the comparison", cobra.NoArgs, false, func(cmd *cobra.Command, m *manager.Manager, _ []string) (any, error) {
			return m.CheckUpdates(cmd.Context())
		}},
		{"submit UPLOAD SHA256", "Accept an encrypted UFI upload", cobra.ExactArgs(2), false, func(_ *cobra.Command, m *manager.Manager, args []string) (any, error) {
			if m.Platform.Config().Kind != platform.UFI {
				return nil, errors.New("该命令仅用于 UFI 上传；本地调用请使用 task")
			}
			file, err := ufitransport.ReadUpload(uploads, args[0], args[1])
			if err != nil {
				return nil, err
			}
			job, err := m.SubmitSealed(file.Bytes)
			if err != nil {
				return nil, err
			}
			return job, file.Consume()
		}},
		{"task ACTION", "Submit an operation; read params JSON from --input, never secret argv", cobra.ExactArgs(1), false, func(cmd *cobra.Command, m *manager.Manager, args []string) (any, error) {
			params := manager.Params{}
			if input != "" {
				var reader io.Reader = cmd.InOrStdin()
				if input != "-" {
					file, err := os.Open(input)
					if err != nil {
						return nil, err
					}
					defer file.Close()
					reader = file
				}
				data, err := io.ReadAll(io.LimitReader(reader, 48*1024+1))
				if err != nil || len(data) > 48*1024 {
					return nil, errors.New("输入过大或不可读")
				}
				raw, _ := json.Marshal(map[string]any{"id": "00000000000000000000000000000000", "action": args[0], "params": json.RawMessage(data)})
				parsed, err := manager.DecodeRequest(raw)
				if err != nil {
					return nil, err
				}
				params = parsed.Params
			}
			job, err := m.Submit(manager.Request{ID: id, Action: args[0], Params: params})
			if err != nil {
				return nil, err
			}
			if wait {
				return awaitTask(cmd.Context(), m, job)
			}
			return job, nil
		}},
		{"job ID", "Print task state", cobra.ExactArgs(1), false, func(_ *cobra.Command, m *manager.Manager, args []string) (any, error) { return m.Job(args[0]) }},
		{"job-log ID", "Print sanitized task logs", cobra.ExactArgs(1), false, func(_ *cobra.Command, m *manager.Manager, args []string) (any, error) { return m.JobLog(args[0]) }},
		{"controller-secret PUBLIC_KEY", "Encrypt the API key for the supplied public key", cobra.ExactArgs(1), false, func(_ *cobra.Command, m *manager.Manager, args []string) (any, error) {
			return m.ControllerSecret(args[0])
		}},
		{"logs", "Print sanitized runtime logs", cobra.NoArgs, false, func(_ *cobra.Command, m *manager.Manager, _ []string) (any, error) { return m.Logs() }},
		{"diagnose", "Print network diagnostics", cobra.NoArgs, false, func(_ *cobra.Command, m *manager.Manager, _ []string) (any, error) { return m.Diagnose() }},
		{"worker ID", "Execute an accepted task with inherited descriptors", cobra.ExactArgs(1), true, func(_ *cobra.Command, m *manager.Manager, args []string) (any, error) { return nil, m.Worker(args[0]) }},
		{"supervise", "Run the UFI runtime supervisor", cobra.NoArgs, true, func(_ *cobra.Command, m *manager.Manager, _ []string) (any, error) { return nil, m.Supervise() }},
	} {
		child := &cobra.Command{Use: entry.use, Short: entry.short, Args: entry.args, Hidden: entry.hidden, RunE: func(cmd *cobra.Command, args []string) error {
			m, err := open()
			if err != nil {
				return err
			}
			defer m.Close()
			result, err := entry.run(cmd, m, args)
			if err != nil || result == nil {
				return err
			}
			return json.NewEncoder(cmd.OutOrStdout()).Encode(result)
		}}
		switch child.Name() {
		case "install":
			child.Flags().StringVar(&githubProxy, "github-proxy", "", "HTTPS mirror prefix for GitHub release queries and downloads")
			child.Flags().StringVar(&config.Unit, "unit", "", "Service name (Linux)")
			child.Flags().StringVar(&config.ListenAddress, "listen-address", "", "Local IPv4 listen address (Linux; loopback by default)")
		case "submit":
			child.Flags().StringVar(&uploads, "uploads", platform.UFIUploads, "UFI public upload directory")
		case "task":
			child.Flags().StringVar(&input, "input", "", "Params JSON file, or - for stdin")
			child.Flags().StringVar(&id, "id", "", "Stable task ID for retry/reconnection")
			child.Flags().BoolVar(&wait, "wait", false, "Observe until finished; disconnecting does not cancel the task")
		}
		command.AddCommand(child)
	}
	return command
}
func awaitTask(ctx context.Context, m *manager.Manager, initial *manager.Job) (*manager.Job, error) {
	task := initial
	missing := 0
	if task.Action == "uninstall" {
		_ = m.Close()
	}
	for task.State == "queued" || task.State == "running" {
		select {
		case <-ctx.Done():
			return task, ctx.Err()
		case <-time.After(300 * time.Millisecond):
		}
		if task.Action == "uninstall" {
			removed := true
			for _, path := range append([]string{m.Root}, m.Platform.ExtraPaths()...) {
				if _, err := os.Lstat(path); !os.IsNotExist(err) {
					removed = false
				}
			}
			if removed {
				task.State = "succeeded"
				task.Phase = "done"
				task.Result = "Mihomo Agent 数据已卸载"
				return task, nil
			}
		}
		next, err := m.Job(task.ID)
		if task.Action == "uninstall" {
			_ = m.Close()
		}
		if err != nil {
			if task.Action == "uninstall" {
				missing++
				if missing < 200 {
					continue
				}
			}
			return task, err
		}
		task = next
	}
	if task.State != "succeeded" {
		return task, fmt.Errorf("任务 %s 失败：%s", task.ID, task.Error)
	}
	return task, nil
}
