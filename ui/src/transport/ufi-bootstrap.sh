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
  can=false
  case "$1:$2" in queued:preparing|running:download|running:verify) can=true;; esac
  requested=false
  [ ! -f "$job/cancel" ] || requested=true
  printf '{"id":"%s","action":"bootstrap","state":"%s","phase":"%s","updated":"%s","hash":"","result":"","error":"","downloaded":%s,"total":%s,"speed":%s,"cancellable":%s,"cancelRequested":%s,"started":"%s"}\n' "$id" "$1" "$2" "${3:-$(date -u '+%Y-%m-%dT%H:%M:%SZ')}" "${downloaded:-0}" "${total:-0}" "${speed:-0}" "$can" "$requested" "$(cat "$job/started" 2>/dev/null || date -u '+%Y-%m-%dT%H:%M:%SZ')"
}
control() {
  tries=0
  while ! mkdir "$job/control" 2>/dev/null; do
    tries=$((tries + 1))
    [ "$tries" -lt 10 ] || { echo '安装任务控制繁忙'; exit 1; }
    sleep 1
  done
}
if [ "$mode" = cancel ]; then
  control
  if grep -q '"cancellable":true' "$job/state.json"; then
    touch "$job/cancel"
    rmdir "$job/control"
    exec sh "$0" status "$id"
  fi
  if grep -Eq '"state":"(succeeded|failed|cancelled|interrupted)"' "$job/state.json"; then
    rmdir "$job/control"
    exec sh "$0" status "$id"
  fi
  rmdir "$job/control"
  echo '任务已进入不可取消阶段，请等待完成'
  exit 1
fi
state() {
  if [ "$mode" = worker ] && [ "${logged_phase:-}" != "$2" ]; then
    printf '%s INFO phase=%s task=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$2" "$id"
    logged_phase=$2
  fi
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
    if [ -f "$job/cancel" ]; then
      printf '%s\n' "$current" | sed 's/"cancelRequested":false/"cancelRequested":true/'
    else printf '%s\n' "$current"; fi
  fi
  exit 0
fi
if [ "$mode" = submit ]; then
  date -u '+%Y-%m-%dT%H:%M:%SZ' > "$job/started"
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
[ -f "$job/started" ] || date -u '+%Y-%m-%dT%H:%M:%SZ' > "$job/started"
cleanup() {
  code=$?
  if [ "$code" != 0 ]; then
    printf '%s ERROR task=%s phase=%s exit=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$id" "${logged_phase:-preparing}" "$code"
    state failed failed
  fi
  rm -f "$job/mihomoctl" "$job/ca.pem"
}
trap cleanup EXIT
trap '' HUP
protocol=$7
forward=$8
case "$(getprop ro.product.cpu.abi)" in
  arm64-v8a) address=$3; digest=$4; total=$9;;
  armeabi-v7a|armeabi) address=$5; digest=$6; total=${10};;
  *) echo '不支持的设备架构'; exit 1;;
esac
case "$total" in ''|*[!0-9]*) exit 1;; esac
[ "$total" -gt 0 ] && [ "$total" -le 33554432 ] || exit 1
downloaded=0
speed=0
state running download
[ -x "$CURL" ] || { echo 'UFI 缺少 curl，请更新 UFI'; exit 1; }
# The app's curl may not know Android's CA location. Never disable TLS verification.
for cert in /system/etc/security/cacerts/* /apex/com.android.conscrypt/cacerts/*; do
  if [ -f "$cert" ]; then cat "$cert"; printf '\n'; fi
done > "$job/ca.pem"
set --
[ -n "$forward" ] || set -- -L
[ ! -s "$job/ca.pem" ] || set -- "$@" --cacert "$job/ca.pem"
[ ! -f "$job/cancel" ] || { state cancelled cancelled; exit 0; }
"$CURL" -q -fsS "$@" --speed-limit 1 --speed-time 45 --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 300 --max-filesize 33554432 "$address" -o "$job/mihomoctl" &
curl_pid=$!
last=$(date +%s)
while kill -0 "$curl_pid" 2>/dev/null; do
  if [ -f "$job/cancel" ]; then
    kill "$curl_pid" 2>/dev/null || :
    wait "$curl_pid" 2>/dev/null || :
    state cancelled cancelled
    exit 0
  fi
  size=0
  [ ! -f "$job/mihomoctl" ] || size=$(wc -c < "$job/mihomoctl")
  now=$(date +%s)
  elapsed=$((now - last))
  if [ "$size" -gt "$downloaded" ] && [ "$elapsed" -gt 0 ]; then
    speed=$(((size - downloaded) / elapsed))
    downloaded=$size
    last=$now
    state running download
  fi
  sleep 1
done
wait "$curl_pid" || exit 1
downloaded=$(wc -c < "$job/mihomoctl")
speed=0
state running verify
actual=$(sha256sum "$job/mihomoctl") || exit 1
[ "${actual%% *}" = "$digest" ] || { echo 'mihomoctl 文件校验失败'; exit 1; }
chmod 700 "$job/mihomoctl" || exit 1
case "$protocol" in ''|*[!0-9]*) exit 1;; esac
info=$("$job/mihomoctl" version) || exit 1
printf '%s' "$info" | grep -Eq "\"protocol\"[[:space:]]*:[[:space:]]*$protocol([[:space:]]*[,}])" || { echo 'mihomoctl 协议已变化，请更新 UFI 插件'; exit 1; }
control
if [ -f "$job/cancel" ]; then
  state cancelled cancelled
  rmdir "$job/control"
  exit 0
fi
state running installing
rmdir "$job/control"
"$job/mihomoctl" --platform ufi install --release-proxy "$forward" || exit 1
state succeeded "done"
