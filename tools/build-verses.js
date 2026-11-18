// Builds data/verses.json: every Bhagavad Gita verse with its Sanskrit text and a public-domain
// English translation. Runs on the laptop once; the phone only reads the result.
//   node tools/build-verses.js            downloads the sources (cached in .cache/sources), writes the file
//
// Sources (both free to reuse):
//   Sanskrit: github.com/gita/gita data/verse.json (Unlicense). Only the Devanagari text is taken; its
//             word meanings and transliterations come from modern commentaries, so they are left out.
//   English:  Annie Besant's translation, 4th edition (1922), as transcribed on Wikisource. Public domain:
//             published before 1931, and Besant died in 1933.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '.cache', 'sources');
const OUT = path.join(ROOT, 'data', 'verses.json');
const SANSKRIT_URL = 'https://raw.githubusercontent.com/gita/gita/main/data/verse.json';
const besantUrl = (n) => `https://en.wikisource.org/wiki/Bhagavad-Gita_(Besant_4th)/Discourse_${n}`;
// Wikimedia asks automated clients to name themselves.
const USER_AGENT = 'phone-hosted-llm-data-builder/1.0 (personal project, one-off download)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cached(name, url) {
  const file = path.join(CACHE, name);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const text = await res.text();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, text);
  await sleep(1500); // be gentle with Wikisource
  return text;
}

const DEVANAGARI_DIGITS = '०१२३४५६७८९';
// Below this share of shared letter pairs, the book's Sanskrit isn't the verse we expect (see overlap()).
const MIN_MATCH = 0.8; // correct pairs score 89–100%, a verse against its neighbour at most 65%
const hasDevanagari = (s) => /[ऀ-ॿ]/.test(s);

function htmlToParagraphs(html) {
  const start = html.indexOf('mw-parser-output');
  const end = html.indexOf('printfooter', start);
  if (start < 0 || end < 0) throw new Error('page layout changed: article body not found');
  const text = html.slice(start, end)
    .replace(/^[^>]*>/, '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/g, '')
    .replace(/<sup[^>]*class="reference"[\s\S]*?<\/sup>/g, '') // footnote markers like [1]
    .replace(/<ol class="references">[\s\S]*?<\/ol>/g, '') // the footnotes themselves
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/(p|div|h\d|li|tr|td|dd|dt)>/g, '\n\n')
    // Quoted attribute values may contain ">" (Wikisource puts template JSON in data-mw).
    .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[​ ]/g, ' ');
  return text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

const devanagariNumber = (s) => Number([...s].map((c) => DEVANAGARI_DIGITS.indexOf(c)).join(''));

// The verse number at the end of Besant's English: "(47)", or "(20, 21)" for verses translated
// together. The book misprints a few as "(42" or "32)", so either bracket may be missing.
const ENGLISH_NUMBER = /\s*(?:\((\d+)(?:\s*(?:[-–,]|and)\s*(\d+))?\)?|(\d+)(?:\s*(?:[-–,]|and)\s*(\d+))?\))\s*$/;

