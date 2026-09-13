package host

import (
	"fmt"

	"github.com/prometheus/procfs"
)

// Read the process network namespace and require ownership of every listener.
func Listeners(pid int) bool {
	p, err := procfs.NewProc(pid)
	if err != nil {
		return false
	}
	targets, err := p.FileDescriptorTargets()
	if err != nil {
		return false
	}
	owned := map[string]bool{}
	for _, target := range targets {
		owned[target] = true
	}
	fs, err := procfs.NewFS(fmt.Sprintf("/proc/%d", pid))
	if err != nil {
		return false
	}
	tcp, err := fs.NetTCP()
	if err != nil {
		return false
	}
	tcp6, err := fs.NetTCP6()
	if err == nil {
		tcp = append(tcp, tcp6...)
	}
	udp, err := fs.NetUDP()
	if err != nil {
		return false
	}
	udp6, err := fs.NetUDP6()
	if err == nil {
		udp = append(udp, udp6...)
	}
	for _, port := range []uint64{7894, 1053} {
		hasTCP, hasUDP := false, false
		for _, s := range tcp {
			if s.LocalPort == port && s.St == 10 && owned[fmt.Sprintf("socket:[%d]", s.Inode)] {
				hasTCP = true
			}
		}
		for _, s := range udp {
			if s.LocalPort == port && s.St == 7 && owned[fmt.Sprintf("socket:[%d]", s.Inode)] {
				hasUDP = true
			}
		}
		if !hasTCP || !hasUDP {
			return false
		}
	}
	return true
}
