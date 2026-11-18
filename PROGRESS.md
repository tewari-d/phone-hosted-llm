# Daily Gita video: progress

Last updated: 2026-11-18

> **Retired on 18 Nov 2026**, after steps 1–3 and the first part of step 6. The slides and the video
> (steps 4–5) were never built. The Telegram bot is deleted and the phone is cleaned up. This file is kept
> as the working record; the overview is in [README.md](README.md).

## Goal

Make a 1-minute Bhagavad Gita video every day, one verse per video, for YouTube and other platforms.
It must cost ₹0, and everything except posting runs offline on a Samsung Galaxy M30 (3 GB RAM) in Termux.

## Decisions so far

- **No AI image or video model.** They're far too slow for the M30. Slides are drawn from templates
  instead, like the LinkedIn bot's images (`..\LinkedIn\src\image\`), so every word is spelled right.
- **English narration** for now. A 1.7B model on a 3 GB phone writes much better English than Hindi.
  Hindi may come later.
- **No Sanskrit audio.** The verse appears on screen in Devanagari; the voiceover explains it.
- **The verse and its translation come from a stored dataset, never from the model.** The model writes
  only the explanation and slide text. Use a public-domain translation, e.g. Annie Besant (1905).
- **A script is generated daily on the phone.** The Telegram approval step (Post / Skip / Regenerate)
  is the review.
- **Model:** Qwen3 1.7B (Apache 2.0, so commercial use is fine). Fallback if it won't load: Qwen3 0.6B.
- **Built step by step.**

## Steps

| # | Step | Status |
|---|---|---|
| 1 | AI model on the phone plus a Telegram bot to chat with it ([phone-chat/](phone-chat/)) | **Done 2026-11-06.** Runs on the phone as @Dt_localllm_bot. Qwen3 1.7B, 4 threads: **5.5 tokens/s**, a 3-sentence answer in 13 s. Answers correct but generic without context. Token and chat id reached the phone via `phone-chat/phone.env` in git while the repo was private (removed before it went public). |
| 2 | Generate one verse's script (title, meaning, 3 lessons, narration) in a fixed format | **Works on the phone (2026-11-06):** about 85 s per script, 108–131 words; you liked the first two. Fixed the same day: the model turned Krishna's "Me" into "your true self" (18.66) and had Krishna "explain" a verse where Arjuna only asks (18.1), so the prompt now says who is speaking and what that means. Confirmed on 18.66: faithful now (99 s, 141 words). Narration length varied 83–141 words (a 1.7B model can't count words), so since 2026-11-07 it is asked for 5 parts (hook, explain, example, apply, close), which also suit one slide each. Still generic: titles and the closing line repeat a pattern; vary them with example titles/endings when the daily schedule is built. `/verse 2.47` in the bot. The model must answer in a fixed JSON shape (llama-server enforces it). Verses: [data/verses.json](data/verses.json), 701 verses, Sanskrit from gita/gita (Unlicense) + Annie Besant's English (1922, public domain), built and alignment-checked by [tools/build-verses.js](tools/build-verses.js). |
| 3 | Offline voiceover | **Works on the phone (2026-11-06).** Chosen voice: **Kristin (US)**, set in phone-chat/phone.env. Speaking styles (2026-11-07, `/styles`): Piper has no emotion/emphasis controls (no SSML), so "natural" (default) adds pauses (0.35 s after sentences, 0.75 s between narration parts) and reads the hook and closing line slower; "lively" also varies pitch and rhythm more. Next level if still flat: Kokoro (checked 2026-11-07: Apache 2.0; best voices Heart A and Bella A−, female only; 132 MB; runs in our engine; estimated 20–25 min per voiceover on the M30, or about 3 min with a native build compiled in Termux; hear it first at hf.co/spaces/hexgrad/Kokoro-TTS) and background music in step 5. Speed on the M30: about 17 s to start, then about 3 s per second of speech, so a 50 s narration takes about 3 min. [phone-chat/speak.js](phone-chat/speak.js): Piper voices run by sherpa-onnx 1.13.8's WebAssembly build (npm, pinned with checksum; works in Termux without compiling; 2.x dropped espeak-ng, which Piper voices need). Voices are public domain/CC0 only: John, Norman, Kristin, Cori (Ryan, HFC = non-commercial; Lessac = research licence). `/voices` to compare, `/verse` sends the voiceover. Not run on the laptop: auto mode blocks running downloaded code there. |
| 4 | Vertical 1080×1920 slides from a template, Devanagari font for the verse | Not started |
| 5 | FFmpeg: slides + voice + music into an MP4 | Not started |
| 6 | Daily schedule, video sent to Telegram for approval, then posted | **First part built 2026-11-07:** at DAILY_TIME (06:00 India time) the bot sends a random verse's (ch. 2–18) script and Kokoro Bella voiceover; Kristin if Kokoro fails. Approval buttons and posting: not started. |

## Next time

Nothing: the project is retired (2026-11-18). If it is ever picked up again, the next step was step 4 (slides),
after checking how long a Kokoro Bella voiceover really takes on the M30.

## Things to remember

- YouTube API uploads from an unverified app stay private, so post manually from the phone at first.
- YouTube may refuse monetisation for mass-produced, repetitive videos. Varied layouts and your own
  touch help.
- Keep the phone cool while it works. If it stays plugged in 24/7, check now and then that the
  battery isn't swelling.
