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

/* ---------- People, progress, settings and spaced repetition ----------
   Every person in data/profiles.js has their own progress. It is saved in the
   browser and, when the local server is running, in progress.json next to the
   app, so it survives a cleared browser or a different browser.
   There are no passwords: choosing a name only opens that person's progress. */
const Store = (() => {
  // Browser storage: KEY.<person id> holds one person's progress. KEY alone is
  // where progress was kept before there were profiles.
  const KEY = 'habla.progress.v1';
  const keyOf = (id) => `${KEY}.${id}`;
  const WHO = 'habla.who';       // the person chosen in this tab (kept for the tab, for one day)
  const TAKEN = 'habla.earlier'; // who took over the progress from before profiles

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

  const listed = (Array.isArray(window.PROFILES) ? window.PROFILES : [])
    .filter((p) => p && /^[a-z0-9-]+$/.test(p.id || '') && typeof p.name === 'string' && p.name.trim())
    .map((p) => ({ id: p.id, name: p.name.trim() }));
  const profiles = listed.filter((p, i) => listed.findIndex((x) => x.id === p.id) === i);
  // Without a list of people the app has one learner with no name and never asks who is
  // learning. Their progress stays exactly where the app kept it before profiles: under
  // KEY in the browser, and as the whole progress file. If names are added later, that
  // progress is the "earlier progress" somebody can take over.
  const solo = !profiles.length;
  if (solo) profiles.push({ id: 'me', name: '' });

  let who = null; // the person learning now; null until somebody is chosen
  let state = fresh();
  let serverOk = false;
  let pushTimer = null;
  // What progress.json holds: everybody's progress, and progress from before profiles.
  let file = { profiles: {}, earlier: null, taken: '' };

  // The progress file only exists when the app is served by tools/serve.ps1 on
  // this computer. On a website, progress stays in the browser.
  const onThisComputer = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const hosted = location.protocol.startsWith('http') && !onThisComputer;

  // Browser storage can be full or blocked. Then nothing is remembered, and the app still runs.
  const LOCAL = 'localStorage';  // kept on this device
  const TAB = 'sessionStorage';  // kept while this tab is open
  const get = (box, k) => { try { return window[box].getItem(k); } catch { return null; } };
  const put = (box, k, v) => { try { window[box].setItem(k, v); } catch { /* full or blocked */ } };
  const readJson = (k) => {
    try {
      const v = JSON.parse(get(LOCAL, k));
      return v && typeof v === 'object' ? v : null;
    } catch { return null; }
  };

  function normalize(raw) {
    const base = fresh();
    if (!raw || typeof raw !== 'object') return base;
    return { ...base, ...raw, settings: { ...base.settings, ...(raw.settings || {}) } };
  }

  // The more recently saved of two copies. When they are equally new, the first one.
  const newer = (a, b) => (!a ? b || null : !b ? a : (b.updated || 0) > (a.updated || 0) ? b : a);
  const count = (o) => (o && typeof o === 'object' ? Object.keys(o).length : 0);
  const hasProgress = (s) => !!s && (count(s.done) > 0 || count(s.cards) > 0 || count(s.log) > 0);

  // progress.json holds { v: 2, profiles: { id: progress }, earlier, taken }.
  // A file written before profiles existed is one person's progress on its own.
  function readFile(raw) {
    if (!raw || typeof raw !== 'object') return { profiles: {}, earlier: null, taken: '' };
    if (raw.profiles && typeof raw.profiles === 'object') {
      return { profiles: raw.profiles, earlier: raw.earlier || null, taken: raw.taken || '' };
    }
    return { profiles: {}, earlier: raw, taken: '' };
  }

  async function pull() {
    try {
      const r = await fetch('api/progress', { cache: 'no-store' });
      if (!r.ok) return false;
      const next = readFile(await r.json());
      // Nothing this page already knows is dropped: for each person the newer copy wins.
      // (A page still running the app from before profiles can write the old format again.)
      Object.keys(file.profiles).forEach((id) => { next.profiles[id] = newer(next.profiles[id], file.profiles[id]); });
      next.earlier = newer(next.earlier, file.earlier);
      next.taken = next.taken || file.taken;
      file = next;
      return true;
    } catch { return false; } // no server: browser storage only
  }

  // Where one person's progress is kept: in the browser, and in the file.
  const slot = (id) => (solo ? KEY : keyOf(id));
  const inFile = (id) => (solo ? file.earlier : file.profiles[id]);
  // A person's saved progress, or null if they never practiced here.
  const stored = (id) => newer(inFile(id), readJson(slot(id)));

  /* Progress from before profiles. It belongs to whoever used the app then, so the
     app asks instead of guessing, and keeps it until somebody says it is theirs. */
  const takenBy = () => get(LOCAL, TAKEN) || file.taken || '';
  function earlierState() {
    if (solo || takenBy()) return null;
    const s = newer(file.earlier, readJson(KEY));
    return hasProgress(s) ? s : null;
  }

  function fileBody(id, mine) {
    // One learner and nobody else in the file: the file is their progress, as before profiles.
    if (solo && !count(file.profiles)) return mine;
    const body = { v: 2, updated: Date.now(), profiles: { ...file.profiles } };
    if (solo) {
      body.earlier = mine;
      if (file.taken) body.taken = file.taken;
      return body;
    }
    profiles.forEach((p) => {
      const s = stored(p.id);
      if (s) body.profiles[p.id] = s;
    });
    body.profiles[id] = mine;
    const taken = takenBy();
    if (taken) body.taken = taken;
    // Progress from before profiles stays in the file as it was, also after somebody took it over.
    const before = newer(file.earlier, readJson(KEY));
    if (before) body.earlier = before;
    return body;
  }

  // Another tab may have saved another person's progress since this page loaded,
  // so the file is read again first and only this person's part is replaced.
  async function push(keepalive) {
    clearTimeout(pushTimer);
    pushTimer = null;
    if (!serverOk || !who) return;
    const id = who.id;
    const mine = state;
    if (!keepalive) await pull();
    const body = fileBody(id, mine);
    file = readFile(body);
    fetch('api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Habla': '1' },
      body: JSON.stringify(body),
      keepalive: !!keepalive,
    }).catch(() => {});
  }

  function pushSoon() {
    if (!serverOk) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => push(false), 800);
  }

  function save() {
    if (!who) return;
    state.updated = Date.now();
    put(LOCAL, slot(who.id), JSON.stringify(state));
    pushSoon();
  }

  window.addEventListener('pagehide', () => { if (pushTimer) push(true); });

  // Open one person's progress. Returns false if there is no such person.
  function choose(id) {
    const p = profiles.find((x) => x.id === id);
    if (!p) return false;
    if (pushTimer) push(false); // the person who was learning: save their last changes first
    const mine = readJson(slot(id));
    const theirs = inFile(id);
    who = p;
    state = normalize(newer(theirs, mine));
    if (!solo) put(TAB, WHO, `${id}|${dateStr()}`);
    if (mine && (!theirs || (mine.updated || 0) > (theirs.updated || 0))) pushSoon();
    return true;
  }

  function takeEarlier() {
    const s = earlierState();
    if (!s || !who) return false;
    state = normalize(s);
    put(LOCAL, TAKEN, who.id);
    file.taken = who.id;
    save();
    return true;
  }

  async function init() {
    if (onThisComputer) serverOk = await pull();
    if (solo) { choose('me'); return; }
    // A reload keeps the person chosen in this tab. A new tab, or a new day, asks again,
    // so nobody practices under another person's name by accident.
    const [id, day] = String(get(TAB, WHO) || '').split('|');
    if (id && day === dateStr()) choose(id);
  }

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

  // How far some saved progress has come: for the list of people, and for progress from before profiles.
  function describe(s) {
    const done = (s && s.done) || {};
    const cards = (s && s.cards) || {};
    const log = (s && Array.isArray(s.log) && s.log) || [];
    const next = Course.days.find((d) => !done[d.id]) || null;
    let last = '';
    log.forEach((x) => { if (x && x[0] > last) last = x[0]; });
    Object.keys(cards).forEach((id) => { if (cards[id] && cards[id].t > last) last = cards[id].t; });
    const daysAgo = last ? Math.round((new Date(`${dateStr()}T12:00`) - new Date(`${last}T12:00`)) / 86400000) : null;
    return {
      started: hasProgress(s),
      day: next ? next.day : null, // the day they are on; null when the course is finished
      sessions: Course.days.filter((d) => done[d.id]).length,
      phrases: Object.keys(cards).filter((id) => Course.card(id)).length,
      daysAgo,
    };
  }

  const summary = (id) => describe(who && who.id === id ? state : stored(id));
  function earlier() {
    const s = earlierState();
    return s ? describe(s) : null;
  }

  function replace(raw) { if (who) { state = normalize(raw); save(); } }
  function reset() { if (who) { state = fresh(); save(); } }

  return {
    init, save, rate, due, complete, nextDay, stats, replace, reset,
    choose, summary, earlier, takeEarlier,
    profiles,
    solo,
    isNew: (id) => !stored(id),
    get who() { return who; },
    get state() { return state; },
    get serverOk() { return serverOk; },
    hosted,
    today: dateStr,
  };
})();
