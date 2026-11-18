// Telegram chat with the AI model running on this phone. You message the bot; llama-server
// (started by start.sh) writes the answer, fully offline. Node 22+; the voice (speak.js) uses the
// one npm package, sherpa-onnx.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const verse = require('./verse');
const { installedVoices, voiceLabel, STYLES } = require('./speak');

const envFile = path.join(__dirname, '.env');
// A token already set in the shell wins: Node never overwrites a variable from .env.
const tokenFromShell = Boolean(process.env.TELEGRAM_BOT_TOKEN);
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
const OWNER_CHAT_ID = Number(process.env.OWNER_CHAT_ID) || null;
const MODEL_NAME = path.basename(process.env.MODEL_FILE ?? 'unknown model');
const LLM_URL = `http://127.0.0.1:${process.env.LLM_PORT || 8080}`;
const MAX_REPLY_TOKENS = Number(process.env.MAX_REPLY_TOKENS) || 400;
// Remembered conversation, in characters. Keeps it, the system prompt and the reply inside the
// model's 2048-token window.
const HISTORY_CHARS = 3000;
// Telegram allows 4096 characters per message; longer replies go out in parts.
const TELEGRAM_TEXT_LIMIT = 4000;
const SYSTEM_PROMPT = 'You are a helpful assistant running offline on a phone. '
  + 'Answer briefly and clearly, in plain text without Markdown.';

const HELP = [
  'I answer with the AI model running on your phone, fully offline.',
  'Just send a message. I remember the last few messages of our chat.',
  '',
  '/verse 2.47  a 1-minute video script and voiceover for that verse (/verse alone picks one at random)',
  '/voices  the same line in every installed voice, to choose one',
  '/styles  the same narration in each speaking style (pauses, pace), to choose one',
  '/reset  forget the conversation',
  '/status  model state and the last reply\'s speed',
].join('\n');

const history = new Map();
let lastReply = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => console.log(`${new Date().toLocaleString('en-GB')}  ${text}`);

// params is a plain object, or FormData when a file is uploaded.
async function telegram(method, params = {}, timeoutMs = 30_000) {
  const isForm = params instanceof FormData;
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: isForm ? {} : { 'content-type': 'application/json' },
      body: isForm ? params : JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // The token is part of the URL, so the URL never goes into errors or logs.
    throw new Error(`cannot reach Telegram (${method}): ${err.cause?.code ?? err.name}`);
  }
  const body = await res.json().catch(() => null);
  if (!body?.ok) {
    const err = new Error(`Telegram ${method} failed (${body?.error_code ?? res.status}): ${body?.description ?? res.statusText}`);
    err.code = body?.error_code ?? res.status;
    throw err;
  }
  return body.result;
}

// Says what looks wrong with a token Telegram rejected, without printing the token itself.
function tokenProblem() {
  if (tokenFromShell) {
    return 'TELEGRAM_BOT_TOKEN is also set in your shell, and that value is used instead of .env. '
      + 'Run: unset TELEGRAM_BOT_TOKEN (and remove it from ~/.bashrc if it is there).';
  }
  if (/^bot/i.test(TOKEN)) return 'it starts with "bot". Remove that: the token itself starts with digits.';
  if (/\s/.test(TOKEN)) return 'it contains a space or a line break. Put only the token after the = sign, on one line.';
  if (!/^\d+:[\w-]{30,}$/.test(TOKEN)) {
    return `it doesn't look like a bot token, which is digits, a colon, then about 35 letters and digits. `
      + `Yours is ${TOKEN.length} characters long, so part of it may have been cut off when pasting.`;
  }
  return 'its format is right, but Telegram doesn\'t know it. It probably has a typo, or it was replaced in '
    + '@BotFather (/revoke or /token makes the old one stop working). Copy it again from @BotFather.';
}

