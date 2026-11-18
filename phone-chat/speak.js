// Text to speech, offline: a Piper voice run by sherpa-onnx's WebAssembly build (no native code, so
// the same package works in Termux and on a PC). The bot runs this as a separate process, so the
// bot stays responsive and the voice's memory is freed afterwards.
//   echo "Hello there" | node speak.js out/hello.wav             WAV only
//   echo "Hello there" | node speak.js out/hello.ogg             also an OGG voice message (needs ffmpeg)
//   node speak.js --list                                          installed voices
// Options: --voice en_US-john-medium-int8 (default: VOICE in .env, else the first installed voice)
//          --style natural (default: VOICE_STYLE in .env, else natural; see STYLES)
// A blank line in the text separates parts (the narration's hook, explanation, ...): the voice
// pauses longer there. The last line printed is "RESULT {json}" with the timings, for the bot.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const VOICES_DIR = path.join(os.homedir(), 'voices');
const PREFIX = 'vits-piper-';
// Kokoro (Apache 2.0): one model with many voices, picked by number. Only the best-rated English
// ones are offered (grades from the model's VOICES.md): Heart A, Bella A-, Nicole B-, Emma B- (GB).
// It sounds far more natural than Piper but is about 10x slower on the phone.
const KOKORO_DIR = path.join(VOICES_DIR, 'kokoro-int8-multi-lang-v1_0');
const KOKORO_VOICES = { af_heart: 3, af_bella: 2, af_nicole: 6, bf_emma: 21 };

function installedVoices() {
  if (!fs.existsSync(VOICES_DIR)) return [];
  const piper = fs.readdirSync(VOICES_DIR)
    .filter((d) => d.startsWith(PREFIX) && fs.readdirSync(path.join(VOICES_DIR, d)).some((f) => f.endsWith('.onnx')))
    .map((d) => d.slice(PREFIX.length));
  const kokoro = fs.existsSync(path.join(KOKORO_DIR, 'voices.bin')) ? Object.keys(KOKORO_VOICES).map((v) => `kokoro-${v}`) : [];
  return [...piper, ...kokoro].sort();
}

// "en_US-john-medium-int8" → "John (US)"; "kokoro-af_bella" → "Bella (Kokoro, US)"
function voiceLabel(id) {
  const cap = (s) => `${s[0].toUpperCase()}${s.slice(1)}`;
  if (id.startsWith('kokoro-')) {
    const [accent, name] = id.slice('kokoro-'.length).split('_');
    return `${cap(name)} (Kokoro, ${accent.startsWith('b') ? 'GB' : 'US'})`;
  }
  const [lang, name] = id.split('-');
  return `${cap(name)} (${lang.split('_')[1]})`;
}

// Loads the voice. Returns the engine and the speaker number to pass to generate().
function loadVoice(sherpa, voice, style) {
  const engine = { numThreads: 1, debug: 0, provider: 'cpu' };
  if (voice.startsWith('kokoro-')) {
    const name = voice.slice('kokoro-'.length);
    const d = KOKORO_DIR;
    const english = path.join(d, name.startsWith('b') ? 'lexicon-gb-en.txt' : 'lexicon-us-en.txt');
    const tts = sherpa.createOfflineTts({
      offlineTtsModelConfig: {
        ...engine,
        offlineTtsKokoroModelConfig: {
          model: path.join(d, fs.readdirSync(d).find((f) => f.endsWith('.onnx'))),
          voices: path.join(d, 'voices.bin'),
          tokens: path.join(d, 'tokens.txt'),
          dataDir: path.join(d, 'espeak-ng-data'),
          // As in sherpa-onnx's documented setup for this model: English lexicon plus the Chinese one.
          lexicon: `${english},${path.join(d, 'lexicon-zh.txt')}`,
          lang: '',
          lengthScale: 1.0,
        },
      },
      ruleFsts: '',
      ruleFars: '',
      maxNumSentences: 1,
    });
    return { tts, sid: KOKORO_VOICES[name] };
  }
  const dir = path.join(VOICES_DIR, PREFIX + voice);
  const tts = sherpa.createOfflineTts({
    offlineTtsModelConfig: {
      ...engine,
      offlineTtsVitsModelConfig: {
        model: path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.onnx'))),
        tokens: path.join(dir, 'tokens.txt'),
        dataDir: path.join(dir, 'espeak-ng-data'),
        lexicon: '',
        noiseScale: style.noiseScale,
        noiseScaleW: style.noiseScaleW,
        lengthScale: 1.0,
      },
    },
    ruleFsts: '',
    ruleFars: '',
    maxNumSentences: 1,
  });
  return { tts, sid: 0 };
}

// espeak reads "Hrishîkesha" letter by letter; without the accents it sounds the word out.
const forSpeech = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim();

