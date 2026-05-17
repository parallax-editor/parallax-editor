#!/usr/bin/env bash
set -euo pipefail

# Bootstrap del sistema de sitios parallax de Daniela Reyes.
# Clona los 4 repos, instala dependencias y configura los links.
#
# Uso:
#   ./bootstrap.sh [directorio-destino]
#   ./bootstrap.sh --check   (solo verifica prerequisitos)

GITHUB_ORG="danielareyesarte"
REPOS=("parallax-engine" "daniela-reyes-site" "daniela-reyes-eventos" "parallax-editor")
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
      fail "Node $(node --version) — se necesita >= 20. Instalar: brew install node@22"
      missing=1
    fi
  else
    fail "Node no encontrado. Instalar: brew install node@22"
    missing=1
  fi

  if command -v yarn &>/dev/null; then
    ok "Yarn $(yarn --version)"
  else
    fail "Yarn no encontrado. Instalar: npm install -g yarn"
    missing=1
  fi

  if command -v git &>/dev/null; then
    ok "Git $(git --version | awk '{print $3}')"
  else
    fail "Git no encontrado. Instalar: xcode-select --install"
    missing=1
  fi

  if command -v claude &>/dev/null; then
    ok "Claude Code CLI encontrado"
  else
    warn "Claude Code CLI no encontrado (opcional para uso básico). Instalar: npm install -g @anthropic-ai/claude-code"
  fi

  if command -v gh &>/dev/null; then
    ok "GitHub CLI $(gh --version | head -1 | awk '{print $4}')"
  else
    warn "GitHub CLI no encontrado (necesario para clonar repos privados). Instalar: brew install gh"
    missing=1
  fi

  return $missing
}

echo "═══════════════════════════════════════════"
echo " Bootstrap — Sistema Parallax Daniela Reyes"
echo "═══════════════════════════════════════════"
echo ""

echo "Verificando prerequisitos..."
echo ""
if ! check_prereqs; then
  echo ""
  fail "Faltan prerequisitos. Instálalos y vuelve a correr este script."
  exit 1
fi
echo ""

if [ "${1:-}" = "--check" ]; then
  echo ""
  ok "Todos los prerequisitos OK."
  exit 0
fi

echo "Directorio destino: $TARGET_DIR"
mkdir -p "$TARGET_DIR"
cd "$TARGET_DIR"

echo ""
echo "Clonando repositorios..."
for repo in "${REPOS[@]}"; do
  if [ -d "$repo" ]; then
    warn "$repo/ ya existe, saltando clone."
  else
    echo "  Clonando $repo..."
    gh repo clone "$GITHUB_ORG/$repo" "$repo"
    ok "$repo clonado."
  fi
done

echo ""
echo "Instalando dependencias (engine primero)..."
cd parallax-engine
yarn install
ok "parallax-engine: dependencias instaladas."
cd ..

for repo in "daniela-reyes-site" "daniela-reyes-eventos" "parallax-editor"; do
  cd "$repo"
  yarn install
  ok "$repo: dependencias instaladas (link a parallax-engine activo)."
  cd ..
done

echo ""
echo "Verificando links..."
for repo in "daniela-reyes-site" "daniela-reyes-eventos" "parallax-editor"; do
  if [ -L "$repo/node_modules/parallax-engine" ]; then
    ok "$repo → parallax-engine (symlink OK)"
  else
    fail "$repo: symlink a parallax-engine NO encontrado."
    exit 1
  fi
done

echo ""
ok "Bootstrap completado. Todos los repos listos."
echo ""
echo "Próximo paso: cd parallax-engine && yarn dev"
