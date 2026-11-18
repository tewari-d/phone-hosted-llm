// Step 2: a 1-minute video script for one Bhagavad Gita verse. The verse and its translation come
// from data/verses.json (built by tools/build-verses.js); the model only explains them.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const VERSES_FILE = path.join(__dirname, '..', 'data', 'verses.json');
// Piper voices at normal speed read the /voices sample at 3.3 (John) to 3.9 (Cori) words a second;
// Kristin 3.7. VOICE_SPEED below 1 slows the voice down.
const WORDS_PER_SECOND = 3.6;
// The script is about 300–400 tokens; the cap only stops a runaway reply.
const SCRIPT_MAX_TOKENS = 900;

let verses = null;
function allVerses() {
  verses ??= JSON.parse(fs.readFileSync(VERSES_FILE, 'utf8')).verses;
  return verses;
}

// "2.47", "2 47", "2:47" → that verse; nothing → a random one. Returns { verse } or { error }.
function findVerse(arg) {
  const list = allVerses();
  if (!arg?.trim()) return { verse: list[Math.floor(Math.random() * list.length)] };
  const m = arg.trim().match(/^(\d{1,2})\s*[.:\s]\s*(\d{1,2})$/);
  if (!m) return { error: 'Send the verse as chapter.verse, e.g. /verse 2.47, or just /verse for a random one.' };
  const verse = list.find((v) => v.chapter === Number(m[1]) && v.verse === Number(m[2]));
  if (verse) return { verse };
  const inChapter = list.filter((v) => v.chapter === Number(m[1])).length;
  return {
    error: inChapter
      ? `Chapter ${m[1]} has verses 1 to ${inChapter}.`
      : 'The Gita has chapters 1 to 18.',
  };
}

const SPEAKERS = {
  'The Blessed Lord': 'Krishna, speaking to Arjuna',
  Arjuna: 'Arjuna, speaking to Krishna',
  Sanjaya: 'Sanjaya, describing the scene to King Dhritarashtra',
  Dhritarashtra: 'King Dhritarashtra, asking Sanjaya',
};
const speakerName = (v) => (v.speaker === 'The Blessed Lord' ? 'Krishna' : v.speaker);

// The model must answer with exactly these fields, in this order (llama-server turns the schema
// into a grammar), so the reply always parses and later steps can rely on it.
// The narration comes in parts: asked for a word count, the model wrote anything from 83 to 141
// words, but it reliably fills a few short parts. The parts can also become slides later.
const NARRATION_PARTS = {
  hook: '1 sentence that makes people stop scrolling: a question or a striking line.',
  explain: '2 sentences: what the verse says, in plain words, covering every part of it.',
  example: '2 or 3 sentences: one everyday example (work, studies, family or money) that shows the idea.',
  apply: '2 sentences: what the viewer can do differently today.',
  close: '1 short sentence to reflect on.',
};
const textField = { type: 'string' };
const SCRIPT_SCHEMA = {
  type: 'object',
  properties: {
    title: textField,
    meaning: textField,
    lessons: { type: 'array', items: textField, minItems: 3, maxItems: 3 },
    narration: {
      type: 'object',
      properties: Object.fromEntries(Object.keys(NARRATION_PARTS).map((k) => [k, textField])),
      required: Object.keys(NARRATION_PARTS),
      additionalProperties: false,
    },
  },
  required: ['title', 'meaning', 'lessons', 'narration'],
  additionalProperties: false,
};

// The model's JSON → the script: `narration` becomes the text to speak, `narrationParts` keeps the parts.
function finishScript(raw) {
  const parts = Object.keys(NARRATION_PARTS).map((k) => String(raw.narration?.[k] ?? '').trim()).filter(Boolean);
  return { ...raw, narrationParts: raw.narration, narration: parts.join(' '), narrationLines: parts };
}

