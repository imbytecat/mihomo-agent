package platform

import (
	"io"
	"strconv"
	"strings"

	"github.com/coreos/go-systemd/v22/unit"
)

// Unit serializes the bound deployment; installation is handled by Prepare.
func (a *SystemdAdapter) Unit() (string, error) {
	quote := func(value string) string { return strconv.Quote(strings.ReplaceAll(value, "%", "%%")) }
	var command []string
	for _, arg := range []string{a.CorePath(), "-d", a.runtime(), "-f", a.runtime("current", "config.yaml")} {
		command = append(command, quote(arg))
	}
	escape := func(value string) string { return strings.ReplaceAll(value, "%", "%%") }
	// The ":" command prefix keeps ${...} in paths literal; % still needs escaping.
	options := []*unit.UnitOption{
		unit.NewUnitOption("Unit", "Description", "Mihomo managed by mihomoctl"),
		unit.NewUnitOption("Unit", "Wants", "network-online.target"),
		unit.NewUnitOption("Unit", "After", "network-online.target"),
		unit.NewUnitOption("Unit", "ConditionPathExists", escape(a.runtime("current", "config.yaml"))),
		unit.NewUnitOption("Unit", "StartLimitIntervalSec", "0"),
		unit.NewUnitOption("Service", "Type", "exec"),
		unit.NewUnitOption("Service", "ExecStart", ":"+strings.Join(command, " ")),
		unit.NewUnitOption("Service", "WorkingDirectory", escape(a.runtime())),
		unit.NewUnitOption("Service", "Restart", "always"),
		unit.NewUnitOption("Service", "RestartSec", "5s"),
		unit.NewUnitOption("Service", "TimeoutStopSec", "20s"),
		unit.NewUnitOption("Service", "KillMode", "control-group"),
		unit.NewUnitOption("Service", "UMask", "0077"),
		unit.NewUnitOption("Service", "NoNewPrivileges", "yes"),
		unit.NewUnitOption("Service", "CapabilityBoundingSet", "CAP_NET_ADMIN CAP_NET_BIND_SERVICE"),
		unit.NewUnitOption("Service", "AmbientCapabilities", "CAP_NET_ADMIN CAP_NET_BIND_SERVICE"),
		unit.NewUnitOption("Service", "RestrictAddressFamilies", "AF_INET AF_INET6 AF_NETLINK"),
		unit.NewUnitOption("Service", "ProtectSystem", "strict"),
		unit.NewUnitOption("Service", "ReadWritePaths", quote(a.runtime())),
		unit.NewUnitOption("Service", "ProtectKernelTunables", "yes"),
		unit.NewUnitOption("Service", "ProtectKernelModules", "yes"),
		unit.NewUnitOption("Service", "ProtectControlGroups", "yes"),
		unit.NewUnitOption("Service", "PrivateDevices", "yes"),
		unit.NewUnitOption("Install", "WantedBy", "multi-user.target"),
	}
	data, err := io.ReadAll(unit.Serialize(options))
	return string(data), err
}
