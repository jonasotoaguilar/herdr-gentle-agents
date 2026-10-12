#!/bin/sh
# herdr-gentle-agents remote installer (Linux only, POSIX sh).
#
# Stable public entrypoint (example):
#   curl -fsSL https://github.com/jonasotoaguilar/herdr-gentle-agents/releases/latest/download/install.sh | sh
#
# Trust/review: this script is intentionally small and reviewable. Fetch the
# stable URL above (never `main`), read it before piping to a shell, and
# re-run the same stable URL to update or with `--uninstall` to remove.
# It never uses sudo and never handles credentials.
#
# What it does (install/update):
#   1. Validates Linux, Node >= 18, herdr availability, and a safe ref
#      (resolves the newest release tag when --ref is omitted).
#   2. Compares the installed plugin version with the target: already
#      current exits 0 without touching anything; a newer installed
#      version aborts unless --allow-downgrade is given.
#   3. Replaces a locally linked plugin automatically (unlink + warning).
#   4. Installs + enables the Herdr plugin at the target ref.
#   4. Resolves the exact plugin_root from plugin-list JSON (fail closed).
#   5. Records a non-destructive exclusion of the managed native base
#      extension in the Pi global settings (idempotent, preserves unrelated
#      settings and pre-existing user exclusions; invalid settings fail
#      closed; the base file bytes are never touched). A later ordinary
#      failure rolls the exclusion back (best-effort) so the base is not
#      left disabled with no replacement.
#   6. Atomically copies extensions/gentle-herdr-state.ts into the Pi
#      agent dir and records a SHA-256 ownership record.
#   7. Backs up a conflicting/modified destination before replacing it.
#   8. Runs configure --apply/--check offline, best-effort server reload,
#      then restarts the daemon (--stop handover sweep + ensure) so the new
#      bin takes effect. The daemon loads its code once at spawn: an
#      already-running process keeps serving the previous release after an
#      update (stale ask/review toasts beside native attention). Warns
#      without rolling back on best-effort failures.
#
# Environment overrides (for isolated tests / local use):
#   HERDR_BIN_PATH            herdr binary (default: herdr from PATH)
#   PI_AGENT_DIR              Pi agent dir (default: $HOME/.pi/agent)
#   XDG_STATE_HOME            state base (default: $HOME/.local/state)
#   HERDR_GENTLE_PLUGIN_ROOT  explicit plugin root (test/local override only;
#                             must be absolute; bypasses plugin-list lookup)
#   HERDR_GENTLE_LATEST_URL   release lookup URL for newest-tag resolution
#                             (test/local override only; default: the GitHub
#                             releases/latest API endpoint for this repo)
#
# Exit codes: 0 success; 1 operational failure; 2 usage/validation failure.

set -eu

REPO="jonasotoaguilar/herdr-gentle-agents"
LATEST_URL_DEFAULT="https://api.github.com/repos/jonasotoaguilar/herdr-gentle-agents/releases/latest"
LS_REMOTE_URL="https://github.com/jonasotoaguilar/herdr-gentle-agents"
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
usage: install.sh [--ref REF] [--allow-downgrade] [--force] [--uninstall] [--help]

  (no flags)     install or update the Herdr plugin, the managed Pi
                 extension copy, and the managed sidebar configuration
                 (resolves the newest release when --ref is omitted;
                 already current exits 0 without changing anything)
  --ref REF      plugin release ref (default: newest release; never main)
  --allow-downgrade
                 permit installing a target older than the installed
                 version (otherwise a newer installed version aborts)
  --force        deprecated no-op: accepted so previously documented
                 commands keep working; a locally linked plugin is now
                 replaced automatically with a warning
  --uninstall    remove the managed install (ownership-checked)
  --help         print this help and exit

examples:
  curl -fsSL https://github.com/jonasotoaguilar/herdr-gentle-agents/releases/latest/download/install.sh | sh
  curl -fsSL https://github.com/jonasotoaguilar/herdr-gentle-agents/releases/latest/download/install.sh | sh -s -- --ref v0.2.0
  curl -fsSL https://github.com/jonasotoaguilar/herdr-gentle-agents/releases/latest/download/install.sh | sh -s -- --uninstall

environment:
  HERDR_BIN_PATH, PI_AGENT_DIR, XDG_STATE_HOME, HERDR_GENTLE_PLUGIN_ROOT (test/local override only), HERDR_GENTLE_LATEST_URL (test/local override only)
EOF
}

