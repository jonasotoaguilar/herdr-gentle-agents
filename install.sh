#!/bin/sh
# herdr-gentle-agents two-package installer (Linux only, POSIX sh).
#
# Stable public entrypoint (example):
#   curl -fsSL https://github.com/jonasotoaguilar/herdr-gentle-agents/releases/latest/download/install.sh | sh
#
# Trust/review: this script is intentionally small and reviewable. Fetch the
# stable URL above (never `main`), read it before piping to a shell, and
# re-run the same stable URL to update or with `--uninstall` to remove.
# It never uses sudo and never handles credentials.
#
# What it installs (two separate packages, one command):
#   1. The Herdr plugin from the repository subdirectory, pinned at a
#      herdr-vX.Y.Z release ref:
#        herdr plugin install jonasotoaguilar/herdr-gentle-agents/herdr-plugin --ref REF
#      then `herdr plugin enable herdr-gentle-agents`.
#   2. The Pi package (the repository root, npm name
#      @jonasotoaguilar/herdr-gentle-agents) with `pi install`, either from
#      the npm registry or from git when the registry is unreachable.
#
# What it does (install/update):
#   1. Validates Linux, Node >= 18, herdr/pi availability, and a safe ref
#      (resolves the newest herdr-vX.Y.Z release tag when --ref is omitted).
#   2. Resolves the Pi source (--pi-source wins; auto prefers npm and falls
#      back to git with one warning when the registry is unreachable).
#   3. Compares the installed plugin version with the target for release
#      refs: already current (same plugin version, same Pi source, no
#      legacy managed copy) exits 0 without touching anything; a newer
#      installed version aborts unless --allow-downgrade is given. A ref
#      that is not a herdr-vX.Y.Z tag skips the version gate with a warning.
#   4. Migrates the retired managed copy: an installer-owned
#      $PI_DIR/extensions/gentle-herdr-state.ts (bytes still matching the
#      recorded sha256) is removed; a user-modified file is kept with a
#      warning and never deleted.
#   5. Replaces a locally linked plugin automatically (unlink + warning).
#   6. Installs + enables the Herdr plugin at the target ref, then resolves
#      the exact plugin_root from plugin-list JSON (fail closed).
#   7. Installs the Pi package with `pi install "<source>"`. A failure here
#      reports the exact retry command: the Herdr plugin at $REF is already
#      installed at that point.
#   8. Converges the Pi-owned coexistence exclusion of the native base
#      extension via the installed Pi package helper (idempotent,
#      marker-checked; an unresolvable package root warns and continues).
#   9. Runs configure --apply/--check, best-effort server reload, then
#      restarts the daemon (--stop handover sweep + ensure) so the new bin
#      takes effect. The daemon loads its code once at spawn: an
#      already-running process keeps serving the previous release after an
#      update (stale ask/review toasts beside native attention). All three
#      are best-effort and warn without failing the install.
#  10. Records a versioned installer state file (ref, plugin version, Pi
#      source, timestamp).
#
# Why the managed copy was retired: install.sh used to copy
# extensions/gentle-herdr-state.ts into $PI_DIR/extensions and track it with
# a sha256 ownership record. The Pi side is now a real versioned Pi package,
# so Pi owns that file and its updates (`pi update --extensions`) instead of
# a script-owned copy. This installer migrates an owned copy away (step 4)
# and never writes that path again.
#
# Updates (each package on its own story):
#   pi update --extensions
#   herdr plugin update herdr-gentle-agents
#
# Environment overrides (for isolated tests / local use):
#   HERDR_BIN_PATH            herdr binary (default: herdr from PATH)
#   PI_BIN_PATH               pi binary (default: pi from PATH)
#   NPM_BIN_PATH              npm binary (default: npm from PATH; used only
#                             to probe the registry for auto source)
#   HERDR_GENTLE_PI_SOURCE    explicit Pi source (auto|npm|git; same values
#                             as --pi-source; the flag wins when both given)
#   PI_AGENT_DIR              Pi agent dir (default: $HOME/.pi/agent)
#   XDG_STATE_HOME            state base (default: $HOME/.local/state)
#   HERDR_GENTLE_PLUGIN_ROOT  explicit plugin root (test/local override only;
#                             must be absolute; bypasses plugin-list lookup)
#   HERDR_GENTLE_LATEST_URL   release lookup URL for newest-tag resolution
#                             (test/local override only; default: the GitHub
#                             releases list API endpoint for this repo)
#
# Exit codes: 0 success; 1 operational failure; 2 usage/validation failure.

