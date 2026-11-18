#!/data/data/com.termux/files/usr/bin/bash
# One-time setup in Termux: Node.js, llama.cpp, ffmpeg, the model, the voice engine and voices, and
# the .env file. Safe to run again: it skips what is already there.
# Run:  bash setup.sh                                 Qwen3 1.7B (1.1 GB, better answers)
#       MODEL=Qwen3-0.6B-Q4_K_M.gguf bash setup.sh    Qwen3 0.6B (0.4 GB, faster but weaker; use it if 1.7B won't load)
set -euo pipefail

# Piper voices whose recordings allow commercial use without credit (public domain or CC0), in the
# small int8 form (about 21 MB each). Not used on purpose: Ryan, HFC and others are non-commercial
# only, and Lessac's licence is for research.
VOICES="en_US-john-medium-int8 en_US-norman-medium-int8 en_US-kristin-medium-int8 en_GB-cori-medium-int8"

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
MODEL="${MODEL:-Qwen3-1.7B-Q4_K_M.gguf}"
case "$MODEL" in
  Qwen3-1.7B-*) REPO="unsloth/Qwen3-1.7B-GGUF" ;;
  Qwen3-0.6B-*) REPO="unsloth/Qwen3-0.6B-GGUF" ;;
  *) echo "Unknown model: $MODEL" >&2; exit 1 ;;
esac
MODEL_PATH="$HOME/models/$MODEL"

step() { printf '\n== %s\n' "$1"; }

step "Installing Node.js, llama.cpp, ffmpeg and download tools"
pkg install -y nodejs-lts llama-cpp curl ffmpeg bzip2
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node $(node -v) is too old; the bot needs 22 or newer. Try: pkg upgrade" >&2
  exit 1
fi

step "Downloading $MODEL (once; resumes if interrupted)"
mkdir -p "$HOME/models"
if [ ! -s "$MODEL_PATH" ]; then
  curl -fL --retry 3 -C - -o "$MODEL_PATH.part" "https://huggingface.co/$REPO/resolve/main/$MODEL"
  mv "$MODEL_PATH.part" "$MODEL_PATH"
fi
ls -lh "$MODEL_PATH"

step "Installing the voice engine (sherpa-onnx, WebAssembly: nothing to compile)"
# npm ci installs exactly the version in package-lock.json and checks its checksum.
(cd "$APP_DIR" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

step "Downloading voices (once)"
mkdir -p "$HOME/voices"
for voice in $VOICES; do
  dir="$HOME/voices/vits-piper-$voice"
  if [ -d "$dir" ] && ls "$dir"/*.onnx >/dev/null 2>&1; then echo "$voice: already there"; continue; fi
  curl -fL --retry 3 -o "$dir.tar.bz2" "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-$voice.tar.bz2"
  tar -xjf "$dir.tar.bz2" -C "$HOME/voices"
  rm "$dir.tar.bz2"
  echo "$voice: installed"
done

step "Downloading the Kokoro voice model (once, 132 MB; Apache 2.0)"
KOKORO="kokoro-int8-multi-lang-v1_0"
if [ -f "$HOME/voices/$KOKORO/voices.bin" ]; then
  echo "Kokoro: already there"
else
  curl -fL --retry 3 -o "$HOME/voices/$KOKORO.tar.bz2" "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/$KOKORO.tar.bz2"
  tar -xjf "$HOME/voices/$KOKORO.tar.bz2" -C "$HOME/voices"
  rm "$HOME/voices/$KOKORO.tar.bz2"
  echo "Kokoro: installed"
fi

step "Preparing .env"
cd "$APP_DIR"
[ -f .env ] || cp .env.example .env
# A file edited on Windows has CRLF line endings; normalise them so every value reads cleanly.
sed -i 's/\r$//' .env
if grep -q '^MODEL_FILE=' .env; then
  sed -i "s|^MODEL_FILE=.*|MODEL_FILE=$MODEL_PATH|" .env
else
  echo "MODEL_FILE=$MODEL_PATH" >>.env
fi
grep -q '^TELEGRAM_BOT_TOKEN=.' .env && echo "Bot token: set" || echo "Bot token: NOT set yet"
grep -q '^OWNER_CHAT_ID=.' .env && echo "Owner chat id: set" || echo "Owner chat id: not set yet (the bot will tell you yours)"

cat <<EOF

Setup done. Next:
  1. Put your bot token in .env:   nano $APP_DIR/.env
  2. Start everything:             bash $APP_DIR/start.sh
  3. Message your bot on Telegram.
EOF
