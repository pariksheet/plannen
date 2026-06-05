#!/usr/bin/env bash
# Wraps `claude -p "/plannen-mailbox-sync"` with:
#   - atomic mkdir-based concurrency lock (portable: no flock dependency, macOS-friendly)
#   - 7-day log rotation
#   - macOS notification on failure (non-zero exit or `"ok": false` in output)
#
# Designed to be invoked by launchd; safe to run manually.

set -uo pipefail

# Repo root = scripts/mailbox/sync-wrapper.sh → ../../ . `claude -p` only loads
# the plannen plugin's slash command when run from inside the project.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

LOCK_DIR="/tmp/plannen-mailbox-sync.lock.d"
LOG_DIR="$HOME/.plannen/logs"
LOG="$LOG_DIR/mailbox-sync.log"
ERR="$LOG_DIR/mailbox-sync.err"

# Hard wall-clock cap on a single run. A healthy sync finishes in ~1-3 min; the
# 2026-06-02 run blocked for ~8h, which (with the lock below) silently wedged
# every later run. Past this cap the run is killed and reported. Override via
# PLANNEN_MAILBOX_TIMEOUT_SECS. A timeout surfaces as exit code 124.
RUN_TIMEOUT_SECS="${PLANNEN_MAILBOX_TIMEOUT_SECS:-600}"

mkdir -p "$LOG_DIR"

# 7-day rotation: delete anything older than 7 days in the log dir.
find "$LOG_DIR" -type f -name 'mailbox-sync.*' -mtime +7 -delete 2>/dev/null || true

notify_failure() {
  local message="$1"
  /usr/bin/osascript -e "display notification \"$message\" with title \"Plannen mailbox sync\"" >/dev/null 2>&1 || true
}

# Run a command with a wall-clock cap, portably. Prefers GNU `timeout`/`gtimeout`
# when present; otherwise falls back to a background watchdog (this Mac ships
# neither). Exit code 124 signals a timeout, matching GNU `timeout`'s convention.
run_with_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout -k 10 "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout -k 10 "$secs" "$@"
  else
    "$@" &
    local cmd_pid=$!
    # Watchdog: poll the command once a second; once the cap elapses, TERM it,
    # then KILL after a 10s grace. Polling lets the watchdog notice a normal
    # finish and exit on its own within ~1s, so cancelling it never orphans a
    # long grace-period sleep. fds → /dev/null so a command substitution that
    # captures the caller's stdout doesn't block on this subshell's pipe end.
    ( waited=0
      while kill -0 "$cmd_pid" 2>/dev/null; do
        sleep 1
        waited=$((waited + 1))
        if [[ "$waited" -ge "$secs" ]]; then
          kill -TERM "$cmd_pid" 2>/dev/null
          sleep 10
          kill -0 "$cmd_pid" 2>/dev/null && kill -KILL "$cmd_pid" 2>/dev/null
          break
        fi
      done
    ) >/dev/null 2>&1 &
    local dog=$!
    wait "$cmd_pid"; local rc=$?
    # Command done (finished or killed) — stop the watchdog and reap its current
    # 1s sleep child so nothing lingers.
    kill "$dog" 2>/dev/null || true
    pkill -P "$dog" 2>/dev/null || true
    wait "$dog" 2>/dev/null || true
    # 143 = 128+SIGTERM, 137 = 128+SIGKILL → normalise a watchdog kill to 124.
    if [[ "$rc" -eq 143 || "$rc" -eq 137 ]]; then rc=124; fi
    return "$rc"
  fi
}

# Atomic lock via mkdir + a PID file for staleness detection. mkdir on an
# existing dir returns non-zero, so only the first concurrent invocation wins.
# If a previous run was hard-killed (an 8-hour hang that launchd, a reboot, or
# `kickstart -k` terminated), its lock dir can survive. Without staleness
# detection that orphaned lock silently blocks every later run until the 7-day
# find sweep above — up to a week of no syncing, no error surfaced. So on a
# mkdir failure we inspect the recorded holder PID: alive → genuine concurrent
# run, exit; dead or unrecorded → stale, reclaim and proceed.
acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "$LOCK_DIR/pid"
    return 0
  fi
  local holder
  holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ -n "$holder" ]] && kill -0 "$holder" 2>/dev/null; then
    return 1  # holder alive — genuine concurrent run
  fi
  echo "=== $(date -Iseconds) reclaiming stale lock (holder=${holder:-unknown}) ===" >> "$LOG"
  rm -rf "$LOCK_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "$LOCK_DIR/pid"
    return 0
  fi
  return 1  # lost a reclaim race with a concurrent run
}

