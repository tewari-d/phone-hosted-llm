# Phone chat (step 1)

Chat on Telegram with an AI model running on the phone itself (Samsung M30, Termux). The model works
offline. Only the Telegram messages use the internet.

- `bot.js`: the Telegram bot. It passes your messages to the model and sends back its replies. Node.js 22+.
- `verse.js`: the `/verse` command: a video script for one verse, from [../data/verses.json](../data/verses.json).
- `speak.js`: text to speech, offline, with a Piper voice run by sherpa-onnx's WebAssembly build (the only npm
  package; nothing to compile). Try it in Termux: `echo "Hello" | node speak.js out/hello.wav`.
- `start.sh`: loads the model (llama.cpp's `llama-server`), then starts the bot. Ctrl+C stops both.
- `setup.sh`: one-time install of Node.js, llama.cpp and ffmpeg, the model, the voice engine and four voices, and `.env`.
- `.env.example`: every setting, explained.

## Setup

1. In Telegram, open **@BotFather**, send `/newbot` and copy the token it gives you. Make a new bot;
   don't reuse the LinkedIn bot's token.
2. In Termux, install git once: `pkg install git`.
3. In Termux:
   ```bash
   git clone https://github.com/tewari-d/phone-hosted-llm ~/phone-hosted-llm
   cd ~/phone-hosted-llm/phone-chat
   bash setup.sh                              # downloads about 1.1 GB the first time
   nano .env                                  # paste the token after TELEGRAM_BOT_TOKEN=
   bash start.sh
   ```
4. Message your bot. It replies with your chat id. Put it after `OWNER_CHAT_ID=` in `.env`, press
   Ctrl+C, then run `bash start.sh` again. From then on the bot answers only you.

In Telegram:
- `/verse 2.47` writes a 1-minute video script for that verse (title, meaning, 3 lessons, narration) and sends the
  voiceover as a voice message. `/verse` alone picks a random verse. About 1.5 minutes for the script, then the voice.
- `/voices` reads the same line in every installed voice (`/voices bella`: only Bella). Pick one with `VOICE=...` in `phone.env`.
- Daily verse: at `DAILY_TIME` (India time, in `phone.env`; now 06:00) the bot picks a verse from chapters 2–18 and sends
  its script and voiceover. Leave `start.sh` running with the phone plugged in, and don't exit Termux (the wake lock).
- `/styles` reads a short narration in each speaking style (plain, natural, lively). Pick one with `VOICE_STYLE=...`.
  Piper has no emotion or emphasis controls; "natural" adds pauses and a slower opening and closing line.
- `/status` shows the model's state and the last reply's speed.
- `/reset` makes it forget the conversation.

The verses come from [../data/verses.json](../data/verses.json): Sanskrit from github.com/gita/gita (Unlicense) and Annie Besant's
English translation (1922, public domain). The model only explains them; it never writes the verse itself.
[../tools/build-verses.js](../tools/build-verses.js) builds the file on the laptop and checks that every English verse sits next to the right Sanskrit.

To get later changes onto the phone: `cd ~/phone-hosted-llm && git pull`. Your `.env` isn't in git, so a pull never touches it.

`phone.env` holds settings that travel through git (voice, speed, style, daily time), so nothing has to be typed
on the phone. `start.sh` copies each of its lines into `.env` on every start, and its values win. To change a
setting (e.g. `THREADS=2`), add it to `phone.env` in your own copy, then `git pull` on the phone. Keep the bot token
and your chat id in `.env` only: while this repo was private they travelled in `phone.env`, but a token in a public
repo lets anyone control your bot.

The voices (in `~/voices`) are Piper voices whose recordings are public domain or CC0, so they are fine for
monetised videos without credit: John and Norman (US, male), Kristin (US, female), Cori (British, female).
Kokoro (Apache 2.0, 132 MB): Heart, Bella, Nicole (US) and Emma (GB), the best-rated ones; far more natural but
about 20–30 minutes per voiceover on the M30. The videos use Bella at 0.9 speed; Kristin steps in if Kokoro fails.
Several popular Piper voices are not: Ryan and HFC are non-commercial only, and Lessac is for research.

## If something goes wrong

- **The bot doesn't answer:** while `start.sh` runs, open `http://127.0.0.1:8080` in the phone's browser.
  That's llama.cpp's own chat page. If you can chat there, the model is fine and the problem is in the bot or
  the token; if not, see `llm.log`.
- **It stops when the screen is off:** in Android Settings → Apps → Termux → Battery, turn off optimisation.
- **The model doesn't load:** the phone is probably short of memory. Close other apps, or switch to the smaller
  model: `MODEL=Qwen3-0.6B-Q4_K_M.gguf bash setup.sh`.
- **Slow replies:** try `THREADS=2` and `THREADS=8` in `.env` and keep the faster one.
- **Model errors:** see `llm.log` in this folder.