set -eu

REPO="jonasotoaguilar/herdr-gentle-agents"
PLUGIN_SUBDIR="herdr-plugin"
LATEST_URL_DEFAULT="https://api.github.com/repos/jonasotoaguilar/herdr-gentle-agents/releases"
LS_REMOTE_URL="https://github.com/jonasotoaguilar/herdr-gentle-agents"
PLUGIN_ID="herdr-gentle-agents"
PI_PKG="@jonasotoaguilar/herdr-gentle-agents"
PI_NPM_SPEC="npm:@jonasotoaguilar/herdr-gentle-agents"
PI_GIT_SPEC="git:github.com/jonasotoaguilar/herdr-gentle-agents"
LEGACY_REL="extensions/gentle-herdr-state.ts"
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
usage: install.sh [--ref REF] [--pi-source auto|npm|git] [--allow-downgrade] [--force] [--uninstall] [--help]

  (no flags)     install or update the Herdr plugin (from the herdr-plugin/
                 subdirectory at the newest herdr-vX.Y.Z release) and the
                 Pi package (already current exits 0 without changing
                 anything)
  --ref REF      Herdr plugin release ref (default: newest herdr-v* release;
                 never main; a non-release ref skips the version gate)
  --pi-source auto|npm|git
                 Pi package source (default: auto — npm when the registry
                 is reachable, otherwise git; an explicit flag or
                 HERDR_GENTLE_PI_SOURCE wins)
  --allow-downgrade
                 permit installing a target older than the installed
                 version (otherwise a newer installed version aborts)
  --force        deprecated no-op: accepted so previously documented
                 commands keep working; a locally linked plugin is now
                 replaced automatically with a warning
  --uninstall    remove both packages (ownership-checked)
  --help         print this help and exit

two packages (one command installs both):
  herdr plugin install jonasotoaguilar/herdr-gentle-agents/herdr-plugin --ref REF
  pi install npm:@jonasotoaguilar/herdr-gentle-agents (or git:github.com/jonasotoaguilar/herdr-gentle-agents)

updates (each package on its own story):
  pi update --extensions
  herdr plugin update herdr-gentle-agents

retired managed copy:
  install.sh no longer copies extensions/gentle-herdr-state.ts into the Pi
  agent dir. The Pi side is a versioned Pi package now, so Pi owns that
  file. An installer-owned copy left by a previous release is migrated
  away; a user-modified file is kept with a warning and never deleted.

examples:
  curl -fsSL https://github.com/jonasotoaguilar/herdr-gentle-agents/releases/latest/download/install.sh | sh
  curl -fsSL https://github.com/jonasotoaguilar/herdr-gentle-agents/releases/latest/download/install.sh | sh -s -- --ref herdr-v0.2.0
  curl -fsSL https://github.com/jonasotoaguilar/herdr-gentle-agents/releases/latest/download/install.sh | sh -s -- --pi-source git
  curl -fsSL https://github.com/jonasotoaguilar/herdr-gentle-agents/releases/latest/download/install.sh | sh -s -- --uninstall

environment:
  HERDR_BIN_PATH, PI_BIN_PATH, NPM_BIN_PATH, HERDR_GENTLE_PI_SOURCE (auto|npm|git), PI_AGENT_DIR, XDG_STATE_HOME, HERDR_GENTLE_PLUGIN_ROOT (test/local override only), HERDR_GENTLE_LATEST_URL (test/local override only)
EOF
}

