#!/system/bin/sh
# Sourced by service.sh. Only these chains, mark bit and table belong to us.
MARK=0x40000000
TABLE=2026
PRIORITY=9000

ipt() { iptables -w 5 "$@"; }
ip6t() { ip6tables -w 5 "$@"; }

resolve_interfaces() {
  configured=$(cat "$DIR/interfaces" 2>/dev/null)
  if [ -n "$configured" ] && [ "$configured" != auto ]; then
    # shellcheck disable=SC2086
    for iface in $configured; do
      case "$iface" in lo|rmnet*|ccmni*|pdp*|wwan*|*[!a-zA-Z0-9_.-]*|[-.]*) return 1;; esac
      [ "${#iface}" -le 15 ] || return 1
    done
    printf '%s\n' "$configured"
    return
  fi
  # Android keeps upstream routes outside the main table. Include IPv6-only uplinks.
  routes=$(ip -4 route show table all) || return 1
  routes6=$(ip -6 route show table all) || return 1
  upstreams=$(printf '%s\n%s\n' "$routes" "$routes6" | awk '
    $1 == "default" || $1 == "0.0.0.0/1" || $1 == "128.0.0.0/1" {
      for (i=1; i<NF; i++) if ($i == "dev") printf "%s ", $(i+1)
    }')
  addresses=$(ip -o -4 addr show up scope global) || return 1
  # ponytail: F50 Wi-Fi/USB/bridge names + private IPv4; unknown firmware names need an override.
  printf '%s\n' "$addresses" | awk -v upstreams="$upstreams" '
    BEGIN { n=split(upstreams, list, " "); for (i=1; i<=n; i++) upstream[list[i]]=1 }
    {
      iface=$2; sub(/@.*/, "", iface)
      if (iface !~ /^(wlan[0-9]+|ap[0-9]+|softap[0-9]*|rndis[0-9]+|usb[0-9]+|br[0-9]+|br-lan)$/ || upstream[iface]) next
      split($4, addr, /[.\/]/)
      if (addr[1]==10 || (addr[1]==172 && addr[2]>=16 && addr[2]<=31) || (addr[1]==192 && addr[2]==168)) print iface
    }' | sort -u | tr '\n' ' ' | sed 's/ *$//'
}

network_sync() {
  selected=$(resolve_interfaces) || { network_stop; return 1; }
  if [ -z "$selected" ]; then
    network_stop
    return 0
  fi
  listeners_ready || { network_stop; return 1; }
  # An old downstream may have become an upstream. Do not keep capturing it on rollback.
  previous_interfaces=$(active_interfaces)
  for previous_iface in $previous_interfaces; do
    case " $selected " in *" $previous_iface "*) ;; *) network_stop || return 1; break;; esac
  done
  if [ "$selected" != "$(active_interfaces)" ] || ! network_ok; then
    network_start || return 1
  fi
}

active_slot() { sed -n '1p' "$DIR/network.active" 2>/dev/null; }
active_interfaces() { sed -n '2p' "$DIR/network.active" 2>/dev/null; }