// One Besant chapter: the English of each verse, with the speaker when a new one starts.
// The page runs: Sanskrit lines ending in the verse number ("॥ ४७ ॥"), then "Arjuna said:" if the
// speaker changes, then the English. The Sanskrit number decides which verse the English belongs
// to, because the English numbers have misprints (and two verses have none). Where the two
// disagree, a note is printed. English with no Sanskrit before it (headings, the closing
// colophon) is skipped.
function parseBesant(html, chapter, warn = () => {}) {
  const verses = new Map();
  let pending = []; // Sanskrit verse numbers waiting for their English
  let sanskrit = []; // the book's own Sanskrit for them, kept to check the alignment
  let buffer = [];
  let speaker = null;

  const flush = () => {
    if (pending.length && buffer.length) {
      let english = buffer.join(' ');
      const label = english.match(ENGLISH_NUMBER);
      if (label) {
        english = english.slice(0, label.index);
        const from = Number(label[1] ?? label[3]);
        const to = Number(label[2] ?? label[4] ?? from);
        if (from !== pending[0] || to !== pending.at(-1)) {
          warn(`${chapter}.${pending.join(',')}: the English is numbered (${from === to ? from : `${from}-${to}`}); using the Sanskrit number`);
        }
      }
      english = english.replace(/\s*\[\d+\]/g, '').trim();
      const shared = pending.length > 1 ? `${chapter}.${pending[0]}-${pending.at(-1)}` : null;
      for (const v of pending) {
        if (verses.has(v)) throw new Error(`Besant ${chapter}.${v} appears twice`);
        verses.set(v, { english, speaker: v === pending[0] ? speaker : null, shared, sanskrit: sanskrit.join(' ') });
      }
      pending = [];
      sanskrit = [];
      speaker = null;
    }
    buffer = [];
  };

  for (const para of htmlToParagraphs(html)) {
    if (hasDevanagari(para)) {
      flush();
      sanskrit.push(para);
      // The closing colophon ("…नाम … अध्यायः ॥१८॥") carries the chapter's number, not a verse's.
      if (!para.includes('ध्यायः')) {
        for (const mark of para.matchAll(/॥\s*([०-९]+)\s*॥/g)) pending.push(devanagariNumber(mark[1]));
      }
      continue;
    }
    // "Dhritarâshtra said:" → speaker "Dhritarashtra" (accents dropped, so the name reads plainly).
    const said = para.match(/^(\p{Lu}[\p{L}\s.'’-]{1,40}?) said:?$/u);
    if (said) { flush(); speaker = said[1].trim().normalize('NFD').replace(/\p{M}/gu, ''); continue; }
    if (!pending.length || para.startsWith('↑')) continue; // "↑ …" lines are footnotes
    buffer.push(para);
    if (ENGLISH_NUMBER.test(para)) flush();
  }
  flush();
  return verses;
}

// How much of verse `a` appears in text `b`: the share of a's letter pairs found in b. Near 1 when
// both are the same verse (OCR typos only nudge it); low when they are different verses.
function overlap(a, b) {
  const pairs = (s) => {
    const letters = s.replace(/[^ऀ-ॣ॰-ॿ]/g, ''); // Devanagari without dandas and digits
    return new Set(Array.from({ length: Math.max(letters.length - 1, 0) }, (_, i) => letters.slice(i, i + 2)));
  };
  const pa = pairs(a);
  const pb = pairs(b);
  if (!pa.size) return 0;
  return [...pa].filter((p) => pb.has(p)).length / pa.size;
}

function cleanSanskrit(text) {
  return text
    .replace(/[।|]{2}\s*[\d.]+\s*[।|]{1,2}/g, '॥') // "।।2.47।।" (once "।।18.78।") → "॥"
    .replace(/।\s*(?=[^\s।॥])/g, '।\n') // a half-verse ends at "।": start a new line there ("व्रज।अहं")
    .split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
}

async function main() {
  const sanskrit = JSON.parse(await cached('gita-verse.json', SANSKRIT_URL));
  const out = [];
  const problems = [];
  const matches = [];
  let speaker = null; // the book names the speaker only when it changes; it holds until the next change
  for (let chapter = 1; chapter <= 18; chapter++) {
    const english = parseBesant(await cached(`besant-${chapter}.html`, besantUrl(chapter)), chapter, (w) => console.log(`Note: ${w}`));
    const source = sanskrit.filter((v) => v.chapter_number === chapter).sort((a, b) => a.verse_number - b.verse_number);
    if (source.length !== english.size) problems.push(`chapter ${chapter}: ${source.length} Sanskrit verses, ${english.size} English`);
    for (const v of source) {
      const verse = v.verse_number;
      const en = english.get(verse);
      if (!en) { problems.push(`${chapter}.${verse}: no English`); continue; }
      // The English sits next to the book's own Sanskrit. If that Sanskrit isn't this verse, the two
      // sources have slipped out of step here.
      const match = overlap(v.text, en.sanskrit);
      matches.push({ id: `${chapter}.${verse}`, match });
      if (match < MIN_MATCH) problems.push(`${chapter}.${verse}: the book's Sanskrit doesn't match (${Math.round(match * 100)}%)`);
      speaker = en.speaker ?? speaker;
      out.push({
        id: `${chapter}.${verse}`,
        chapter,
        verse,
        sanskrit: cleanSanskrit(v.text),
        speaker,
        english: en.english,
        ...(en.shared ? { translatedWith: en.shared } : {}),
      });
    }
  }
  if (problems.length) throw new Error(`The sources don't line up:\n  ${problems.join('\n  ')}`);
  matches.sort((a, b) => a.match - b.match);
  console.log(`Sanskrit match per verse: lowest ${matches.slice(0, 3).map((m) => `${m.id} ${Math.round(m.match * 100)}%`).join(', ')}; `
    + `median ${Math.round(matches[matches.length >> 1].match * 100)}%`);

  const file = {
    note: 'Bhagavad Gita verses. Sanskrit: github.com/gita/gita (Unlicense). English: Annie Besant, '
      + '4th edition 1922, via Wikisource (public domain). Built by tools/build-verses.js.',
    count: out.length,
    verses: out,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(file, null, 1)}\n`);
  console.log(`Wrote ${out.length} verses to ${path.relative(ROOT, OUT)} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
}

if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { parseBesant, cleanSanskrit, htmlToParagraphs, overlap };
