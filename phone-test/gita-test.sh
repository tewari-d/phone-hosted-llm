#!/data/data/com.termux/files/usr/bin/bash
# SUPERSEDED (2026-11-06): phone-chat/ now does the model, the verse script and the voice. Kept for
# reference only. Do not reuse its voice: Lessac's licence is for research, not monetised videos.
# Gita video, phone test for a Samsung M30 (3 GB RAM) in Termux. Fully offline after the first run.
# It checks the two things the plan depends on, using verse 2.47:
#   1. Can a small local LLM (Qwen3 1.7B) write usable slide text and narration, and how fast?
#   2. How does offline text-to-speech (Piper) sound, and how fast?
# Run:   bash gita-test.sh                    English (default)
#        VIDEO_LANG=hindi bash gita-test.sh   Hindi, to compare
#        THREADS=2 bash gita-test.sh          to compare speed with fewer threads
# First run downloads about 1.3 GB (model, Ubuntu environment, voice). Later runs need no internet.
set -euo pipefail

WORK="$HOME/gita-test"
THREADS="${THREADS:-4}"
VIDEO_LANG="${VIDEO_LANG:-english}"
PORT=8091
MODEL="Qwen3-1.7B-Q4_K_M.gguf"
MODEL_URL="https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/$MODEL"
VOICES="https://huggingface.co/rhasspy/piper-voices/resolve/main"
case "$VIDEO_LANG" in
  english)
    VOICE="en_US-lessac-medium"
    VOICE_URL="$VOICES/en/en_US/lessac/medium/$VOICE"
    LANGUAGE_RULE="Write everything in simple, clear English."
    ;;
  hindi)
    VOICE="hi_IN-pratham-medium"
    VOICE_URL="$VOICES/hi/hi_IN/pratham/medium/$VOICE"
    LANGUAGE_RULE="Write everything in simple, correct Hindi (Devanagari script)."
    ;;
  *) echo "VIDEO_LANG must be english or hindi" >&2; exit 1 ;;
esac

step() { printf '\n== %s\n' "$1"; }
# Downloads once, resumes if interrupted.
fetch() {
  [ -s "$2" ] && return 0
  curl -fL --retry 3 -C - -o "$2.part" "$1" && mv "$2.part" "$2"
}

mkdir -p "$WORK"
cd "$WORK"

step "Installing packages"
pkg install -y llama-cpp curl jq proot-distro

step "Downloading the model (about 1.1 GB) and the $VIDEO_LANG voice (about 60 MB)"
fetch "$MODEL_URL" "$MODEL"
fetch "$VOICE_URL.onnx" "$VOICE.onnx"
fetch "$VOICE_URL.onnx.json" "$VOICE.onnx.json"

step "Free memory before loading the model"
free -m 2>/dev/null || head -3 /proc/meminfo

# ---------------------------------------------------------------- 1. Script from the local LLM
step "Loading the model ($THREADS threads)"
llama-server -m "$MODEL" -c 2048 -t "$THREADS" --host 127.0.0.1 --port "$PORT" >server.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 150); do
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  kill -0 "$SERVER" 2>/dev/null || break
  sleep 2
done
if ! curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  tail -20 server.log
  echo "The model did not load. On a 3 GB phone this usually means not enough free memory:" >&2
  echo "close other apps and run again." >&2
  exit 1
fi
echo "Model loaded."

SYSTEM='You write short, accurate scripts for videos about the Bhagavad Gita.'
read -r -d '' USER_MSG <<'EOF' || true
Verse: Bhagavad Gita 2.47
Sanskrit:
कर्मण्येवाधिकारस्ते मा फलेषु कदाचन।
मा कर्मफलहेतुर्भूर्मा ते सङ्गोऽस्त्वकर्मणि॥
English translation (Annie Besant, 1905): Thy business is with the action only, never with its fruits; so let not the fruit of action be thy motive, nor be thou to inaction attached.

