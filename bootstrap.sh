#!/usr/bin/env bash
set -euo pipefail

# Bootstrap for the Parallax Editor system.
# Clones parallax-engine + parallax-editor side-by-side, installs deps, and
# verifies the local link between them.
#
# Usage:
#   ./bootstrap.sh [target-dir]
#   ./bootstrap.sh --check      (only verifies prerequisites)
#
# Optional env vars:
#   GITHUB_ORG   GitHub org/user to clone from (default: parallax-editor)
#   ENGINE_REPO  Engine repo name              (default: parallax-engine)
#   EDITOR_REPO  Editor repo name              (default: parallax-editor)

GITHUB_ORG="${GITHUB_ORG:-parallax-editor}"
ENGINE_REPO="${ENGINE_REPO:-parallax-engine}"
EDITOR_REPO="${EDITOR_REPO:-parallax-editor}"
REPOS=("$ENGINE_REPO" "$EDITOR_REPO")
TARGET_DIR="${1:-$(pwd)}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; }

check_prereqs() {
  local missing=0

  if command -v node &>/dev/null; then
    local node_major
    node_major=$(node --version | sed 's/v\([0-9]*\).*/\1/')
    if [ "$node_major" -ge 20 ]; then
      ok "Node $(node --version)"
    else
      fail "Node $(node --version) — requires >= 20. Install: brew install node@22"
      missing=1
    fi
  else
    fail "Node not found. Install: brew install node@22"
    missing=1
  fi

  if command -v yarn &>/dev/null; then
    ok "Yarn $(yarn --version)"
  else
    fail "Yarn not found. Install: npm install -g yarn"
    missing=1
  fi

  if command -v git &>/dev/null; then
    ok "Git $(git --version | awk '{print $3}')"
  else
    fail "Git not found. Install: xcode-select --install (macOS)"
    missing=1
  fi

  if command -v claude &>/dev/null; then
    ok "Claude Code CLI found"
  else
    warn "Claude Code CLI not found (optional; only needed for the AI chat panel). Install: npm install -g @anthropic-ai/claude-code"
  fi

  if command -v gh &>/dev/null; then
    ok "GitHub CLI $(gh --version | head -1 | awk '{print $3}')"
  else
    warn "GitHub CLI not found (used for the clone step). Install: brew install gh — or set up plain 'git clone' yourself."
  fi

  return $missing
}

echo "═══════════════════════════════════════════"
echo " Bootstrap — Parallax Editor"
echo "═══════════════════════════════════════════"
echo ""

echo "Checking prerequisites..."
echo ""
if ! check_prereqs; then
  echo ""
  fail "Missing prerequisites. Install them and re-run this script."
  exit 1
fi
echo ""

if [ "${1:-}" = "--check" ]; then
  echo ""
  ok "All prerequisites OK."
  exit 0
fi

echo "Target dir: $TARGET_DIR"
mkdir -p "$TARGET_DIR"
cd "$TARGET_DIR"

echo ""
echo "Cloning repositories from $GITHUB_ORG..."
for repo in "${REPOS[@]}"; do
  if [ -d "$repo" ]; then
    warn "$repo/ already exists, skipping clone."
  else
    echo "  Cloning $repo..."
    if command -v gh &>/dev/null; then
      gh repo clone "$GITHUB_ORG/$repo" "$repo"
    else
      git clone "https://github.com/$GITHUB_ORG/$repo.git" "$repo"
    fi
    ok "$repo cloned."
  fi
done

echo ""
echo "Installing dependencies (engine first)..."
cd "$ENGINE_REPO"
yarn install
ok "$ENGINE_REPO: dependencies installed."
cd ..

cd "$EDITOR_REPO"
yarn install
ok "$EDITOR_REPO: dependencies installed (link to $ENGINE_REPO active)."
cd ..

echo ""
echo "Verifying link..."
if [ -L "$EDITOR_REPO/node_modules/parallax-engine" ]; then
  ok "$EDITOR_REPO → parallax-engine (symlink OK)"
else
  fail "$EDITOR_REPO: symlink to parallax-engine not found."
  exit 1
fi

echo ""
ok "Bootstrap complete."
echo ""
echo "Next steps:"
echo "  cd $ENGINE_REPO && yarn dev    # watch-build the engine"
echo "  cd $EDITOR_REPO && yarn editor # start the editor on :3000"
