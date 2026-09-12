#!/system/bin/sh
umask 077
DIR=/data/ufi-mihomo
BOOT=/sdcard/ufi_tools_boot.sh
CURL=/data/data/com.minikano.f50_sms/files/curl
export PATH="/system/bin:/system/xbin:/vendor/bin:$PATH"
# shellcheck source=scripts/network.sh
. "$DIR/network.sh"

fail() { echo "$*" >&2; exit 1; }
alive() {
  [ -f "$DIR/$1.pid" ] || return 1
  pid=$(cat "$DIR/$1.pid")
  case "$pid" in ''|*[!0-9]*) return 1;; esac
  [ "$pid" -gt 1 ] && kill -0 "$pid" 2>/dev/null &&
    tr '\000' ' ' < "/proc/$pid/cmdline" | grep -q "$DIR/"
}
kill_owned() {
  if alive "$1"; then
    kill "$pid" 2>/dev/null
    n=0
    while alive "$1" && [ "$n" -lt 10 ]; do sleep 1; n=$((n + 1)); done
    if alive "$1"; then kill -9 "$pid" 2>/dev/null; fi
  fi
  rm -f "$DIR/$1.pid"
}
stop_service() {
  kill_owned supervisor
  network_stop
  kill_owned core
}
start_service() {
  alive supervisor && return 0
  [ -x "$DIR/mihomo" ] && [ -s "$DIR/config.yaml" ] && [ -s "$DIR/interfaces" ] || return 1
  # This file is data, never source it as shell code.
  # shellcheck disable=SC2013
  for iface in $(cat "$DIR/interfaces"); do
    case "$iface" in lo|rmnet*|ccmni*|pdp*|wwan*|*[!a-zA-Z0-9_.-]*|''|[-.]*) echo '无效 LAN 接口' >&2; return 1;; esac
    [ "${#iface}" -le 15 ] || return 1
  done
  if pgrep -f '/data/clash/.*(Clash|clash)' >/dev/null 2>&1; then
    echo '旧猫猫服务仍在运行，请先在旧插件停止并关闭自启' >&2
    return 1
  fi
  timeout 30 "$DIR/mihomo" -t -d "$DIR" -f "$DIR/config.yaml" >> "$DIR/service.log" 2>&1 || return 1
  # A SIGKILL of the supervisor may have left an orphaned core.
  network_stop
  kill_owned core
  nohup sh "$DIR/service.sh" supervise </dev/null >> "$DIR/service.log" 2>&1 &
  echo $! > "$DIR/supervisor.pid"
  n=0
  while [ "$n" -lt 15 ]; do
    sleep 1
    alive supervisor || return 1
    if alive core && network_ok; then return 0; fi
    n=$((n + 1))
  done
  stop_service
  return 1
}

case "${1:-status}" in
  supervise)
    trap 'network_stop; kill_owned core; exit 0' TERM INT
    trap '' HUP
    delay=2
    while :; do
      # ponytail: rotate between starts/polls; use a log pipe if strict byte caps become necessary.
      if [ -f "$DIR/core.log" ] && [ "$(wc -c < "$DIR/core.log")" -gt 1048576 ]; then : > "$DIR/core.log"; fi
      "$DIR/mihomo" -d "$DIR" -f "$DIR/config.yaml" >> "$DIR/core.log" 2>&1 &
      echo $! > "$DIR/core.pid"
      sleep 2
      if alive core && network_start; then
        ticks=0
        while alive core; do
          sleep 10
          ticks=$((ticks + 1))
          if ! network_ok; then network_start || break; fi
          if [ "$(wc -c < "$DIR/core.log")" -gt 1048576 ]; then : > "$DIR/core.log"; fi
          if [ "$(wc -c < "$DIR/service.log")" -gt 262144 ]; then : > "$DIR/service.log"; fi
          [ "$ticks" -lt 6 ] || delay=2
        done
      fi
      network_stop
      kill_owned core
      sleep "$delay"
      delay=$((delay * 2)); [ "$delay" -le 60 ] || delay=60
    done
    ;;
  status)
    if alive supervisor; then
      if alive core && network_ok; then echo '运行中'; else echo '恢复中 / 网络接管未就绪'; fi
    else echo '已停止'; fi
    if grep -qxF "sh $DIR/service.sh start # ufi-mihomo" "$BOOT" 2>/dev/null; then echo '开机自启：开启'; else echo '开机自启：关闭'; fi
    [ ! -x "$DIR/mihomo" ] || "$DIR/mihomo" -v
    exit 0
    ;;
  logs) tail -n 60 "$DIR/install.log" "$DIR/service.log" "$DIR/core.log" 2>/dev/null; exit 0;;
  *)
    # Serialize mutations, including boot versus button clicks. PID permits recovery after a crash.
    if ! mkdir "$DIR/lock" 2>/dev/null; then
      owner=$(cat "$DIR/lock/pid" 2>/dev/null)
      case "$owner" in ''|*[!0-9]*) fail '操作锁未就绪，请稍后重试';; esac
      if kill -0 "$owner" 2>/dev/null; then fail '已有操作执行中'; fi
      rm -f "$DIR/lock/pid"; rmdir "$DIR/lock" || exit 1
      mkdir "$DIR/lock" || exit 1
    fi
    echo $$ > "$DIR/lock/pid"
    trap 'rm -f "$DIR/lock/pid"; rmdir "$DIR/lock"' EXIT
    ;;
esac