# --- argument parsing (POSIX, shift-based) ---
MODE="install"
REF=""
REF_SET="0"
FORCE="0"
ALLOW_DOWNGRADE="0"
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --force)
      FORCE="1"
      shift
      ;;
    --allow-downgrade)
      ALLOW_DOWNGRADE="1"
      shift
      ;;
    --uninstall)
      MODE="uninstall"
      shift
      ;;
    --ref=*)
      REF="${1#--ref=}"
      REF_SET="1"
      shift
      ;;
    --ref)
      [ $# -ge 2 ] || die "missing value for --ref (usage: --ref REF)" 2
      shift
      REF="$1"
      REF_SET="1"
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
EXCLUSION_REL="extensions/herdr-agent-state.ts"
EXCLUSION_ENTRY="-$EXCLUSION_REL"
EXCLUSION_LIB="lib/pi-extension-exclusion.js"
PI_SETTINGS="$PI_DIR/settings.json"
EXCLUSION_MARKER="$STATE_DIR/pi-extension-exclusion-owned"
EXCLUSION_ADDED_THIS_RUN=0
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
    die "ref 'main' is mutable and not allowed (use a pinned release ref such as v0.2.0)" 2
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

# Best-effort rollback for a failed install that already recorded the native
# exclusion: re-enable the base rather than leave it disabled with no working
# replacement. Only acts when this run added the entry (flag set after
# ensure); silent no-op otherwise. Never fails the surrounding exit path.
rollback_exclusion() {
  if [ "$EXCLUSION_ADDED_THIS_RUN" = "1" ]; then
    if [ -n "${EXCLUSION_HELPER:-}" ] && [ -f "$EXCLUSION_HELPER" ]; then
      if node "$EXCLUSION_HELPER" remove --settings "$PI_SETTINGS" --entry "$EXCLUSION_ENTRY" --marker "$EXCLUSION_MARKER" >/dev/null 2>&1; then
        warn "rolled back native extension exclusion in $PI_SETTINGS after failed install (re-run install to converge)"
      else
        warn "FAILED to roll back native extension exclusion in $PI_SETTINGS; the base may stay disabled with no replacement — remove $EXCLUSION_ENTRY manually or re-run install"
      fi
    else
      warn "FAILED to roll back native extension exclusion in $PI_SETTINGS (helper unavailable); the base may stay disabled with no replacement"
    fi
  fi
  return 0
}

# Emit the plugin list JSON (stdout) or fail. Never aborts the caller.
plugin_list_json() {
  "$HERDR_BIN" plugin list --plugin "$PLUGIN_ID" --json 2>/dev/null
}

# Parse plugin-list JSON from stdin; prints matches/distinct/root/kind/version
# lines (best-effort: prints parse_error=1 on any failure). Never fails.
plugin_info() {
  node -e '
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  try {
    const doc = JSON.parse(raw);
    const arr = (doc && doc.result && doc.result.plugins) || doc.plugins || [];
    if (!Array.isArray(arr)) throw new Error("no plugins array");
    const hits = arr.filter((p) => p && (p.plugin_id === "herdr-gentle-agents" || p.id === "herdr-gentle-agents"));
    const roots = hits.map((h) => h.plugin_root).filter((r) => typeof r === "string" && r.length > 0);
    const uniq = [...new Set(roots)];
    const first = hits[0] || {};
    const kind = (first.source && first.source.kind) || "";
    const version = (typeof first.version === "string") ? first.version : "";
    console.log("matches=" + hits.length);
    console.log("distinct=" + uniq.length);
    console.log("root=" + (uniq.length === 1 ? uniq[0] : ""));
    console.log("kind=" + kind);
    console.log("version=" + version);
  } catch (e) {
    console.log("parse_error=1");
  }
});
' 2>/dev/null
  return 0
}