# --- argument parsing (POSIX, shift-based) ---
MODE="install"
REF=""
REF_SET="0"
PI_SOURCE_REQ=""
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
    --pi-source=*)
      PI_SOURCE_REQ="${1#--pi-source=}"
      shift
      ;;
    --pi-source)
      [ $# -ge 2 ] || die "missing value for --pi-source (usage: --pi-source auto|npm|git)" 2
      shift
      PI_SOURCE_REQ="$1"
      shift
      ;;
    --pi-*)
      die "unknown flag $1" 2
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
PI_BIN="${PI_BIN_PATH:-pi}"
NPM_BIN="${NPM_BIN_PATH:-npm}"
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
LEGACY_DEST="$PI_DIR/$LEGACY_REL"
EXCLUSION_REL="extensions/herdr-agent-state.ts"
EXCLUSION_ENTRY="-$EXCLUSION_REL"
EXCLUSION_LIB="lib/pi-extension-exclusion.js"
PI_SETTINGS="$PI_DIR/settings.json"
EXCLUSION_MARKER="$STATE_DIR/pi-extension-exclusion-owned"
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

case "$PI_BIN" in
  */*)
    [ -x "$PI_BIN" ] || die "pi binary not executable: $PI_BIN"
    ;;
  *)
    command -v "$PI_BIN" >/dev/null 2>&1 || die "pi not found (PI_BIN_PATH=$PI_BIN)"
    ;;
esac

command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"
command -v date >/dev/null 2>&1 || die "date is required"

validate_ref() {
  _ref="$1"
  [ -n "$_ref" ] || die "ref must be nonempty (usage: --ref REF)" 2
  if [ "$_ref" = "main" ]; then
    die "ref 'main' is mutable and not allowed (use a pinned release ref such as herdr-v0.2.0)" 2
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

validate_pi_source() {
  case "$1" in
    auto|npm|git) ;;
    *) die "unknown --pi-source value: $1 (expected auto|npm|git)" 2 ;;
  esac
}

sha_of() {
  sha256sum -- "$1" 2>/dev/null | cut -d' ' -f1
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

# Extract every tag_name value from release JSON on stdin (no jq); the caller
# filters the herdr-vX.Y.Z series. Prints one tag per line.
extract_herdr_tags() {
  grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' 2>/dev/null \
    | sed -e 's/^"tag_name"//' -e 's/^[^"]*"//' -e 's/"$//'
  return 0
}

# Resolve the newest herdr-vX.Y.Z release tag and echo it. Releases-list API
# first, then a git ls-remote version sort when curl is absent or fails;
# returns 1 when both are unavailable so the caller can fail closed naming
# --ref.
resolve_latest_ref() {
  _latest_url="${HERDR_GENTLE_LATEST_URL:-$LATEST_URL_DEFAULT}"
  if command -v curl >/dev/null 2>&1; then
    _latest_json=""
    if _latest_json="$(curl -fsSL "$_latest_url" 2>/dev/null)"; then
      _latest_tag="$(printf '%s' "$_latest_json" | extract_herdr_tags | grep -E '^herdr-v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1)"
      if [ -n "$_latest_tag" ]; then
        printf '%s' "$_latest_tag"
        return 0
      fi
    fi
  fi
  if command -v git >/dev/null 2>&1; then
    _ls_remote=""
    if _ls_remote="$(git ls-remote --tags --refs "$LS_REMOTE_URL" 2>/dev/null)"; then
      _best_tag="$(printf '%s\n' "$_ls_remote" | sed -e 's|.*refs/tags/||' -e 's|\^{}||' | grep -E '^herdr-v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1)"
      if [ -n "$_best_tag" ]; then
        printf '%s' "$_best_tag"
        return 0
      fi
    fi
  fi
  return 1
}

# Print the X.Y.Z group when $1 matches ^herdr-vX.Y.Z$; return 1 otherwise.
herdr_version_of_ref() {
  case "$1" in
    herdr-v*.*.*)
      _hvr="${1#herdr-v}"
      case "$_hvr" in *.*.*) ;; *) return 1 ;; esac
      _hvr_rest="${_hvr#*.}"
      _hvr_maj="${_hvr%%.*}"
      _hvr_min="${_hvr_rest%%.*}"
      _hvr_pat="${_hvr_rest#*.}"
      case "$_hvr_pat" in *.*) return 1 ;; esac
      for _hvr_n in "$_hvr_maj" "$_hvr_min" "$_hvr_pat"; do
        case "$_hvr_n" in ''|*[!0-9]*) return 1 ;; esac
      done
      printf '%s' "$_hvr"
      return 0
      ;;
    *) return 1 ;;
  esac
}

# Strip a leading herdr-v/v prefix for version comparison.
normalize_version() {
  _nv="$1"
  case "$_nv" in herdr-v*) _nv="${_nv#herdr-v}" ;; v*) _nv="${_nv#v}" ;; esac
  printf '%s' "$_nv"
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

# Echo the resolved Pi source spec. Explicit --pi-source wins, then
# HERDR_GENTLE_PI_SOURCE, then auto (npm registry probe with a bounded
# timeout; git fallback with exactly one warning naming the fallback).
resolve_pi_source() {
  _req="$PI_SOURCE_REQ"
  if [ -z "$_req" ] && [ -n "${HERDR_GENTLE_PI_SOURCE:-}" ]; then
    _req="$HERDR_GENTLE_PI_SOURCE"
  fi
  if [ -z "$_req" ]; then
    _req="auto"
  fi
  validate_pi_source "$_req"
  case "$_req" in
    npm) printf '%s' "$PI_NPM_SPEC"; return 0 ;;
    git) printf '%s' "$PI_GIT_SPEC"; return 0 ;;
  esac
  _npm_out=""
  if command -v timeout >/dev/null 2>&1; then
    _npm_out="$(timeout 20 "$NPM_BIN" view "$PI_PKG" version 2>/dev/null)" || _npm_out=""
  else
    _npm_out="$("$NPM_BIN" view "$PI_PKG" version 2>/dev/null)" || _npm_out=""
  fi
  case "$_npm_out" in
    *[!A-Za-z0-9._-]*|'') ;;
    *) printf '%s' "$PI_NPM_SPEC"; return 0 ;;
  esac
  warn "npm registry unavailable (npm view $PI_PKG failed); falling back to git source $PI_GIT_SPEC"
  printf '%s' "$PI_GIT_SPEC"
  return 0
}

# True (0) when `pi list` shows $1 installed. Silent; never fails the caller.
pi_source_installed() {
  _psi_out=""
  _psi_out="$("$PI_BIN" list 2>/dev/null)" || return 1
  case "$_psi_out" in
    *"$1"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Echo the installed Pi package root parsed from `pi list` output: the
# absolute path line following the two-space-indented package source line.
# Returns 1 when unresolvable.
resolve_pi_root() {
  _rpr_out=""
  _rpr_out="$("$PI_BIN" list 2>/dev/null)" || return 1
  [ -n "$_rpr_out" ] || return 1
  HERDR_GENTLE_WANT_SOURCE="$HERDR_GENTLE_WANT_SOURCE" printf '%s' "$_rpr_out" | node -e '
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  try {
    const lines = raw.split("\n");
    const wants = ["npm:@jonasotoaguilar/herdr-gentle-agents", "git:github.com/jonasotoaguilar/herdr-gentle-agents"];
    const want = process.env.HERDR_GENTLE_WANT_SOURCE || "";
    const ordered = (want && wants.indexOf(want) !== -1) ? [want].concat(wants.filter((w) => w !== want)) : wants;
    for (const spec of ordered) {
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].trim() === spec) {
          for (let j = i + 1; j < lines.length; j += 1) {
            const t = lines[j].trim();
            if (t === "") continue;
            if (t[0] === "/") { process.stdout.write(t); return; }
            break;
          }
        }
      }
    }
    process.exit(1);
  } catch (e) { process.exit(1); }
});
' 2>/dev/null
}

# Print the recorded sha256 when STATE_FILE holds the retired managed-copy
# shape (bare 64-hex ownership record); return 1 for the versioned state,
# a missing file, or malformed content (treated as unknown, never fatal).
legacy_record_sha() {
  [ -f "$STATE_FILE" ] || return 1
  _lrs="$(tr -d ' \t\r\n' < "$STATE_FILE" 2>/dev/null || printf '')"
  case "$_lrs" in
    ''|*[!0-9a-f]*) return 1 ;;
  esac
  [ "${#_lrs}" = "64" ] || return 1
  printf '%s' "$_lrs"
  return 0
}

# Retired-copy migration, before installing anything. An owned legacy copy
# (bytes still matching the recorded sha256) is removed and its record
# dropped with one info line; a user-modified file is kept with one warning
# naming its exact path. Never touches Pi settings or the exclusion marker.
migrate_legacy() {
  _ml_rec=""
  _ml_rec="$(legacy_record_sha)" || return 0
  if [ ! -e "$LEGACY_DEST" ] && [ ! -L "$LEGACY_DEST" ]; then
    rm -f "$STATE_FILE" 2>/dev/null || true
    return 0
  fi
  if [ -f "$LEGACY_DEST" ] && [ ! -L "$LEGACY_DEST" ]; then
    _ml_cur="$(sha_of "$LEGACY_DEST")"
    if [ -n "$_ml_cur" ] && [ "$_ml_cur" = "$_ml_rec" ]; then
      rm -f "$LEGACY_DEST" || die "could not remove legacy managed copy $LEGACY_DEST"
      rm -f "$STATE_FILE" 2>/dev/null || true
      info "removed legacy managed copy $LEGACY_DEST (the Pi side is now a pi-install package)"
      return 0
    fi
  fi
  warn "preserving user-modified legacy copy at $LEGACY_DEST (checksum differs from the installer record; left in place)"
  return 0
}

# Write the versioned installer state (atomic tmp + rename). Silent.
write_state() {
  _ws_ref="$1"
  _ws_ver="$2"
  _ws_src="$3"
  case "$_ws_ver" in ''|*[!A-Za-z0-9._-]*) _ws_ver="unknown" ;; esac
  _ws_ts=""
  _ws_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" || _ws_ts="unknown"
  mkdir -p "$STATE_DIR" || die "could not create $STATE_DIR"
  _ws_tmp="$STATE_DIR/.installer-state.tmp.$$"
  rm -f "$_ws_tmp" 2>/dev/null || true
  printf '{"version":1,"ref":"%s","plugin_version":"%s","pi_source":"%s","installed_at":"%s"}\n' \
    "$_ws_ref" "$_ws_ver" "$_ws_src" "$_ws_ts" >"$_ws_tmp" || die "could not stage installer state"
  mv "$_ws_tmp" "$STATE_FILE" || die "could not record installer state"
}

# Best-effort read of the installed plugin version from plugin-list JSON;
# echoes "" when unknown. Never fails.
current_plugin_version() {
  _cpv_json=""
  if _cpv_json="$(plugin_list_json 2>/dev/null)"; then
    if [ -n "$_cpv_json" ]; then
      _cpv_info="$(printf '%s' "$_cpv_json" | plugin_info)" || _cpv_info=""
      if [ -n "$_cpv_info" ]; then
        while IFS= read -r _cpv_line; do
          case "$_cpv_line" in
            version=*) printf '%s' "${_cpv_line#version=}"; return 0 ;;
          esac
        done <<EOF
$_cpv_info
EOF
      fi
    fi
  fi
  printf ''
  return 0
}

# --- install/update ---
do_install() {
  # 1. Target ref: explicit --ref wins, otherwise resolve the newest release.
  if [ "$REF_SET" = "0" ]; then
    if REF="$(resolve_latest_ref)"; then
      :
    else
      die "could not resolve the latest herdr-v release tag (curl and git fallback failed); re-run with an explicit --ref, e.g. --ref herdr-v0.2.0" 1
    fi
  fi
  validate_ref "$REF"

  if [ "$FORCE" = "1" ]; then
    warn "--force is deprecated and has no effect; a locally linked plugin is replaced automatically"
  fi

  # 2. Pi source: explicit flag/env wins, auto probes npm with git fallback.
  PI_SOURCE="$(resolve_pi_source)"

  # 3. Version gate (release refs only).
  _target_ver=""
  _gate="0"
  if _target_ver="$(herdr_version_of_ref "$REF")"; then
    _gate="1"
  else
    warn "ref $REF is not a herdr-vX.Y.Z release tag; skipping the version check"
  fi

  # Pre-install plugin state (best-effort: unknown means not current).
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

  if [ "$_gate" = "1" ]; then
    # Downgrade guard: a newer installed version aborts unless allowed.
    # A missing, empty, or non-numeric installed version never aborts.
    _iver_norm="$(normalize_version "$_iver")"
    _cmp=""
    _cmp_ok=0
    if _cmp="$(semver_cmp "v$_iver_norm" "v$_target_ver")"; then _cmp_ok=1; fi
    if [ "$_cmp_ok" = "1" ] && [ "$_cmp" = "1" ]; then
      if [ "$ALLOW_DOWNGRADE" = "0" ]; then
        die "installed version $_iver is newer than target $REF; refusing downgrade (re-run with --allow-downgrade to proceed)" 1
      fi
    fi

    # Already current: one resolvable root, not locally linked, installed
    # version equals the target, the Pi package is already installed from
    # the same source, and no legacy managed copy exists. Exit 0 before any
    # mutation with exactly one info line.
    if [ "$_cmp_ok" = "1" ] && [ "$_cmp" = "0" ] && [ "$_ikind" != "local" ]; then
      _exact_one=0
      if [ -n "$OVERRIDE_ROOT" ]; then
        _exact_one=1
      elif [ "$_distinct" = "1" ]; then
        _exact_one=1
      fi
      if [ "$_exact_one" = "1" ] && [ ! -e "$LEGACY_DEST" ] && [ ! -L "$LEGACY_DEST" ]; then
        if pi_source_installed "$PI_SOURCE"; then
          info "already up to date ($REF)"
          exit 0
        fi
      fi
    fi
  fi

  # 4. Legacy migration, before installing anything.
  migrate_legacy

  # 5. A locally linked plugin is replaced automatically (warn loudly).
  if [ "$_have_pre" = "1" ] && [ "$_ikind" = "local" ]; then
    warn "replacing locally linked plugin $PLUGIN_ID (source.kind=local); to re-link a checkout run: herdr plugin link --enabled . from the checkout directory"
    "$HERDR_BIN" plugin unlink "$PLUGIN_ID" \
      || die "herdr plugin unlink failed"
    info "removed locally linked plugin $PLUGIN_ID (source.kind=local)"
  fi

  # 6. Install + enable the Herdr plugin from the subdirectory.
  "$HERDR_BIN" plugin install "$REPO/$PLUGIN_SUBDIR" --ref "$REF" --yes \
    || die "herdr plugin install failed (ref=$REF)"
  "$HERDR_BIN" plugin enable "$PLUGIN_ID" \
    || die "herdr plugin enable failed"

  # 7. Resolve the exact plugin root.
  PLUGIN_ROOT="$(resolve_plugin_root)"
  CONFIGURE="$PLUGIN_ROOT/$CONFIGURE_REL"
  STATUS_BIN="$PLUGIN_ROOT/$STATUS_REL"

  # 8. Install the Pi package. A failure here is fatal and must say what is
  # already installed plus the exact retry command.
  if "$PI_BIN" install "$PI_SOURCE" >/dev/null 2>&1; then
    info "installed Pi package $PI_SOURCE"
  else
    die "pi install \"$PI_SOURCE\" failed (Herdr plugin $PLUGIN_ID at $REF is already installed; retry with: install.sh --ref $REF --pi-source git)" 1
  fi

  # 9. Coexistence exclusion through the installed Pi package helper. The
  # root comes from `pi list` (a two-space-indented source line followed by
  # a four-space-indented absolute path); an unresolvable root warns naming
  # the in-Pi toggle and never fails the install.
  HERDR_GENTLE_WANT_SOURCE="$PI_SOURCE" _pi_root=""
  if HERDR_GENTLE_WANT_SOURCE="$PI_SOURCE" _pi_root="$(resolve_pi_root)"; then
    :
  else
    _pi_root=""
  fi
  if [ -n "$_pi_root" ]; then
    _pi_helper="$_pi_root/$EXCLUSION_LIB"
    if [ -f "$_pi_helper" ]; then
      _excl_out=""
      if _excl_out="$(node "$_pi_helper" ensure --settings "$PI_SETTINGS" --entry "$EXCLUSION_ENTRY" --marker "$EXCLUSION_MARKER" 2>&1)"; then
        [ -n "$_excl_out" ] && info "$_excl_out"
      else
        [ -n "$_excl_out" ] && printf '%s\n' "$_excl_out" >&2
        warn "could not record native extension exclusion for $PI_SETTINGS; open /herdr-gentle:customize inside Pi and apply the sidebar row to converge it"
      fi
    else
      warn "exclusion helper unavailable ($_pi_helper); open /herdr-gentle:customize inside Pi and apply the sidebar row to converge the sidebar exclusion"
    fi
  else
    warn "could not resolve the installed Pi package root from 'pi list'; open /herdr-gentle:customize inside Pi and apply the sidebar row to converge the sidebar exclusion"
  fi

  # 10. Best-effort configure, reload, and daemon restart.
  if [ -f "$CONFIGURE" ]; then
    if node "$CONFIGURE" --apply >/dev/null 2>&1; then
      info "configure --apply complete"
    else
      warn "configure --apply failed; continuing (packages are installed)"
    fi
    if node "$CONFIGURE" --check >/dev/null 2>&1; then
      info "configure --check complete"
    else
      warn "configure --check failed; continuing (packages are installed)"
    fi
  else
    warn "configure script unavailable ($CONFIGURE); continuing (packages are installed)"
  fi

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
      warn "daemon ensure via gentle-status.js failed; continuing (packages are installed)"
    fi
  else
    warn "daemon script unavailable ($STATUS_BIN); continuing (packages are installed)"
  fi

  # 11. Versioned installer state.
  _post_ver="$(current_plugin_version)"
  [ -n "$_post_ver" ] || _post_ver=""
  _post_norm=""
  if [ -n "$_post_ver" ]; then
    _post_norm="$(normalize_version "$_post_ver")"
  fi
  if [ -z "$_post_norm" ] && [ "$_gate" = "1" ]; then
    _post_norm="$_target_ver"
  fi
  [ -n "$_post_norm" ] || _post_norm="unknown"
  write_state "$REF" "$_post_norm" "$PI_SOURCE"

  # 12. Session reminder.
  info "done (ref=$REF, pi=$PI_SOURCE). Running Pi sessions need /reload or a restart to pick up the new packages."
}

# Echo the Pi source to remove on uninstall: explicit --pi-source/env wins,
# then the source `pi list` actually shows, then the state-file record, then
# the npm default. Never fails; never touches the network.
uninstall_pi_source() {
  if [ -n "$PI_SOURCE_REQ" ]; then
    validate_pi_source "$PI_SOURCE_REQ"
    case "$PI_SOURCE_REQ" in
      npm) printf '%s' "$PI_NPM_SPEC"; return 0 ;;
      git) printf '%s' "$PI_GIT_SPEC"; return 0 ;;
    esac
  fi
  if [ -n "${HERDR_GENTLE_PI_SOURCE:-}" ]; then
    case "$HERDR_GENTLE_PI_SOURCE" in
      npm) printf '%s' "$PI_NPM_SPEC"; return 0 ;;
      git) printf '%s' "$PI_GIT_SPEC"; return 0 ;;
      *) ;;
    esac
  fi
  _uus_out=""
  if _uus_out="$("$PI_BIN" list 2>/dev/null)"; then
    case "$_uus_out" in
      *"$PI_NPM_SPEC"*) printf '%s' "$PI_NPM_SPEC"; return 0 ;;
    esac
    case "$_uus_out" in
      *"$PI_GIT_SPEC"*) printf '%s' "$PI_GIT_SPEC"; return 0 ;;
    esac
  fi
  if [ -f "$STATE_FILE" ]; then
    if grep -Fq "$PI_NPM_SPEC" "$STATE_FILE" 2>/dev/null; then
      printf '%s' "$PI_NPM_SPEC"; return 0
    fi
    if grep -Fq "$PI_GIT_SPEC" "$STATE_FILE" 2>/dev/null; then
      printf '%s' "$PI_GIT_SPEC"; return 0
    fi
  fi
  printf '%s' "$PI_NPM_SPEC"
  return 0
}

# --- uninstall ---
do_uninstall() {
  if [ "$FORCE" = "1" ]; then
    warn "--force is deprecated and has no effect"
  fi

  # Pi source for removal (no network probe on uninstall).
  _rm_source="$(uninstall_pi_source)"

  # Resolve the installed root first; missing root skips daemon cleanup only.
  PLUGIN_ROOT=""
  if _r="$(resolve_plugin_root 2>/dev/null)"; then
    PLUGIN_ROOT="$_r"
  else
    warn "could not resolve installed plugin root; skipping daemon cleanup"
  fi

  # Daemon stop (best-effort).
  if [ -n "$PLUGIN_ROOT" ]; then
    STATUS_BIN="$PLUGIN_ROOT/$STATUS_REL"
    if [ -f "$STATUS_BIN" ]; then
      if node "$STATUS_BIN" --stop --purge >/dev/null 2>&1; then
        info "daemon stopped and purged"
      else
        warn "daemon --stop --purge failed; continuing"
      fi
    else
      warn "daemon script unavailable; skipping daemon stop"
    fi
  fi

  # Owned exclusion removal through the installed Pi helper (marker-checked
  # by the helper itself: a foreign or missing record preserves the entry).
  HERDR_GENTLE_WANT_SOURCE="$_rm_source" _u_pi_root=""
  if HERDR_GENTLE_WANT_SOURCE="$_rm_source" _u_pi_root="$(resolve_pi_root 2>/dev/null)"; then
    :
  else
    _u_pi_root=""
  fi
  if [ -n "$_u_pi_root" ]; then
    _u_helper="$_u_pi_root/$EXCLUSION_LIB"
    if [ -f "$_u_helper" ]; then
      _excl_out=""
      if _excl_out="$(node "$_u_helper" remove --settings "$PI_SETTINGS" --entry "$EXCLUSION_ENTRY" --marker "$EXCLUSION_MARKER" 2>&1)"; then
        [ -n "$_excl_out" ] && info "$_excl_out"
      else
        [ -n "$_excl_out" ] && printf '%s\n' "$_excl_out" >&2
        warn "preserving $PI_SETTINGS as-is (exclusion cleanup failed; remove $EXCLUSION_ENTRY manually if desired)"
      fi
    else
      warn "preserving $PI_SETTINGS as-is (exclusion helper unavailable: $_u_helper)"
    fi
  else
    warn "preserving $PI_SETTINGS as-is (installed Pi package root unknown)"
  fi

  # Pi package removal: a refusal is reported without failing the rest.
  _pu_out=""
  _pu_rc=0
  _pu_out="$("$PI_BIN" remove "$_rm_source" 2>&1)" || _pu_rc=$?
  if [ "$_pu_rc" = "0" ]; then
    info "removed Pi package $_rm_source"
  else
    [ -n "$_pu_out" ] && printf '%s\n' "$_pu_out" >&2
    warn "pi remove $_rm_source refused or failed (exit $_pu_rc); continuing with the Herdr uninstall"
  fi

  # Legacy managed-copy removal only when still owned (sha match). Never
  # deletes unowned content; never touches user settings.
  if [ -L "$LEGACY_DEST" ]; then
    warn "preserving $LEGACY_DEST (symlink, not the managed copy)"
  elif [ ! -e "$LEGACY_DEST" ]; then
    info "legacy managed copy already absent: $LEGACY_DEST"
  elif [ ! -f "$LEGACY_DEST" ]; then
    warn "preserving $LEGACY_DEST (not a regular file)"
  else
    _u_rec=""
    _u_rec="$(legacy_record_sha)" || _u_rec=""
    if [ -z "$_u_rec" ]; then
      warn "preserving $LEGACY_DEST (no managed-copy ownership record)"
    else
      _u_cur="$(sha_of "$LEGACY_DEST")"
      if [ -n "$_u_cur" ] && [ "$_u_cur" = "$_u_rec" ]; then
        rm -f "$LEGACY_DEST" || die "could not remove $LEGACY_DEST"
        info "removed owned legacy copy $LEGACY_DEST"
      else
        warn "preserving $LEGACY_DEST (modified since install; ownership checksum differs)"
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