const SYSTEM_PROMPT = 'You write scripts for 1-minute vertical videos that explain one verse of the '
  + 'Bhagavad Gita to a modern audience. Write in simple, warm, everyday English. Stay faithful to the '
  + 'translation you are given: do not add stories or claims that are not in the verse, and do not '
  + 'reinterpret it. Explain every part of the translation, leaving none out, and do not bring in '
  + 'feelings or ideas it does not mention. Quote only the translation; never invent words for Krishna or Arjuna.';
// Seen on 2.47: the script dropped "nor be thou to inaction attached" and made the verse about fear.

// What the speaker means for the script. Without this the model has Krishna "explain" a verse in
// which Arjuna only asks, and turns Krishna's "Me" into "your true self" (seen on 18.1 and 18.66).
const SPEAKER_NOTES = {
  'The Blessed Lord': 'When Krishna says "I" or "Me", he means himself, Krishna, the Supreme Lord. Keep it that way; do not turn it into "your true self" or "your inner voice".',
  Arjuna: 'Arjuna is speaking here, not Krishna. Explain what Arjuna says or asks and why it matters; do not answer for Krishna.',
  Sanjaya: 'Sanjaya is narrating here, not Krishna. Explain what is happening in the scene and why it matters.',
  Dhritarashtra: 'King Dhritarashtra is asking Sanjaya about the battle. Explain the question and the setting.',
};

// A few verses are half a sentence that the next or previous verse completes; the model then gets
// those neighbours as context so it can make sense of the verse.
function neighbours(verse) {
  const list = allVerses();
  const i = list.indexOf(verse);
  const prev = list[i - 1]?.chapter === verse.chapter ? list[i - 1] : null;
  const next = list[i + 1]?.chapter === verse.chapter ? list[i + 1] : null;
  const endsSentence = (v) => /[.!?]["'”’]?$/.test(v.english);
  return {
    prev: prev && !endsSentence(prev) ? prev : null,
    next: next && !endsSentence(verse) ? next : null,
  };
}

function scriptMessages(verse) {
  const { prev, next } = neighbours(verse);
  const lines = [
    `Bhagavad Gita, chapter ${verse.chapter}, verse ${verse.verse}. Speaker: ${SPEAKERS[verse.speaker] ?? verse.speaker}.`,
    `Translation: "${verse.english}"`,
  ];
  if (SPEAKER_NOTES[verse.speaker]) lines.push(SPEAKER_NOTES[verse.speaker]);
  if (prev) lines.push(`(Context only, the verse before: "${prev.english}")`);
  if (next) lines.push(`(Context only, the verse after: "${next.english}")`);
  lines.push(
    '',
    'Write the script as JSON with these fields:',
    '- title: a short hook for the video, at most 8 words.',
    '- meaning: what the verse says, in 2 plain sentences.',
    '- lessons: exactly 3 lessons for daily life, each at most 12 words.',
    '- narration: the voiceover, spoken to the viewer, in these parts:',
    ...Object.entries(NARRATION_PARTS).map(([k, how]) => `  - ${k}: ${how}`),
  );
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;

function formatScript(verse, script, seconds) {
  const words = wordCount(script.narration);
  const spoken = words / (WORDS_PER_SECOND * (Number(process.env.VOICE_SPEED) || 1));
  return [
    `Bhagavad Gita ${verse.id} (${speakerName(verse)})`,
    '',
    verse.sanskrit,
    '',
    `"${verse.english}"`,
    '(Annie Besant\'s translation)',
    '',
    'TITLE',
    script.title,
    '',
    'MEANING',
    script.meaning,
    '',
    'LESSONS',
    ...script.lessons.map((l, i) => `${i + 1}. ${l}`),
    '',
    `NARRATION (${words} words, about ${Math.round(spoken)} s spoken)`,
    ...script.narrationLines,
    '',
    `Written in ${seconds} s. Send /verse ${verse.id} again for another version.`,
  ].join('\n');
}

module.exports = { allVerses, findVerse, scriptMessages, finishScript, formatScript, SCRIPT_SCHEMA, SCRIPT_MAX_TOKENS, wordCount };
