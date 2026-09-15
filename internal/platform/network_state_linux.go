package platform

import (
	"fmt"
	"net"
	"time"

	"github.com/vishvananda/netlink"
	"golang.org/x/sys/unix"
)

// NetworkState reads numeric kernel IDs, independent of ip command variants and rt_tables aliases.
// It never changes routes or rules, and an incomplete dump must not imply absence.
func NetworkState(field string, table, priority int, mark uint32) (bool, error) {
	if field != "table-empty" && field != "route-owned" && field != "priority-free" && field != "rule-owned" {
		return false, fmt.Errorf("未知网络检查：%s", field)
	}
	handle, err := netlink.NewHandle(unix.NETLINK_ROUTE)
	if err != nil {
		return false, fmt.Errorf("无法打开路由 netlink：%w", err)
	}
	defer handle.Close()
	if err := handle.SetSocketTimeout(2 * time.Second); err != nil {
		return false, err
	}
	if field == "table-empty" || field == "route-owned" {
		routes, err := handle.RouteListFiltered(netlink.FAMILY_V4, &netlink.Route{Table: table}, netlink.RT_FILTER_TABLE)
		if err != nil {
			return false, fmt.Errorf("无法读取 IPv4 路由表 %d：%w", table, err)
		}
		if field == "table-empty" {
			return len(routes) == 0, nil
		}
		loopback, err := net.InterfaceByName("lo")
		if err != nil {
			return false, err
		}
		for _, route := range routes {
			if ownedRoute(route, table, loopback.Index) {
				return true, nil
			}
		}
		return false, nil
	}
	rules, err := handle.RuleList(netlink.FAMILY_V4)
	if err != nil {
		return false, fmt.Errorf("无法读取 IPv4 策略规则：%w", err)
	}
	for _, rule := range rules {
		if field == "priority-free" && rule.Priority == priority {
			return false, nil
		}
		if field == "rule-owned" && ownedRule(rule, table, priority, mark) {
			return true, nil
		}
	}
	return field == "priority-free", nil
}

func ownedRoute(route netlink.Route, table, loopback int) bool {
	defaultRoute := route.Dst == nil
	if route.Dst != nil {
		ones, bits := route.Dst.Mask.Size()
		defaultRoute = ones == 0 && bits == 32 && route.Dst.IP.IsUnspecified()
	}
	return route.Table == table && route.Type == unix.RTN_LOCAL && defaultRoute && route.LinkIndex == loopback && len(route.MultiPath) == 0
}

func ownedRule(rule netlink.Rule, table, priority int, mark uint32) bool {
	return rule.Priority == priority && rule.Table == table && rule.Mark == mark && rule.Mask != nil && *rule.Mask == mark &&
		!rule.Invert && rule.Src == nil && rule.Dst == nil && rule.IifName == "" && rule.OifName == "" &&
		rule.Tos == 0 && rule.TunID == 0 && rule.IPProto == 0 && rule.Dport == nil && rule.Sport == nil && rule.UIDRange == nil &&
		rule.SuppressIfgroup < 0 && rule.SuppressPrefixlen < 0 && rule.Goto < 0
}
