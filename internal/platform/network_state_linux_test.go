package platform

import (
	"net"
	"testing"

	"github.com/vishvananda/netlink"
	"golang.org/x/sys/unix"
)

func TestNetworkStateKernelReads(t *testing.T) {
	// Exercise real Linux netlink dumps without adding or deleting any network state.
	for _, field := range []string{"table-empty", "route-owned", "priority-free", "rule-owned"} {
		if _, err := NetworkState(field, 2026, 9000, 0x40000000); err != nil {
			t.Fatalf("%s: %v", field, err)
		}
	}
}

func TestNumericNetworkOwnership(t *testing.T) {
	// Numeric IDs come from netlink; rt_tables aliases cannot change ownership.
	route := netlink.Route{Table: 2026, Type: unix.RTN_LOCAL, LinkIndex: 1}
	if !ownedRoute(route, 2026, 1) {
		t.Fatal("nil destination is the default route")
	}
	_, route.Dst, _ = net.ParseCIDR("0.0.0.0/0")
	if !ownedRoute(route, 2026, 1) || ownedRoute(route, 2027, 1) || ownedRoute(route, 2026, 2) {
		t.Fatal("route table or interface ownership mismatch")
	}
	_, route.Dst, _ = net.ParseCIDR("10.0.0.0/8")
	if ownedRoute(route, 2026, 1) {
		t.Fatal("foreign destination accepted")
	}
	mark := uint32(0x40000000)
	rule := netlink.NewRule()
	rule.Priority, rule.Table, rule.Mark, rule.Mask = 9000, 2026, mark, &mark
	if !ownedRule(*rule, 2026, 9000, mark) || ownedRule(*rule, 2027, 9000, mark) || ownedRule(*rule, 2026, 9001, mark) {
		t.Fatal("rule numeric ownership mismatch")
	}
	rule.Mask = nil
	if ownedRule(*rule, 2026, 9000, mark) {
		t.Fatal("missing explicit mask accepted")
	}
	rule.Mask, rule.IifName = &mark, "wlan0"
	if ownedRule(*rule, 2026, 9000, mark) {
		t.Fatal("foreign rule selector accepted")
	}
	if _, err := NetworkState("unknown", 2026, 9000, mark); err == nil {
		t.Fatal("unknown field accepted")
	}
}
