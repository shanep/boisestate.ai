#!/bin/sh
# Sets up Claude Code on boisestate.ai in one step. Run it in a terminal with:
#
#   curl -fsSL https://raw.githubusercontent.com/shanep/boisestate.ai/master/install.sh | sh
#
# It installs whatever is missing (git, Node, Claude Code, the boisestate
# plugin and command), puts ~/.local/bin on your PATH, and asks for your
# boisestate.ai API key. It skips anything already done, so it is safe to run
# again, and a second run updates the plugin.
#
# It is plain POSIX sh so it works with sh, bash, dash and zsh on macOS and
# Linux. The work happens in main() at the bottom, so a download that stops
# halfway runs nothing.

set -eu

REPO_URL='https://github.com/shanep/boisestate.ai.git'
MARKETPLACE='boisestate-ai'
PLUGIN='boisestate@boisestate-ai'
KEY_URL='https://boisestate.ai/settings'
NODE_DIST='https://nodejs.org/dist/latest-v24.x'
CLAUDE_INSTALLER='https://claude.ai/install.sh'
MARK='# Added by the boisestate.ai installer'
STEPS=6

usage() {
  cat <<'EOF'
Sets up Claude Code on boisestate.ai: git, Node, Claude Code, the boisestate
plugin and command, your PATH, and your API key.

Usage:
  curl -fsSL https://raw.githubusercontent.com/shanep/boisestate.ai/master/install.sh | sh
  curl -fsSL .../install.sh | sh -s -- [options]
  sh install.sh [options]

Options:
  --skip-login      Do not ask for the API key. Run `boisestate login` later.
  --no-modify-path  Do not add ~/.local/bin to your shell's startup file.
  -h, --help        Show this help.

It is safe to run more than once. A second run updates the plugin.
EOF
}

# Output -------------------------------------------------------------------

setup_colors() {
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
    BOLD=$(printf '\033[1m')
    DIM=$(printf '\033[2m')
    RED=$(printf '\033[31m')
    GREEN=$(printf '\033[32m')
    YELLOW=$(printf '\033[33m')
    BLUE=$(printf '\033[34m')
    RESET=$(printf '\033[0m')
  else
    BOLD='' DIM='' RED='' GREEN='' YELLOW='' BLUE='' RESET=''
  fi
}

# Shows paths in the home folder as ~/..., which is shorter and easier to read.
tildify() {
  awk -v home="$HOME/" '{
    out = ""
    while ((i = index($0, home)) > 0) {
      out = out substr($0, 1, i - 1) "~/"
      $0 = substr($0, i + length(home))
    }
    print out $0
  }'
}