Write the text for a one-minute video about this verse. __LANGUAGE_RULE__
Do not quote or invent other verses. Do not add claims the verse does not make.
- title: a short headline, at most 6 words
- meaning: the verse's meaning in one or two simple sentences
- points: exactly 3 short life lessons, each at most 10 words
- narration: the spoken script, 130 to 150 words, warm and simple, ending with one question to the viewer
/no_think
EOF
USER_MSG="${USER_MSG/__LANGUAGE_RULE__/$LANGUAGE_RULE}"

SCHEMA='{"type":"object","properties":{
  "title":{"type":"string"},
  "meaning":{"type":"string"},
  "points":{"type":"array","items":{"type":"string"},"minItems":3,"maxItems":3},
  "narration":{"type":"string"}
},"required":["title","meaning","points","narration"]}'

jq -n --arg sys "$SYSTEM" --arg user "$USER_MSG" --argjson schema "$SCHEMA" '{
  messages: [{role: "system", content: $sys}, {role: "user", content: $user}],
  temperature: 0.7,
  max_tokens: 1200,
  response_format: {type: "json_schema", json_schema: {name: "video", schema: $schema}},
  chat_template_kwargs: {enable_thinking: false}
}' >request.json

SCRIPT="script-$VIDEO_LANG.json"
NARRATION="narration-$VIDEO_LANG.txt"
AUDIO="voice-$VIDEO_LANG.wav"

step "Writing the $VIDEO_LANG script (a few minutes on this phone)"
START=$(date +%s)
curl -sf --max-time 1800 "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H 'Content-Type: application/json' -d @request.json >response.json
LLM_SECONDS=$(( $(date +%s) - START ))

jq -r '.choices[0].message.content' response.json >"$SCRIPT"
jq . "$SCRIPT" 2>/dev/null || { echo "The model's output was not valid JSON:"; cat "$SCRIPT"; }
jq -r '.timings // empty | "Speed: reading \(.prompt_per_second | floor) tokens/s, writing \(.predicted_per_second * 10 | floor / 10) tokens/s, \(.predicted_n) tokens written"' response.json || true
echo "Script took ${LLM_SECONDS}s"

# Free the model's memory before the voice step; a 3 GB phone can't hold both comfortably.
kill "$SERVER" 2>/dev/null || true
wait "$SERVER" 2>/dev/null || true

# ---------------------------------------------------------------- 2. Voice from Piper
jq -r '.narration' "$SCRIPT" >"$NARRATION"

step "Setting up Piper in an Ubuntu environment (first run only, a few minutes)"
proot-distro login ubuntu -- true 2>/dev/null || proot-distro install ubuntu
proot-distro login ubuntu -- bash -c '
  set -e
  if [ ! -x /opt/piper/bin/piper ]; then
    apt-get update -qq
    apt-get install -y -qq python3-venv >/dev/null
    python3 -m venv /opt/piper
    /opt/piper/bin/pip install -q piper-tts
  fi'

step "Speaking the narration"
START=$(date +%s)
proot-distro login ubuntu --bind "$WORK:/work" -- \
  /opt/piper/bin/piper --data-dir /work -m "$VOICE" -f "/work/$AUDIO" --input-file "/work/$NARRATION"
TTS_SECONDS=$(( $(date +%s) - START ))
echo "Voice took ${TTS_SECONDS}s"

step "Results"
echo "Script:  $WORK/$SCRIPT  (written in ${LLM_SECONDS}s)"
echo "Voice:   $WORK/$AUDIO  (spoken in ${TTS_SECONDS}s)"
if [ -d "$HOME/storage/downloads" ]; then
  cp "$SCRIPT" "$AUDIO" "$HOME/storage/downloads/"
  echo "Copied both to your phone's Downloads folder."
else
  echo "To get them in Downloads, run termux-setup-storage once, then run this script again."
fi
