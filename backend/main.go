package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/imbytecat/ufi-mihomo/backend/internal/agent"
)

var version = "dev"

func main() {
	flags := flag.NewFlagSet("ufi-agent", flag.ContinueOnError)
	root := flags.String("root", "/data/ufi-mihomo", "device state directory")
	uploads := flags.String("uploads", "/data/data/com.minikano.f50_sms/files/uploads", "UFI upload directory")
	mirror := flags.String("mirror", "", "initial download mirror")
	if len(os.Args) < 2 {
		fatal(fmt.Errorf("missing command"))
	}
	command := os.Args[1]
	if err := flags.Parse(os.Args[2:]); err != nil {
		fatal(err)
	}
	a, err := agent.New(*root, *uploads, version)
	if err != nil {
		fatal(err)
	}
	a.InitialMirror = *mirror
	var result any
	switch command {
	case "version":
		result = map[string]any{"version": version, "protocol": agent.Protocol}
	case "install":
		err = a.Install()
		result = map[string]any{"ok": err == nil}
	case "inspect":
		result, err = a.Inspect()
	case "boot":
		result, err = a.Boot()
	case "stop", "boot-off":
		result, err = a.LocalTask(command)
	case "submit":
		if len(flags.Args()) != 2 {
			fatal(fmt.Errorf("submit requires upload name and SHA-256"))
		}
		result, err = a.Submit(flags.Arg(0), flags.Arg(1))
	case "job":
		if len(flags.Args()) != 1 {
			fatal(fmt.Errorf("job requires id"))
		}
		result, err = a.Job(flags.Arg(0))
	case "logs":
		result, err = a.Logs()
	case "diagnose":
		result, err = a.Diagnose()
	case "job-log":
		if len(flags.Args()) != 1 {
			fatal(fmt.Errorf("job-log requires id"))
		}
		result, err = a.JobLog(flags.Arg(0))
	case "worker":
		if len(flags.Args()) != 1 {
			fatal(fmt.Errorf("worker requires id"))
		}
		err = a.Worker(flags.Arg(0))
		if err != nil {
			fatal(err)
		}
		return
	case "supervise":
		err = a.Supervise()
		if err != nil {
			fatal(err)
		}
		return
	default:
		fatal(fmt.Errorf("unknown command"))
	}
	if err != nil {
		fatal(err)
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"error": err.Error()})
	os.Exit(1)
}
