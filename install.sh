#!/bin/sh
# herdr-gentle-agents remote installer (Linux only, POSIX sh).
#
# Pinned public entrypoint (example):
#   curl -fsSL https://raw.githubusercontent.com/jonasotoaguilar/herdr-gentle-agents/v0.1.0/install.sh \
#     | sh -s -- --ref v0.1.0
#
# Trust/review: this script is intentionally small and reviewable. Fetch the
# pinned tag above (never `main`), read it before piping to a shell, and
# re-run the same pinned URL to update or with `--uninstall` to remove.
# It never uses sudo and never handles credentials.
#
# What it does (install/update):
#   1. Validates Linux, Node >= 18, herdr availability, and a safe ref.
#   2. Refuses remote replacement when the installed plugin source is local.
#   3. Installs + enables the Herdr plugin at the pinned ref.
#   4. Resolves the exact plugin_root from plugin-list JSON (fail closed).
#   5. Atomically copies extensions/gentle-herdr-state.ts into the Pi
#      agent dir and records a SHA-256 ownership record.
#   6. Backs up a conflicting/modified destination before replacing it.
#   7. Runs configure --apply/--check offline, best-effort server reload,
#      best-effort daemon ensure. Warns without rolling back on best-effort
#      failures.
#
# Environment overrides (for isolated tests / local use):
#   HERDR_BIN_PATH            herdr binary (default: herdr from PATH)
#   PI_AGENT_DIR              Pi agent dir (default: $HOME/.pi/agent)
#   XDG_STATE_HOME            state base (default: $HOME/.local/state)
#   HERDR_GENTLE_PLUGIN_ROOT  explicit plugin root (test/local override only;
#                             must be absolute; bypasses plugin-list lookup)
#
# Exit codes: 0 success; 1 operational failure; 2 usage/validation failure.

set -eu

DEFAULT_REF="v0.1.0"
REPO="jonasotoaguilar/herdr-gentle-agents"
PLUGIN_ID="herdr-gentle-agents"
EXT_REL="extensions/gentle-herdr-state.ts"
CONFIGURE_REL="bin/configure.js"
STATUS_REL="bin/gentle-status.js"

die() {
  printf 'install.sh: error: %s\n' "$1" >&2
  exit "${2:-1}"
}

warn() {
  printf 'install.sh: warning: %s\n' "$1" >&2
}

info() {
  printf 'install.sh: %s\n' "$1"
}

usage() {
  cat <<'EOF'
usage: install.sh [--ref REF] [--uninstall] [--help]

  (no flags)     install or update the Herdr plugin, the managed Pi
                 extension copy, and the managed sidebar configuration
  --ref REF      plugin release ref (default: v0.1.0; never main)
  --uninstall    remove the managed install (ownership-checked)
  --help         print this help and exit

examples:
  curl -fsSL https://raw.githubusercontent.com/jonasotoaguilar/herdr-gentle-agents/v0.1.0/install.sh | sh -s -- --ref v0.1.0
  curl -fsSL https://raw.githubusercontent.com/jonasotoaguilar/herdr-gentle-agents/v0.1.0/install.sh | sh -s -- --uninstall

environment:
  HERDR_BIN_PATH, PI_AGENT_DIR, XDG_STATE_HOME, HERDR_GENTLE_PLUGIN_ROOT (test/local override only)
EOF
}

# --- argument parsing (POSIX, shift-based) ---
MODE="install"
REF="$DEFAULT_REF"
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --uninstall)
      MODE="uninstall"
      shift
      ;;
    --ref=*)
      REF="${1#--ref=}"
      shift
      ;;
    --ref)
      [ $# -ge 2 ] || die "missing value for --ref (usage: --ref REF)" 2
      shift
      REF="$1"
      shift
      ;;
    --ref-*)
      die "unknown flag $1" 2
      ;;
    -*)
      die "unknown flag $1 (see --help)" 2
      ;;
    *)
      die "unexpected argument $1 (see --help)" 2
      ;;
  esac