say() { printf '  %s\n' "$*" | tildify; }
ok() { printf '  %s+%s %s\n' "$GREEN" "$RESET" "$*" | tildify; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*" | tildify >&2; }

step() {
  STEP=$((STEP + 1))
  printf '\n%s%s[%d/%d] %s%s\n' "$BOLD" "$BLUE" "$STEP" "$STEPS" "$*" "$RESET"
}

die() {
  printf '\n  %sx %s%s\n' "$RED$BOLD" "$1" "$RESET" >&2
  shift
  for line in "$@"; do
    printf '    %s\n' "$line" >&2
  done
  exit 1
}

# Runs when the script exits for any reason. It removes the scratch folder
# and, when the setup did not finish, says how to pick it back up.
finish() {
  status=$?
  if [ -n "${SCRATCH:-}" ]; then
    rm -rf "$SCRATCH"
  fi
  if [ "$status" -ne 0 ] && [ "${FINISHED:-0}" != 1 ]; then
    printf '\n  %sThe setup stopped before it finished.%s\n' "$BOLD" "$RESET" >&2
    printf '  Fix the problem above and run the same command again. It skips the\n' >&2
    printf '  steps that already worked. If you are stuck, send your instructor\n' >&2
    printf '  everything this printed.\n' >&2
  fi
  exit "$status"
}

# Helpers -------------------------------------------------------------------

# Finds a program on PATH, skipping the Windows folders WSL adds, since a
# Windows node or claude cannot run the Linux plugin.
find_cmd() {
  old_ifs=$IFS
  IFS=:
  for dir in $PATH; do
    IFS=$old_ifs
    [ -n "$dir" ] || continue
    if [ "$IS_WSL" = 1 ]; then
      case $dir in /mnt/[a-z]/*) continue ;; esac
    fi
    if [ -f "$dir/$1" ] && [ -x "$dir/$1" ]; then
      printf '%s\n' "$dir/$1"
      return 0
    fi
  done
  IFS=$old_ifs
  return 1
}

on_path() {
  case ":$ORIGINAL_PATH:" in
    *":$1:"* | *":$1/:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# True when there is a terminal to ask the student something, even under
# `curl | sh`, where stdin is the script itself.
have_tty() {
  [ -z "${BOISESTATE_NO_TTY:-}" ] && (: </dev/tty) 2>/dev/null
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 --timeout=20 -O "$2" "$1"
  else
    die 'This needs curl or wget to download things, and neither is installed.' \
      'Install curl with your package manager and run this again.'
  fi
}

# Runs a command up to 3 times, since a network blip should not end the setup.
retry() {
  tries=1
  while ! "$@"; do
    if [ "$tries" -ge 3 ]; then
      return 1
    fi
    warn "That did not work. Trying again in $((tries * 5)) seconds."
    sleep $((tries * 5))
    tries=$((tries + 1))
  done
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    openssl dgst -sha256 -r "$1" | cut -d ' ' -f 1
  fi
}

# Installs Linux packages with whatever package manager the system has.
install_packages() {
  if [ "$(id -u)" = 0 ]; then
    sudo=''
  elif command -v sudo >/dev/null 2>&1; then
    sudo='sudo'
    say "Installing $* needs sudo. If it asks for a password, type the one you"
    say 'log in with. Nothing shows as you type, that is normal.'
  else
    die "Install $* with your package manager, then run this again." \
      'This script could not do it for you since sudo is not installed.'
  fi
  # sudo asks for the password on the terminal itself, so stdin can be empty.
  if command -v apt-get >/dev/null 2>&1; then
    $sudo apt-get update -qq </dev/null && $sudo apt-get install -y -qq "$@" </dev/null
  elif command -v dnf >/dev/null 2>&1; then
    $sudo dnf install -y "$@" </dev/null
  elif command -v yum >/dev/null 2>&1; then
    $sudo yum install -y "$@" </dev/null
  elif command -v pacman >/dev/null 2>&1; then
    $sudo pacman -Sy --noconfirm "$@" </dev/null
  elif command -v zypper >/dev/null 2>&1; then
    $sudo zypper --non-interactive install "$@" </dev/null
  elif command -v apk >/dev/null 2>&1; then
    $sudo apk add "$@" </dev/null
  else
    die "Install $* with your package manager, then run this again." \
      'This script does not know the package manager on this system.'
  fi || die "Could not install $*. The error is above." \
    'Install it with your package manager, then run this again.'
}

# True when the node at $1 is 22.3 or newer.
node_ok() {
  "$1" -e 'const [a, b] = process.versions.node.split(".").map(Number);
process.exit(a > 22 || (a === 22 && b >= 3) ? 0 : 1);' </dev/null >/dev/null 2>&1
}

# Steps ---------------------------------------------------------------------

check_computer() {
  step 'Checking your computer'
  if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then
    die 'Run this without sudo.' \
      'It installs into your home folder and asks for sudo itself if it needs it.'
  fi
  if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ] || [ ! -w "$HOME" ]; then
    die "Your home folder (${HOME:-not set}) is missing or read-only."
  fi

  IS_WSL=0
  case $(uname -s) in
    Darwin) PLATFORM=darwin ;;
    Linux)
      PLATFORM=linux
      if grep -qi microsoft /proc/version 2>/dev/null; then
        IS_WSL=1
      fi
      ;;
    MINGW* | MSYS* | CYGWIN*)
      die 'This runs on macOS and Linux. On Windows, use WSL.' \
        'Open PowerShell as administrator, run: wsl --install' \
        'Restart, open the Ubuntu app, and run this command there.'
      ;;
    *) die "This runs on macOS and Linux, not $(uname -s)." ;;
  esac

  case $(uname -m) in
    x86_64 | amd64) ARCH=x64 ;;
    arm64 | aarch64) ARCH=arm64 ;;
    *) die "This needs a 64-bit Intel or ARM computer, not $(uname -m)." ;;
  esac
  # A Terminal running under Rosetta reports x86_64 on an Apple chip.
  if [ "$PLATFORM" = darwin ] && [ "$ARCH" = x64 ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    ARCH=arm64
  fi

  if [ "$PLATFORM" = darwin ]; then
    ok "macOS $(sw_vers -productVersion 2>/dev/null || true) on $ARCH"
  elif [ "$IS_WSL" = 1 ]; then
    ok "Linux on $ARCH, inside WSL"
  else
    ok "Linux on $ARCH"
  fi

  # git is how Claude Code downloads plugins.
  if [ "$PLATFORM" = darwin ] && ! xcode-select -p >/dev/null 2>&1; then
    xcode-select --install >/dev/null 2>&1 || true
    die 'macOS needs its Command Line Tools for git.' \
      'A window should have opened asking to install them. Click Install and' \
      'wait for it to finish (it takes a few minutes), then run this again.' \
      'No window? Run: xcode-select --install'
  fi
  if ! find_cmd git >/dev/null; then
    install_packages git
    find_cmd git >/dev/null || die 'git did not install. Install it yourself and run this again.'
  fi
  ok "$(git --version)"
}

setup_node() {
  step 'Node'
  NODE=''
  NODE_IS_OURS=0
  if found=$(find_cmd node) && node_ok "$found"; then
    NODE=$found
  elif [ -x "$BIN/node" ] && node_ok "$BIN/node"; then
    NODE=$BIN/node
  elif [ -x "$NODE_HOME/bin/node" ] && node_ok "$NODE_HOME/bin/node"; then
    NODE=$NODE_HOME/bin/node
    NODE_IS_OURS=1
  fi

  if [ -n "$NODE" ]; then
    ok "Node $("$NODE" --version) at $NODE"
  else
    if [ -n "${found:-}" ]; then
      say "The node at $found is $("$found" --version 2>/dev/null || echo 'too old'), and boisestate needs 22.3 or newer."
      say 'This installs a newer one in your home folder and leaves that one alone.'
    fi
    install_node
    NODE=$NODE_HOME/bin/node
    NODE_IS_OURS=1
    ok "Installed Node $("$NODE" --version) in $NODE_HOME"
  fi

  if [ "$NODE_IS_OURS" = 1 ]; then
    mkdir -p "$BIN"
    for tool in node npm npx; do
      ln -sf "$NODE_HOME/bin/$tool" "$BIN/$tool"
    done
  fi

  # The student's own shell has to find this node too, ahead of any older one.
  first=$(PATH=$ORIGINAL_PATH find_cmd node || true)
  if [ -z "$first" ] || ! node_ok "$first"; then
    NEED_PATH_FIRST=1
  fi
}

install_node() {
  if [ "$PLATFORM" = linux ] &&
    { ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; }; then
    die 'This Linux uses musl (Alpine?), and Node does not ship a build for it.' \
      'Install Node 22.3 or newer with your package manager, then run this again.'
  fi
  for tool in tar gzip; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      install_packages "$tool"
    fi
  done

  say 'Downloading Node from nodejs.org.'
  fetch "$NODE_DIST/SHASUMS256.txt" "$SCRATCH/SHASUMS256.txt" ||
    die 'Could not reach nodejs.org. Check your internet connection and run this again.'
  line=$(grep -E "  node-v[0-9.]+-$PLATFORM-$ARCH\\.tar\\.gz\$" "$SCRATCH/SHASUMS256.txt" | head -n 1 || true)
  [ -n "$line" ] || die "nodejs.org has no Node for $PLATFORM-$ARCH."
  sum=${line%% *}
  file=${line##* }
  fetch "$NODE_DIST/$file" "$SCRATCH/$file" ||
    die 'The Node download failed. Check your internet connection and run this again.'
  if [ "$(sha256_of "$SCRATCH/$file")" != "$sum" ]; then
    die 'The Node download is damaged (its checksum does not match). Run this again.'
  fi

  mkdir -p "$SCRATCH/node"
  tar -xzf "$SCRATCH/$file" -C "$SCRATCH/node"
  unpacked=$SCRATCH/node/${file%.tar.gz}
  node_ok "$unpacked/bin/node" || die 'The new Node does not run on this computer.'

  # Swap the new one in only once it works, so a failed update keeps the old.
  rm -rf "$NODE_HOME.old"
  if [ -e "$NODE_HOME" ]; then
    mv "$NODE_HOME" "$NODE_HOME.old"
  fi
  mv "$unpacked" "$NODE_HOME"
  rm -rf "$NODE_HOME.old"
}

setup_claude() {
  step 'Claude Code'
  if CLAUDE=$(find_cmd claude); then
    ok "Claude Code $("$CLAUDE" --version </dev/null 2>/dev/null | head -n 1) at $CLAUDE"
  else
    say "Installing Claude Code with Anthropic's installer."
    command -v bash >/dev/null 2>&1 || install_packages bash
    fetch "$CLAUDE_INSTALLER" "$SCRATCH/claude-install.sh" ||
      die 'Could not download the Claude Code installer. Check your internet connection and run this again.'
    bash "$SCRATCH/claude-install.sh" </dev/null ||
      die 'The Claude Code installer failed. Its message is above.'
    CLAUDE=$(find_cmd claude) ||
      die "Claude Code installed, but this cannot find the claude command in $BIN."
    ok "Installed Claude Code $("$CLAUDE" --version </dev/null 2>/dev/null | head -n 1)"
  fi

  # Plugins need a recent Claude Code.
  if ! "$CLAUDE" plugin --help </dev/null >/dev/null 2>&1; then
    say 'This Claude Code is too old for plugins, so updating it.'
    "$CLAUDE" update </dev/null || true
    "$CLAUDE" plugin --help </dev/null >/dev/null 2>&1 ||
      die 'Claude Code is too old for plugins and did not update.' \
        'Update it (claude update) or reinstall it, then run this again.'
  fi
}

setup_plugin() {
  step 'The boisestate plugin'
  plugins=$CLAUDE_DIR/plugins
  if grep -q "\"$MARKETPLACE\"" "$plugins/known_marketplaces.json" 2>/dev/null; then
    retry "$CLAUDE" plugin marketplace update "$MARKETPLACE" </dev/null ||
      die 'Could not update the boisestate.ai plugin list from GitHub.'
  else
    retry "$CLAUDE" plugin marketplace add "$SOURCE" </dev/null ||
      die 'Could not add the boisestate.ai plugin list from GitHub.'
  fi
  # install does nothing when it is already there, and update gets the newest.
  retry "$CLAUDE" plugin install "$PLUGIN" </dev/null ||
    die 'Could not install the boisestate plugin.'
  retry "$CLAUDE" plugin update "$PLUGIN" </dev/null ||
    die 'Could not update the boisestate plugin.'

  BUNDLE=$("$NODE" -e '
const fs = require("node:fs");
const path = require("node:path");
const [list, id] = process.argv.slice(1);
const entries = JSON.parse(fs.readFileSync(list, "utf8")).plugins[id] || [];
for (const entry of entries) {
  const bundle = path.join(entry.installPath, "dist", "boisestate.cjs");
  if (fs.existsSync(bundle)) {
    console.log(bundle);
    process.exit(0);
  }
}
process.exit(1);
' "$plugins/installed_plugins.json" "$PLUGIN" </dev/null) ||
    die 'The plugin installed, but this cannot find its files.' \
      "Look in $plugins/installed_plugins.json for $PLUGIN."
}

setup_command() {
  step 'The boisestate command'
  output=$("$NODE" "$BUNDLE" install "$BIN" </dev/null 2>&1) ||
    die "Could not write the boisestate command to $BIN." "$output"
  SHIM=$BIN/boisestate
  ok "Wrote $SHIM"

  if on_path "$BIN" && [ "${NEED_PATH_FIRST:-0}" = 0 ]; then
    ok "$BIN is already on your PATH"
    return
  fi
  if [ "$NO_MODIFY_PATH" = 1 ]; then
    warn "Skipped adding $BIN to your PATH (--no-modify-path)."
    warn 'Add it to the front of your PATH yourself.'
    return
  fi
  case $(basename "${SHELL:-sh}") in
    zsh) add_path_line "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      add_path_line "$HOME/.bashrc"
      # macOS Terminal opens login shells, which read only the first of these.
      if [ "$PLATFORM" = darwin ]; then
        profile=$HOME/.bash_profile
        for candidate in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
          if [ -f "$candidate" ]; then
            profile=$candidate
            break
          fi
        done
        add_path_line "$profile"
      fi
      ;;
    fish)
      conf=${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/boisestate-ai.fish
      mkdir -p "$(dirname "$conf")"
      # shellcheck disable=SC2016 # fish expands these when it starts.
      printf '%s\nset -gx PATH $HOME/.local/bin $PATH\n' "$MARK" >"$conf"
      ok "Added $BIN to your PATH in $conf"
      PATH_CHANGED=1
      ;;
    *) add_path_line "$HOME/.profile" ;;
  esac
}

add_path_line() {
  if grep -qF "$MARK" "$1" 2>/dev/null; then
    ok "$BIN is already in $1"
  else
    # shellcheck disable=SC2016 # The shell expands these when it starts.
    printf '\n%s\n%s\n' "$MARK" 'export PATH="$HOME/.local/bin:$PATH"' >>"$1"
    ok "Added $BIN to your PATH in $1"
  fi
  PATH_CHANGED=1
}

key_saved() {
  "$NODE" "$SHIM" status </dev/null 2>/dev/null | grep -Eq '^key: (saved|from)'
}

open_browser() {
  # Over ssh the browser would open on the other computer.
  if [ -n "${SSH_CONNECTION:-}" ]; then
    return
  elif [ "$PLATFORM" = darwin ]; then
    open "$1" >/dev/null 2>&1 || true
  elif [ "$IS_WSL" = 1 ]; then
    if command -v wslview >/dev/null 2>&1; then
      wslview "$1" >/dev/null 2>&1 || true
    else
      # explorer.exe opens the URL and then exits 1 no matter what.
      explorer.exe "$1" >/dev/null 2>&1 || true
    fi
  elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1" >/dev/null 2>&1 || true
  fi
}

setup_key() {
  step 'Your boisestate.ai API key'
  if key_saved; then
    ok 'Your API key is already saved'
    return
  fi
  if [ "$SKIP_LOGIN" = 1 ]; then
    warn 'Skipped (--skip-login). Run: boisestate login, when you have your key.'
    return
  fi
  if ! have_tty; then
    warn 'There is no terminal here to type the key into.'
    warn 'Run: boisestate login, to save it yourself.'
    return
  fi

  say "Get your key from $KEY_URL, copy it,"
  say 'and paste it below. Nothing shows as you paste, that is on purpose.'
  say "${BOLD}Never paste the key into a Claude chat.${RESET} It goes here and nowhere else."
  open_browser "$KEY_URL"
  printf '\n'
  for attempt in 1 2; do
    if "$NODE" "$SHIM" login </dev/tty && key_saved; then
      return
    fi
    if [ "$attempt" = 1 ]; then
      say 'That did not save. Try once more, or press Enter on an empty line to skip.'
    fi
  done
  warn 'No key saved. Run: boisestate login, when you have it.'
}

report() {
  FINISHED=1
  printf '\n%s%sAll set!%s\n' "$BOLD" "$GREEN" "$RESET"
  "$NODE" "$SHIM" status </dev/null 2>/dev/null | sed 's/^/  /' | tildify || true
  printf '\n%sNext:%s\n' "$BOLD" "$RESET"
  n=1
  if [ "${PATH_CHANGED:-0}" = 1 ]; then
    say "$n. Close this terminal and open a new one, so it picks up the new PATH."
    n=$((n + 1))
  fi
  if ! key_saved; then
    say "$n. Run ${BOLD}boisestate login${RESET} and paste your key from $KEY_URL"
    n=$((n + 1))
  fi
  say "$n. Go to a project folder:   ${BOLD}cd your-project${RESET}"
  n=$((n + 1))
  say "$n. Start Claude Code:         ${BOLD}boisestate${RESET}"
  n=$((n + 1))
  say "$n. When it asks if you trust the folder, pick ${BOLD}Yes, I trust this folder${RESET}."
  printf '\n  %sRun this script again any time to update. Help: boisestate help%s\n\n' "$DIM" "$RESET"
}

main() {
  SKIP_LOGIN=0
  NO_MODIFY_PATH=0
  for arg in "$@"; do
    case $arg in
      --skip-login) SKIP_LOGIN=1 ;;
      --no-modify-path) NO_MODIFY_PATH=1 ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        printf 'Unknown option: %s\n\n' "$arg" >&2
        usage >&2
        exit 2
        ;;
    esac
  done

  setup_colors
  STEP=0
  IS_WSL=0
  BIN=$HOME/.local/bin
  DATA=$HOME/.local/share/boisestate-ai
  NODE_HOME=$DATA/node
  CLAUDE_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
  SOURCE=${BOISESTATE_MARKETPLACE:-$REPO_URL}
  # A wrong or private repo URL should fail, not sit waiting for a password.
  GIT_TERMINAL_PROMPT=0
  export GIT_TERMINAL_PROMPT
  ORIGINAL_PATH=$PATH
  # Everything this installs lands in ~/.local/bin, so look there first.
  PATH=$BIN:$PATH
  export PATH

  trap finish EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  printf '\n%sboisestate.ai setup%s\n' "$BOLD" "$RESET"
  printf '%sThis sets up Claude Code to run on boisestate.ai.%s\n' "$DIM" "$RESET"

  check_computer
  # Scratch space lives in the home folder, since /tmp can be mounted noexec.
  mkdir -p "$DATA"
  SCRATCH=$(mktemp -d "$DATA/tmp.XXXXXX")
  setup_node
  setup_claude
  setup_plugin
  setup_command
  setup_key
  report
}

main "$@"