# The file descriptors prove these sockets belong to our core, not another process.
listeners_ready() {
  alive core || return 1
  listener_pid=$(cat "$DIR/core.pid")
  socket_inodes=$(for fd in /proc/"$listener_pid"/fd/*; do readlink "$fd" 2>/dev/null; done |
    sed -n 's/^socket:\[\([0-9]*\)\]$/\1/p' | tr '\n' ' ')
  [ -n "$socket_inodes" ] || return 1
  awk -v owned="$socket_inodes" '
    BEGIN { n=split(owned, ids, " "); for(i=1;i<=n;i++) inode[ids[i]]=1 }
    inode[$10] {
      split($2, localaddr, ":")
      if (localaddr[1] !~ /^0+$/) next
      port=toupper(localaddr[2]); proto=FILENAME ~ /udp6?$/ ? "udp" : "tcp"
      if ((proto=="tcp" && $4=="0A") || (proto=="udp" && $4=="07")) found[proto,port]=1
    }
    END { exit !(found["tcp","1ED6"] && found["udp","1ED6"] && found["tcp","041D"] && found["udp","041D"]) }
  ' /proc/net/tcp /proc/net/udp /proc/net/tcp6 /proc/net/udp6 2>/dev/null
}

network_stop() {
  [ -f "$DIR/network.owned" ] || return 0
  for group in 'ipt mangle PREROUTING UFI_MH' 'ipt nat PREROUTING UFI_MH_DNS' 'ip6t filter FORWARD UFI_MH6' 'ipt filter INPUT UFI_MH_IN'; do
    # Fixed tuples, not user input.
    # shellcheck disable=SC2086
    set -- $group
    while "$1" -t "$2" -C "$3" -j "$4" >/dev/null 2>&1; do
      "$1" -t "$2" -D "$3" -j "$4" || return 1
    done
    if "$1" -t "$2" -S "$4" >/dev/null 2>&1; then "$1" -t "$2" -F "$4" || return 1; fi
    for chain in "${4}_A" "${4}_B" "$4"; do
      if "$1" -t "$2" -S "$chain" >/dev/null 2>&1; then
        "$1" -t "$2" -F "$chain" && "$1" -t "$2" -X "$chain" || return 1
      fi
    done
  done
  while ip -4 rule del priority "$PRIORITY" fwmark "$MARK/$MARK" table "$TABLE" >/dev/null 2>&1; do :; done
  ip -4 route del local 0.0.0.0/0 dev lo table "$TABLE" >/dev/null 2>&1
  rm -f "$DIR/network.active" "$DIR/network.pending"
  return 0
}

build_slot() {
  for group in 'ipt mangle UFI_MH' 'ipt nat UFI_MH_DNS' 'ip6t filter UFI_MH6' 'ipt filter UFI_MH_IN'; do
    # shellcheck disable=SC2086
    set -- $group
    if "$1" -t "$2" -S "${3}_$next" >/dev/null 2>&1; then
      "$1" -t "$2" -F "${3}_$next" || return 1
    else "$1" -t "$2" -N "${3}_$next" || return 1; fi
  done
  ipt -A "UFI_MH_IN_$next" -i lo -j RETURN || return 1
  ipt -t mangle -A "UFI_MH_$next" -m addrtype --dst-type LOCAL -j RETURN || return 1
  for subnet in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do
    ipt -t mangle -A "UFI_MH_$next" -d "$subnet" -j RETURN || return 1
  done
  # Interface names are validated in both the UI and service entry point.
  # shellcheck disable=SC2086
  for iface in $selected; do
    ipt -A "UFI_MH_IN_$next" -i "$iface" -m mark --mark "$MARK/$MARK" -j ACCEPT || return 1
    for proto in tcp udp; do
      ipt -A "UFI_MH_IN_$next" -i "$iface" -p "$proto" -m multiport --dports 7894,1053 -j ACCEPT || return 1
      ipt -t mangle -A "UFI_MH_$next" -i "$iface" -p "$proto" ! --dport 53 -j TPROXY --on-port 7894 --tproxy-mark "$MARK/$MARK" || return 1
      ipt -t nat -A "UFI_MH_DNS_$next" -i "$iface" -p "$proto" --dport 53 -j REDIRECT --to-ports 1053 || return 1
    done
    ip6t -A "UFI_MH6_$next" -i "$iface" -j REJECT --reject-with icmp6-adm-prohibited || return 1
  done
  for proto in tcp udp; do
    ipt -A "UFI_MH_IN_$next" -p "$proto" -m multiport --dports 7894,1053 -j REJECT || return 1
  done
}

# Set INPUT/IPv6 protection before DNS and TProxy capture. Each jump replacement is atomic.
switch_slot() {
  slot=$1
  for group in 'ipt filter INPUT UFI_MH_IN' 'ip6t filter FORWARD UFI_MH6' 'ipt nat PREROUTING UFI_MH_DNS' 'ipt mangle PREROUTING UFI_MH'; do
    # shellcheck disable=SC2086
    set -- $group
    "$1" -t "$2" -S "$4" >/dev/null 2>&1 || "$1" -t "$2" -N "$4" || return 1
    wrapper_rules=$("$1" -t "$2" -S "$4") || return 1
    entries=$(printf '%s\n' "$wrapper_rules" | awk '$1=="-A" {n++} END {print n+0}')
    case "$entries" in
      0) "$1" -t "$2" -A "$4" -j "${4}_$slot" || return 1;;
      1) "$1" -t "$2" -R "$4" 1 -j "${4}_$slot" || return 1;;
      *) echo '入口链状态异常，请停止服务后重试' >&2; return 1;;
    esac
    "$1" -t "$2" -C "$3" -j "$4" >/dev/null 2>&1 || "$1" -t "$2" -I "$3" 1 -j "$4" || return 1
  done
}

network_routes_ok() {
  ip -4 rule show | grep -Eq "^$PRIORITY:.*fwmark 0x40000000/0x40000000.*lookup $TABLE( |$)" &&
  ip -4 route show table "$TABLE" | grep -q 'local default dev lo'
}

network_ok() {
  slot=$(active_slot)
  case "$slot" in A|B) ;; *) return 1;; esac
  [ ! -f "$DIR/network.pending" ] || return 1
  for group in 'ipt mangle PREROUTING UFI_MH' 'ipt nat PREROUTING UFI_MH_DNS' 'ip6t filter FORWARD UFI_MH6' 'ipt filter INPUT UFI_MH_IN'; do
    # shellcheck disable=SC2086
    set -- $group
    "$1" -t "$2" -C "$3" -j "$4" >/dev/null 2>&1 || return 1
    "$1" -t "$2" -C "$4" -j "${4}_$slot" >/dev/null 2>&1 || return 1
  done
  network_routes_ok
}

network_start() {
  selected=$(resolve_interfaces) || return 1
  [ -n "$selected" ] && listeners_ready || return 1
  old=$(active_slot)
  case "$old" in A) next=B;; B) next=A;; '') next=A;; *) return 1;; esac
  if [ -f "$DIR/network.pending" ]; then
    if [ -n "$old" ]; then switch_slot "$old" || return 1; else network_stop || return 1; fi
    rm -f "$DIR/network.pending"
  fi
  if [ ! -f "$DIR/network.owned" ]; then
    [ -z "$(ip -4 route show table "$TABLE" 2>/dev/null)" ] || return 1
    ! ip -4 rule show | grep -q "^$PRIORITY:" || return 1
    for group in 'ipt mangle UFI_MH' 'ipt nat UFI_MH_DNS' 'ip6t filter UFI_MH6' 'ipt filter UFI_MH_IN'; do
      # shellcheck disable=SC2086
      set -- $group
      for chain in "$3" "${3}_A" "${3}_B"; do
        ! "$1" -t "$2" -S "$chain" >/dev/null 2>&1 || return 1
      done
    done
    touch "$DIR/network.owned" || return 1
  fi
  if ! network_routes_ok; then
    # Only add missing owned routes; never replace foreign entries.
    if [ -z "$(ip -4 route show table "$TABLE" 2>/dev/null)" ]; then
      ip -4 route add local 0.0.0.0/0 dev lo table "$TABLE" || return 1
    fi
    if ! ip -4 rule show | grep -q "^$PRIORITY:"; then
      ip -4 rule add priority "$PRIORITY" fwmark "$MARK/$MARK" table "$TABLE" || return 1
    fi
    network_routes_ok || return 1
  fi
  build_slot || return 1
  printf '%s\n' "$next" > "$DIR/network.pending" || return 1
  if switch_slot "$next"; then
    if printf '%s\n%s\n' "$next" "$selected" > "$DIR/network.active.next" &&
      mv "$DIR/network.active.next" "$DIR/network.active"; then
      rm -f "$DIR/network.pending"
      return 0
    fi
  fi
  if [ -n "$old" ]; then
    switch_slot "$old" || { echo '网络规则回滚失败，将重试' >&2; return 1; }
    rm -f "$DIR/network.pending"
  else network_stop || return 1; fi
  return 1
}
