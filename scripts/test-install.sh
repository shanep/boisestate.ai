#!/bin/sh
# Runs install.sh the way a student would, twice, and checks what it left
# behind. CI runs it on macOS, Linux and WSL. It changes the home folder it runs
# in, so only run it on a throwaway machine or with HOME pointed somewhere else.
#
# It installs the plugin from a copy of this checkout instead of GitHub, so it
# tests the commit in front of it. With --from-github it runs the quickstart's one-line
# curl command instead, which tests what students get right now.

set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
url=https://raw.githubusercontent.com/shanep/boisestate.ai/master/install.sh
from_github=0
if [ "${1:-}" = --from-github ]; then
  from_github=1
else
  # Claude Code installs plugins from a marketplace, so wrap the checkout in a
  # throwaway one with the same name as the real shanep/claude-plugins.
  market=$(mktemp -d)
  mkdir -p "$market/.claude-plugin" "$market/boisestate"
  (cd "$root" && tar cf - --exclude .git --exclude node_modules .) |
    (cd "$market/boisestate" && tar xf -)
  cat >"$market/.claude-plugin/marketplace.json" <<'EOF'
{
  "name": "shanep",
  "owner": { "name": "Shane K. Panter" },
  "plugins": [{ "name": "boisestate", "source": "./boisestate" }]
}
EOF
  BOISESTATE_MARKETPLACE=$market
  export BOISESTATE_MARKETPLACE
fi

fail() {
  printf '\nFAIL: %s\n' "$*" >&2
  exit 1
}

section() {
  printf '\n==== %s\n' "$*"
}

# --skip-login, since a runner can have a terminal (WSL does) and the key
# prompt would wait on it forever. The key gets its own test below.
run_install() {
  if [ "$from_github" = 1 ]; then
    # sh exits 0 when the download is empty, so check the download first.
    curl -fsSI "$url" >/dev/null || fail "cannot download $url"
    curl -fsSL "$url" | sh -s -- --skip-login
  else
    sh "$root/install.sh" --skip-login </dev/null
  fi
}

section 'First run'
run_install

section 'Second run, which should skip everything'
run_install >"$HOME/second-run.log" 2>&1 || {
  cat "$HOME/second-run.log"
  fail 'the second run failed'
}
cat "$HOME/second-run.log"
grep -Eq 'Installed (Node|Claude Code)' "$HOME/second-run.log" &&
  fail 'the second run installed something again'

section 'Shell startup file'
shell=$(basename "${SHELL:-sh}")
case $shell in
  zsh) profile=${ZDOTDIR:-$HOME}/.zshrc ;;
  bash) profile=$HOME/.bashrc ;;
  *) profile=$HOME/.profile ;;
esac
count=$(grep -c 'Added by the boisestate.ai installer' "$profile" 2>/dev/null || true)
echo "$profile has the PATH line ${count:-0} times"
[ "${count:-0}" -le 1 ] || fail "the PATH line is in $profile more than once"

section 'A new terminal'
# Runs what a student types in a new terminal: the startup files decide PATH.
new_terminal() {
  case $shell in
    zsh) zsh -ic "$1" ;;
    bash)
      if [ "$(uname -s)" = Darwin ]; then
        bash -lc "$1"
      else
        bash -ic "$1"
      fi
      ;;
    *) sh -lc "$1" ;;
  esac
}
# shellcheck disable=SC2016 # The new terminal expands these, not this script.
new_terminal '
  set -e
  echo "boisestate: $(command -v boisestate)"
  echo "claude: $(command -v claude)"
  echo "node: $(command -v node) $(node --version)"
  node -e "const [a, b] = process.versions.node.split(\".\").map(Number);
    process.exit(a > 22 || (a === 22 && b >= 3) ? 0 : 1)"
  boisestate status
' 2>/dev/null || fail 'a new terminal cannot find boisestate, claude or a new enough node'

# The rest runs on the PATH a new terminal gets.
# shellcheck disable=SC2016 # The new terminal expands $PATH.
PATH=$(new_terminal 'printf "PATH=%s\n" "$PATH"' 2>/dev/null | sed -n 's/^PATH=//p' | tail -n 1)
export PATH

section 'Claude Code has the plugin'
claude plugin list </dev/null | tee "$HOME/plugins.txt"
grep -q 'boisestate@shanep' "$HOME/plugins.txt" || fail 'the plugin is not installed'
if [ "$from_github" = 1 ]; then
  claude plugin marketplace list </dev/null | grep -q 'github.com/shanep/claude-plugins' ||
    fail 'the plugin did not come from GitHub'
fi

# Only in CI, since on a Mac this would replace the real key in your keychain.
if [ -n "${CI:-}" ]; then
  section 'Saving and removing a key'
  printf 'ci-not-a-real-key\n' | boisestate login
  boisestate status | grep -q '^key: saved' || fail 'the key did not save'
  boisestate logout
  boisestate status | grep -q '^key: not saved' || fail 'the key did not go away'
fi

section 'The launcher starts the bridge and claude'
# A stand-in for claude: it asks the bridge for its models, and checks that
# the node on its PATH (the one the plugin's hook uses) is new enough.
fake=$HOME/fake-claude
cat >"$fake" <<'EOF'
#!/bin/sh
set -e
curl -fsS -H "authorization: Bearer $ANTHROPIC_AUTH_TOKEN" "$ANTHROPIC_BASE_URL/v1/models" >/dev/null
node -e 'const [a, b] = process.versions.node.split(".").map(Number);
  process.exit(a > 22 || (a === 22 && b >= 3) ? 0 : 1)'
echo "fake claude ran with $*"
exit 7
EOF
chmod +x "$fake"
status=0
BOISESTATE_API_KEY=ci-not-a-real-key BOISESTATE_CLAUDE=$fake boisestate -p hello || status=$?
[ "$status" = 7 ] || fail "the launcher exited $status, not the fake claude's 7"

section 'Everything passed'