case "$1" in
  start) start_service || fail '启动失败，请查看日志';;
  stop) stop_service;;
  restart) stop_service; start_service || fail '重启失败，请查看日志';;
  fetch)
    [ -s "$DIR/subscription.curl" ] || fail '请先保存订阅'
    "$CURL" -q -fsSL --proto '=http,https' --proto-redir '=http,https' --connect-timeout 15 --max-time 90 --max-filesize 4194304 -A 'mihomo' --config "$DIR/subscription.curl" -o "$DIR/download.yaml" 2> "$DIR/download-error.log" || fail '订阅下载失败，当前配置未更改'
    [ -s "$DIR/download.yaml" ] || fail '订阅内容为空'
    echo '订阅下载完成'
    ;;
  apply)
    [ -x "$DIR/mihomo" ] || fail '请先安装核心'
    timeout 30 "$DIR/mihomo" -t -d "$DIR" -f "$DIR/candidate.yaml" >> "$DIR/service.log" 2>&1 || fail '配置校验失败，当前配置未更改'
    if cmp -s "$DIR/config.yaml" "$DIR/candidate.yaml"; then echo '配置未变化'; exit 0; fi
    was_running=0; alive supervisor && was_running=1
    [ ! -f "$DIR/config.yaml" ] || cp "$DIR/config.yaml" "$DIR/config.previous.yaml" || exit 1
    [ ! -f "$DIR/download.yaml" ] || cp "$DIR/download.yaml" "$DIR/subscription.yaml" || exit 1
    stop_service
    mv "$DIR/candidate.yaml" "$DIR/config.yaml" || exit 1
    if [ "$was_running" = 1 ]; then
      if ! start_service; then
        stop_service
        if [ -f "$DIR/config.previous.yaml" ]; then
          cp "$DIR/config.previous.yaml" "$DIR/config.yaml" || exit 1
          start_service || fail '新配置失败，旧配置恢复后仍启动失败，请查看日志'
        fi
        fail '新配置启动失败，已回滚'
      fi
    fi
    echo '配置已更新'
    ;;
  core|import-zip|install-official)
    alive supervisor && fail '更新核心前请先停止服务'
    if [ "$1" = install-official ]; then
      # The UI resolves latest once; download and digest must refer to that same release.
      version=$(sed -n '1p' "$DIR/core-release")
      abi=$(sed -n '2p' "$DIR/core-release")
      checksum=$(sed -n '3p' "$DIR/core-release")
      printf '%s\n' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || fail '无效核心版本'
      printf '%s\n' "$checksum" | grep -Eq '^[a-f0-9]{64}$' || fail '无效核心摘要'
      [ "$abi" = "$(getprop ro.product.cpu.abi)" ] || fail '核心架构与设备不匹配'
      case "$abi" in
        arm64-v8a) arch=arm64-v8;;
        armeabi-v7a|armeabi) arch=armv7;;
        *) fail '官方安装支持 Android ARM64 / ARMv7，请为其他架构手动上传核心';;
      esac
      asset="https://github.com/MetaCubeX/mihomo/releases/download/$version/mihomo-android-$arch-$version.gz"
      mirror=$(cat "$DIR/core-mirror" 2>/dev/null)
      if [ -n "$mirror" ]; then
        case "$mirror" in https://*) asset="${mirror%/}/$asset";; *) fail '无效核心下载镜像';; esac
      fi
      "$CURL" -q -fL --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 300 --max-filesize 67108864 "$asset" -o "$DIR/mihomo.gz.next" || fail '核心下载失败'
      actual=$(sha256sum "$DIR/mihomo.gz.next") || fail '本机缺少 sha256sum'
      [ "${actual%% *}" = "$checksum" ] || fail '核心 SHA-256 不匹配，拒绝执行'
      gzip -dc "$DIR/mihomo.gz.next" > "$DIR/mihomo.next" || fail '核心解压失败'
      rm -f "$DIR/mihomo.gz.next"
    fi
    if [ "$1" = import-zip ]; then
      unzip -p "$DIR/bundle.zip" Proxy/Clash.Core > "$DIR/mihomo.next" || fail 'ZIP 中缺少 Proxy/Clash.Core'
    fi
    chmod 700 "$DIR/mihomo.next" || exit 1
    "$DIR/mihomo.next" -v || fail '核心不能在本机执行，请检查架构'
    if [ -f "$DIR/config.yaml" ]; then
      timeout 30 "$DIR/mihomo.next" -t -d "$DIR" -f "$DIR/config.yaml" >> "$DIR/service.log" 2>&1 || fail '新核心无法加载当前配置'
    fi
    mv "$DIR/mihomo.next" "$DIR/mihomo" || exit 1
    if [ "$1" = import-zip ]; then
      for geo in GeoIP GeoSite; do
        lower=$(echo "$geo" | tr '[:upper:]' '[:lower:]')
        if [ ! -f "$DIR/$lower.dat" ]; then
          unzip -p "$DIR/bundle.zip" "Proxy/$geo.dat" > "$DIR/$lower.dat.next" && mv "$DIR/$lower.dat.next" "$DIR/$lower.dat"
        fi
      done
      rm -f "$DIR/bundle.zip"
    fi
    ;;
  boot-on)
    touch "$BOOT" || exit 1
    grep -qxF "sh $DIR/service.sh start # ufi-mihomo" "$BOOT" || printf '\nsh %s/service.sh start # ufi-mihomo\n' "$DIR" >> "$BOOT"
    ;;
  boot-off) [ ! -f "$BOOT" ] || sed -i '/^sh \/data\/ufi-mihomo\/service\.sh start # ufi-mihomo$/d' "$BOOT";;
  *) fail '未知操作';;
esac
