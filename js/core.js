'use strict';

/* ---------- Course index: turns the weekly data files into lessons, cards and days ---------- */
const Course = (() => {
  const src = window.COURSE || { weeks: [] };
  const weeks = src.weeks.slice().sort((a, b) => a.n - b.n);
  const lessons = {};
  const cards = {};
  const days = [];

  weeks.forEach((w) => {
    w.lessons.forEach((l, i) => {
      const id = `${w.n}.${i + 1}`;
      l.id = id;
      l.week = w.n;
      lessons[id] = l;
      l.phrases.forEach((p, j) => {
        const cid = `${id}.${j}`;
        cards[cid] = { id: cid, es: p[0], en: p[1], note: p[2] || '', lesson: id };
      });
      days.push({ kind: 'lesson', id, week: w.n, title: l.title });
    });
    days.push({ kind: 'review', id: `r${w.n}`, week: w.n, title: 'Review and listening test' });
    days.push({ kind: 'mission', id: `m${w.n}`, week: w.n, title: `Mission: ${w.mission.title}` });
  });
  days.forEach((d, i) => { d.day = i + 1; });

  return {
    meta: src,
    weeks,
    lessons,
    days,
    week: (n) => weeks.find((w) => w.n === n),
    card: (id) => cards[id],
    cardsOf: (lessonId) => lessons[lessonId].phrases.map((_, j) => cards[`${lessonId}.${j}`]),
  };
})();

/* ---------- Progress, settings and spaced repetition ----------
   Saved in the browser and, when the local server is running, in progress.json
   next to the app, so progress survives a cleared browser or a different browser. */
const Store = (() => {
  const KEY = 'habla.progress.v1';
  // Days until a phrase comes back, by box. Recall it and it moves up a box;
  // miss it and it returns to box 1.
  const BOX_DAYS = [0, 1, 3, 7, 14, 30, 60];
  const MAX_BOX = BOX_DAYS.length - 1;

  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (s, n) => {
    const [y, m, d] = s.split('-').map(Number);
    return dateStr(new Date(y, m - 1, d + n, 12));
  };

  const fresh = () => ({
    v: 1,
    created: dateStr(),
    updated: 0,
    settings: { accent: 'es-MX', voiceA: '', voiceB: '', voiceEn: '', rate: 1, sayEnglish: true, mic: true, onboarded: false },
    done: {},   // day id -> date first completed
    log: [],    // [date, day id, minutes] for every completed session
    cards: {},  // card id -> { b: box, d: due date, n: reviews, l: lapses, t: last review date }
    cando: {},
    notes: {},
    resume: null,
  });

  let state = fresh();
  let serverOk = false;
  let pushTimer = null;

  // The progress file only exists when the app is served by tools/serve.ps1 on
  // this computer. On a website, progress stays in the browser.
  const onThisComputer = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const hosted = location.protocol.startsWith('http') && !onThisComputer;

  function normalize(raw) {
    const base = fresh();
    if (!raw || typeof raw !== 'object') return base;
    return { ...base, ...raw, settings: { ...base.settings, ...(raw.settings || {}) } };
  }

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
  }

  async function init() {
    const local = readLocal();
    let remote = null;
    if (onThisComputer) {
      try {
        const r = await fetch('api/progress', { cache: 'no-store' });
        if (r.ok) { remote = await r.json(); serverOk = true; }
      } catch { /* no server: browser storage only */ }
    }
    const useRemote = remote && (!local || (remote.updated || 0) >= (local.updated || 0));
    state = normalize(useRemote ? remote : local);
    if (!useRemote && local && serverOk) push(false);
  }

  function push(keepalive) {
    clearTimeout(pushTimer);
    pushTimer = null;
    if (!serverOk) return;
    fetch('api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Habla': '1' },
      body: JSON.stringify(state),
      keepalive: !!keepalive,
    }).catch(() => {});
  }

  function save() {
    state.updated = Date.now();
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage full or blocked */ }
    if (serverOk) {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(() => push(false), 800);
    }
  }

  window.addEventListener('pagehide', () => { if (pushTimer) push(true); });

  /* grade: 0 = missed, 1 = almost, 2 = got it */
  function rate(id, grade) {
    const today = dateStr();
    const c = state.cards[id] || { b: 0, d: today, n: 0, l: 0, t: '' };
    const again = c.t === today; // a second success on the same day does not promote again
    if (grade === 2) {
      if (!again || c.b === 0) c.b = Math.min(MAX_BOX, c.b + 1);
    } else if (grade === 1) {
      c.b = Math.max(1, c.b);
    } else {
      if (c.n > 0) c.l++;
      c.b = 1;
    }
    const wait = grade === 2 ? BOX_DAYS[c.b] : grade === 1 ? Math.max(1, Math.ceil(BOX_DAYS[c.b] / 2)) : 1;
    c.d = addDays(today, wait);
    c.n++;
    c.t = today;
    state.cards[id] = c;
    save();
  }

  function due(limit = 30) {
    const today = dateStr();
    return Object.keys(state.cards)
      .filter((id) => state.cards[id].d <= today && Course.card(id))
      .sort((a, b) => {
        const x = state.cards[a];
        const y = state.cards[b];
        return x.d < y.d ? -1 : x.d > y.d ? 1 : x.b - y.b;
      })
      .slice(0, limit);
  }

  function complete(dayId, minutes) {
    const today = dateStr();
    if (!state.done[dayId]) state.done[dayId] = today;
    state.log.push([today, dayId, minutes]);
    state.resume = null;
    save();
  }

  const nextDay = () => Course.days.find((d) => !state.done[d.id]) || null;

  function stats() {
    const dates = new Set(state.log.map((x) => x[0]));
    let streak = 0;
    let d = dateStr();
    if (!dates.has(d)) d = addDays(d, -1);
    while (dates.has(d)) { streak++; d = addDays(d, -1); }
    const ids = Object.keys(state.cards).filter((id) => Course.card(id));
    return {
      streak,
      minutes: state.log.reduce((s, x) => s + (x[2] || 0), 0),
      sessions: Course.days.filter((x) => state.done[x.id]).length,
      learned: ids.length,
      strong: ids.filter((id) => state.cards[id].b >= 4).length,
      practicedToday: dates.has(dateStr()),
    };
  }

  function replace(raw) { state = normalize(raw); save(); }
  function reset() { state = fresh(); save(); }

  return {
    init, save, rate, due, complete, nextDay, stats, replace, reset,
    get state() { return state; },
    get serverOk() { return serverOk; },
    hosted,
    today: dateStr,
  };
})();
