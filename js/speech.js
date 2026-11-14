'use strict';

/* Speech engine: Spanish and English voices (browser text-to-speech) and the
   optional microphone check (browser speech recognition). */
const Speech = (() => {
  const synth = window.speechSynthesis || null;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  let voices = [];
  let getSettings = () => ({});
  let lastCancel = 0;
  let activeRec = null;
  const pending = new Set();
  const watchers = new Set();

  const langOf = (v) => (v.lang || '').replace('_', '-');
  const isEs = (v) => /^es(-|$)/i.test(langOf(v));
  const isEn = (v) => /^en(-|$)/i.test(langOf(v));
  const natural = (v) => /natural|neural/i.test(v.name);

  let checked = !synth; // false until the browser has reported its voices (or had time to)

  // Call a snapshot of the watchers: a watcher may re-render its view, which registers a
  // new watcher. Iterating the live Set would visit that new one too, and never finish.
  const notify = () => Array.from(watchers).forEach((fn) => fn());

  function refresh() {
    if (!synth) return;
    const list = synth.getVoices() || [];
    if (list.length !== voices.length) {
      voices = list;
      if (voices.some(isEs)) checked = true;
      notify();
    }
  }

  function init(settingsFn) {
    getSettings = settingsFn;
    if (!synth) return;
    refresh();
    synth.addEventListener('voiceschanged', refresh);
    // Online voices can arrive a moment after the local ones.
    [300, 1000, 2500, 5000].forEach((ms) => setTimeout(refresh, ms));
    setTimeout(() => {
      if (checked) return;
      checked = true;
      notify();
    }, 3000);
  }

  function onVoices(fn) {
    watchers.add(fn);
    return () => watchers.delete(fn);
  }

  /* ---------- choosing voices ---------- */
  const esVoices = () => voices.filter(isEs).sort((a, b) => (natural(a) ? 0 : 1) - (natural(b) ? 0 : 1));
  const enVoices = () => voices.filter(isEn).sort((a, b) => (natural(a) ? 0 : 1) - (natural(b) ? 0 : 1));

  function accents() {
    const seen = [];
    esVoices().forEach((v) => { if (!seen.includes(langOf(v))) seen.push(langOf(v)); });
    return seen;
  }

  // Two different voices for the two speakers of a dialogue.
  function pairFor(accent) {
    const es = esVoices();
    const want = (code) => es.filter((v) => langOf(v).toLowerCase() === code.toLowerCase());
    let pool = want(accent || 'es-MX');
    for (const code of ['es-MX', 'es-US', 'es-419', 'es-CO', 'es-ES']) {
      if (pool.length) break;
      pool = want(code);
    }
    if (!pool.length) pool = es;
    const a = pool[0] || null;
    const b = pool.find((v) => v !== a) || es.find((v) => v !== a) || a;
    return [a, b];
  }

  function defaultEn() {
    const en = enVoices();
    const us = en.filter((v) => /en-US/i.test(langOf(v)));
    return us.find(natural) || us.find((v) => /google/i.test(v.name)) || us[0] || en[0] || null;
  }

  const byName = (name) => (name ? voices.find((v) => v.name === name) || null : null);

  // who: 'a' or 'b' (Spanish speakers) or 'en' (English prompts)
  function voiceFor(who) {
    const s = getSettings();
    if (who === 'en') return byName(s.voiceEn) || defaultEn();
    const [a, b] = pairFor(s.accent);
    return who === 'b' ? byName(s.voiceB) || b : byName(s.voiceA) || a;
  }

  function quality() {
    const es = esVoices();
    if (!es.length) return checked ? 'none' : 'checking';
    return es.some(natural) ? 'natural' : 'basic';
  }

  /* ---------- speaking ---------- */
  function say(text, who = 'a', rate = 1) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      // English prompts carry hints such as "(informal)": shown on screen, not read aloud.
      const clean = who === 'en' ? String(text).replace(/\s*\([^)]*\)/g, '').trim() : String(text);
      let settled = false;
      let timer = null;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(finish);
        resolve({ ok, ms: performance.now() - t0 });
      };
      pending.add(finish);

      if (!synth || !voices.length) {
        // No speech in this browser: keep the lesson moving at a readable pace.
        timer = setTimeout(() => finish(false), Math.min(2500, 300 + clean.length * 40));
        return;
      }

      const u = new SpeechSynthesisUtterance(clean);
      const v = voiceFor(who);
      if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = who === 'en' ? 'en-US' : 'es-MX'; }
      const base = who === 'en' ? 1 : Number(getSettings().rate) || 1;
      u.rate = Math.max(0.5, Math.min(1.3, rate * base));
      u.onend = () => finish(true);
      u.onerror = () => finish(false);
      finish.utterance = u; // keep a reference: some browsers drop events for collected utterances
      timer = setTimeout(() => finish(false), 6000 + (clean.length * 260) / u.rate);

      // Speaking right after cancel() can be swallowed, so leave a short gap.
      const wait = Math.max(0, 80 - (performance.now() - lastCancel));
      setTimeout(() => { if (!settled) synth.speak(u); }, wait);
    });
  }

  function stopAll() {
    if (synth) synth.cancel();
    lastCancel = performance.now();
    Array.from(pending).forEach((finish) => finish(false));
  }

  /* ---------- listening (microphone check) ---------- */
  const canListen = () => !!SR;
  const srLang = () => getSettings().accent || 'es-MX';

  function listen({ lang, onInterim, maxMs = 10000 } = {}) {
    return new Promise((resolve) => {
      if (!SR) { resolve({ alternatives: [], error: 'unsupported' }); return; }
      const rec = new SR();
      rec.lang = lang || srLang();
      rec.interimResults = true;
      rec.maxAlternatives = 5;
      rec.continuous = false;
      const finals = [];
      let interim = '';
      let error = null;
      let settled = false;
      let timer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (activeRec === rec) activeRec = null;
        resolve({ alternatives: finals.length ? finals : interim ? [interim] : [], error });
      };
      rec.onresult = (e) => {
        interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) { for (let j = 0; j < r.length; j++) finals.push(r[j].transcript); }
          else interim += r[0].transcript;
        }
        if (onInterim) onInterim(interim || finals[0] || '');
      };
      rec.onerror = (e) => { error = e.error; };
      rec.onend = finish;
      timer = setTimeout(() => { try { rec.stop(); } catch { finish(); } }, maxMs);
      activeRec = rec;
      try { rec.start(); } catch { error = 'start-failed'; finish(); }
    });
  }

  function stopListening() {
    if (!activeRec) return;
    try { activeRec.stop(); } catch { /* already stopped */ }
  }

  /* ---------- comparing what was said with the target ---------- */
  const UNITS = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidos', 'veintitres', 'veinticuatro', 'veinticinco', 'veintiseis', 'veintisiete', 'veintiocho', 'veintinueve'];
  const TENS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
  const HUNDREDS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

  // Recognizers often write "2" where the learner said "dos".
  function numToEs(n) {
    if (n < 30) return UNITS[n];
    if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` y ${UNITS[n % 10]}` : '');
    if (n === 100) return 'cien';
    if (n < 1000) return HUNDREDS[Math.floor(n / 100)] + (n % 100 ? ` ${numToEs(n % 100)}` : '');
    if (n < 1000000) {
      const k = Math.floor(n / 1000);
      return (k === 1 ? 'mil' : `${numToEs(k)} mil`) + (n % 1000 ? ` ${numToEs(n % 1000)}` : '');
    }
    return String(n);
  }

  function tokens(s) {
    const flat = String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\d+/g, (m) => ` ${numToEs(parseInt(m, 10))} `)
      .replace(/[^a-z0-9\s]/g, ' ')
      .trim();
    return flat ? flat.split(/\s+/) : [];
  }

  // Same word, or the same word with a different gender/number ending
  // (cansado / cansada), so a woman's answer is not marked wrong.
  function sameWord(a, b) {
    if (a === b) return true;
    if (a.length < 4 || b.length < 4) return false;
    const stem = (w) => w.replace(/[oa]s?$/, '');
    return stem(a).length >= 3 && stem(a) === stem(b);
  }

  // Longest common subsequence of words; returns which target words were matched.
  function matchWords(target, heard) {
    const n = target.length;
    const m = heard.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = sameWord(target[i], heard[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const hit = new Array(n).fill(false);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (sameWord(target[i], heard[j])) { hit[i] = true; i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    return hit;
  }

  function compare(targetText, alternatives) {
    const display = String(targetText).split(/\s+/).filter(Boolean);
    const perWord = display.map((w) => tokens(w));
    const target = perWord.flat();
    let best = { score: 0, heard: alternatives[0] || '', hit: new Array(target.length).fill(false) };
    alternatives.forEach((alt) => {
      const hit = matchWords(target, tokens(alt));
      const score = target.length ? hit.filter(Boolean).length / target.length : 0;
      if (score > best.score) best = { score, heard: alt, hit };
    });
    let k = 0;
    const words = display.map((w, idx) => {
      const count = perWord[idx].length;
      const ok = best.hit.slice(k, k + count).every(Boolean);
      k += count;
      return { text: w, ok };
    });
    return { score: best.score, heard: best.heard, words };
  }

  return {
    init, onVoices, say, stopAll, listen, stopListening, canListen, srLang, compare,
    voiceFor, esVoices, enVoices, accents, quality, langOf,
    hasSynth: () => !!synth,
  };
})();