done

# --- environment resolution ---
HERDR_BIN="${HERDR_BIN_PATH:-herdr}"
if [ -n "${PI_AGENT_DIR:-}" ]; then
  PI_DIR="$PI_AGENT_DIR"
else
  _HOME="${HOME:-}"
  [ -n "$_HOME" ] || die "HOME is unset and PI_AGENT_DIR is unset" 2
  PI_DIR="$_HOME/.pi/agent"
fi
if [ -n "${XDG_STATE_HOME:-}" ]; then
  STATE_BASE="$XDG_STATE_HOME"
else
  _HOME2="${HOME:-}"
  [ -n "$_HOME2" ] || die "HOME is unset and XDG_STATE_HOME is unset" 2
  STATE_BASE="$_HOME2/.local/state"
fi
STATE_DIR="$STATE_BASE/herdr/plugins/$PLUGIN_ID"
STATE_FILE="$STATE_DIR/installer-state"
DEST_DIR="$PI_DIR/extensions"
DEST="$DEST_DIR/gentle-herdr-state.ts"
OVERRIDE_ROOT="${HERDR_GENTLE_PLUGIN_ROOT:-}"

# --- validations shared by install and uninstall ---
_OS="$(uname -s 2>/dev/null || printf 'unknown')"
[ "$_OS" = "Linux" ] || die "Linux only (detected: $_OS)" 2

command -v node >/dev/null 2>&1 || die "node >= 18 is required (node not found in PATH)"
_NODE_MAJOR="$(node --version 2>/dev/null | sed -e 's/^v//' -e 's/\..*//')"
case "$_NODE_MAJOR" in
  ''|*[!0-9]*) die "cannot determine node version (node --version failed)" ;;
esac
[ "$_NODE_MAJOR" -ge 18 ] || die "node >= 18 is required (running $(node --version 2>/dev/null || printf 'unknown'))"