async function checkToken() {
  if (!TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is empty. Put your bot token in .env: nano .env');
  try {
    return await telegram('getMe');
  } catch (err) {
    // 401: a well-formed token Telegram doesn't know; 404: a malformed one.
    if (err.code === 401 || err.code === 404) throw new Error(`Telegram rejected the bot token in .env: ${tokenProblem()}`);
    throw err;
  }
}

async function send(chatId, text) {
  // Split by characters, not UTF-16 units, so an emoji is never cut in half.
  const chars = [...(text || '(empty reply)')];
  for (let i = 0; i < chars.length; i += TELEGRAM_TEXT_LIMIT) {
    await telegram('sendMessage', { chat_id: chatId, text: chars.slice(i, i + TELEGRAM_TEXT_LIMIT).join('') });
  }
}

// Telegram shows "typing..." (or "recording a voice message...") for 5 seconds per request, so it
// is renewed until the reply is ready.
function keepTyping(chatId, action = 'typing') {
  const ping = () => telegram('sendChatAction', { chat_id: chatId, action }).catch(() => {});
  ping();
  const timer = setInterval(ping, 4500);
  return () => clearInterval(timer);
}

// schema: a JSON schema the reply must follow; llama-server enforces it while the model writes.
async function askModel(messages, { maxTokens = MAX_REPLY_TOKENS, schema = null } = {}) {
  let res;
  try {
    res = await fetch(`${LLM_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages,
        max_tokens: maxTokens,
        temperature: 0.7,
        // Qwen3 "thinks" at length before answering by default; off, replies arrive much sooner.
        chat_template_kwargs: { enable_thinking: false },
        ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'reply', schema } } } : {}),
      }),
      signal: AbortSignal.timeout(20 * 60_000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('the model took over 20 minutes, so I stopped it.');
    throw new Error('the model isn\'t running. Start everything with: bash start.sh');
  }
  if (!res.ok) throw new Error(`the model server answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const choice = body.choices?.[0];
  return {
    text: (choice?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(),
    cutOff: choice?.finish_reason === 'length',
    timings: body.timings,
  };
}

// Drops the oldest question-and-answer pairs until the conversation fits the budget.
function trimHistory(messages) {
  const kept = [...messages];
  const size = () => kept.reduce((n, m) => n + m.content.length, 0);
  while (kept.length && size() > HISTORY_CHARS) kept.splice(0, 2);
  return kept;
}

async function status(chatId) {
  let state = 'not running (start it with: bash start.sh)';
  try {
    const res = await fetch(`${LLM_URL}/health`, { signal: AbortSignal.timeout(5000) });
    state = res.ok ? 'ready' : 'still loading';
  } catch { /* server not running */ }
  const last = lastReply
    ? `${lastReply.seconds}s${lastReply.speed ? `, ${lastReply.speed.toFixed(1)} tokens/s` : ''}`
    : 'none yet';
  return [
    `Model: ${MODEL_NAME} (${state})`,
    `Last reply took: ${last}`,
    `Remembered exchanges: ${(history.get(chatId)?.length ?? 0) / 2}`,
    `Daily verse: ${process.env.DAILY_TIME ? `${process.env.DAILY_TIME} India time` : 'off (set DAILY_TIME in phone.env)'}`,
    `Voice: ${process.env.VOICE || 'first installed'}, style ${process.env.VOICE_STYLE || 'natural'}, speed ${process.env.VOICE_SPEED || 1}`
      + (process.env.FALLBACK_VOICE ? `, fallback ${process.env.FALLBACK_VOICE}` : ''),
  ].join('\n');
}

async function onMessage(message) {
  const chatId = message.chat.id;
  if (message.chat.type !== 'private') return;
  if (!OWNER_CHAT_ID) {
    await send(chatId, `Your chat id is ${chatId}.\nPut OWNER_CHAT_ID=${chatId} in .env and restart, so the bot answers only you.`);
    return;
  }
  // Anyone can find a bot by its name; only the owner gets to use the phone's model.
  if (chatId !== OWNER_CHAT_ID) {
    log(`Ignored a message from chat ${chatId} (not the owner)`);
    return;
  }

  const text = message.text?.trim();
  if (!text) return send(chatId, 'I can only read text messages for now.');
  const command = text.startsWith('/') ? text.split(/[\s@]/)[0] : null;
  if (command === '/start' || command === '/help') return send(chatId, HELP);
  if (command === '/reset') {
    history.delete(chatId);
    return send(chatId, 'Done. I\'ve forgotten our conversation.');
  }
  if (command === '/status') return send(chatId, await status(chatId));
  if (command === '/verse') return writeVerseScript(chatId, text.slice(command.length).replace(/^@\S+/, ''));
  if (command === '/voices') return sampleVoices(chatId, text.slice(command.length).replace(/^@\S+/, ''));
  if (command === '/styles') return sampleStyles(chatId);

  const past = history.get(chatId) ?? [];
  const started = Date.now();
  const stopTyping = keepTyping(chatId);
  let answer;
  try {
    answer = await askModel([{ role: 'system', content: SYSTEM_PROMPT }, ...past, { role: 'user', content: text }]);
  } catch (err) {
    log(`Model error: ${err.message}`);
    return send(chatId, `Sorry, ${err.message}`);
  } finally {
    stopTyping();
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  lastReply = { seconds, speed: answer.timings?.predicted_per_second };
  log(`Replied in ${seconds}s (${answer.timings?.predicted_n ?? '?'} tokens)`);
  history.set(chatId, trimHistory([...past, { role: 'user', content: text }, { role: 'assistant', content: answer.text }]));
  await send(chatId, answer.text + (answer.cutOff ? '\n\n[Cut off at the length limit. Say "continue" for more.]' : ''));
}

// /verse 2.47: the model writes a video script for that verse. Kept out of the chat history.
async function writeVerseScript(chatId, arg) {
  let found;
  try {
    found = verse.findVerse(arg);
  } catch (err) {
    log(`Cannot read the verses: ${err.message}`);
    return send(chatId, 'Sorry, I can\'t read data/verses.json. Run: cd ~/phone-hosted-llm && git pull');
  }
  if (found.error) return send(chatId, found.error);
  const v = found.verse;
  await send(chatId, `Writing a script for verse ${v.id}. This takes about a minute.`);

  const started = Date.now();
  const stopTyping = keepTyping(chatId);
  let script;
  let answer;
  try {
    answer = await askModel(verse.scriptMessages(v), { maxTokens: verse.SCRIPT_MAX_TOKENS, schema: verse.SCRIPT_SCHEMA });
    script = verse.finishScript(JSON.parse(answer.text));
  } catch (err) {
    log(`Verse ${v.id} failed: ${err.message}`);
    const detail = answer?.cutOff ? 'the script ran past the length limit' : err.message;
    return send(chatId, `Sorry, the script for ${v.id} didn't work out (${detail}). Try again.`);
  } finally {
    stopTyping();
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  lastReply = { seconds, speed: answer.timings?.predicted_per_second };
  log(`Verse ${v.id} script in ${seconds}s (${answer.timings?.predicted_n ?? '?'} tokens)`);
  await send(chatId, verse.formatScript(v, script, seconds));

  // Kept for the next steps (slides, video), which work from the script and the voiceover.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `verse-${v.id}.json`), `${JSON.stringify({ verse: v, script }, null, 1)}\n`);
  const voice = process.env.VOICE || installedVoices()[0];
  if (!voice) return send(chatId, 'No voice is installed yet, so no voiceover. On the phone run: bash setup.sh');
  // One part per paragraph, so the voice pauses between hook, explanation, example, ...
  const narration = script.narrationLines.join('\n\n');
  const caption = (r) => `Voiceover for ${v.id}: ${r.label}, ${r.style} style, ${r.audioSeconds} s long, made in ${r.seconds} s`;
  if (voice.startsWith('kokoro-')) {
    await send(chatId, `${voiceLabel(voice)} is recording the voiceover. Kokoro takes about 20 to 30 minutes on this phone.`);
  }
  const ok = await sendSpoken(chatId, narration, path.join(OUT_DIR, `verse-${v.id}.ogg`), voice, caption);
  // A Kokoro voice that fails (memory, settings) shouldn't leave the day without a voiceover.
  const fallback = process.env.FALLBACK_VOICE;
  if (!ok && fallback && fallback !== voice && installedVoices().includes(fallback)) {
    await send(chatId, `Trying ${voiceLabel(fallback)} instead.`);
    await sendSpoken(chatId, narration, path.join(OUT_DIR, `verse-${v.id}.ogg`), fallback, caption);
  }
}

// Daily verse: at DAILY_TIME (India time, e.g. 06:00) a verse's script and voiceover arrive in
// Telegram. It runs at most once a day, and only within the hour after DAILY_TIME, so starting
// the bot late in the day doesn't set it off.
const DAILY_STATE = path.join(__dirname, 'out', 'daily.json');

// India has no daylight saving: India time is always UTC+5:30.
function indiaNow(date = new Date()) {
  const t = new Date(date.getTime() + 330 * 60_000);
  return { day: t.toISOString().slice(0, 10), minutes: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

function dailyDue(now, lastDay, time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time ?? '');
  if (!m) return false;
  const start = Number(m[1]) * 60 + Number(m[2]);
  return now.day !== lastDay && now.minutes >= start && now.minutes < start + 60;
}

async function dailyVerse() {
  const now = indiaNow();
  let lastDay = null;
  try { lastDay = JSON.parse(fs.readFileSync(DAILY_STATE, 'utf8')).lastDay; } catch { /* first run */ }
  if (!OWNER_CHAT_ID || !dailyDue(now, lastDay, process.env.DAILY_TIME)) return;
  fs.mkdirSync(path.dirname(DAILY_STATE), { recursive: true });
  fs.writeFileSync(DAILY_STATE, JSON.stringify({ lastDay: now.day }));
  // Chapter 1 is mostly the armies being named, so the daily verse comes from chapters 2 to 18.
  const pool = verse.allVerses().filter((x) => x.chapter >= 2);
  const pick = pool[Math.floor(Math.random() * pool.length)];
  log(`Daily verse: ${pick.id}`);
  await send(OWNER_CHAT_ID, `Good morning! Today's verse is ${pick.id}.`);
  await writeVerseScript(OWNER_CHAT_ID, pick.id);
}

// One job at a time (a message, the daily verse): the phone can't run two models or voices at once.
let queue = Promise.resolve();
function enqueue(job) {
  const run = queue.then(job).catch((err) => log(`Job failed: ${err.message}`));
  queue = run;
  return run;
}

const OUT_DIR = path.join(__dirname, 'out');
const VOICE_SAMPLE = 'Thy business is with the action only, never with its fruits. '
  + 'In the next minute, let us see what Krishna means by this, and how it can help you today.';
// Three parts, like a narration's hook, middle and closing line, so the pauses and pacing show.
const STYLE_SAMPLE = [
  'Have you ever worked hard, and still lost sleep over the result?',
  'Krishna says: thy business is with the action only, never with its fruits. Do your part fully. Then let the outcome go.',
  'What would change today, if the result were not yours to hold?',
].join('\n\n');

// Runs speak.js in its own process, so the bot stays responsive and the voice's memory is freed.
// style: one of speak.js's STYLES; by default VOICE_STYLE in .env.
function speak(text, file, voice, style) {
  return new Promise((resolve, reject) => {
    const args = [path.join(__dirname, 'speak.js'), file, '--voice', voice, ...(style ? ['--style', style] : [])];
    const child = spawn(process.execPath, args, { cwd: __dirname });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    // Kokoro can take half an hour for a narration; 90 minutes means something is stuck.
    const timer = setTimeout(() => child.kill(), 90 * 60_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const result = out.split('\n').reverse().find((l) => l.startsWith('RESULT '));
      if (code === 0 && result) return resolve(JSON.parse(result.slice('RESULT '.length)));
      const lastError = err.trim().split('\n').filter(Boolean).at(-1);
      reject(new Error((lastError || `speak.js stopped (exit ${code})`).slice(0, 300)));
    });
    child.stdin.end(text);
  });
}

async function sendVoice(chatId, file, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
  form.append('voice', new Blob([fs.readFileSync(file)], { type: 'audio/ogg' }), path.basename(file));
  await telegram('sendVoice', form, 120_000);
}

// Records the text in a voice and sends it as a voice message. A failure is reported, not thrown;
// returns whether it worked.
async function sendSpoken(chatId, text, file, voice, caption, style) {
  const stop = keepTyping(chatId, 'record_voice');
  try {
    const r = await speak(text, file, voice, style);
    log(`Voice ${r.voice}: ${r.audioSeconds}s of audio in ${r.seconds}s (loading ${r.loadSeconds}s)`);
    await sendVoice(chatId, r.file, caption(r));
    return true;
  } catch (err) {
    log(`Voice failed: ${err.message}`);
    await send(chatId, `Sorry, the voice didn't work: ${err.message}`);
    return false;
  } finally {
    stop();
  }
}

// /voices: the same line in every installed voice, to choose one for the videos.
// /voices bella: only the voices whose name contains "bella".
async function sampleVoices(chatId, filter = '') {
  const all = installedVoices();
  if (!all.length) return send(chatId, 'No voices are installed yet. On the phone run: bash setup.sh');
  const voices = all.filter((v) => v.toLowerCase().includes(filter.trim().toLowerCase()));
  if (!voices.length) return send(chatId, `No installed voice matches "${filter.trim()}". Installed: ${all.join(', ')}`);
  const current = process.env.VOICE || all[0];
  await send(chatId, `The same line in ${voices.length} voice${voices.length > 1 ? 's' : ''}. The videos use ${voiceLabel(current)}; `
    + 'to change it, put VOICE=<name> in phone.env.'
    + (voices.some((v) => v.startsWith('kokoro-')) ? ' Kokoro voices take a few minutes each.' : ''));
  for (const v of voices) {
    await sendSpoken(chatId, VOICE_SAMPLE, path.join(OUT_DIR, `sample-${v}.ogg`), v,
      (r) => `${r.label}: VOICE=${r.voice} (${r.audioSeconds} s, made in ${r.seconds} s)`);
  }
}

// /styles: the same short narration in each speaking style, in the chosen voice.
async function sampleStyles(chatId) {
  const voice = process.env.VOICE || installedVoices()[0];
  if (!voice) return send(chatId, 'No voices are installed yet. On the phone run: bash setup.sh');
  const current = process.env.VOICE_STYLE || 'natural';
  const names = Object.keys(STYLES);
  await send(chatId, `The same short narration in ${names.length} styles, read by ${voiceLabel(voice)}. `
    + `The videos use "${current}"; to change it, put VOICE_STYLE=<name> in phone.env. About a minute each.`);
  for (const name of names) {
    await sendSpoken(chatId, STYLE_SAMPLE, path.join(OUT_DIR, `style-${name}.ogg`), voice,
      (r) => `VOICE_STYLE=${name}: ${r.styleLabel} (${r.audioSeconds} s, made in ${r.seconds} s)`, name);
  }
}

async function main() {
  const me = await checkToken();
  log(`@${me.username} is listening. Model: ${MODEL_NAME}`);
  if (!OWNER_CHAT_ID) log('OWNER_CHAT_ID is empty: message the bot on Telegram and it will tell you your chat id.');
  await telegram('setMyCommands', {
    commands: [
      { command: 'verse', description: 'Video script and voiceover for a verse, e.g. /verse 2.47' },
      { command: 'voices', description: 'Hear every installed voice' },
      { command: 'styles', description: 'Hear the speaking styles (pauses, pace)' },
      { command: 'reset', description: 'Forget the conversation' },
      { command: 'status', description: 'Model state and last reply speed' },
      { command: 'help', description: 'What this bot does' },
    ],
  }).catch((err) => log(`Could not set the command menu: ${err.message}`));

  if (process.env.DAILY_TIME) log(`Daily verse at ${process.env.DAILY_TIME} India time (now ${JSON.stringify(indiaNow())})`);
  // Checked every 30 s; while a long job runs, at most one check waits in the queue.
  let checkWaiting = false;
  setInterval(() => {
    if (checkWaiting) return;
    checkWaiting = true;
    enqueue(dailyVerse).finally(() => { checkWaiting = false; });
  }, 30_000);

  // Long polling: the bot asks Telegram for new messages, so nothing on the phone is exposed.
  // Messages are handled one at a time, and never alongside the daily verse (see enqueue).
  let offset = 0;
  for (;;) {
    let updates;
    try {
      updates = await telegram('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] }, 70_000);
    } catch (err) {
      if (err.code === 401) throw new Error(`Telegram rejected the bot token in .env: ${tokenProblem()}`);
      if (err.code === 409) throw new Error('Another program is already reading this bot\'s messages. Stop it, or use a separate bot token.');
      log(`Telegram polling error: ${err.message}. Retrying in 5 s`);
      await sleep(5000);
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      if (!update.message) continue;
      await enqueue(() => onMessage(update.message));
    }
  }
}

if (require.main === module) {
  // start.sh runs "node bot.js --check-token" first, so a bad token shows up before the model loads.
  const run = process.argv[2] === '--check-token'
    ? () => checkToken().then((me) => log(`Bot token OK: @${me.username}`))
    : main;
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { askModel, trimHistory, status, onMessage, speak, sendVoice, indiaNow, dailyDue, dailyVerse };
