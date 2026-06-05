# Plannen bootstrap helpers — sourced by scripts/bootstrap.sh and
# scripts/functions-start.sh. Bash 3.2 compatible (macOS default).

# ── Output ─────────────────────────────────────────────────────────────────────

if [ -t 1 ]; then
  C_RESET=$'\033[0m'
  C_DIM=$'\033[2m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
  C_CYAN=$'\033[36m'
else
  C_RESET=""; C_DIM=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""
fi

step() { printf "\n${C_CYAN}==> %s${C_RESET}\n" "$*"; }
ok()   { printf "  ${C_GREEN}✓${C_RESET} %s\n" "$*"; }
warn() { printf "  ${C_YELLOW}⚠${C_RESET} %s\n" "$*" >&2; }
err()  { printf "  ${C_RED}✗${C_RESET} %s\n" "$*" >&2; }
dim()  { printf "  ${C_DIM}%s${C_RESET}\n" "$*"; }

# ── Prereq checks ──────────────────────────────────────────────────────────────

# Verify a command exists. Usage: require_cmd <cmd> "<install hint>".
# On failure, prints the hint and returns 1.
require_cmd() {
  local cmd=$1
  local hint=$2
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "$cmd not found"
    dim "$hint"
    return 1
  fi
  return 0
}

# Verify docker daemon is reachable (any runtime — Docker Desktop, Colima,
# OrbStack, podman with docker compat, etc.). Returns 1 with hints on failure.
require_docker_running() {
  if ! command -v docker >/dev/null 2>&1; then
    err "docker CLI not found"
    dim "macOS:    brew install --cask docker      (Docker Desktop)"
    dim "          brew install colima docker      (Colima — open-source)"
    dim "          brew install --cask orbstack    (OrbStack)"
    dim "Linux:    install Docker Engine, or podman with docker-compat"
    dim "WSL2:     same as Linux above"
    return 1
  fi
  if ! docker info >/dev/null 2>&1; then
    err "docker daemon is not reachable"
    dim "Start your container runtime:"
    dim "  Docker Desktop / OrbStack / Rancher Desktop:  open the app"
    dim "  Colima:                                       colima start"
    dim "  podman:                                       podman machine start"
    return 1
  fi
  return 0
}

# Compare semver-ish "a.b.c" >= "x.y.z". Usage: version_ge "1.2.3" "1.0.0".
# Bash 3.2 compatible — no arrays.
version_ge() {
  local have=$1
  local need=$2
  # Strip non-digit prefix/suffix, take only first three components
  have=$(printf "%s" "$have" | sed -E 's/[^0-9.]//g' | awk -F. '{ printf "%s.%s.%s", ($1?$1:0), ($2?$2:0), ($3?$3:0) }')
  need=$(printf "%s" "$need" | sed -E 's/[^0-9.]//g' | awk -F. '{ printf "%s.%s.%s", ($1?$1:0), ($2?$2:0), ($3?$3:0) }')
  local h1 h2 h3 n1 n2 n3
  h1=$(printf "%s" "$have" | cut -d. -f1)
  h2=$(printf "%s" "$have" | cut -d. -f2)
  h3=$(printf "%s" "$have" | cut -d. -f3)
  n1=$(printf "%s" "$need" | cut -d. -f1)
  n2=$(printf "%s" "$need" | cut -d. -f2)
  n3=$(printf "%s" "$need" | cut -d. -f3)
  if [ "$h1" -ne "$n1" ]; then [ "$h1" -gt "$n1" ]; return; fi
  if [ "$h2" -ne "$n2" ]; then [ "$h2" -gt "$n2" ]; return; fi
  [ "$h3" -ge "$n3" ]
}