# Extract "tag_name" from release JSON on stdin (no jq). Prints the tag.
extract_tag() {
  sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

# Resolve the newest release tag and echo it. curl first, then a git
# ls-remote version sort when curl is absent or fails; returns 1 when both
# are unavailable so the caller can fail closed naming --ref.
resolve_latest_ref() {
  _latest_url="${HERDR_GENTLE_LATEST_URL:-$LATEST_URL_DEFAULT}"
  if command -v curl >/dev/null 2>&1; then
    _latest_json=""
    if _latest_json="$(curl -fsSL "$_latest_url" 2>/dev/null)"; then
      _latest_tag="$(printf '%s' "$_latest_json" | extract_tag)"
      if [ -n "$_latest_tag" ]; then
        printf '%s' "$_latest_tag"
        return 0
      fi
    fi
  fi
  if command -v git >/dev/null 2>&1; then
    _ls_remote=""
    if _ls_remote="$(git ls-remote --tags --refs "$LS_REMOTE_URL" 2>/dev/null)"; then
      _best_tag="$(printf '%s\n' "$_ls_remote" | sed -e 's|.*refs/tags/||' -e 's|\^{}||' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1)"
      if [ -n "$_best_tag" ]; then
        printf '%s' "$_best_tag"
        return 0
      fi
    fi
  fi
  return 1
}

# Normalize a non-negative integer (strip leading zeros; empty means 0).
_norm_num() {
  _norm_n="$(printf '%s' "$1" | sed -e 's/^0*//')"
  [ -z "$_norm_n" ] && _norm_n="0"
  printf '%s' "$_norm_n"
}

# Strict vX.Y.Z numeric comparison of two refs. Prints -1, 0, or 1;
# returns 1 when either side is missing, empty, or non-numeric (the caller
# then treats the install as not current and never aborts on it).
semver_cmp() {
  _cmp_a="$1"
  _cmp_b="$2"
  case "$_cmp_a" in v*) _cmp_a="${_cmp_a#v}" ;; *) return 1 ;; esac
  case "$_cmp_b" in v*) _cmp_b="${_cmp_b#v}" ;; *) return 1 ;; esac
  _cmp_a_rest="${_cmp_a#*.}"
  _cmp_b_rest="${_cmp_b#*.}"
  case "$_cmp_a" in *.*.*) ;; *) return 1 ;; esac
  case "$_cmp_b" in *.*.*) ;; *) return 1 ;; esac
  _cmp_a_maj="${_cmp_a%%.*}"
  _cmp_a_min="${_cmp_a_rest%%.*}"
  _cmp_a_pat="${_cmp_a_rest#*.}"
  _cmp_b_maj="${_cmp_b%%.*}"
  _cmp_b_min="${_cmp_b_rest%%.*}"
  _cmp_b_pat="${_cmp_b_rest#*.}"
  for _cmp_n in "$_cmp_a_maj" "$_cmp_a_min" "$_cmp_a_pat" "$_cmp_b_maj" "$_cmp_b_min" "$_cmp_b_pat"; do
    case "$_cmp_n" in ''|*[!0-9]*) return 1 ;; esac
  done
  case "$_cmp_a_pat" in *.*) return 1 ;; esac
  case "$_cmp_b_pat" in *.*) return 1 ;; esac
  for _cmp_p in maj min pat; do
    eval "_cmp_x=\$_cmp_a_$_cmp_p; _cmp_y=\$_cmp_b_$_cmp_p"
    _cmp_x="$(_norm_num "$_cmp_x")"
    _cmp_y="$(_norm_num "$_cmp_y")"
    if [ "${#_cmp_x}" -gt "${#_cmp_y}" ]; then printf '1'; return 0; fi
    if [ "${#_cmp_x}" -lt "${#_cmp_y}" ]; then printf '%s' '-1'; return 0; fi
    if [ "$(expr "x$_cmp_x" \> "x$_cmp_y" || true)" = "1" ]; then printf '1'; return 0; fi
    if [ "$(expr "x$_cmp_x" \< "x$_cmp_y" || true)" = "1" ]; then printf '%s' '-1'; return 0; fi
  done
  printf '0'
  return 0
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
  # 1. Target ref: explicit --ref wins, otherwise resolve the newest release.
  if [ "$REF_SET" = "0" ]; then
    if REF="$(resolve_latest_ref)"; then
      :
    else
      die "could not resolve the latest release tag (curl and git fallback failed); re-run with an explicit --ref, e.g. --ref v0.2.0" 1
    fi
  fi
  validate_ref "$REF"

  if [ "$FORCE" = "1" ]; then
    warn "--force is deprecated and has no effect; a locally linked plugin is replaced automatically"
  fi

  # 2. Pre-install plugin state (best-effort: unknown means not current).
  _pre=""
  _have_pre=0
  if _pre="$(plugin_list_json)"; then
    if [ -n "$_pre" ]; then _have_pre=1; fi
  fi
  _matches=0
  _distinct=0
  _iroot=""
  _ikind=""
  _iver=""
  if [ "$_have_pre" = "1" ]; then
    _info="$(printf '%s' "$_pre" | plugin_info)" || _info=""
    if [ -n "$_info" ]; then
      while IFS= read -r _line; do
        case "$_line" in
          matches=*) _matches="${_line#matches=}" ;;
          distinct=*) _distinct="${_line#distinct=}" ;;
          root=*) _iroot="${_line#root=}" ;;
          kind=*) _ikind="${_line#kind=}" ;;
          version=*) _iver="${_line#version=}" ;;
          parse_error=*) _matches=0; _distinct=0; _iroot=""; _ikind=""; _iver="" ;;
        esac
      done <<EOF
