package main

import (
	"encoding/json"
	"os"

	"github.com/imbytecat/ufi-mihomo/agent/internal/app"
	"github.com/spf13/cobra"
)

var version = "dev"

func main() {
	if err := newCommand().Execute(); err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"error": err.Error()})
		os.Exit(1)
	}
}

func newCommand() *cobra.Command {
	var root, uploads, githubProxy string
	command := &cobra.Command{
		Use: "mihomo-agent", Short: "Manage the Mihomo gateway on UFI devices",
		Version: version, SilenceUsage: true, SilenceErrors: true,
	}
	command.PersistentFlags().StringVar(&root, "root", "/data/ufi-mihomo", "Device state directory")
	command.PersistentFlags().StringVar(&uploads, "uploads", "/data/data/com.minikano.f50_sms/files/uploads", "UFI upload directory")
	for _, entry := range []struct {
		use, short string
		args       cobra.PositionalArgs
		hidden     bool
		run        func(*app.Agent, []string) (any, error)
	}{
		{"version", "Print version and protocol as JSON", cobra.NoArgs, false, func(_ *app.Agent, _ []string) (any, error) {
			return map[string]any{"version": version, "protocol": app.Protocol}, nil
		}},
		{"install", "Install Mihomo Agent and initialize the service", cobra.NoArgs, false, func(a *app.Agent, _ []string) (any, error) {
			a.InitialGitHubProxy = githubProxy
			return map[string]bool{"ok": true}, a.Install()
		}},
		{"inspect", "Print device state as JSON", cobra.NoArgs, false, func(a *app.Agent, _ []string) (any, error) { return a.Inspect() }},
		{"controller-secret PUBLIC_KEY", "Encrypt the API secret for the supplied public key", cobra.ExactArgs(1), false, func(a *app.Agent, args []string) (any, error) { return a.ControllerSecret(args[0]) }},
		{"boot", "Submit a startup task", cobra.NoArgs, false, func(a *app.Agent, _ []string) (any, error) { return a.Boot() }},
		{"stop", "Submit a stop task", cobra.NoArgs, false, func(a *app.Agent, _ []string) (any, error) { return a.LocalTask("stop") }},
		{"boot-off", "Submit a task to disable startup", cobra.NoArgs, false, func(a *app.Agent, _ []string) (any, error) { return a.LocalTask("boot-off") }},
		{"submit UPLOAD SHA256", "Submit a verified encrypted request", cobra.ExactArgs(2), false, func(a *app.Agent, args []string) (any, error) { return a.Submit(args[0], args[1]) }},
		{"job ID", "Print task state as JSON", cobra.ExactArgs(1), false, func(a *app.Agent, args []string) (any, error) { return a.Job(args[0]) }},
		{"job-log ID", "Print sanitized task logs as JSON", cobra.ExactArgs(1), false, func(a *app.Agent, args []string) (any, error) { return a.JobLog(args[0]) }},
		{"logs", "Print sanitized service logs as JSON", cobra.NoArgs, false, func(a *app.Agent, _ []string) (any, error) { return a.Logs() }},
		{"diagnose", "Print network diagnostics as JSON", cobra.NoArgs, false, func(a *app.Agent, _ []string) (any, error) { return a.Diagnose() }},
		{"worker ID", "Run a detached task with the inherited lock", cobra.ExactArgs(1), true, func(a *app.Agent, args []string) (any, error) { return nil, a.Worker(args[0]) }},
		{"supervise", "Supervise the proxy runtime", cobra.NoArgs, true, func(a *app.Agent, _ []string) (any, error) { return nil, a.Supervise() }},
	} {
		child := &cobra.Command{
			Use: entry.use, Short: entry.short, Args: entry.args, Hidden: entry.hidden,
			RunE: func(cmd *cobra.Command, args []string) error {
				a, err := app.New(root, uploads, version)
				if err != nil {
					return err
				}
				result, err := entry.run(a, args)
				if err != nil || result == nil {
					return err
				}
				return json.NewEncoder(cmd.OutOrStdout()).Encode(result)
			},
		}
		if child.Name() == "install" {
			child.Flags().StringVar(&githubProxy, "github-proxy", "", "HTTPS GitHub download proxy prefix")
		}
		command.AddCommand(child)
	}
	return command
}
