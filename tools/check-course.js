// Checks the lesson data for mistakes in structure. Run:  node tools/check-course.js
// It loads data/course.js and every data/weekNN.js the same way the browser does.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dataDir = path.join(__dirname, '..', 'data');
const sandbox = { window: {} };
sandbox.window = sandbox;
vm.createContext(sandbox);

const files = ['course.js', ...fs.readdirSync(dataDir).filter((f) => /^week\d+\.js$/.test(f)).sort()];
files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(dataDir, f), 'utf8'), sandbox, { filename: f }));

const course = sandbox.COURSE;
const errors = [];
const warnings = [];
const isText = (s) => typeof s === 'string' && s.trim().length > 0 && s === s.trim();
const flat = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const seenPhrase = new Map();
const words = new Set();
let phrases = 0;
let lines = 0;
let builds = 0;

const weeks = course.weeks.slice().sort((a, b) => a.n - b.n);
weeks.forEach((w, wi) => {
  const at = `week ${w.n}`;
  if (w.n !== wi + 1) errors.push(`${at}: week numbers must run 1, 2, 3… (found ${w.n} at position ${wi + 1})`);
  ['title', 'goal'].forEach((k) => { if (!isText(w[k])) errors.push(`${at}: missing ${k}`); });
  const m = w.mission || {};
  ['title', 'scene', 'you', 'partner'].forEach((k) => { if (!isText(m[k])) errors.push(`${at}: mission.${k} missing`); });
  if (!Array.isArray(m.goals) || m.goals.length < 3 || !m.goals.every(isText)) errors.push(`${at}: mission.goals needs at least 3 entries`);
  if (!Array.isArray(w.lessons) || w.lessons.length !== 5) errors.push(`${at}: needs exactly 5 lessons (has ${w.lessons && w.lessons.length})`);

  (w.lessons || []).forEach((l, li) => {
    const id = `${w.n}.${li + 1}`;
    ['title', 'can', 'tip', 'say'].forEach((k) => { if (!isText(l[k])) errors.push(`${id}: missing ${k}`); });
    if (/^i can\b/i.test(l.can || '')) errors.push(`${id}: "can" must not start with "I can" (the app adds it)`);
    if (l.who && (!Array.isArray(l.who) || l.who.length !== 2 || !l.who.every(isText))) errors.push(`${id}: who must be [nameA, nameB]`);

    if (!Array.isArray(l.phrases) || l.phrases.length < 6 || l.phrases.length > 11) errors.push(`${id}: needs 6 to 11 phrases (has ${l.phrases && l.phrases.length})`);
    (l.phrases || []).forEach((p, i) => {
      if (!Array.isArray(p) || p.length < 2 || p.length > 3 || !p.every(isText)) { errors.push(`${id}: phrase ${i + 1} must be [Spanish, English, optional note]`); return; }
      phrases++;
      const key = flat(p[0]).replace(/[^a-z0-9ñ ]/g, '');
      if (seenPhrase.has(key)) warnings.push(`${id}: phrase "${p[0]}" is also taught in ${seenPhrase.get(key)}`);
      else seenPhrase.set(key, id);
      if (/[.]$/.test(p[0])) warnings.push(`${id}: phrase "${p[0]}" ends with a full stop`);
    });

    if (!Array.isArray(l.dialogue) || l.dialogue.length < 6) errors.push(`${id}: dialogue needs at least 6 lines`);
    const speakers = new Set();
    (l.dialogue || []).forEach((d, i) => {
      if (!Array.isArray(d) || d.length !== 3 || !['A', 'B'].includes(d[0]) || !isText(d[1]) || !isText(d[2])) { errors.push(`${id}: dialogue line ${i + 1} must be ['A' or 'B', Spanish, English]`); return; }
      speakers.add(d[0]);
      lines++;
    });
    if (speakers.size !== 2) errors.push(`${id}: dialogue needs both speakers A and B`);

    if (!Array.isArray(l.build) || l.build.length < 5) errors.push(`${id}: build needs at least 5 prompts`);
    (l.build || []).forEach((b, i) => {
      if (!Array.isArray(b) || b.length !== 2 || !b.every(isText)) { errors.push(`${id}: build ${i + 1} must be [English, Spanish]`); return; }
      builds++;
      if (/[¿¡ñáéíóú]/i.test(b[0])) warnings.push(`${id}: build ${i + 1} looks reversed: Spanish text in the English prompt`);
    });

    // Balanced Spanish punctuation, and collect the vocabulary.
    const spanish = [...(l.phrases || []).map((p) => p[0]), ...(l.dialogue || []).map((d) => d[1]), ...(l.build || []).map((b) => b[1])];
    spanish.forEach((s) => {
      if (typeof s !== 'string') return;
      const count = (ch) => s.split(ch).length - 1;
      if (count('¿') !== count('?')) errors.push(`${id}: unbalanced ¿ ? in "${s}"`);
      if (count('¡') !== count('!')) errors.push(`${id}: unbalanced ¡ ! in "${s}"`);
      flat(s).replace(/[^a-zñ\s]/g, ' ').split(/\s+/).forEach((x) => { if (x) words.add(x); });
    });
  });
});

console.log(`${weeks.length} weeks, ${weeks.reduce((n, w) => n + w.lessons.length, 0)} lessons, ${weeks.length * 7} days`);
console.log(`${phrases} phrases (review cards), ${lines} dialogue lines, ${builds} sentence-building prompts`);
console.log(`about ${words.size} different Spanish word forms`);
if (warnings.length) console.log(`\n${warnings.length} warning(s):\n  ${warnings.join('\n  ')}`);
if (errors.length) {
  console.log(`\n${errors.length} error(s):\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
console.log('\nNo errors.');
