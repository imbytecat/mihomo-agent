package agent

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/nacl/box"
)

type Status struct {
	Protocol     int               `json:"protocol"`
	Version      string            `json:"version"`
	PublicKey    string            `json:"publicKey"`
	Service      bool              `json:"service"`
	Core         bool              `json:"core"`
	Config       bool              `json:"config"`
	Subscription bool              `json:"subscription"`
	Running      bool              `json:"running"`
	Supervisor   bool              `json:"supervisor"`
	Listeners    bool              `json:"listeners"`
	Network      bool              `json:"network"`
	Boot         bool              `json:"boot"`
	Locked       bool              `json:"locked"`
	Capture      bool              `json:"capture"`
	Settings     Settings          `json:"settings"`
	Task         *Job              `json:"task"`
	Controller   *ControllerStatus `json:"controller"`
	Dashboard    DashboardStatus   `json:"dashboard"`
}

func (a *Agent) Inspect() (Status, error) {
	status := Status{Protocol: Protocol, Version: a.Version}
	if err := a.requireIdentity(); err != nil {
		return status, err
	}
	var err error
	status.PublicKey, err = a.PublicKey()
	if err != nil {
		return status, err
	}
	status.Service = regularFile(a.runtime("installed.json"))
	status.Core = regularFile(a.runtime("mihomo"))
	if id, e := a.activeGeneration(); e == nil {
		status.Config = id != ""
	}
	if config, e := a.configuration(); e == nil {
		status.Subscription = config.URL != ""
	}
	status.Running = a.running()
	status.Supervisor = a.alive("supervisor")
	status.Capture = regularFile(a.runtime("network.active")) || regularFile(a.runtime("network.pending"))
	if status.Service {
		control, e := a.controller()
		if e != nil {
			return status, e
		}
		config, _ := a.configuration()
		status.Controller = &ControllerStatus{Enabled: control.Enabled, Port: control.Port, Applied: config.Controller != nil}
		status.Dashboard = a.dashboard()
		if output, e := a.run(context.Background(), "/system/bin/sh", a.runtime("network.sh"), a.runtime(), "inspect"); e == nil {
			var network struct{ Listeners, Network bool }
			if json.Unmarshal(output, &network) == nil {
				status.Listeners = network.Listeners
				status.Network = network.Network
			}
		}
		status.Settings, err = a.settings()
		if err != nil {
			return status, err
		}
	}
	if status.Settings.Interfaces == nil {
		status.Settings.Interfaces = []string{}
	}
	if data, e := os.ReadFile(a.BootPath); e == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.TrimSpace(line) == a.bootLine() {
				status.Boot = true
			}
		}
	}
	status.Task = a.latestJob()
	if lock, e := a.lock(); e == nil {
		lock.Close()
	} else {
		status.Locked = true
	}
	return status, nil
}

// Boot uses the same persistent job mechanism as browser commands.
func (a *Agent) Boot() (*Job, error) {
	return a.LocalTask("start")
}

// Root-shell recovery uses the same durable worker, not a second lifecycle path.
func (a *Agent) LocalTask(action string) (*Job, error) {
	if err := a.requireIdentity(); err != nil {
		return nil, err
	}
	var key keyPair
	if err := readJSON(a.path("identity.json"), &key); err != nil {
		return nil, err
	}
	id := randomID()
	plain, _ := json.Marshal(Request{ID: id, Action: action})
	sealed, err := box.SealAnonymous(nil, plain, &key.Public, rand.Reader)
	if err != nil {
		return nil, err
	}
	dir := a.path("boot-requests")
	name := id[:8] + "-" + id[8:12] + "-" + id[12:16] + "-" + id[16:20] + "-" + id[20:] + ".bin"
	if err = atomicWrite(filepath.Join(dir, name), sealed, 0600); err != nil {
		return nil, err
	}
	sum := sha256.Sum256(sealed)
	local := *a
	local.Uploads = dir
	return local.Submit(name, hex.EncodeToString(sum[:]))
}
