#!/bin/bash
# One-time setup: dependencies, speech model, Claude Code settings, MCP registration, claude-ticket on PATH.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
DATA="${VERMITTLUNG_DIR:-$HOME/.claude/vermittlung}"
NODE="$(command -v node)"
MODEL="$DATA/modelle/ggml-large-v3-turbo-q5_0.bin"

echo "→ npm install"
(cd "$REPO" && npm install --silent)

for tool in ffmpeg whisper-cli; do
  command -v "$tool" >/dev/null || { echo "Missing $tool – install with: brew install ffmpeg whisper-cpp"; exit 1; }
done
command -v tmux >/dev/null || echo "Optional: brew install tmux (lets the relay report what a busy session is doing)"

mkdir -p "$DATA/modelle"
if [ ! -f "$MODEL" ]; then
  echo "→ downloading Whisper model (~570 MB)"
  curl -L --fail -o "$MODEL" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
fi

echo "→ writing $DATA/settings.json"
sed -e "s|__NODE__|$NODE|" -e "s|__REPO__|$REPO|" "$REPO/settings.example.json" > "$DATA/settings.json"

echo "→ registering MCP server 'vermittlung' (user scope; stays silent unless started via claude-ticket)"
claude mcp remove --scope user vermittlung >/dev/null 2>&1 || true
claude mcp add --scope user vermittlung -- "$NODE" "$REPO/kanal.mjs"

mkdir -p "$HOME/.local/bin"
ln -sf "$REPO/claude-ticket" "$HOME/.local/bin/claude-ticket"
chmod +x "$REPO/claude-ticket"
echo "→ claude-ticket linked to ~/.local/bin (make sure it is on your PATH)"
echo
echo "Next: node $REPO/vermittlung.mjs einrichten   (paste your bot token, then pair with the code it prints)"
