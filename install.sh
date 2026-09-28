#!/usr/bin/env bash
# comic-motion - instalador para macOS / Linux
# Deja la skill en ~/.claude/skills/comic-motion con sus dependencias.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.claude/skills/comic-motion"

need() { command -v "$1" >/dev/null 2>&1; }

echo "comic-motion → $DEST"

if ! need node; then
  if need brew; then brew install node; else echo "Instalá Node.js 20+ (https://nodejs.org) y volvé a correr."; exit 1; fi
fi
major=$(node -p "process.versions.node.split('.')[0]")
[ "$major" -ge 20 ] || { echo "Necesitás Node 20+ (tenés $major)."; exit 1; }

if ! need ffmpeg; then
  if need brew; then brew install ffmpeg
  elif need apt-get; then sudo apt-get update && sudo apt-get install -y ffmpeg
  else echo "Instalá ffmpeg y volvé a correr."; exit 1; fi
fi

if ! need claude; then
  echo "No encontré Claude Code. Instalalo con: curl -fsSL https://claude.ai/install.sh | bash"
fi

if [ "$SRC" != "$DEST" ]; then
  mkdir -p "$DEST"
  rsync -a --delete --exclude node_modules --exclude .git --exclude dist --exclude "*.local.md" "$SRC/" "$DEST/"
fi

cd "$DEST"
npm install --no-fund --no-audit
npm run build
npx playwright install chromium
node bin/comic.js presets >/dev/null

echo
echo "Listo. Abrí Claude Code en una carpeta de trabajo y pedile un motion comic."
echo "CLI: node \"$DEST/bin/comic.js\" help"