$_info
EOF
    fi
  fi
  _check_root="$_iroot"
  if [ -n "$OVERRIDE_ROOT" ]; then
    case "$OVERRIDE_ROOT" in
      /*) _check_root="$OVERRIDE_ROOT" ;;
      *) die "HERDR_GENTLE_PLUGIN_ROOT must be absolute: $OVERRIDE_ROOT" 2 ;;
    esac
  fi

  # 3. Downgrade guard: a newer installed version aborts unless allowed.
  # A missing, empty, or non-numeric installed version never aborts.
  _cmp=""
  _cmp_ok=0
  if _cmp="$(semver_cmp "$_iver" "$REF")"; then _cmp_ok=1; fi
  if [ "$_cmp_ok" = "1" ] && [ "$_cmp" = "1" ]; then
    if [ "$ALLOW_DOWNGRADE" = "0" ]; then
      die "installed version $_iver is newer than target $REF; refusing downgrade (re-run with --allow-downgrade to proceed)" 1
    fi
  fi

  # 4. Current means: exactly one resolvable root, not locally linked,
  # installed version equals the target, and the managed copy is a
  # regular file whose sha256 equals both the ownership record and the
  # plugin source. When current, exit 0 before any mutation; a missing
  # or drifted managed copy repairs instead of reporting current.
  if [ "$_cmp_ok" = "1" ] && [ "$_cmp" = "0" ] && [ "$_ikind" != "local" ]; then
    _exact_one=0
    if [ -n "$OVERRIDE_ROOT" ]; then
      _exact_one=1
    elif [ "$_distinct" = "1" ]; then
      _exact_one=1
    fi
    if [ "$_exact_one" = "1" ] && [ -n "$_check_root" ]; then
      case "$_check_root" in
        /*)
          _cur_src="$_check_root/$EXT_REL"
          if [ -f "$_cur_src" ] && [ -f "$DEST" ] && [ ! -L "$DEST" ] && [ -f "$STATE_FILE" ]; then
            _cur_dest_sum="$(sha_of "$DEST")"
            _cur_src_sum="$(sha_of "$_cur_src")"
            _cur_rec="$(tr -d ' \t\r\n' < "$STATE_FILE" 2>/dev/null || printf '')"
            if [ -n "$_cur_dest_sum" ] && [ "$_cur_dest_sum" = "$_cur_src_sum" ] && [ "$_cur_dest_sum" = "$_cur_rec" ]; then
              info "already up to date ($REF)"
              exit 0
            fi
          fi
          ;;
      esac
    fi
  fi

  # 5. A locally linked plugin is replaced automatically (warn loudly).
  if [ "$_have_pre" = "1" ] && [ "$_ikind" = "local" ]; then
    warn "replacing locally linked plugin $PLUGIN_ID (source.kind=local); to re-link a checkout run: herdr plugin link --enabled . from the checkout directory"
    "$HERDR_BIN" plugin unlink "$PLUGIN_ID" \
      || die "herdr plugin unlink failed"
    info "removed locally linked plugin $PLUGIN_ID (source.kind=local)"
  fi

  # 6. Install + enable.
  "$HERDR_BIN" plugin install "$REPO" --ref "$REF" --yes \
    || die "herdr plugin install failed (ref=$REF)"
  "$HERDR_BIN" plugin enable "$PLUGIN_ID" \
    || die "herdr plugin enable failed"

  # 7. Resolve the exact plugin root.
  PLUGIN_ROOT="$(resolve_plugin_root)"

  SRC="$PLUGIN_ROOT/$EXT_REL"
  CONFIGURE="$PLUGIN_ROOT/$CONFIGURE_REL"
  STATUS_BIN="$PLUGIN_ROOT/$STATUS_REL"
  [ -f "$SRC" ] || die "plugin extension source missing: $SRC"

  # 8. Non-destructive native-extension exclusion: keep the managed native
  #    base file on disk but stop Pi from auto-loading it, so the managed
  #    copy above is the single publisher. Runs before the copy so a
  #    settings failure leaves the destination untouched. Never reads,
  #    writes, or deletes the base file itself. A later ordinary failure
  #    rolls the exclusion back via rollback_exclusion (EXIT trap) so the
  #    base is not left disabled with no replacement.
  EXCLUSION_HELPER="$PLUGIN_ROOT/$EXCLUSION_LIB"
  [ -f "$EXCLUSION_HELPER" ] || die "plugin exclusion helper missing: $EXCLUSION_HELPER"
  MARKER_BEFORE=0
  if [ -e "$EXCLUSION_MARKER" ]; then
    MARKER_BEFORE=1
  fi
  _excl_out=""
  if _excl_out="$(node "$EXCLUSION_HELPER" ensure --settings "$PI_SETTINGS" --entry "$EXCLUSION_ENTRY" --marker "$EXCLUSION_MARKER" 2>&1)"; then
    [ -n "$_excl_out" ] && info "$_excl_out"
  else
    [ -n "$_excl_out" ] && printf '%s\n' "$_excl_out" >&2
    die "could not record native extension exclusion for $PI_SETTINGS (see error above)"
  fi
  if [ "$MARKER_BEFORE" = "0" ] && [ -e "$EXCLUSION_MARKER" ]; then
    EXCLUSION_ADDED_THIS_RUN=1
  fi
  trap 'rollback_exclusion' EXIT

  # 9. Atomic copy with ownership record + conflict backup.
  SRC_SUM="$(sha_of "$SRC")"
  [ -n "$SRC_SUM" ] || die "could not checksum $SRC"
  mkdir -p "$DEST_DIR" "$STATE_DIR" || die "could not create $DEST_DIR / $STATE_DIR"

  PREV_RECORD=""
  if [ -f "$STATE_FILE" ]; then
    PREV_RECORD="$(tr -d ' \t\r\n' < "$STATE_FILE" 2>/dev/null || printf '')"
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

  # 10. Offline configure + verify, then best-effort reload + daemon restart.
  [ -f "$CONFIGURE" ] || die "plugin configure script missing: $CONFIGURE"
  node "$CONFIGURE" --apply || die "configure --apply failed"
  node "$CONFIGURE" --check || die "configure --check failed (applied but not current)"
  EXCLUSION_ADDED_THIS_RUN=0

  if "$HERDR_BIN" server reload-config >/dev/null 2>&1; then
    info "reloaded Herdr config"
  else
    warn "herdr server reload-config failed or no server running; continuing (config is applied on next start)"
  fi

  if [ -f "$STATUS_BIN" ]; then
    # Restart, not just ensure: the daemon loads its code once at spawn, so
    # an already-running process would keep serving the previous release
    # after this update (stale ask/review toasts beside native attention).
    # --stop is a scoped handover sweep (owned tokens only, live panes keep
    # their last frame until the successor republishes); ensure then spawns
    # the current bin detached. Both best-effort: a missing daemon or a
    # failed sweep must not fail the install.
    if node "$STATUS_BIN" --stop >/dev/null 2>&1; then
      info "stopped previous daemon"
    else
      warn "daemon --stop failed or no daemon was running; continuing with ensure"
    fi
    if node "$STATUS_BIN" >/dev/null 2>&1; then
      info "daemon restarted"
    else
      warn "daemon ensure via gentle-status.js failed; continuing (install and config are complete)"
    fi
  else
    warn "daemon script unavailable ($STATUS_BIN); continuing (install and config are complete)"
  fi

  # 11. Session reminder.
  info "done (ref=$REF). Running Pi sessions need /reload or a restart to pick up the updated extension."
  warn "global exclusion $EXCLUSION_ENTRY is recorded in $PI_SETTINGS; explicit project extensions entries can re-enable the base file for that project"
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
      RECORD="$(tr -d ' \t\r\n' < "$STATE_FILE" 2>/dev/null || printf '')"
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

  # Ownership-aware exclusion removal (best-effort): only the entry this
  # installer added is removed; a preexisting user exclusion and unrelated
  # settings are preserved. Runs before state cleanup (the marker lives in
  # STATE_DIR). Never touches the native base file.
  if [ -n "$PLUGIN_ROOT" ]; then
    EXCLUSION_HELPER="$PLUGIN_ROOT/$EXCLUSION_LIB"
    if [ -f "$EXCLUSION_HELPER" ]; then
      _excl_out=""
      if _excl_out="$(node "$EXCLUSION_HELPER" remove --settings "$PI_SETTINGS" --entry "$EXCLUSION_ENTRY" --marker "$EXCLUSION_MARKER" 2>&1)"; then
        [ -n "$_excl_out" ] && info "$_excl_out"
      else
        [ -n "$_excl_out" ] && printf '%s\n' "$_excl_out" >&2
        warn "preserving $PI_SETTINGS as-is (exclusion cleanup failed; remove $EXCLUSION_ENTRY manually if desired)"
      fi
    else
      warn "preserving $PI_SETTINGS as-is (exclusion helper unavailable: $EXCLUSION_HELPER)"
    fi
  else
    warn "preserving $PI_SETTINGS as-is (installed plugin root unknown)"
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