case "$HERDR_BIN" in
  */*)
    [ -x "$HERDR_BIN" ] || die "herdr binary not executable: $HERDR_BIN"
    ;;
  *)
    command -v "$HERDR_BIN" >/dev/null 2>&1 || die "herdr not found (HERDR_BIN_PATH=$HERDR_BIN)"
    ;;
esac

command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"
command -v date >/dev/null 2>&1 || die "date is required"

validate_ref() {
  _ref="$1"
  [ -n "$_ref" ] || die "ref must be nonempty (usage: --ref REF)" 2
  if [ "$_ref" = "main" ]; then
    die "ref 'main' is mutable and not allowed (use a pinned release ref such as v0.1.0)" 2
  fi
  case "$_ref" in
    -*) die "ref must not look like an option: $_ref" 2 ;;
  esac
  case "$_ref" in
    *[!A-Za-z0-9._/-]*)
      die "ref contains unsafe characters (allowed: A-Z a-z 0-9 . _ / -): $_ref" 2
      ;;
  esac
}

sha_of() {
  sha256sum -- "$1" 2>/dev/null | cut -d' ' -f1
}

# Emit the plugin list JSON (stdout) or fail. Never aborts the caller.
plugin_list_json() {
  "$HERDR_BIN" plugin list --plugin "$PLUGIN_ID" --json 2>/dev/null
}

# Exit 0 (silent) unless the installed plugin source.kind is local,
# in which case exit 10. Parse errors / absent plugin mean "not local".
is_local_source() {
  _json="$1"
  printf '%s' "$_json" | node -e '
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  try {
    const doc = JSON.parse(raw);
    const plugins = (doc && doc.result && doc.result.plugins) || doc.plugins || [];
    if (!Array.isArray(plugins)) process.exit(0);
    const hit = plugins.find((p) => p && (p.plugin_id === "herdr-gentle-agents" || p.id === "herdr-gentle-agents"));
    if (hit && hit.source && hit.source.kind === "local") process.exit(10);
    process.exit(0);
  } catch (e) {
    process.exit(0);
  }
});
' 2>/dev/null
  return $?
}

# Resolve the exact plugin_root: explicit test override bypasses lookup,
# otherwise parse `herdr plugin list --json` and fail closed on
# zero / multiple / non-absolute / malformed roots. Echoes the root.
resolve_plugin_root() {
  if [ -n "$OVERRIDE_ROOT" ]; then
    case "$OVERRIDE_ROOT" in
      /*) ;;
      *) die "HERDR_GENTLE_PLUGIN_ROOT must be absolute: $OVERRIDE_ROOT" 2 ;;
    esac
    warn "using HERDR_GENTLE_PLUGIN_ROOT test/local override: $OVERRIDE_ROOT"
    printf '%s' "$OVERRIDE_ROOT"
    return 0
  fi
  _list=""
  _list="$(plugin_list_json)" || die "failed to list Herdr plugins (herdr plugin list --json)"
  [ -n "$_list" ] || die "failed to list Herdr plugins (empty output)"
  _root="$(printf '%s' "$_list" | node -e '
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  try {
    const doc = JSON.parse(raw);
    const container = doc && doc.result && doc.result.plugins;
    if (!Array.isArray(container)) {
      console.error("install.sh: plugin list JSON has no result.plugins array");
      process.exit(1);
    }
    const hits = container.filter((p) => p && (p.plugin_id === "herdr-gentle-agents" || p.id === "herdr-gentle-agents"));
    const roots = hits.map((h) => h.plugin_root).filter((r) => typeof r === "string" && r.length > 0);
    if (roots.length === 0) {
      console.error("install.sh: no plugin_root found for herdr-gentle-agents (zero matches)");
      process.exit(1);
    }
    if (roots.length !== 1 || new Set(roots).size !== 1) {
      console.error("install.sh: ambiguous plugin_root for herdr-gentle-agents (multiple distinct roots)");
      process.exit(1);
    }
    const root = roots[0];
    if (root[0] !== "/") {
      console.error("install.sh: plugin_root is not absolute: " + root);
      process.exit(1);
    }
    process.stdout.write(root);
  } catch (e) {
    console.error("install.sh: malformed plugin list JSON: " + e.message);
    process.exit(1);
  }
});
')" || die "could not resolve plugin_root for $PLUGIN_ID from plugin list JSON"
  [ -n "$_root" ] || die "could not resolve plugin_root for $PLUGIN_ID (empty)"
  printf '%s' "$_root"
}

timestamp() {
  date +%Y%m%d%H%M%S
}

# Echo a non-existing timestamped backup path beside $1.
unique_backup() {
  _base="$1.bak.$(timestamp)"
  _cand="$_base"
  _n=1
  while [ -e "$_cand" ] || [ -L "$_cand" ]; do
    _n=$((_n + 1))
    _cand="${_base}.$_n"
  done
  printf '%s' "$_cand"
}

# --- install/update ---
do_install() {
  validate_ref "$REF"

  # 2. Refuse remote replacement of a locally linked plugin before touching anything.
  _pre=""
  if _pre="$(plugin_list_json)"; then
    if [ -n "$_pre" ]; then
      _local_rc=0
      is_local_source "$_pre" || _local_rc=$?
      if [ "$_local_rc" = "10" ]; then
        die "refusing remote install: plugin $PLUGIN_ID is locally linked (source.kind=local). Unlink it first or install locally; nothing was changed." 2
      fi
    fi
  fi

  # 3. Install + enable.
  "$HERDR_BIN" plugin install "$REPO" --ref "$REF" --yes \
    || die "herdr plugin install failed (ref=$REF)"
  "$HERDR_BIN" plugin enable "$PLUGIN_ID" \
    || die "herdr plugin enable failed"

  # 4. Resolve the exact plugin root.
  PLUGIN_ROOT="$(resolve_plugin_root)"

  SRC="$PLUGIN_ROOT/$EXT_REL"
  CONFIGURE="$PLUGIN_ROOT/$CONFIGURE_REL"
  STATUS_BIN="$PLUGIN_ROOT/$STATUS_REL"
  [ -f "$SRC" ] || die "plugin extension source missing: $SRC"

  # 5/6. Atomic copy with ownership record + conflict backup.
  SRC_SUM="$(sha_of "$SRC")"
  [ -n "$SRC_SUM" ] || die "could not checksum $SRC"
  mkdir -p "$DEST_DIR" "$STATE_DIR" || die "could not create $DEST_DIR / $STATE_DIR"

  PREV_RECORD=""
  if [ -f "$STATE_FILE" ]; then
    PREV_RECORD="$(cat "$STATE_FILE" 2>/dev/null | tr -d ' \t\r\n' || printf '')"
  fi

  if [ -L "$DEST" ] || [ -e "$DEST" ]; then
    if [ -L "$DEST" ]; then
      # A symlink is never the managed regular file: preserve it.
      BACKUP="$(unique_backup "$DEST")"
      info "destination is a symlink; moving it aside to $BACKUP"
      mv "$DEST" "$BACKUP" || die "could not back up $DEST"
    elif [ -d "$DEST" ]; then
      BACKUP="$(unique_backup "$DEST")"
      info "destination is a directory; moving it aside to $BACKUP"
      mv "$DEST" "$BACKUP" || die "could not back up $DEST"
    elif [ -f "$DEST" ]; then
      DEST_SUM="$(sha_of "$DEST")"
      _needs_backup=1
      if [ -n "$DEST_SUM" ] && [ "$DEST_SUM" = "$SRC_SUM" ]; then
        _needs_backup=0
      elif [ -n "$PREV_RECORD" ] && [ -n "$DEST_SUM" ] && [ "$DEST_SUM" = "$PREV_RECORD" ]; then
        _needs_backup=0
      fi
      if [ "$_needs_backup" = "1" ]; then
        BACKUP="$(unique_backup "$DEST")"
        info "backing up conflicting destination to $BACKUP"
        mv "$DEST" "$BACKUP" || die "could not back up $DEST"
      fi
    else
      BACKUP="$(unique_backup "$DEST")"
      info "destination is special; moving it aside to $BACKUP"
      mv "$DEST" "$BACKUP" || die "could not back up $DEST"
    fi
  fi

  TMP_DEST="$DEST_DIR/.gentle-herdr-state.ts.tmp.$$"
  rm -f "$TMP_DEST" 2>/dev/null || true
  cp "$SRC" "$TMP_DEST" || die "could not stage extension copy"
  mv "$TMP_DEST" "$DEST" || die "could not install $DEST"

  TMP_STATE="$STATE_DIR/.installer-state.tmp.$$"
  rm -f "$TMP_STATE" 2>/dev/null || true
  printf '%s\n' "$SRC_SUM" >"$TMP_STATE" || die "could not stage installer state"
  mv "$TMP_STATE" "$STATE_FILE" || die "could not record installer state"

  # 7. Offline configure + verify, then best-effort reload + daemon ensure.
  [ -f "$CONFIGURE" ] || die "plugin configure script missing: $CONFIGURE"
  node "$CONFIGURE" --apply || die "configure --apply failed"
  node "$CONFIGURE" --check || die "configure --check failed (applied but not current)"

  if "$HERDR_BIN" server reload-config >/dev/null 2>&1; then
    info "reloaded Herdr config"
  else
    warn "herdr server reload-config failed or no server running; continuing (config is applied on next start)"
  fi

  if [ -f "$STATUS_BIN" ]; then
    if node "$STATUS_BIN" >/dev/null 2>&1; then
      info "daemon ensured"
    else
      warn "daemon ensure via gentle-status.js failed; continuing (install and config are complete)"
    fi
  else
    warn "daemon script unavailable ($STATUS_BIN); continuing (install and config are complete)"
  fi

  # 8. Session reminder.
  info "done (ref=$REF). Running Pi sessions need /reload or a restart to pick up the updated extension."
}

# --- uninstall ---
do_uninstall() {
  # Resolve the installed root first; missing root skips configure/daemon/reload only.
  PLUGIN_ROOT=""
  if _r="$(resolve_plugin_root 2>/dev/null)"; then
    PLUGIN_ROOT="$_r"
  else
    warn "could not resolve installed plugin root; skipping configure/daemon/reload cleanup"
  fi

  if [ -n "$PLUGIN_ROOT" ]; then
    CONFIGURE="$PLUGIN_ROOT/$CONFIGURE_REL"
    STATUS_BIN="$PLUGIN_ROOT/$STATUS_REL"
    if [ -f "$CONFIGURE" ]; then
      node "$CONFIGURE" --uninstall || die "configure --uninstall failed"
    else
      warn "configure script unavailable ($CONFIGURE); skipping unconfigure"
    fi
    if [ -f "$STATUS_BIN" ]; then
      if node "$STATUS_BIN" --stop --purge >/dev/null 2>&1; then
        info "daemon stopped and purged"
      else
        warn "daemon --stop --purge failed; continuing"
      fi
    else
      warn "daemon script unavailable; skipping daemon stop"
    fi
    if "$HERDR_BIN" server reload-config >/dev/null 2>&1; then
      info "reloaded Herdr config"
    else
      warn "herdr server reload-config failed or no server running; continuing"
    fi
  fi

  # Ownership-checked extension removal, then state cleanup.
  if [ -L "$DEST" ]; then
    warn "preserving $DEST (symlink, not the managed copy)"
  elif [ ! -e "$DEST" ]; then
    info "managed extension already absent: $DEST"
  elif [ ! -f "$DEST" ]; then
    warn "preserving $DEST (not a regular file)"
  else
    if [ -f "$STATE_FILE" ]; then
      RECORD="$(cat "$STATE_FILE" 2>/dev/null | tr -d ' \t\r\n' || printf '')"
    else
      RECORD=""
    fi
    if [ -z "$RECORD" ]; then
      warn "preserving $DEST (no installer ownership record)"
    else
      CURRENT="$(sha_of "$DEST")"
      if [ -n "$CURRENT" ] && [ "$CURRENT" = "$RECORD" ]; then
        rm -f "$DEST" || die "could not remove $DEST"
        info "removed managed extension $DEST"
      else
        warn "preserving $DEST (modified since install; ownership checksum differs)"
      fi
    fi
  fi

  rm -f "$STATE_FILE" 2>/dev/null || true
  rmdir "$STATE_DIR" 2>/dev/null || true
  rmdir "$STATE_BASE/herdr/plugins" 2>/dev/null || true
  rmdir "$STATE_BASE/herdr" 2>/dev/null || true

  # Plugin uninstall: tolerate already-absent only when classifiable.
  _uout=""
  _urc=0
  _uout="$("$HERDR_BIN" plugin uninstall "$PLUGIN_ID" 2>&1)" || _urc=$?
  if [ "$_urc" = "0" ]; then
    info "uninstalled Herdr plugin $PLUGIN_ID"
  else
    _ulower="$(printf '%s' "$_uout" | tr '[:upper:]' '[:lower:]')"
    case "$_ulower" in
      *'not installed'*|*'not found'*|*'no such'*|*'unknown plugin'*|*'absent'*|*'does not exist'*)
        warn "plugin $PLUGIN_ID already absent; continuing"
        ;;
      *)
        printf '%s\n' "$_uout" >&2
        die "herdr plugin uninstall failed (exit $_urc)"
        ;;
    esac
  fi

  info "done. Running Pi sessions need /reload or a restart."
}

if [ "$MODE" = "uninstall" ]; then
  do_uninstall
else
  do_install
fi
