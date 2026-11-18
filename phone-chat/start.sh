#!/data/data/com.termux/files/usr/bin/bash
# Starts the model server, waits until the model is loaded, then runs the Telegram bot.
# Ctrl+C stops both.  Run:  bash start.sh
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo ".env is missing. Run: bash setup.sh" >&2; exit 1; }
sed -i 's/\r$//' .env

# Settings delivered through git (phone.env: bot token, owner chat id, ...) are copied into .env, so
# nothing has to be typed on the phone. Each KEY=value there replaces that key in .env.
if [ -f phone.env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="$(printf '%s' "$line" | sed 's/[[:space:]]*$//')"
    [[ "$line" =~ ^[A-Z_][A-Z0-9_]*= ]] || continue
    key="${line%%=*}"
    { grep -v "^$key=" .env || true; printf '%s\n' "$line"; } >.env.new
    mv .env.new .env
  done <phone.env
fi

setting() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
MODEL="$(setting MODEL_FILE)"
THREADS="$(setting THREADS)"
CONTEXT="$(setting CONTEXT)"
PORT="$(setting LLM_PORT)"
MODEL="${MODEL/#\~/$HOME}"
THREADS="${THREADS:-4}"
CONTEXT="${CONTEXT:-2048}"
PORT="${PORT:-8080}"

[ -s "$MODEL" ] || { echo "Model file not found: '$MODEL'. Run: bash setup.sh" >&2; exit 1; }

# Checks the bot token first, so a wrong one shows up in seconds instead of after the model loads.
node bot.js --check-token

echo "Loading $(basename "$MODEL") with $THREADS threads (up to a minute)..."
# --jinja: use the model's own chat template. Without it llama-server ignores bot.js's request to
# switch off Qwen3's long "thinking" step, and every reply takes minutes longer.
# -np 1: one conversation at a time, so it gets the whole context.
llama-server -m "$MODEL" -c "$CONTEXT" -t "$THREADS" --jinja -np 1 --host 127.0.0.1 --port "$PORT" >llm.log 2>&1 &
LLM=$!
# Keeps Android from pausing Termux while the screen is off. All of Termux shares this one lock, and
# the LinkedIn bot needs it too, so it is never released here.
termux-wake-lock 2>/dev/null || true
trap 'kill $LLM 2>/dev/null || true' EXIT

for _ in $(seq 1 90); do
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  kill -0 "$LLM" 2>/dev/null || break
  sleep 2
done
if ! curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  tail -20 llm.log
  echo "The model did not load. Usually that's not enough free memory: close other apps and try again," >&2
  echo "or switch to the smaller model:  MODEL=Qwen3-0.6B-Q4_K_M.gguf bash setup.sh" >&2
  exit 1
fi

echo "Model ready. Starting the Telegram bot. Ctrl+C stops everything."
node bot.js
