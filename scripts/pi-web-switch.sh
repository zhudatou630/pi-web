#!/usr/bin/env bash
# Switch this machine's pi-web on port 30141 between:
#   git  — this checkout, via systemd (daily driver)
#   npm  — global @agegr/pi-web (temporary rollback; reboot returns to git)
#
# Usage:
#   pi-web-switch status
#   pi-web-switch git          # rebuild if sources newer, then restart systemd
#   pi-web-switch git --rebuild
#   pi-web-switch npm          # stop systemd, run global package until reboot
#   pi-web-switch stop
#
# Tailscale: https://…:10443 → http://127.0.0.1:30141
# Only manages the current user's listener on PORT (default 30141).

set -euo pipefail

PORT="${PI_WEB_PORT:-30141}"
HOST="${PI_WEB_HOST:-127.0.0.1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/pi-web-switch"
PID_FILE="$STATE_DIR/git.pid"
NPM_PID_FILE="$STATE_DIR/npm.pid"
LOG_FILE="$STATE_DIR/git.log"
NPM_LOG_FILE="$STATE_DIR/npm.log"
MODE_FILE="$STATE_DIR/mode"
SELF_PID=$$

mkdir -p "$STATE_DIR"

SYSTEMD_UNIT="${PI_WEB_SYSTEMD_UNIT:-pi-web-agegr.service}"

# Match the systemd unit env (used by npm rollback nohup and local builds).
export PI_WEB_NO_OPEN=1
export PI_WEB_ALLOWED_HOSTS="${PI_WEB_ALLOWED_HOSTS:-nuc.tailb8ef79.ts.net,pi.nuc.calmabacus.cn}"
export NEXT_TELEMETRY_DISABLED=1
export NODE_OPTIONS="${NODE_OPTIONS:---import=/home/zhujunshen/.config/pi-web/proxy-bootstrap.mjs}"

unit_exists() {
  systemctl --user cat "$SYSTEMD_UNIT" >/dev/null 2>&1
}

stop_git_unit() {
  if unit_exists && systemctl --user is-active --quiet "$SYSTEMD_UNIT"; then
    echo "Stopping systemd unit $SYSTEMD_UNIT"
    systemctl --user stop "$SYSTEMD_UNIT" || true
  fi
}

start_git_unit() {
  if ! unit_exists; then
    echo "systemd unit $SYSTEMD_UNIT not found; cannot start git via systemd."
    exit 1
  fi
  echo "Starting systemd unit $SYSTEMD_UNIT ..."
  systemctl --user start "$SYSTEMD_UNIT"
}

is_listening() {
  ss -ltn 2>/dev/null | grep -qE ":${PORT}[[:space:]]" || return 1
}

listener_info() {
  ss -ltnp 2>/dev/null | grep -E ":${PORT}[[:space:]]" || true
}

pids_bound_to_port() {
  local line pid
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    pid="$(sed -n 's/.*pid=\([0-9]\+\).*/\1/p' <<<"$line" | head -1)"
    [[ -z "$pid" ]] && continue
    [[ -d "/proc/$pid" ]] || continue
    [[ "$(stat -c %u "/proc/$pid" 2>/dev/null || true)" == "$(id -u)" ]] || continue
    echo "$pid"
  done < <(ss -ltnp 2>/dev/null | grep -E ":${PORT}[[:space:]]" || true)
}

related_wrapper_pids() {
  local bound="$1"
  local pid ppid cmd
  for pid in $bound; do
    ppid="$(awk '/^PPid:/{print $2}' "/proc/$pid/status" 2>/dev/null || true)"
    while [[ -n "${ppid:-}" && "$ppid" != 0 && "$ppid" != 1 ]]; do
      [[ "$ppid" == "$SELF_PID" ]] && break
      [[ -d "/proc/$ppid" ]] || break
      [[ "$(stat -c %u "/proc/$ppid" 2>/dev/null || true)" == "$(id -u)" ]] || break
      cmd="$(tr '\0' ' ' <"/proc/$ppid/cmdline" 2>/dev/null || true)"
      if [[ "$cmd" == *"/bin/pi-web.js"* ]] \
        || [[ "$cmd" == *"next dev"* ]] \
        || [[ "$cmd" == *"next start"* ]] \
        || [[ "$cmd" == *"next-server"* ]] \
        || [[ "$cmd" == *"next/dist/bin/next"* ]] \
        || [[ "$cmd" == *"npm run dev"* ]] \
        || [[ "$cmd" == *"npm run start"* ]]; then
        echo "$ppid"
        ppid="$(awk '/^PPid:/{print $2}' "/proc/$ppid/status" 2>/dev/null || true)"
        continue
      fi
      break
    done
  done
}

collect_stop_pids() {
  local bound wrappers
  bound="$(pids_bound_to_port | sort -u | tr '\n' ' ')"
  wrappers=""
  if [[ -n "${bound// }" ]]; then
    wrappers="$(related_wrapper_pids "$bound" | sort -u | tr '\n' ' ')"
  fi
  {
    # shellcheck disable=SC2086
    printf '%s\n' $bound $wrappers
    [[ -f "$PID_FILE" ]] && cat "$PID_FILE"
    [[ -f "$NPM_PID_FILE" ]] && cat "$NPM_PID_FILE"
  } | awk 'NF && $1 ~ /^[0-9]+$/ {print $1}' | sort -u
}