// Piper can't be told to sound emotional or to stress a word (it has no SSML). What makes it less
// flat: a pause after each sentence and a longer one between parts, a slower opening and closing
// line (they then carry more weight), and more variation in pitch (noiseScale) and rhythm
// (noiseScaleW). Speeds multiply VOICE_SPEED; pauses are in seconds.
const STYLES = {
  plain: { label: 'Plain (Piper as is)', noiseScale: 0.667, noiseScaleW: 0.8, sentencePause: 0, partPause: 0, edgeSpeed: 1, middleSpeed: 1 },
  natural: { label: 'Natural (pauses, calmer start and end)', noiseScale: 0.667, noiseScaleW: 0.8, sentencePause: 0.35, partPause: 0.75, edgeSpeed: 0.88, middleSpeed: 0.95 },
  lively: { label: 'Natural, livelier intonation', noiseScale: 0.85, noiseScaleW: 0.95, sentencePause: 0.35, partPause: 0.75, edgeSpeed: 0.88, middleSpeed: 0.95 },
};

function synthesize(text, voice, wavPath, style) {
  const sherpa = require('sherpa-onnx');
  const started = Date.now();
  const { tts, sid } = loadVoice(sherpa, voice, style);
  const loadSeconds = (Date.now() - started) / 1000;

  // VOICE_SPEED in .env: 1 is the voice's own pace, 0.9 is 10% slower.
  const base = Number(process.env.VOICE_SPEED) || 1.0;
  const parts = text.split(/\n\s*\n/).map(forSpeech).filter(Boolean);
  const chunks = [];
  let sampleRate = 22050;
  const say = (t, speed) => {
    const audio = tts.generate({ text: t, sid, speed });
    sampleRate = audio.sampleRate;
    chunks.push(audio.samples);
  };
  const pause = (seconds) => chunks.push(new Float32Array(Math.round(sampleRate * seconds)));

  if (!style.sentencePause && !style.partPause) {
    say(parts.join(' '), base);
  } else {
    parts.forEach((part, i) => {
      const edge = i === 0 || i === parts.length - 1;
      const speed = base * (edge ? style.edgeSpeed : style.middleSpeed);
      const sentences = part.split(/(?<=[.!?…])\s+(?=\S)/);
      sentences.forEach((sentence, j) => {
        say(sentence, speed);
        if (j < sentences.length - 1) pause(style.sentencePause);
      });
      if (i < parts.length - 1) pause(style.partPause);
    });
  }
  tts.free();

  const samples = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  chunks.reduce((at, c) => { samples.set(c, at); return at + c.length; }, 0);
  sherpa.writeWave(wavPath, { samples, sampleRate });
  return { loadSeconds, audioSeconds: samples.length / sampleRate };
}

// Telegram plays voice messages only as OGG/Opus.
function toOgg(wavPath, oggPath) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wavPath, '-c:a', 'libopus', '-b:a', '48k', oggPath]);
}

function main() {
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const args = process.argv.slice(2);
  const voices = installedVoices();
  if (args.includes('--list')) {
    console.log(voices.length ? voices.map((v) => `${v}  ${voiceLabel(v)}`).join('\n') : `No voices in ${VOICES_DIR}. Run: bash setup.sh`);
    return;
  }
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const voice = option('--voice') ?? (process.env.VOICE || voices[0]);
  const styleName = option('--style') ?? (process.env.VOICE_STYLE || 'natural');
  const out = args.find((a, i) => !a.startsWith('--') && !['--voice', '--style'].includes(args[i - 1]));
  if (!out) throw new Error('Usage: echo "text" | node speak.js out/file.ogg [--voice NAME] [--style natural]');
  if (!voices.includes(voice)) {
    throw new Error(`Voice "${voice}" isn't installed. Installed: ${voices.join(', ') || 'none (run: bash setup.sh)'}`);
  }
  if (!STYLES[styleName]) throw new Error(`Style "${styleName}" doesn't exist. Styles: ${Object.keys(STYLES).join(', ')}`);
  const text = fs.readFileSync(0, 'utf8');
  if (!text.trim()) throw new Error('No text on standard input.');

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const wavPath = out.endsWith('.ogg') ? out.replace(/\.ogg$/, '.wav') : out;
  const started = Date.now();
  const { loadSeconds, audioSeconds } = synthesize(text, voice, wavPath, STYLES[styleName]);
  if (out.endsWith('.ogg')) toOgg(wavPath, out);
  console.log(`RESULT ${JSON.stringify({
    voice,
    label: voiceLabel(voice),
    style: styleName,
    styleLabel: STYLES[styleName].label,
    wav: wavPath,
    file: out,
    audioSeconds: Math.round(audioSeconds * 10) / 10,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    loadSeconds: Math.round(loadSeconds * 10) / 10,
  })}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    // One line, so the bot can pass it on as is.
    if (err.code === 'MODULE_NOT_FOUND') console.error('The voice engine isn\'t installed. On the phone run: bash setup.sh');
    else if (err.code === 'ENOENT' && err.path === 'ffmpeg') console.error('ffmpeg isn\'t installed. On the phone run: bash setup.sh');
    else console.error(String(err.message).split('\n')[0]);
    process.exit(1);
  }
}

module.exports = { installedVoices, voiceLabel, forSpeech, STYLES };
