#!/system/bin/sh
# Sourced by service.sh. Only these chains, mark bit and table belong to us.
MARK=0x40000000
TABLE=2026
PRIORITY=9000

ipt() { iptables -w 5 "$@"; }
ip6t() { ip6tables -w 5 "$@"; }

network_stop() {
  [ -f "$DIR/network.owned" ] || return 0
  while ipt -t mangle -C PREROUTING -j UFI_MH >/dev/null 2>&1; do ipt -t mangle -D PREROUTING -j UFI_MH || break; done
  while ipt -t nat -C PREROUTING -j UFI_MH_DNS >/dev/null 2>&1; do ipt -t nat -D PREROUTING -j UFI_MH_DNS || break; done
  while ip6t -C FORWARD -j UFI_MH6 >/dev/null 2>&1; do ip6t -D FORWARD -j UFI_MH6 || break; done
  while ipt -C INPUT -j UFI_MH_IN >/dev/null 2>&1; do ipt -D INPUT -j UFI_MH_IN || break; done
  ipt -t mangle -F UFI_MH >/dev/null 2>&1
  ipt -t mangle -X UFI_MH >/dev/null 2>&1
  ipt -t nat -F UFI_MH_DNS >/dev/null 2>&1
  ipt -t nat -X UFI_MH_DNS >/dev/null 2>&1
  ip6t -F UFI_MH6 >/dev/null 2>&1
  ip6t -X UFI_MH6 >/dev/null 2>&1
  ipt -F UFI_MH_IN >/dev/null 2>&1
  ipt -X UFI_MH_IN >/dev/null 2>&1
  while ip -4 rule del priority "$PRIORITY" fwmark "$MARK/$MARK" table "$TABLE" >/dev/null 2>&1; do :; done
  ip -4 route del local 0.0.0.0/0 dev lo table "$TABLE" >/dev/null 2>&1
  return 0
}

network_start() {
  network_stop
  # Refuse table/priority collisions; never overwrite Android or another plugin.
  [ -z "$(ip -4 route show table "$TABLE" 2>/dev/null)" ] || return 1
  ! ip -4 rule show | grep -q "^$PRIORITY:" || return 1
  if [ ! -f "$DIR/network.owned" ]; then
    ! ipt -t mangle -S UFI_MH >/dev/null 2>&1 || return 1
    ! ipt -t nat -S UFI_MH_DNS >/dev/null 2>&1 || return 1
    ! ip6t -S UFI_MH6 >/dev/null 2>&1 || return 1
    ! ipt -S UFI_MH_IN >/dev/null 2>&1 || return 1
    touch "$DIR/network.owned" || return 1
  fi
  ipt -t mangle -N UFI_MH || return 1
  ipt -t nat -N UFI_MH_DNS || return 1
  ip6t -N UFI_MH6 || return 1
  ipt -N UFI_MH_IN || return 1
  ipt -A UFI_MH_IN -i lo -j RETURN || return 1
  ipt -t mangle -A UFI_MH -m addrtype --dst-type LOCAL -j RETURN || return 1
  for subnet in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do
    ipt -t mangle -A UFI_MH -d "$subnet" -j RETURN || return 1
  done
  # Interface names are validated in both the UI and service entry point.
  # shellcheck disable=SC2013
  for iface in $(cat "$DIR/interfaces"); do
    ipt -A UFI_MH_IN -i "$iface" -m mark --mark "$MARK/$MARK" -j ACCEPT || return 1
    for proto in tcp udp; do
      ipt -A UFI_MH_IN -i "$iface" -p "$proto" -m multiport --dports 7894,1053 -j ACCEPT || return 1
      ipt -t mangle -A UFI_MH -i "$iface" -p "$proto" ! --dport 53 -j TPROXY --on-port 7894 --tproxy-mark "$MARK/$MARK" || return 1
      ipt -t nat -A UFI_MH_DNS -i "$iface" -p "$proto" --dport 53 -j REDIRECT --to-ports 1053 || return 1
    done
    ip6t -A UFI_MH6 -i "$iface" -j REJECT --reject-with icmp6-adm-prohibited || return 1
  done
  for proto in tcp udp; do
    ipt -A UFI_MH_IN -p "$proto" -m multiport --dports 7894,1053 -j REJECT || return 1
  done
  ip -4 route add local 0.0.0.0/0 dev lo table "$TABLE" || return 1
  ip -4 rule add priority "$PRIORITY" fwmark "$MARK/$MARK" table "$TABLE" || return 1
  ip6t -I FORWARD 1 -j UFI_MH6 || return 1
  ipt -I INPUT 1 -j UFI_MH_IN || return 1
  ipt -t nat -I PREROUTING 1 -j UFI_MH_DNS || return 1
  ipt -t mangle -I PREROUTING 1 -j UFI_MH || return 1
}

network_ok() {
  ipt -t mangle -C PREROUTING -j UFI_MH >/dev/null 2>&1 &&
  ipt -t nat -C PREROUTING -j UFI_MH_DNS >/dev/null 2>&1 &&
  ip6t -C FORWARD -j UFI_MH6 >/dev/null 2>&1 &&
  ipt -C INPUT -j UFI_MH_IN >/dev/null 2>&1 &&
  ip -4 rule show | grep -q "^$PRIORITY:.*lookup $TABLE" &&
  ip -4 route show table "$TABLE" | grep -q 'local default dev lo'
}