stop_port() {
  local pids pid alive
  mapfile -t pids < <(collect_stop_pids)
  if [[ ${#pids[@]} -eq 0 ]]; then
    echo "No owned listener on :$PORT to stop."
    rm -f "$PID_FILE" "$NPM_PID_FILE"
    return 0
  fi

  echo "Stopping PIDs: ${pids[*]}"
  for pid in "${pids[@]}"; do
    [[ "$pid" == "$SELF_PID" ]] && continue
    kill "$pid" 2>/dev/null || true
  done
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    alive=0
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then alive=1; break; fi
    done
    if [[ $alive -eq 0 ]]; then break; fi
    sleep 0.3
  done
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "Force kill $pid"
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  rm -f "$PID_FILE" "$NPM_PID_FILE"
  sleep 0.2
}

wait_for_listen() {
  local label="$1"
  local log="$2"
  local i
  for i in $(seq 1 80); do
    if is_listening; then
      echo "OK — $label at http://$HOST:$PORT"
      echo "    remote: https://nuc.tailb8ef79.ts.net:10443/  (tailscale → :$PORT)"
      return 0
    fi
    sleep 0.25
  done
  echo "Started but :$PORT not open yet; check $log"
  if [[ -f "$log" ]]; then
    tail -n 50 "$log" || true
  elif unit_exists; then
    journalctl --user -u "$SYSTEMD_UNIT" -n 50 --no-pager || true
  fi
  return 1
}

needs_rebuild() {
  local stamp="$ROOT/.next/BUILD_ID"
  [[ -f "$stamp" ]] || return 0
  local newer
  newer="$(find "$ROOT/app" "$ROOT/components" "$ROOT/hooks" "$ROOT/lib" \
    "$ROOT/package.json" "$ROOT/next.config.ts" \
    -type f -newer "$stamp" 2>/dev/null | head -1 || true)"
  [[ -n "$newer" ]]
}

build_git() {
  cd "$ROOT"
  if [[ ! -d node_modules ]]; then
    echo "node_modules missing; run npm install in $ROOT first."
    exit 1
  fi
  echo "Building git checkout (next build) ..."
  rm -rf "$ROOT/.next/dev"
  npm run build
}

start_git() {
  local force_rebuild=0
  if [[ "${1:-}" == "--rebuild" || "${1:-}" == "-f" ]]; then
    force_rebuild=1
  fi

  cd "$ROOT"
  if [[ $force_rebuild -eq 1 ]] || needs_rebuild; then
    # Stop first so Restart=on-failure cannot respawn the old build mid-compile.
    stop_git_unit
    stop_port
    if is_listening; then
      echo "Port $PORT still in use after stop:"
      listener_info
      exit 1
    fi
    build_git
  else
    echo "Reusing existing .next build (pass --rebuild to force)."
    if [[ -f "$NPM_PID_FILE" ]]; then
      stop_port
    fi
  fi

  if [[ ! -f "$ROOT/.next/BUILD_ID" ]]; then
    echo "No build found; building..."
    stop_git_unit
    stop_port
    build_git
  fi

  echo "git" >"$MODE_FILE"
  start_git_unit
  wait_for_listen "git pi-web (systemd)" "/dev/null"
  echo "mode: git  (systemd: $SYSTEMD_UNIT, repo: $ROOT)"
}

start_npm() {
  stop_git_unit
  stop_port
  if is_listening; then
    echo "Port $PORT still in use after stop:"
    listener_info
    exit 1
  fi
  local bin
  bin="$(command -v pi-web || true)"
  if [[ -z "$bin" ]]; then
    echo "pi-web not found on PATH (global @agegr/pi-web)."
    exit 1
  fi
  echo "Starting npm pi-web ($bin) on $HOST:$PORT ..."
  echo "Temporary rollback — reboot or 'pi-web-switch git' returns to the git unit."
  echo "log: $NPM_LOG_FILE"
  nohup "$bin" --port "$PORT" --hostname "$HOST" --no-open >"$NPM_LOG_FILE" 2>&1 &
  echo $! >"$NPM_PID_FILE"
  echo "npm" >"$MODE_FILE"
  wait_for_listen "npm pi-web" "$NPM_LOG_FILE"
  echo "mode: npm  ($bin)"
}

show_status() {
  local mode="unknown"
  [[ -f "$MODE_FILE" ]] && mode="$(cat "$MODE_FILE")"
  echo "requested mode: $mode"
  echo "port: $PORT"
  echo "tailscale: https://nuc.tailb8ef79.ts.net:10443/ → http://127.0.0.1:$PORT"
  if unit_exists; then
    echo "systemd $SYSTEMD_UNIT: $(systemctl --user is-active "$SYSTEMD_UNIT" 2>/dev/null || true) / $(systemctl --user is-enabled "$SYSTEMD_UNIT" 2>/dev/null || true)"
  else
    echo "systemd $SYSTEMD_UNIT: (missing)"
  fi
  if is_listening; then
    echo "listening:"
    listener_info
  else
    echo "listening: (none on :$PORT)  ← remote URL will fail until something is up"
  fi
  if [[ -f "$PID_FILE" ]]; then
    echo "git pid file: $(cat "$PID_FILE") (alive=$(kill -0 "$(cat "$PID_FILE")" 2>/dev/null && echo yes || echo no))"
  fi
  if [[ -f "$NPM_PID_FILE" ]]; then
    echo "npm pid file: $(cat "$NPM_PID_FILE") (alive=$(kill -0 "$(cat "$NPM_PID_FILE")" 2>/dev/null && echo yes || echo no))"
  fi
}

cmd="${1:-status}"
shift || true
case "$cmd" in
  status|st) show_status ;;
  git|local|prod) start_git "${1:-}" ;;
  npm|official) start_npm ;;
  stop)
    stop_git_unit
    stop_port
    echo "none" >"$MODE_FILE"
    show_status
    ;;
  *)
    echo "Usage: $0 {status|git [--rebuild]|npm|stop}"
    exit 2
    ;;
esac
