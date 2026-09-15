#!/system/bin/sh
# Only provisions the native binary. All device mutations after that use Go/flock.
set -u
BASE=/data/mihomoctl-bootstrap
CURL=/data/data/com.minikano.f50_sms/files/curl
umask 077
mode=$1
id=$2
case "$id" in ''|*[!a-f0-9]*) exit 1;; esac
[ "${#id}" = 32 ] || exit 1
job="$BASE/jobs/$id"
record() {
  printf '{"id":"%s","action":"bootstrap","state":"%s","phase":"%s","updated":"%s","hash":"","result":"","error":""}\n' "$id" "$1" "$2" "${3:-$(date -u '+%Y-%m-%dT%H:%M:%SZ')}"
}
state() {
  record "$1" "$2" > "$job/state-$$.next"
  mv "$job/state-$$.next" "$job/state.json"
}
if [ "$mode" = status ]; then
  pid=$(cat "$job/worker.pid" 2>/dev/null)
  alive=false
  case "$pid" in ''|*[!0-9]*) ;;
    *) if kill -0 "$pid" 2>/dev/null && tr '\000' '\n' < "/proc/$pid/cmdline" | grep -qxF "$0"; then alive=true; fi;;
  esac
  # Re-read after checking the process. Status never overwrites the worker's result.
  current=$(cat "$job/state.json") || exit 1
  if [ "$alive" = false ] && printf '%s' "$current" | grep -Eq '"state":"(queued|running)"'; then
    updated=$(printf '%s' "$current" | sed -n 's/.*"updated":"\([^"]*\)".*/\1/p')
    record interrupted interrupted "$updated"
  else
    printf '%s\n' "$current"
  fi
  exit 0
fi
if [ "$mode" = submit ]; then
  echo $$ > "$job/worker.pid"
  state queued preparing
  printf '%s' "$id" > "$BASE/latest-$id"
  mv "$BASE/latest-$id" "$BASE/latest"
  shift 2
  nohup sh "$0" worker "$id" "$@" </dev/null > "$job/log.txt" 2>&1 &
  echo $! > "$job/worker.pid"
  cat "$job/state.json"
  exit 0
fi
[ "$mode" = worker ] || exit 1
cleanup() {
  code=$?
  if [ "$code" != 0 ]; then state failed failed; fi
  rm -f "$job/mihomoctl" "$job/ca.pem"
}
trap cleanup EXIT
trap '' HUP
state running download
protocol=$7
forward=$8
case "$(getprop ro.product.cpu.abi)" in
  arm64-v8a) address=$3; digest=$4;;
  armeabi-v7a|armeabi) address=$5; digest=$6;;
  *) echo '不支持的设备架构'; exit 1;;
esac
[ -x "$CURL" ] || { echo 'UFI 缺少 curl，请更新 UFI'; exit 1; }
# The app's curl may not know Android's CA location. Never disable TLS verification.
for cert in /system/etc/security/cacerts/* /apex/com.android.conscrypt/cacerts/*; do
  if [ -f "$cert" ]; then cat "$cert"; printf '\n'; fi
done > "$job/ca.pem"
set --
[ -n "$forward" ] || set -- -L
[ ! -s "$job/ca.pem" ] || set -- "$@" --cacert "$job/ca.pem"
"$CURL" -q -f "$@" --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 300 --max-filesize 33554432 "$address" -o "$job/mihomoctl" || exit 1
state running verify
actual=$(sha256sum "$job/mihomoctl") || exit 1
[ "${actual%% *}" = "$digest" ] || { echo 'mihomoctl 文件校验失败'; exit 1; }
chmod 700 "$job/mihomoctl" || exit 1
case "$protocol" in ''|*[!0-9]*) exit 1;; esac
info=$("$job/mihomoctl" version) || exit 1
printf '%s' "$info" | grep -Eq "\"protocol\"[[:space:]]*:[[:space:]]*$protocol([[:space:]]*[,}])" || { echo 'mihomoctl 协议已变化，请更新 UFI 插件'; exit 1; }
state running installing
"$job/mihomoctl" --platform ufi install --release-proxy "$forward" || exit 1
state succeeded "done"