if ! acquire_lock; then
  # Previous run still alive — exit silently.
  exit 0
fi
trap 'rm -rf "$LOCK_DIR" 2>/dev/null || true' EXIT

echo "=== $(date -Iseconds) start ===" >> "$LOG"

# Run the routine. Capture both streams.
# - Model: Sonnet 4.6 (escalated from Haiku 4.5 on 2026-05-27 after the rework).
#   The new skill prompt got long (Step A rule kinds, Step B exclusions,
#   Step D.2 semantic dedupe, Step E provenance recording, tightened
#   final-report shape). Haiku was doing the work but skipping the formatting
#   requirements — no #mbsync hashtag, no Gmail-ID prefix, no add_event_provenance
#   call. Sonnet follows the structured prompt faithfully. ~5× the per-token
#   cost, but 6 runs/day means the absolute cost is still tiny.
# - Slash command needs the plugin namespace prefix; the bare /plannen-mailbox-sync
#   form only works in interactive shells.
# - bypassPermissions: this is an unattended, fully-scripted routine on the user's
#   own machine using MCPs they already trust (Gmail/GCal/Plannen). Without it,
#   the per-tool consent prompt blocks every MCP call and the run aborts with
#   "permissions not granted".
# One-time warning if the loaded plist still has the old hourly 06–23 schedule.
# A stale plist means the user updated the code but didn't re-run
# `npx plannen mailbox install` — they're getting the old cadence.
PLIST_INFO="$(launchctl print "gui/$(id -u)/work.plannen.mailbox-sync" 2>/dev/null || true)"
if [[ -n "$PLIST_INFO" ]] && echo "$PLIST_INFO" | grep -qE 'Hour = (7|11|15|19);'; then
  echo "[warn] $(date -Iseconds) Old launchd schedule detected (hourly 06–23). Run 'npx plannen mailbox install' to switch to the new every-4h cadence." >&2
fi

OUTPUT="$(run_with_timeout "$RUN_TIMEOUT_SECS" claude -p \
  --model claude-sonnet-4-6 \
  --permission-mode bypassPermissions \
  "/plannen:plannen-mailbox-sync" \
  2>>"$ERR")"
EXIT=$?
# Built-in tools (Bash, Read, Write, …) are left enabled. The skill prompt's
# "Do NOT" section explicitly forbids invoking them; the mkdir lock + 1-hour
# launchd ThrottleInterval prevent any accidental recursion from doing harm.
# Tried `--tools ""` but its variadic parser ate the slash command as a value.

echo "$OUTPUT" >> "$LOG"
echo "=== $(date -Iseconds) end exit=$EXIT ===" >> "$LOG"

# Parse the last JSON line for ok=false.
LAST_JSON="$(echo "$OUTPUT" | grep -oE '\{"ok":\s*(true|false).*\}' | tail -1)"

if [[ "$EXIT" -eq 124 ]]; then
  echo "[error] $(date -Iseconds) run exceeded ${RUN_TIMEOUT_SECS}s and was killed" >> "$LOG"
  notify_failure "Mailbox sync timed out after ${RUN_TIMEOUT_SECS}s and was killed"
elif [[ "$EXIT" -ne 0 ]]; then
  notify_failure "Routine exited $EXIT — see ~/.plannen/logs/mailbox-sync.err"
elif [[ -n "$LAST_JSON" && "$LAST_JSON" =~ \"ok\"[[:space:]]*:[[:space:]]*false ]]; then
  # Pull errors array as best-effort.
  ERR_SUMMARY="$(echo "$LAST_JSON" | sed -E 's/.*"errors":\[([^]]*)\].*/\1/' | tr -d '\\"')"
  notify_failure "Run reported failure: ${ERR_SUMMARY:-see logs}"
fi