# Check `cmd --version` (or other) emits a version >= min. Usage:
#   require_version <cmd> <min> <"version-extract-cmd"> <"install hint">
# version-extract-cmd is a command that prints the version. Defaults to
# `<cmd> --version`. We grep the first x.y.z out of its output.
require_version() {
  local cmd=$1
  local min=$2
  local extract=${3:-"$cmd --version"}
  local hint=$4
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "$cmd not found"
    dim "$hint"
    return 1
  fi
  local raw v
  raw=$(eval "$extract" 2>&1 | head -3)
  v=$(printf "%s" "$raw" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1)
  if [ -z "$v" ]; then
    warn "$cmd: couldn't parse version from: $raw"
    return 0
  fi
  if version_ge "$v" "$min"; then
    return 0
  fi
  err "$cmd $v is too old; need >= $min"
  dim "$hint"
  return 1
}

# ── Email ──────────────────────────────────────────────────────────────────────

# Lowercase a string. Bash 3.2 compatible (no ${var,,}).
lower() { printf "%s" "$1" | tr '[:upper:]' '[:lower:]'; }

# Confirm an email with the user. If $1 is non-empty, offer it as default.
# Returns the chosen email on stdout. Loops until one is chosen.
confirm_email() {
  local default=$1
  local answer email
  while :; do
    if [ -n "$default" ]; then
      printf "  Use ${C_CYAN}%s${C_RESET} as your Plannen user? [Y/n/edit]: " "$default" >&2
      read -r answer
      case "$(lower "$answer")" in
        ""|y|yes) email=$default; break ;;
        n|no)
          err "Cancelled by user"
          return 1
          ;;
        e|edit|*)
          printf "  Enter the email to use: " >&2
          read -r answer
          [ -n "$answer" ] && default=$answer
          ;;
      esac
    else
      printf "  Enter the email to use as your Plannen user: " >&2
      read -r answer
      [ -n "$answer" ] && default=$answer
    fi
  done
  printf "%s\n" "$email"
}

# ── .env merging ───────────────────────────────────────────────────────────────

# Read a key's value out of a dotenv file. Usage: env_get <file> <key>.
# Strips surrounding quotes. Empty if not found.
env_get() {
  local file=$1
  local key=$2
  [ -f "$file" ] || return 0
  # Match "KEY=value", strip leading/trailing whitespace and surrounding quotes
  awk -v k="$key" -F= '
    /^[[:space:]]*#/ { next }
    $1 == k {
      sub(/^[^=]+=/, "")
      gsub(/^[[:space:]]+|[[:space:]]+$/, "")
      gsub(/^"|"$/, "")
      gsub(/^'\''|'\''$/, "")
      print
      exit
    }
  ' "$file"
}

# Set a key in a dotenv file (in-place). Creates the file if missing.
# Replaces existing line, otherwise appends.
env_set() {
  local file=$1
  local key=$2
  local value=$3
  [ -f "$file" ] || : > "$file"
  if grep -qE "^${key}=" "$file"; then
    # Replace existing — use a tmpfile to keep it portable across BSD/GNU sed
    local tmp
    tmp=$(mktemp 2>/dev/null || mktemp -t plannen)
    awk -v k="$key" -v v="$value" -F= '
      $1 == k { print k "=" v; next }
      { print }
    ' "$file" > "$tmp"
    mv "$tmp" "$file"
  else
    printf "%s=%s\n" "$key" "$value" >> "$file"
  fi
}

# Merge missing keys from <template> into <target>. Existing keys in <target>
# are preserved verbatim. New keys from <template> are appended with their
# template values. Comments and blank lines from <template> are appended only
# if <target> doesn't exist (fresh render).
merge_env() {
  local template=$1
  local target=$2
  if [ ! -f "$target" ]; then
    cp "$template" "$target"
    return 0
  fi
  # For each KEY=value line in template, if target lacks the key, append.
  awk -F= '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    NF >= 2 { print $1 }
  ' "$template" | while read -r key; do
    if ! grep -qE "^${key}=" "$target"; then
      local default_val
      default_val=$(env_get "$template" "$key")
      printf "%s=%s\n" "$key" "$default_val" >> "$target"
    fi
  done
}

# ── PID files ──────────────────────────────────────────────────────────────────

# Returns 0 if the pidfile holds a live PID, 1 otherwise.
pid_alive() {
  local pidfile=$1
  [ -f "$pidfile" ] || return 1
  local pid
  pid=$(cat "$pidfile" 2>/dev/null)
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}
