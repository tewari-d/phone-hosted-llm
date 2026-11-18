# Phone-hosted LLM: a Bhagavad Gita bot on a 3 GB phone

An AI model running entirely on a 2019 Samsung Galaxy M30 (3 GB RAM), with a private Telegram bot as its interface. It was built step by step toward one goal: a one-minute Bhagavad Gita video every day, made offline on the phone, at zero cost. The bot got as far as writing each day's verse script and speaking it with an offline voice.

> **Retired on 18 Nov 2026.** Steps 1–3 and the first part of step 6 worked; the slides and the video itself were never built. The Telegram bot is deleted and the phone is cleaned up (see [How it was shut down](#how-it-was-shut-down)). The code stays here for reference.

## At a glance

| | |
|---|---|
| **Phone** | Samsung Galaxy M30, 3 GB RAM, Android 10, Termux. No cloud, no GPU |
| **Model** | Qwen3 1.7B (Apache 2.0), 4-bit GGUF, about 1.1 GB, run by llama.cpp's `llama-server` |
| **Interface** | A Telegram bot that answers only its owner |
| **Verses** | 701 verses stored in a dataset: Sanskrit plus Annie Besant's public-domain English translation. The model never writes a verse |
| **Voice** | Offline text to speech: Piper voices and Kokoro, run by sherpa-onnx's WebAssembly build |
| **Running cost** | ₹0 |
| **Built** | 6–7 Nov 2026; retired 18 Nov 2026 |

## How far it got

| # | Step | Result |
|---|---|---|
| 1 | Model on the phone + Telegram chat | **Done.** 5.5 tokens/s with 4 threads; a 3-sentence answer in about 13 s. Correct but generic answers without context |
| 2 | One verse's video script in a fixed format | **Done.** Title, meaning, 3 lessons and a 5-part narration, in about 85–100 s per script |
| 3 | Offline voiceover | **Done.** Piper voices: about 17 s to start, then about 3 s per second of speech, so a 50 s narration took about 3 minutes |
| 4 | Vertical 1080×1920 slides with a Devanagari font | Not started |
| 5 | FFmpeg: slides + voice + music into an MP4 | Not started |
| 6 | Daily schedule, approval, posting | **First part built:** at 06:00 India time the bot sent a random verse's script and voiceover to Telegram. Approval and posting were not built |

## How it worked

```
  Samsung Galaxy M30 · Termux · bash start.sh
 ┌──────────────────────────────────────────────────────────────────┐
 │ llama-server (127.0.0.1:8080) ◄── bot.js ◄──► Telegram Bot API     │
 │   Qwen3 1.7B, thinking off         │   long polling, owner only    │
 │   JSON shape enforced              │                               │
 │                                    ├─ verse.js: verse from          │
 │                                    │    data/verses.json → script   │
 │                                    └─ speak.js: narration → voice   │
 │                                         (sherpa-onnx WASM, offline) │
 └──────────────────────────────────────────────────────────────────┘
  Only the Telegram messages use the internet. Nothing listens on it.
```

1. **`start.sh`** loads the model in `llama-server`, bound to the phone's own 127.0.0.1, waits until it's ready, then starts the bot. It also holds Termux's wake lock, so Android doesn't pause it with the screen off.
2. **`bot.js`** reads Telegram by long polling (no public address needed), obeys one chat id, and passes chat messages to the model. Commands: `/verse 2.47` (or `/verse` for a random one), `/voices`, `/styles`, `/status`, `/reset`.
3. **`verse.js`** takes the verse's Sanskrit and English from [data/verses.json](data/verses.json), and tells the model who is speaking and what that means. It asks for a fixed JSON shape (title, meaning, 3 lessons, a narration in 5 parts: hook, explain, example, apply, close), which `llama-server` enforces.
4. **`speak.js`** turns the narration into speech offline and sends it as a Telegram voice message. The optional "natural" speaking style adds pauses after sentences and between parts, and reads the opening and closing lines slower.
5. **Daily:** at `DAILY_TIME` (06:00) the bot picks a verse from chapters 2–18 and sends its script and a Kokoro voiceover, falling back to a Piper voice if Kokoro fails.

The verse dataset is built on a laptop by [tools/build-verses.js](tools/build-verses.js) from github.com/gita/gita (Sanskrit, Unlicense) and Wikisource (Annie Besant's English, public domain). It checks that every English verse sits next to the right Sanskrit.

## Lessons learned

1. **A 1.7B model is usable on a 3 GB phone,** at 5.5 tokens/s. Turn Qwen3's "thinking" off (`--jinja` plus `enable_thinking: false`), or every reply takes minutes longer.
2. **Never let a small model write scripture.** The verse and its translation come from a stored, checked dataset; the model only explains them.
3. **Small models mix up who is speaking.** It turned Krishna's "Me" into "your true self" (18.66), and had Krishna "explain" a verse where Arjuna only asks a question (18.1). Telling the model who speaks fixed both.
4. **Small models can't count words.** Asked for a word count, narrations ranged from 83 to 141 words. Asking for five named parts made the length steadier, and the parts map onto one slide each.
5. **English beats Hindi at this size.** A 1.7B model writes much better English than Hindi, so narration was English, with the verse shown in Devanagari.
6. **Check voice licences before you like a voice.** Several popular Piper voices (Ryan, HFC) are non-commercial only, and Lessac is for research. Only public-domain or CC0 voices were used: John, Norman, Kristin and Cori.
7. **WebAssembly avoids compiling on the phone.** sherpa-onnx's WASM build runs in Termux from npm with nothing to compile. It is pinned to 1.13.8, because 2.x dropped espeak-ng, which Piper voices need. The first test (`phone-test/`) needed a whole Ubuntu environment inside Termux just to run Piper.
8. **Piper has no emotion controls,** so pauses and pacing do the work. Kokoro sounds far more natural, but it was estimated at 20–30 minutes per voiceover on this phone.
9. **Secrets in git are convenient until you want to publish.** While the repo was private, the bot token reached the phone through a file in git. Publishing it meant deleting the bot first and starting from a single clean commit.

## What's in the repo

| Path | Contents |
|---|---|
| `phone-chat/` | The bot (`bot.js`), verse scripts (`verse.js`), voice (`speak.js`), `setup.sh`, `start.sh` and its own [README](phone-chat/README.md) |
| `data/verses.json` | 701 verses: Sanskrit and English |
| `tools/build-verses.js` | Builds and checks that dataset |
| `phone-test/gita-test.sh` | The first feasibility test, superseded by `phone-chat/` |
| `PROGRESS.md` | The working record: decisions, step status, timings |

## Running it yourself

Treat this as a reference, not a maintained product. You need an Android phone with at least 3 GB of RAM, Termux from F-Droid, and your own Telegram bot from @BotFather. The steps are in [phone-chat/README.md](phone-chat/README.md): `setup.sh` installs Node.js, llama.cpp and ffmpeg, then downloads the model (about 1.1 GB) and the voices. You put your token in `.env`, and `start.sh` runs everything. Keep the token in `.env`, never in a file git tracks.

## How it was shut down

On 18 Nov 2026:

- **Telegram:** the bot was deleted in @BotFather, which also cancels its token.
- **Phone:** the bot was stopped, and the code, the model, the voices and the old test environment were removed. Termux stays for future projects.
- **GitHub:** the phone's GitHub login was removed, and this repo was published from one clean commit, so the old token never appears in its history.

A sister project on the same phone, a LinkedIn auto-poster, is at [tewari-d/linked-in-poster-bot](https://github.com/tewari-d/linked-in-poster-bot). It also tried this model for writing posts and found it not accurate enough for expert content.

## Credits

Qwen3 by the Qwen team (Apache 2.0), GGUF files by Unsloth. llama.cpp (MIT). sherpa-onnx (Apache 2.0). Piper voices John, Norman, Kristin and Cori (public domain or CC0 recordings). Kokoro (Apache 2.0). Sanskrit text from github.com/gita/gita (Unlicense). Annie Besant's English translation (public domain) via Wikisource.
