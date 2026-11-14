'use strict';

/* ---------- small helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtTime = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const flat = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const settings = () => Store.state.settings;
const voiceOf = (speaker) => (speaker === 'B' ? 'b' : 'a');

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Only one thing speaks or listens at a time: starting a new flow ends the previous one.
let flowGen = 0;
const newFlow = () => { const id = ++flowGen; return { alive: () => id === flowGen }; };
function killFlows() {
  flowGen++;
  Speech.stopAll();
  Speech.stopListening();
}

// Pause left for the learner to repeat a phrase: a little longer than the phrase itself.
const gapFor = (ms, text) => Math.min(7000, Math.max(1700, (ms > 300 ? ms : text.length * 85) * 1.15 + 500));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 5200);
}

let micBlocked = false;
const micOn = () => settings().mic && Speech.canListen() && !micBlocked;

function micProblem(error) {
  if (error === 'not-allowed' || error === 'service-not-allowed') {
    micBlocked = true;
    toast('The microphone is blocked for this page. Keep going with "Show answer", or allow the microphone from the lock icon in the address bar and reload.');
  } else if (error === 'audio-capture') {
    micBlocked = true;
    toast('No microphone was found. Keep going with "Show answer".');
  } else if (error === 'network') {
    toast('The speech check needs an internet connection.');
  }
}

// The microphone check must never get in the way of practice: after three
// attempts in a row with nothing recognised, it steps aside for this visit.
let micFails = 0;
function micOutcome(res) {
  micProblem(res.error);
  if (res.alternatives.length) { micFails = 0; return; }
  micFails++;
  if (micFails >= 3 && !micBlocked) {
    micBlocked = true;
    toast('The microphone check keeps failing, so it is switched off for now. Say each answer out loud and check yourself. You can test the microphone in Settings.');
  }
}

const onPhone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// Keep the screen on while a session or the Listen page is running, where the
// browser allows it. Browsers drop the lock when the page is hidden, so it is
// requested again when the page comes back.
let wakeLock = null;
let wantAwake = false;
async function keepAwake(on) {
  wantAwake = on;
  try {
    if (on && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
      const lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
      wakeLock = lock;
      if (!wantAwake) keepAwake(false);
    } else if (!on && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
  } catch { /* not supported or refused: the session works without it */ }
}
document.addEventListener('visibilitychange', () => { if (wantAwake && document.visibilityState === 'visible') keepAwake(true); });

const speakerNames = (lesson) => ({ A: (lesson.who && lesson.who[0]) || 'Ana', B: (lesson.who && lesson.who[1]) || 'Luis' });
const ACCENTS = { 'es-MX': 'Mexico', 'es-ES': 'Spain', 'es-US': 'United States', 'es-CO': 'Colombia', 'es-AR': 'Argentina', 'es-PE': 'Peru', 'es-CL': 'Chile', 'es-VE': 'Venezuela', 'es-EC': 'Ecuador', 'es-GT': 'Guatemala', 'es-CR': 'Costa Rica', 'es-CU': 'Cuba', 'es-DO': 'Dominican Republic', 'es-BO': 'Bolivia', 'es-PY': 'Paraguay', 'es-UY': 'Uruguay', 'es-PA': 'Panama', 'es-PR': 'Puerto Rico', 'es-HN': 'Honduras', 'es-NI': 'Nicaragua', 'es-SV': 'El Salvador', 'es-GQ': 'Equatorial Guinea', 'es-419': 'Latin America' };
const shortVoice = (v) => (v ? v.name.replace(/^Microsoft\s+/, '').replace(/\s+Online \(Natural\)/, '') : 'none');

/* =====================================================================
   Practice components. Each one draws into `stage` and returns
   { onKey(event) -> handled?, destroy() }.
   ===================================================================== */

/* English prompt -> say the Spanish -> check -> rate. Used for review, recall and sentence building. */
function RecallDeck(stage, cfg) {
  const queue = cfg.items.slice();
  const repeated = new Set();
  let pos = 0;
  let phase = 'prompt';
  let heard = null;
  let verdict = null;
  let firstTry = 0;
  let finished = false;

  const item = () => queue[pos];

  function render() {
    const it = item();
    let body;
    if (phase === 'prompt') {
      body = `<p class="cue">Say it in Spanish, out loud.</p>
        <div class="row">${micOn()
          ? '<button class="btn big primary" data-act="mic">🎤 Speak <kbd>Space</kbd></button><button class="btn big" data-act="reveal">Show answer <kbd>S</kbd></button>'
          : '<button class="btn big primary" data-act="reveal">Show answer <kbd>Space</kbd></button>'}</div>`;
    } else if (phase === 'listening') {
      body = `<p class="listening"><span class="pulse"></span>Listening… <em id="interim"></em></p>
        <div class="row"><button class="btn" data-act="stopmic">Done <kbd>Space</kbd></button></div>`;
    } else {
      const answer = heard && heard.words
        ? heard.words.map((w) => `<span class="w ${w.ok ? 'ok' : 'miss'}">${esc(w.text)}</span>`).join(' ')
        : esc(it.es);
      let heardHtml = '';
      if (heard && heard.none) {
        heardHtml = '<p class="heard miss">I did not catch that. Listen, then try again or rate yourself.</p>';
      } else if (heard) {
        const label = verdict === 2 ? 'that matches' : verdict === 1 ? 'close' : 'not quite';
        heardHtml = `<p class="heard ${verdict === 2 ? 'ok' : verdict === 1 ? 'close' : 'miss'}">I heard “${esc(heard.heard)}”: ${label}.</p>`;
      }
      const sug = verdict == null ? 2 : verdict;
      const rateRow = cfg.srs
        ? `<div class="row rate">
            <button class="btn rate-0 ${sug === 0 ? 'sug' : ''}" data-act="rate" data-g="0">Missed <kbd>1</kbd></button>
            <button class="btn rate-1 ${sug === 1 ? 'sug' : ''}" data-act="rate" data-g="1">Almost <kbd>2</kbd></button>
            <button class="btn rate-2 ${sug === 2 ? 'sug' : ''}" data-act="rate" data-g="2">Got it <kbd>3</kbd></button>
          </div><p class="keys">Space = ${['Missed', 'Almost', 'Got it'][sug]}</p>`
        : `<div class="row rate">
            <button class="btn rate-0" data-act="rate" data-g="0">Again later <kbd>1</kbd></button>
            <button class="btn primary" data-act="rate" data-g="2">Next <kbd>Space</kbd></button>
          </div>`;
      body = `<div class="answer">${answer}</div>
        ${it.note ? `<p class="note">${esc(it.note)}</p>` : ''}
        ${heardHtml}
        <div class="row">
          <button class="btn sm" data-act="again">🔊 Again <kbd>R</kbd></button>
          <button class="btn sm" data-act="slow">🐢 Slow <kbd>W</kbd></button>
          ${micOn() ? '<button class="btn sm" data-act="mic">🎤 Try again <kbd>T</kbd></button>' : ''}
        </div>
        ${rateRow}`;
    }
    stage.innerHTML = `<div class="deck"><div class="deck-top">${queue.length - pos} left</div><div class="prompt">${esc(it.en)}</div>${body}</div>`;
  }

  function show() {
    killFlows();
    if (pos >= queue.length) { finish(); return; }
    phase = 'prompt';
    heard = null;
    verdict = null;
    render();
    if (settings().sayEnglish) Speech.say(item().en, 'en');
  }

  function playAnswer(rate) {
    Speech.stopAll();
    Speech.say(item().es, pos % 2 ? 'b' : 'a', rate);
  }

  function reveal() {
    killFlows();
    phase = 'answer';
    render();
    playAnswer(1);
  }

  async function mic() {
    killFlows();
    const flow = newFlow();
    phase = 'listening';
    render();
    const res = await Speech.listen({ onInterim: (t) => { const n = $('#interim', stage); if (n) n.textContent = t; } });
    if (!flow.alive()) return;
    micOutcome(res);
    if (res.alternatives.length) {
      heard = Speech.compare(item().es, res.alternatives);
      verdict = heard.score >= 0.85 ? 2 : heard.score >= 0.5 ? 1 : 0;
    } else {
      heard = { none: true };
      verdict = null;
    }
    phase = 'answer';
    render();
    playAnswer(1);
  }

  function rate(grade) {
    const it = item();
    if (cfg.srs && it.id) Store.rate(it.id, grade);
    if (!repeated.has(it)) {
      if (grade === 2) firstTry++;
      if (grade === 0) { repeated.add(it); queue.push(it); } // missed: once more at the end
    }
    pos++;
    show();
  }

  function finish() {
    finished = true;
    const n = cfg.items.length;
    stage.innerHTML = n
      ? `<div class="done-box"><div class="check">✓</div><h3>${esc(cfg.doneTitle || 'Round complete')}</h3><p class="muted">${firstTry} of ${n} right the first time.</p></div>`
      : `<div class="empty"><p>${esc(cfg.emptyText || 'Nothing to practice here yet.')}</p></div>`;
    cfg.onDone();
  }

  stage.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || finished) return;
    const act = b.dataset.act;
    if (act === 'mic') mic();
    else if (act === 'reveal') reveal();
    else if (act === 'stopmic') Speech.stopListening();
    else if (act === 'again') playAnswer(1);
    else if (act === 'slow') playAnswer(0.7);
    else if (act === 'rate') rate(Number(b.dataset.g));
  };

  function onKey(e) {
    if (finished) return false;
    const k = e.key.toLowerCase();
    if (phase === 'prompt') {
      if (k === ' ' || k === 'enter') { if (micOn()) mic(); else reveal(); return true; }
      if (k === 's') { reveal(); return true; }
      return false;
    }
    if (phase === 'listening') {
      if (k === ' ' || k === 'enter' || k === 'escape') { Speech.stopListening(); return true; }
      return false;
    }
    if (k === 'r') playAnswer(1);
    else if (k === 'w') playAnswer(0.7);
    else if (k === 't' && micOn()) mic();
    else if (k === '1') rate(0);
    else if (k === '2') rate(cfg.srs ? 1 : 2);
    else if (k === '3') rate(2);
    else if (k === ' ' || k === 'enter') rate(cfg.srs ? (verdict == null ? 2 : verdict) : 2);
    else return false;
    return true;
  }

  show();
  return { onKey, destroy() { stage.onclick = null; } };
}

/* Hear a phrase three times (normal, slow, normal) with a pause to repeat after each. */
function RepeatPlayer(stage, cfg) {
  const items = cfg.items;
  let i = 0;
  let running = false;
  let started = false;
  let finished = false;

  function render(status, kind) {
    const it = items[i];
    stage.innerHTML = `<div class="player">
      <div class="p-count">${i + 1} of ${items.length}</div>
      ${it.label ? `<div class="p-label">${esc(it.label)}</div>` : ''}
      <div class="p-es">${esc(it.es)}</div>
      <div class="p-en">${esc(it.en)}</div>
      ${it.note ? `<p class="note">${esc(it.note)}</p>` : ''}
      <div><span class="p-status ${kind || ''}" id="pstat">${esc(status)}</span></div>
      <div class="row">
        <button class="btn" data-act="prev" ${i === 0 ? 'disabled' : ''} title="Previous">←</button>
        <button class="btn primary big" data-act="toggle">${running ? 'Pause' : started ? 'Continue' : 'Start'} <kbd>Space</kbd></button>
        <button class="btn" data-act="next" title="Next">→</button>
      </div>
      <div class="row"><button class="btn ghost sm" data-act="skip">${esc(cfg.skipLabel || 'Skip this part')}</button></div>
    </div>`;
  }

  function status(text, kind) {
    const n = $('#pstat', stage);
    if (n) { n.textContent = text; n.className = `p-status ${kind || ''}`; }
  }

  function end() {
    killFlows();
    running = false;
    finished = true;
    stage.innerHTML = '<div class="done-box"><div class="check">✓</div><h3>Done</h3></div>';
    cfg.onDone();
  }

  async function run() {
    killFlows();
    const flow = newFlow();
    running = true;
    started = true;
    while (i < items.length) {
      render('Listen', 'listen');
      const it = items[i];
      const voice = i % 2 ? 'b' : 'a';
      for (const [rate, label] of [[1, 'Listen'], [0.7, 'Listen again, slowly'], [1, 'One more time']]) {
        status(label, 'listen');
        const r = await Speech.say(it.es, voice, rate);
        if (!flow.alive()) return;
        status('Your turn: say it out loud', 'speak');
        await sleep(gapFor(r.ms, it.es));
        if (!flow.alive()) return;
      }
      i++;
    }
    i = items.length - 1;
    end();
  }

  function pause() {
    killFlows();
    running = false;
    render('Paused', '');
  }

  function move(step) {
    const n = i + step;
    if (n < 0) return;
    if (n >= items.length) { end(); return; }
    i = n;
    if (running) run(); else { killFlows(); render(started ? 'Paused' : 'Press Start', ''); }
  }

  stage.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || finished) return;
    const act = b.dataset.act;
    if (act === 'toggle') { if (running) pause(); else run(); }
    else if (act === 'prev') move(-1);
    else if (act === 'next') move(1);
    else if (act === 'skip') end();
  };

  function onKey(e) {
    if (finished) return false;
    if (e.key === ' ') { if (running) pause(); else run(); return true; }
    if (e.key === 'ArrowLeft') { move(-1); return true; }
    if (e.key === 'ArrowRight') { move(1); return true; }
    return false;
  }

  render('Press Start. Repeat each phrase out loud in the pauses.', '');
  return { onKey, destroy() { stage.onclick = null; } };
}

/* The lesson dialogue: three guided listens (no text, with text, no text). */
function DialogueListen(stage, cfg) {
  const lines = cfg.lesson.dialogue;
  const names = speakerNames(cfg.lesson);
  const GUIDE = [
    '',
    'Round 1 of 3. The text is hidden. Just listen and catch what you can.',
    'Round 2 of 3. Read along while you listen.',
    'Round 3 of 3. The text is hidden again. Notice how much more you understand.',
    'Done. Play it again as often as you like, or go on.',
  ];
  let round = cfg.free ? 4 : 1;
  let textOn = !!cfg.free;
  let cur = -1;
  let playing = false;
  let signalled = false;

  function render() {
    stage.innerHTML = `<div class="dlg">
      <p class="guide">${cfg.free ? 'Listen as often as you like. Tap a line to hear it alone.' : GUIDE[round]}</p>
      <div class="lines">${lines.map(([sp, es, en], k) => `<div class="line ${sp === 'B' ? 'b' : 'a'} ${k === cur ? 'cur' : ''}" data-line="${k}">
        <span class="sp">${sp === 'B' ? 'You' : esc(names[sp])}</span>${textOn
          ? `<span class="es">${esc(es)}</span><span class="en">${esc(en)}</span>`
          : '<span class="dots">• • •</span>'}</div>`).join('')}</div>
      <div class="row">
        <button class="btn primary big" data-act="play">${playing ? 'Stop' : 'Play'} <kbd>Space</kbd></button>
        <button class="btn" data-act="text">${textOn ? 'Hide text' : 'Show text'} <kbd>T</kbd></button>
      </div>
    </div>`;
  }

  async function play() {
    killFlows();
    const flow = newFlow();
    playing = true;
    for (let k = 0; k < lines.length; k++) {
      cur = k;
      render();
      await Speech.say(lines[k][1], voiceOf(lines[k][0]));
      if (!flow.alive()) return;
      await sleep(350);
      if (!flow.alive()) return;
    }
    playing = false;
    cur = -1;
    if (round < 4) {
      round++;
      if (round === 2) textOn = true;
      if (round === 3) textOn = false;
    }
    render();
    if (round >= 4 && !signalled) { signalled = true; cfg.onDone(); }
  }

  function stop() {
    killFlows();
    playing = false;
    cur = -1;
    render();
  }

  async function one(k) {
    killFlows();
    const flow = newFlow();
    playing = false;
    cur = k;
    render();
    await Speech.say(lines[k][1], voiceOf(lines[k][0]));
    if (!flow.alive()) return;
    cur = -1;
    render();
  }

  stage.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (b) {
      if (b.dataset.act === 'play') { if (playing) stop(); else play(); }
      else if (b.dataset.act === 'text') { textOn = !textOn; render(); }
      return;
    }
    const line = e.target.closest('[data-line]');
    if (line) one(Number(line.dataset.line));
  };

  function onKey(e) {
    if (e.key === ' ') { if (playing) stop(); else play(); return true; }
    if (e.key.toLowerCase() === 't') { textOn = !textOn; render(); return true; }
    return false;
  }

  render();
  if (cfg.free && !signalled) { signalled = true; cfg.onDone(); }
  return { onKey, destroy() { stage.onclick = null; } };
}

/* Round 1: listen to a line, then repeat it. Round 2: shadow, speaking along with the voice. */
function Shadow(stage, cfg) {
  const lines = cfg.lesson.dialogue;
  const names = speakerNames(cfg.lesson);
  let round = 1;
  let k = 0;
  let running = false;
  let started = false;
  let finished = false;
  let msg = 'Press Start. Repeat each line out loud after you hear it.';
  let kind = '';

  function render() {
    stage.innerHTML = `<div class="dlg">
      <div class="rounds">
        <span class="${round === 1 ? 'on' : ''}">1 · Listen, then repeat</span>
        <span class="${round === 2 ? 'on' : ''}">2 · Shadow: speak with the voice</span>
      </div>
      <p class="center"><span class="p-status ${kind}" id="pstat">${esc(msg)}</span></p>
      <div class="lines">${lines.map(([sp, es, en], n) => `<div class="line ${sp === 'B' ? 'b' : 'a'} ${running && n === k ? 'cur' : ''}">
        <span class="sp">${sp === 'B' ? 'You' : esc(names[sp])}</span><span class="es">${esc(es)}</span><span class="en">${esc(en)}</span></div>`).join('')}</div>
      <div class="row">
        <button class="btn primary big" data-act="toggle">${running ? 'Pause' : started ? 'Continue' : 'Start'} <kbd>Space</kbd></button>
        <button class="btn ghost sm" data-act="skip">Skip to the role-play</button>
      </div>
    </div>`;
  }

  function status(text, cls) {
    msg = text;
    kind = cls;
    const n = $('#pstat', stage);
    if (n) { n.textContent = text; n.className = `p-status ${cls}`; }
  }

  function end() {
    killFlows();
    running = false;
    finished = true;
    cfg.onDone();
  }

  async function run() {
    killFlows();
    const flow = newFlow();
    running = true;
    started = true;
    for (; round <= 2; round++, k = 0) {
      for (; k < lines.length; k++) {
        const [sp, es] = lines[k];
        if (round === 1) {
          msg = 'Listen';
          kind = 'listen';
          render();
          const r = await Speech.say(es, voiceOf(sp));
          if (!flow.alive()) return;
          status('Now repeat it out loud', 'speak');
          await sleep(gapFor(r.ms, es));
          if (!flow.alive()) return;
        } else {
          msg = 'Speak together with the voice. Do not wait for it.';
          kind = 'speak';
          render();
          await Speech.say(es, voiceOf(sp), 0.9);
          if (!flow.alive()) return;
          await sleep(500);
          if (!flow.alive()) return;
        }
      }
    }
    end();
  }

  function pause() {
    killFlows();
    running = false;
    msg = 'Paused';
    kind = '';
    render();
  }

  stage.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || finished) return;
    if (b.dataset.act === 'toggle') { if (running) pause(); else run(); }
    else if (b.dataset.act === 'skip') end();
  };

  function onKey(e) {
    if (finished) return false;
    if (e.key === ' ') { if (running) pause(); else run(); return true; }
    return false;
  }

  render();
  return { onKey, destroy() { stage.onclick = null; } };
}

/* The app plays one speaker; the learner speaks the other from an English cue. */
function RolePlay(stage, cfg) {
  const lines = cfg.lesson.dialogue;
  const names = speakerNames(cfg.lesson);
  let me = 'B';
  let k = 0;
  let state = 'idle';
  let heard = null;
  let signalled = false;

  const bubble = (sp, es, en, extra) => `<div class="line ${sp === me ? 'b' : 'a'} ${extra || ''}">
    <span class="sp">${sp === me ? 'You' : esc(names[sp])}</span><span class="es">${esc(es)}</span><span class="en">${esc(en)}</span></div>`;

  function render() {
    let html = lines.slice(0, k).map(([sp, es, en]) => bubble(sp, es, en)).join('');
    let controls = '';
    if (state === 'idle') {
      controls = `<p class="guide">You are ${esc(names[me])}. Listen to ${esc(names[me === 'B' ? 'A' : 'B'])}, then say your line in Spanish.</p>
        <div class="row"><button class="btn primary big" data-act="start">Start the role-play <kbd>Space</kbd></button></div>`;
    } else if (state === 'end') {
      controls = `<div class="done-box"><div class="check">✓</div><h3>Conversation complete</h3></div>
        <div class="row"><button class="btn" data-act="replay">Play it again</button><button class="btn" data-act="swap">Swap roles</button></div>`;
    } else if (k < lines.length) {
      const [sp, es, en] = lines[k];
      if (state === 'partner') {
        html += `<div class="line a cur"><span class="sp">${esc(names[sp])}</span><span class="dots">• • •</span></div>`;
      } else if (state === 'cue' || state === 'listening') {
        html += `<div class="line b cur you-cue"><span class="sp">You: say this in Spanish</span><span class="es">${esc(en)}</span></div>`;
        controls = state === 'listening'
          ? '<p class="listening center"><span class="pulse"></span>Listening… <em id="interim"></em></p><div class="row"><button class="btn" data-act="stopmic">Done <kbd>Space</kbd></button></div>'
          : `<div class="row">${micOn()
            ? '<button class="btn primary big" data-act="mic">🎤 Speak <kbd>Space</kbd></button><button class="btn big" data-act="reveal">Show line <kbd>S</kbd></button>'
            : '<button class="btn primary big" data-act="reveal">Show line <kbd>Space</kbd></button>'}</div>`;
      } else {
        html += bubble(sp, es, en, 'cur');
        const said = heard && heard.heard
          ? `<p class="center"><span class="heard ${heard.score >= 0.85 ? 'ok' : heard.score >= 0.5 ? 'close' : 'miss'}">I heard “${esc(heard.heard)}”</span></p>`
          : '';
        controls = `${said}<div class="row"><button class="btn sm" data-act="again">🔊 Again <kbd>R</kbd></button><button class="btn primary big" data-act="cont">Continue <kbd>Space</kbd></button></div>`;
      }
    }
    stage.innerHTML = `<div class="dlg"><div class="lines">${html}</div>${controls}</div>`;
    const last = stage.querySelector('.lines .line:last-child');
    if (last && state !== 'idle') last.scrollIntoView({ block: 'nearest' });
  }

  async function advance() {
    killFlows();
    const flow = newFlow();
    while (k < lines.length && lines[k][0] !== me) {
      state = 'partner';
      render();
      await Speech.say(lines[k][1], voiceOf(lines[k][0]));
      if (!flow.alive()) return;
      await sleep(300);
      if (!flow.alive()) return;
      k++;
    }
    if (k >= lines.length) {
      state = 'end';
      render();
      if (!signalled) { signalled = true; cfg.onDone(); }
      return;
    }
    state = 'cue';
    heard = null;
    render();
  }

  function reveal() {
    killFlows();
    state = 'shown';
    render();
    Speech.say(lines[k][1], voiceOf(lines[k][0]));
  }

  async function mic() {
    killFlows();
    const flow = newFlow();
    state = 'listening';
    render();
    const res = await Speech.listen({ onInterim: (t) => { const n = $('#interim', stage); if (n) n.textContent = t; } });
    if (!flow.alive()) return;
    micOutcome(res);
    heard = res.alternatives.length ? Speech.compare(lines[k][1], res.alternatives) : null;
    reveal();
  }

  function restart(role) {
    me = role;
    k = 0;
    advance();
  }

  stage.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'start') advance();
    else if (act === 'mic') mic();
    else if (act === 'reveal') reveal();
    else if (act === 'stopmic') Speech.stopListening();
    else if (act === 'again') { Speech.stopAll(); Speech.say(lines[k][1], voiceOf(lines[k][0])); }
    else if (act === 'cont') { k++; advance(); }
    else if (act === 'replay') restart(me);
    else if (act === 'swap') restart(me === 'B' ? 'A' : 'B');
  };

  function onKey(e) {
    const key = e.key.toLowerCase();
    if (state === 'idle' && key === ' ') { advance(); return true; }
    if (state === 'cue') {
      if (key === ' ') { if (micOn()) mic(); else reveal(); return true; }
      if (key === 's') { reveal(); return true; }
    }
    if (state === 'listening' && key === ' ') { Speech.stopListening(); return true; }
    if (state === 'shown') {
      if (key === ' ') { k++; advance(); return true; }
      if (key === 'r') { Speech.stopAll(); Speech.say(lines[k][1], voiceOf(lines[k][0])); return true; }
    }
    return false;
  }

  render();
  return { onKey, destroy() { stage.onclick = null; } };
}

/* One minute of unscripted speaking, optionally recorded for self-review. Then once more. */
function FreeTalk(stage, cfg) {
  const total = cfg.seconds || 60;
  const canRecord = !!(navigator.mediaDevices && window.MediaRecorder);
  let left = total;
  let running = false;
  let timer = null;
  let recorder = null;
  let stream = null;
  let chunks = [];
  let url = null;
  let attempts = 0;
  let wantRecord = canRecord;
  let alive = true;
  let signalled = false;

  function render() {
    stage.innerHTML = `<div class="talk">
      <p class="task">${esc(cfg.task)}</p>
      <div class="count ${running ? 'run' : ''}" id="count">${fmtTime(Math.max(0, left))}</div>
      <div class="row">${running
        ? '<button class="btn primary big" data-act="stop">Stop <kbd>Space</kbd></button>'
        : `<button class="btn primary big" data-act="start">${attempts ? 'Speak again' : 'Start speaking'} <kbd>Space</kbd></button>`}</div>
      ${canRecord ? `<p class="small muted"><label><input type="checkbox" id="rec" ${wantRecord ? 'checked' : ''} ${running ? 'disabled' : ''}> Record me, so I can listen to myself</label></p>` : ''}
      ${url ? `<audio controls src="${url}"></audio>` : ''}
      ${attempts && !running ? '<p class="small muted">Now say the same thing again, a little faster and smoother. Repeating the same talk is how fluency grows.</p>' : ''}
      ${cfg.hints && cfg.hints.length ? `<details class="hints"><summary>Phrases you can use</summary><ul>${cfg.hints.map((h) => `<li><strong>${esc(h.es)}</strong> · ${esc(h.en)}</li>`).join('')}</ul></details>` : ''}
    </div>`;
  }

  function release() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  }

  async function start() {
    killFlows();
    if (url) { URL.revokeObjectURL(url); url = null; }
    chunks = [];
    recorder = null;
    if (wantRecord && canRecord) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recorder = new MediaRecorder(stream);
        const rec = recorder;
        rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        rec.onstop = () => {
          url = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
          release();
          if (alive) render();
        };
        rec.start();
      } catch {
        wantRecord = false;
        recorder = null;
        release();
        toast('Recording is not available here. Just speak: that is what counts.');
      }
    }
    if (!alive) { release(); return; }
    left = total;
    running = true;
    render();
    timer = setInterval(() => {
      left--;
      const n = $('#count', stage);
      if (n) n.textContent = fmtTime(Math.max(0, left));
      if (left <= 0) stop();
    }, 1000);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    running = false;
    attempts++;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    render();
    if (!signalled) { signalled = true; cfg.onDone(); }
  }

  stage.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'start') start();
    else if (b.dataset.act === 'stop') stop();
  };
  stage.onchange = (e) => { if (e.target.id === 'rec') wantRecord = e.target.checked; };

  function onKey(e) {
    if (e.key !== ' ') return false;
    if (running) stop(); else start();
    return true;
  }

  render();
  return {
    onKey,
    destroy() {
      alive = false;
      clearInterval(timer);
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      release();
      if (url) URL.revokeObjectURL(url);
      stage.onclick = null;
      stage.onchange = null;
    },
  };
}

/* Hear a phrase with no text and choose its meaning. */
function ListenQuiz(stage, cfg) {
  const pool = cfg.pool.filter((x, i, a) => a.findIndex((y) => y.en === x.en) === i);
  const items = shuffle(pool).slice(0, cfg.count).map((it) => {
    const wrong = shuffle(pool.filter((p) => p.en !== it.en)).slice(0, 3);
    return { es: it.es, en: it.en, options: shuffle([it, ...wrong]).map((o) => o.en) };
  });
  let i = 0;
  let picked = null;
  let score = 0;
  let finished = false;

  const voice = () => (i % 2 ? 'b' : 'a');

  function render() {
    const it = items[i];
    stage.innerHTML = `<div class="quiz">
      <div class="deck-top">${i + 1} of ${items.length}</div>
      <div class="row">
        <button class="btn primary" data-act="again">🔊 Hear it <kbd>R</kbd></button>
        <button class="btn" data-act="slow">🐢 Slow <kbd>W</kbd></button>
      </div>
      ${picked != null ? `<div class="answer">${esc(it.es)}</div>` : '<p class="cue" style="margin-top:1rem">What does it mean?</p>'}
      <div class="opts">${it.options.map((o, n) => {
        let cls = '';
        if (picked != null) cls = o === it.en ? 'right' : n === picked ? 'wrong' : '';
        return `<button class="btn opt ${cls}" data-pick="${n}" ${picked != null ? 'disabled' : ''}><b>${n + 1}</b>${esc(o)}</button>`;
      }).join('')}</div>
      ${picked != null ? '<div class="row"><button class="btn primary" data-act="next">Next <kbd>Space</kbd></button></div>' : ''}
    </div>`;
  }

  function show() {
    killFlows();
    picked = null;
    render();
    Speech.say(items[i].es, voice());
  }

  function pick(n) {
    if (picked != null || n >= items[i].options.length) return;
    picked = n;
    if (items[i].options[n] === items[i].en) score++;
    render();
  }

  function next() {
    i++;
    if (i < items.length) { show(); return; }
    killFlows();
    finished = true;
    stage.innerHTML = `<div class="done-box"><div class="check">✓</div><h3>You understood ${score} of ${items.length}</h3>
      <p class="muted">${score >= items.length * 0.8 ? 'Your ear is catching this week\'s Spanish.' : 'Replay this week\'s conversations on the Listen page. Listening again is how the ear tunes in.'}</p></div>`;
    cfg.onDone();
  }

  stage.onclick = (e) => {
    if (finished) return;
    const opt = e.target.closest('[data-pick]');
    if (opt) { pick(Number(opt.dataset.pick)); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'again') { Speech.stopAll(); Speech.say(items[i].es, voice()); }
    else if (b.dataset.act === 'slow') { Speech.stopAll(); Speech.say(items[i].es, voice(), 0.7); }
    else if (b.dataset.act === 'next') next();
  };

  function onKey(e) {
    if (finished) return false;
    const k = e.key.toLowerCase();
    if (k === 'r') { Speech.stopAll(); Speech.say(items[i].es, voice()); return true; }
    if (k === 'w') { Speech.stopAll(); Speech.say(items[i].es, voice(), 0.7); return true; }
    if (picked == null && /^[1-4]$/.test(k)) { pick(Number(k) - 1); return true; }
    if (picked != null && (k === ' ' || k === 'enter')) { next(); return true; }
    return false;
  }

  if (!items.length) {
    finished = true;
    stage.innerHTML = '<div class="empty"><p>Nothing to test yet.</p></div>';
    cfg.onDone();
  } else {
    show();
  }
  return { onKey, destroy() { stage.onclick = null; } };
}

/* A list of dialogues to listen to again or role-play. */
function DialogueMenu(stage, cfg) {
  let sub = null;

  function list() {
    if (sub && sub.destroy) sub.destroy();
    sub = null;
    killFlows();
    stage.innerHTML = `<div>${cfg.lessons.map((l, i) => `<div class="drow">
      <div><strong>${esc(l.title)}</strong><span>${l.dialogue.length} lines</span></div>
      <div class="row"><button class="btn sm" data-listen="${i}">Listen</button><button class="btn sm" data-play="${i}">Role-play</button></div>
    </div>`).join('')}</div>`;
  }

  function open(lesson, kind) {
    killFlows();
    stage.innerHTML = '<p><button class="btn ghost sm" data-back="1">← All conversations</button></p><div id="sub"></div>';
    const el = $('#sub', stage);
    sub = kind === 'listen'
      ? DialogueListen(el, { lesson, free: true, onDone: () => {} })
      : RolePlay(el, { lesson, onDone: () => {} });
  }

  stage.addEventListener('click', onClick);
  function onClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.back) list();
    else if (b.dataset.listen !== undefined) open(cfg.lessons[Number(b.dataset.listen)], 'listen');
    else if (b.dataset.play !== undefined) open(cfg.lessons[Number(b.dataset.play)], 'play');
  }

  list();
  cfg.onDone();
  return {
    onKey: (e) => !!(sub && sub.onKey && sub.onKey(e)),
    destroy() {
      if (sub && sub.destroy) sub.destroy();
      stage.removeEventListener('click', onClick);
    },
  };
}

/* A saved checklist (weekly can-do statements, mission goals). */
function Checklist(stage, cfg) {
  const done = Store.state.cando;
  stage.innerHTML = `<div>${cfg.before || ''}${cfg.items.map((it) => `<label class="cando">
    <input type="checkbox" data-k="${esc(it.key)}" ${done[it.key] ? 'checked' : ''}><span>${esc(it.text)}</span></label>`).join('')}${cfg.after || ''}</div>`;
  stage.onchange = (e) => {
    const k = e.target.dataset.k;
    if (k) { Store.state.cando[k] = e.target.checked; Store.save(); }
    if (e.target.id === 'notes') { Store.state.notes[cfg.notesKey] = e.target.value; Store.save(); }
  };
  cfg.onDone();
  return { destroy() { stage.onchange = null; } };
}

/* Runs several components one after another inside the same step. */
function chain(stage, api, makers) {
  let k = 0;
  let cur = null;
  let token = 0;

  function mount() {
    const my = ++token;
    if (cur && cur.destroy) cur.destroy();
    killFlows();
    cur = null;
    cur = makers[k](stage, {
      // Deferred, so a component that finishes while it is being created does not re-enter mount().
      done: () => setTimeout(() => {
        if (my !== token) return;
        if (k < makers.length - 1) { k++; mount(); } else api.done();
      }, 0),
    }) || null;
  }

  mount();
  return {
    onKey: (e) => !!(cur && cur.onKey && cur.onKey(e)),
    destroy() { token++; if (cur && cur.destroy) cur.destroy(); },
  };
}

/* =====================================================================
   Session steps for the three kinds of day
   ===================================================================== */

function lessonSteps(lesson) {
  const cards = Course.cardsOf(lesson.id);
  return [
    {
      name: 'Warm-up',
      title: 'Warm-up: remember',
      mins: 6,
      intro: 'Phrases from earlier days come back just before you would forget them. Read the English, <strong>say the Spanish out loud</strong>, then check yourself.',
      mount(stage, api) {
        const ids = Store.due(30);
        if (ids.length) return RecallDeck(stage, { items: ids.map(Course.card), srs: true, doneTitle: 'Warm-up complete', onDone: api.done });
        if (lesson.id === '1.1' && Course.meta.sounds) {
          stage.innerHTML = '<p class="center muted">Nothing to review on your first day. Instead, meet the sounds of Spanish. Every letter has one sound, so this takes two minutes and helps for the whole course.</p><div id="sub"></div>';
          return RepeatPlayer($('#sub', stage), {
            items: Course.meta.sounds.map(([label, es, en]) => ({ label, es, en })),
            skipLabel: 'Skip the sounds',
            onDone: api.done,
          });
        }
        stage.innerHTML = '<div class="empty"><p>Nothing is due for review right now. Go on to the next step.</p></div>';
        api.done();
        return null;
      },
    },
    {
      name: 'Listen',
      title: 'Listen first',
      mins: 4,
      intro: 'A short conversation built from today\'s phrases. You hear it three times: without text, with text, and without text again.',
      mount: (stage, api) => DialogueListen(stage, { lesson, onDone: api.done }),
    },
    {
      name: 'Learn',
      title: 'Learn today\'s phrases',
      mins: 7,
      tip: lesson.tip,
      intro: 'Listen to each phrase and repeat it out loud in the pauses. Then recall each one from the English.',
      mount: (stage, api) => chain(stage, api, [
        (s, a) => RepeatPlayer(s, { items: cards, skipLabel: 'Skip to the recall round', onDone: a.done }),
        (s, a) => RecallDeck(s, { items: shuffle(cards), srs: true, doneTitle: 'Phrases learned', onDone: a.done }),
      ]),
    },
    {
      name: 'Build',
      title: 'Build new sentences',
      mins: 5,
      intro: 'Now make <strong>new</strong> sentences from pieces you already know. Think, say it out loud, then check. This is where speaking grows.',
      mount: (stage, api) => RecallDeck(stage, {
        items: lesson.build.map(([en, es]) => ({ en, es })),
        srs: false,
        doneTitle: 'Sentences built',
        onDone: api.done,
      }),
    },
    {
      name: 'Speak',
      title: 'Shadow and role-play',
      mins: 6,
      intro: 'First repeat each line of the conversation. Then shadow it: speak <strong>at the same time</strong> as the voice. After that, play your role.',
      mount: (stage, api) => chain(stage, api, [
        (s, a) => Shadow(s, { lesson, onDone: a.done }),
        (s, a) => RolePlay(s, { lesson, onDone: a.done }),
      ]),
    },
    {
      name: 'Free talk',
      title: 'Talk for one minute',
      mins: 2,
      intro: 'No script now. Speak for one minute, then do it once more. Mistakes are fine. Silence is the only wrong answer.',
      mount: (stage, api) => FreeTalk(stage, { task: lesson.say, hints: cards, onDone: api.done }),
    },
  ];
}

function reviewSteps(week) {
  const cards = week.lessons.flatMap((l) => Course.cardsOf(l.id));
  const lines = week.lessons.flatMap((l) => l.dialogue.map(([, es, en]) => ({ es, en })));
  const builds = week.lessons.flatMap((l) => l.build.map(([en, es]) => ({ en, es })));
  return [
    {
      name: 'Listening test',
      title: 'Listening test',
      mins: 8,
      intro: 'You hear phrases from this week without seeing them. Choose the meaning. This trains your ear to catch Spanish at normal speed.',
      mount: (stage, api) => ListenQuiz(stage, { pool: [...cards, ...lines], count: 14, onDone: api.done }),
    },
    {
      name: 'Recall',
      title: 'Speaking review',
      mins: 10,
      intro: 'Everything that is due, plus a mix from this week. Say each one out loud before you check.',
      mount(stage, api) {
        const due = Store.due(40).map(Course.card);
        const seen = new Set(due.map((c) => c.id));
        const extra = shuffle(cards.filter((c) => !seen.has(c.id))).slice(0, Math.max(0, 24 - due.length));
        return RecallDeck(stage, { items: [...due, ...extra], srs: true, doneTitle: 'Review complete', onDone: api.done });
      },
    },
    {
      name: 'Build',
      title: 'Sentence building',
      mins: 5,
      intro: 'Sentences from this week\'s lessons, in random order.',
      mount: (stage, api) => RecallDeck(stage, { items: shuffle(builds).slice(0, 14), srs: false, doneTitle: 'Sentences built', onDone: api.done }),
    },
    {
      name: 'Conversations',
      title: 'Replay the week',
      mins: 5,
      intro: 'Pick any conversation from this week. Listen again, or play your role without looking.',
      mount: (stage, api) => DialogueMenu(stage, { lessons: week.lessons, onDone: api.done }),
    },
    {
      name: 'Check',
      title: 'What can you do now?',
      mins: 2,
      intro: 'Be honest. Anything you cannot tick yet will keep coming back in your warm-ups.',
      mount: (stage, api) => Checklist(stage, {
        items: week.lessons.map((l) => ({ key: `can.${l.id}`, text: `I can ${l.can}.` })),
        onDone: api.done,
      }),
    },
  ];
}

function partnerPrompt(week) {
  const m = week.mission;
  const phrases = week.lessons.flatMap((l) => l.phrases.map((p) => p[0])).join(' · ');
  const earlier = Course.weeks.filter((w) => w.n < week.n).flatMap((w) => w.lessons.map((l) => l.title)).join(', ');
  const tenses = week.n >= 8
    ? 'Use the present tense, the simple past, and "voy a" for the future.'
    : week.n >= 7 ? 'Use the present tense and "voy a" for the future. No past tenses yet.' : 'Use only the present tense.';
  return `You are my Spanish conversation partner. I am a beginner, in week ${week.n} of a 12-week speaking course.

How to talk with me:
- Speak only Spanish (neutral Latin American), slowly, in short simple sentences.
- Say one thing or ask one question at a time, then wait for me.
- ${tenses}
- If I make a mistake, answer naturally first, then say the correct sentence once, and continue.
- If I say "no entiendo" or "más despacio", say it again with easier words.
- If I am stuck for a long time, give me a short hint in English, then go back to Spanish.
- Do not explain grammar.

Today's role-play: ${m.scene}
You are: ${m.partner}. I am: ${m.you}.
My goals:
${m.goals.map((g, i) => `${i + 1}. ${g}`).join('\n')}

Phrases I learned this week (use them, and help me use them): ${phrases}
${earlier ? `Topics I already know: ${earlier}.\n` : ''}
Start the role-play now with a simple greeting. After about 10 minutes, or when I say "terminamos", stop and tell me in English: two things I did well, and the three most useful corrections.`;
}

function missionSteps(week) {
  const m = week.mission;
  const builds = week.lessons.flatMap((l) => l.build.map(([en, es]) => ({ en, es })));
  return [
    {
      name: 'Brief',
      title: `Your mission: ${m.title}`,
      mins: 2,
      mount(stage, api) {
        stage.innerHTML = `<dl class="brief">
          <dt>The situation</dt><dd>${esc(m.scene)}</dd>
          <dt>You are</dt><dd>${esc(m.you)}</dd>
          <dt>You talk with</dt><dd>${esc(m.partner)}</dd>
          <dt>Your goals</dt><dd><ol>${m.goals.map((g) => `<li>${esc(g)}</li>`).join('')}</ol></dd>
        </dl>
        <p class="muted">Today you use your Spanish for real. First a short rehearsal, then a real conversation of 10 to 15 minutes.</p>`;
        api.done();
        return null;
      },
    },
    {
      name: 'Rehearse',
      title: 'Rehearse',
      mins: 8,
      intro: 'Warm up your mouth before the real thing: a round of sentence building, then any conversation from this week.',
      mount: (stage, api) => chain(stage, api, [
        (s, a) => RecallDeck(s, { items: shuffle(builds).slice(0, 10), srs: false, doneTitle: 'Warm', onDone: a.done }),
        (s, a) => DialogueMenu(s, { lessons: week.lessons, onDone: a.done }),
      ]),
    },
    {
      name: 'Talk',
      title: 'The real conversation',
      mins: 15,
      intro: 'Choose one way to have the conversation. What matters is that <strong>you speak and somebody answers</strong>.',
      mount(stage, api) {
        let left = 900;
        let timer = null;
        const draw = () => {
          stage.innerHTML = `
          <div class="option"><h3>A · An AI voice partner</h3>
            <p>Copy this briefing, paste it into an AI assistant that has a voice mode (on your phone or computer), then switch to voice and talk.</p>
            <textarea readonly id="prompt">${esc(partnerPrompt(week))}</textarea>
            <div class="row left"><button class="btn primary" data-act="copy">Copy the briefing</button></div>
          </div>
          <div class="option"><h3>B · A person</h3>
            <p>A Spanish-speaking friend, a language-exchange partner or an online tutor. Tell them the situation and your goals from the brief, and ask them to speak slowly.</p>
          </div>
          <div class="option"><h3>C · Alone, out loud</h3>
            <p>No partner today? Go back one step and role-play three conversations, then play both roles of the mission from memory. Less powerful, but far better than skipping.</p>
          </div>
          <div class="center"><div class="count ${timer ? 'run' : ''}" id="count">${fmtTime(left)}</div>
            <button class="btn" data-act="timer">${timer ? 'Pause the timer' : 'Start a 15-minute timer'}</button></div>`;
        };
        stage.onclick = (e) => {
          const b = e.target.closest('[data-act]');
          if (!b) return;
          if (b.dataset.act === 'copy') {
            const text = $('#prompt', stage).value;
            const fallback = () => { $('#prompt', stage).select(); document.execCommand('copy'); };
            if (navigator.clipboard) navigator.clipboard.writeText(text).catch(fallback); else fallback();
            toast('Briefing copied. Paste it into your AI assistant, then switch to voice.');
          } else if (b.dataset.act === 'timer') {
            if (timer) { clearInterval(timer); timer = null; draw(); return; }
            timer = setInterval(() => {
              left = Math.max(0, left - 1);
              const n = $('#count', stage);
              if (n) n.textContent = fmtTime(left);
              if (!left) { clearInterval(timer); timer = null; draw(); toast('Fifteen minutes. Well done. Go on to the debrief.'); }
            }, 1000);
            draw();
          }
        };
        draw();
        api.done();
        return { destroy() { clearInterval(timer); stage.onclick = null; } };
      },
    },
    {
      name: 'Debrief',
      title: 'Debrief',
      mins: 5,
      intro: 'Tick what you managed. Then write down what you wanted to say but could not: that list is your most valuable study material.',
      mount: (stage, api) => Checklist(stage, {
        items: m.goals.map((g, i) => ({ key: `goal.${week.n}.${i}`, text: g })),
        notesKey: `m${week.n}`,
        after: `<h4>Words and phrases I was missing</h4>
          <textarea id="notes" placeholder="Write them in English or Spanish. They are saved with your progress.">${esc(Store.state.notes[`m${week.n}`] || '')}</textarea>`,
        onDone: api.done,
      }),
    },
  ];
}

/* =====================================================================
   Views
   ===================================================================== */

function voiceMessage(q) {
  if (q === 'checking') return 'Checking which voices this browser has…';
  if (q === 'natural') return `Natural Spanish voice ready: ${esc(shortVoice(Speech.voiceFor('a')))}.`;
  if (q === 'basic') {
    return onPhone
      ? `Spanish voice ready: ${esc(shortVoice(Speech.voiceFor('a')))}.`
      : 'This browser only has a basic Spanish voice. For much more natural voices, open Habla in <strong>Microsoft Edge</strong>.';
  }
  return onPhone
    ? 'No Spanish voice was found on this phone. Add Spanish in the phone\'s text-to-speech settings, or open Habla on a computer in Microsoft Edge.'
    : 'No Spanish voice was found in this browser. Open Habla in <strong>Microsoft Edge</strong> (best) or Google Chrome, and check that you are online.';
}

function Home(root) {
  const st = Store.stats();
  const next = Store.nextDay();
  const total = Course.days.length;
  const q = Speech.quality();
  const parts = [];

  if (!settings().onboarded) {
    parts.push(`<section class="card welcome">
      <span class="kicker">Before day 1</span>
      <h2>Three quick checks</h2>
      <ol>
        <li><strong>Sound.</strong> ${voiceMessage(q)}<br><button class="btn sm" data-act="testvoice" style="margin-top:.4rem">Play a Spanish sentence</button></li>
        <li><strong>Headphones</strong> make Spanish sounds much clearer. A quiet place where you can talk out loud is even more important.</li>
        <li><strong>Always answer out loud.</strong> Thinking the answer trains your memory. Only saying it trains your mouth.</li>
      </ol>
      <div class="row left"><button class="btn primary" data-act="onboard">I am ready</button><a class="btn ghost" href="#/method">How the method works</a></div>
    </section>`);
  } else if (q === 'none' || (q === 'basic' && !onPhone)) {
    parts.push(`<div class="banner ${q === 'none' ? 'bad' : ''}">${voiceMessage(q)}</div>`);
  }

  if (next) {
    const dueCount = Store.due(200).length;
    let title;
    let lead;
    let meta;
    if (next.kind === 'lesson') {
      const l = Course.lessons[next.id];
      title = l.title;
      lead = `After today you can ${l.can}.`;
      meta = `About 30 minutes · ${l.phrases.length} new phrases · ${dueCount} to review`;
    } else if (next.kind === 'review') {
      title = 'Review and listening test';
      lead = 'No new material today. You test your ear, refresh this week\'s phrases and check what you can do now.';
      meta = `About 30 minutes · ${dueCount} to review`;
    } else {
      const m = Course.week(next.week).mission;
      title = `Mission: ${m.title}`;
      lead = m.scene;
      meta = 'About 30 minutes · a real conversation';
    }
    const resume = Store.state.resume && Store.state.resume.id === next.id && Store.state.resume.step > 0;
    parts.push(`<section class="card hero">
      <span class="kicker">Week ${next.week} of ${Course.weeks.length} · Day ${next.day} of ${total}</span>
      <h1>${esc(title)}</h1>
      <p class="lead">${esc(lead)}</p>
      <a class="btn primary big" href="#/day/${next.day}">${resume ? 'Continue' : 'Start'} today's session →</a>
      <p class="meta">${meta}</p>
      ${st.practicedToday ? '<p class="note-line">You already practiced today. One session a day is the plan, because sleep is when memory sets. You can still go on if you want.</p>' : ''}
    </section>`);
  } else {
    parts.push(`<section class="card hero">
      <span class="kicker">All ${total} days done</span>
      <h1>You finished the course</h1>
      <p class="lead">Keep the habit: a daily warm-up here, plus real conversations and real listening. The Method page lists where to go next.</p>
      <a class="btn primary big" href="#/day/${total}">Repeat the final mission</a>
    </section>`);
  }

  parts.push(`<section class="stats">
    <div class="stat"><b>${st.streak}</b><span>day streak</span></div>
    <div class="stat"><b>${st.sessions}<small class="muted"> / ${total}</small></b><span>sessions done</span></div>
    <div class="stat"><b>${st.minutes}</b><span>minutes practiced</span></div>
    <div class="stat"><b>${st.learned}</b><span>phrases learned · ${st.strong} strong</span></div>
  </section>`);

  parts.push(`<section class="card"><h2>Your 12 weeks</h2>${Course.weeks.map((w) => `<div class="wk">
    <div><span class="wk-n">Week ${w.n}</span><span class="wk-t">${esc(w.title)}</span></div>
    <div class="chips">${Course.days.filter((d) => d.week === w.n).map((d, i) => {
      const cls = Store.state.done[d.id] ? 'done' : next && next.id === d.id ? 'next' : '';
      const label = d.kind === 'lesson' ? i + 1 : d.kind === 'review' ? 'R' : 'M';
      return `<a class="chip ${cls} ${d.kind === 'lesson' ? '' : 'alt'}" href="#/day/${d.day}" title="Day ${d.day}: ${esc(d.title)}">${label}</a>`;
    }).join('')}</div></div>`).join('')}
    <p class="legend">1–5 = lessons · R = review and listening test · M = mission (a real conversation)</p></section>`);

  root.innerHTML = parts.join('');

  root.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'testvoice') {
      Speech.stopAll();
      Speech.say('Hola. Bienvenido a Habla. Vamos a hablar español.', 'a');
    } else if (b.dataset.act === 'onboard') {
      settings().onboarded = true;
      Store.save();
      route();
    }
  };
  const off = Speech.onVoices(() => route());
  return { destroy() { off(); root.onclick = null; } };
}

function DayView(root, arg) {
  const day = Course.days[Number(arg) - 1];
  if (!day) { location.hash = '#/'; return null; }
  const week = Course.week(day.week);
  const steps = day.kind === 'lesson' ? lessonSteps(Course.lessons[day.id])
    : day.kind === 'review' ? reviewSteps(week) : missionSteps(week);

  let i = 0;
  let seconds = 0;
  let comp = null;
  let ready = false;
  let finished = false;

  const saved = Store.state.resume;
  if (saved && saved.id === day.id && saved.step < steps.length) { i = saved.step; seconds = saved.sec || 0; }

  const saveResume = () => { Store.state.resume = { id: day.id, step: i, sec: seconds }; Store.save(); };

  const tick = setInterval(() => {
    if (finished || document.visibilityState !== 'visible') return;
    seconds++;
    const c = $('#clock', root);
    if (c) c.textContent = fmtTime(seconds);
    if (seconds % 20 === 0) saveResume();
  }, 1000);

  function shell() {
    const st = steps[i];
    root.innerHTML = `<div class="session">
      <div class="session-head">
        <a class="leave" href="#/" title="Leave the session (your place is saved)">✕</a>
        <div class="session-title"><span class="kicker">Week ${day.week} · Day ${day.day}</span><strong>${esc(day.title)}</strong></div>
        <div class="clock"><span id="clock">${fmtTime(seconds)}</span> / 30:00</div>
      </div>
      <ol class="steps">${steps.map((s, k) => `<li class="${k < i ? 'done' : k === i ? 'current' : ''}"><span>${k < i ? '✓' : k + 1}</span>${esc(s.name)}</li>`).join('')}</ol>
      <section class="step card">
        <header class="step-head"><h2>${esc(st.title)}</h2><span class="mins">about ${st.mins} min</span></header>
        ${st.intro ? `<p class="intro">${st.intro}</p>` : ''}
        ${st.tip ? `<aside class="tip"><strong>Tip</strong>${esc(st.tip)}</aside>` : ''}
        <div id="stage"></div>
      </section>
      <div class="session-foot">
        <button class="btn ghost" id="prev" ${i === 0 ? 'disabled' : ''}>← Back</button>
        <button class="btn" id="next">${i === steps.length - 1 ? 'Finish session' : 'Next step →'}</button>
      </div>
    </div>`;
  }

  function mountStep() {
    killFlows();
    if (comp && comp.destroy) comp.destroy();
    comp = null;
    ready = false;
    shell();
    comp = steps[i].mount($('#stage', root), {
      done: () => {
        ready = true;
        const b = $('#next', root);
        if (b) b.classList.add('ready');
      },
    }) || null;
    saveResume();
    window.scrollTo(0, 0);
  }

  function go(step) {
    const n = i + step;
    if (n < 0) return;
    if (n >= steps.length) { finish(); return; }
    i = n;
    mountStep();
  }

  function finish() {
    finished = true;
    keepAwake(false);
    killFlows();
    if (comp && comp.destroy) comp.destroy();
    comp = null;
    const minutes = Math.max(1, Math.round(seconds / 60));
    Store.complete(day.id, minutes);
    const next = Store.nextDay();
    const st = Store.stats();
    root.innerHTML = `<section class="card center">
      <div class="done-box"><div class="check">✓</div>
        <h1>Day ${day.day} complete</h1>
        <p class="lead">${minutes} ${minutes === 1 ? 'minute' : 'minutes'} of Spanish today · ${st.learned} phrases learned so far · ${st.streak} day streak</p>
      </div>
      ${next ? `<p>Next: <strong>Day ${next.day}</strong> · ${esc(next.title)}</p>` : '<p><strong>That was the last day. You did it.</strong></p>'}
      <p class="muted">Want more today? Do not start a new lesson. Put on the <a href="#/listen">Listen</a> page while you walk, cook or commute.</p>
      <div class="row"><a class="btn primary big" href="#/">Back to the overview</a></div>
    </section>`;
  }

  root.onclick = (e) => {
    if (e.target.closest('#next')) go(1);
    else if (e.target.closest('#prev')) go(-1);
  };

  mountStep();
  keepAwake(true);
  return {
    onKey(e) {
      if (finished) return false;
      if (comp && comp.onKey && comp.onKey(e)) return true;
      if (e.key === 'Enter' && ready) { go(1); return true; }
      return false;
    },
    destroy() {
      clearInterval(tick);
      keepAwake(false);
      if (!finished) saveResume();
      if (comp && comp.destroy) comp.destroy();
      root.onclick = null;
    },
  };
}

function PhrasesView(root) {
  const next = Store.nextDay();
  const openWeek = next ? next.week : 1;
  root.innerHTML = `<section class="card">
    <h1>Phrasebook</h1>
    <p class="lead">Every phrase in the course. Tap one to hear it.</p>
    <input id="q" type="search" placeholder="Search in Spanish or English" autocomplete="off">
    <div id="plist" style="margin-top:1rem"></div>
  </section>`;
  const list = $('#plist', root);

  function draw(query) {
    const nq = flat(query).trim();
    list.innerHTML = Course.weeks.map((w) => {
      const body = w.lessons.map((l) => {
        const rows = Course.cardsOf(l.id).filter((c) => !nq || flat(`${c.es} ${c.en}`).includes(nq));
        if (!rows.length) return '';
        return `<h4>${l.id} · ${esc(l.title)}</h4>${rows.map((c) => `<button class="prow" data-say="${esc(c.es)}"><span class="es">${esc(c.es)}</span><span class="en">${esc(c.en)}</span></button>`).join('')}`;
      }).join('');
      if (!body) return '';
      return `<details ${nq || w.n === openWeek ? 'open' : ''}><summary>Week ${w.n} · ${esc(w.title)}</summary>${body}</details>`;
    }).join('') || '<p class="muted">No phrase matches.</p>';
  }

  root.oninput = (e) => { if (e.target.id === 'q') draw(e.target.value); };
  root.onclick = (e) => {
    const b = e.target.closest('[data-say]');
    if (b) { Speech.stopAll(); Speech.say(b.dataset.say, 'a'); }
  };
  draw('');
  return { destroy() { root.oninput = null; root.onclick = null; } };
}

function ListenView(root) {
  const finishedLessons = Course.days.filter((d) => d.kind === 'lesson' && Store.state.done[d.id]).map((d) => Course.lessons[d.id]);
  const list = finishedLessons.length ? finishedLessons : Course.weeks.length ? [Course.weeks[0].lessons[0]] : [];
  let playing = false;
  let withEnglish = false;
  let showText = true;
  let now = null;

  function render() {
    root.innerHTML = `<section class="card">
      <h1>Listen</h1>
      <p class="lead">Extra listening for the moments outside your 30 minutes: walking, cooking, commuting. It plays the conversations from every lesson you have finished, one after another.</p>
      <p class="muted">${finishedLessons.length ? `${finishedLessons.length} conversations ready.` : 'You have not finished a lesson yet, so this plays the first conversation as a preview.'}</p>
      <div class="row left">
        <button class="btn primary big" data-act="toggle">${playing ? 'Stop' : 'Play'} <kbd>Space</kbd></button>
        <label><input type="checkbox" id="en" ${withEnglish ? 'checked' : ''}> Say the English after each line</label>
        <label><input type="checkbox" id="txt" ${showText ? 'checked' : ''}> Show the text</label>
      </div>
      <div id="now" style="margin-top:1.2rem;min-height:6rem"></div>
    </section>
    <section class="card prose">
      <h2>Real voices, for free</h2>
      <p>The voices in Habla are synthetic. They are clear and correct, but real people speak faster and less neatly. From week 3 or 4, add a few minutes of real Spanish whenever you can:</p>
      <ul>
        <li><a href="https://www.languagetransfer.org/complete-spanish" target="_blank" rel="noopener">Language Transfer: Complete Spanish</a>. Free audio course, 90 short tracks. You answer out loud, like here. Good for a walk.</li>
        <li><a href="https://www.dreaming.com/spanish" target="_blank" rel="noopener">Dreaming Spanish</a>. Videos made for learners; start with "Superbeginner". You understand from pictures and gestures.</li>
      </ul>
    </section>`;
    drawNow();
  }

  function drawNow() {
    const box = $('#now', root);
    if (!box) return;
    if (!now) { box.innerHTML = ''; return; }
    box.innerHTML = `<span class="kicker">${esc(now.title)}</span>${showText
      ? `<div class="p-es" style="font-size:1.5rem">${esc(now.es)}</div><div class="p-en">${esc(now.en)}</div>`
      : '<div class="p-en">Text hidden. Just listen.</div>'}`;
  }

  async function play() {
    killFlows();
    const flow = newFlow();
    playing = true;
    keepAwake(true);
    render();
    while (flow.alive() && list.length) {
      for (const lesson of list) {
        for (const [sp, es, en] of lesson.dialogue) {
          now = { title: `${lesson.id} · ${lesson.title}`, es, en };
          drawNow();
          await Speech.say(es, voiceOf(sp));
          if (!flow.alive()) return;
          if (withEnglish) {
            await Speech.say(en, 'en');
            if (!flow.alive()) return;
          }
          await sleep(400);
          if (!flow.alive()) return;
        }
        await sleep(1200);
        if (!flow.alive()) return;
      }
    }
  }

  function stop() {
    killFlows();
    playing = false;
    keepAwake(false);
    now = null;
    render();
  }

  root.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (b && b.dataset.act === 'toggle') { if (playing) stop(); else play(); }
  };
  root.onchange = (e) => {
    if (e.target.id === 'en') withEnglish = e.target.checked;
    if (e.target.id === 'txt') { showText = e.target.checked; drawNow(); }
  };
  render();
  return {
    onKey(e) { if (e.key === ' ') { if (playing) stop(); else play(); return true; } return false; },
    destroy() { keepAwake(false); root.onclick = null; root.onchange = null; },
  };
}

function SettingsView(root) {
  let micResult = '';

  function draw() {
    const s = settings();
    const es = Speech.esVoices();
    const en = Speech.enVoices();
    const cur = { a: Speech.voiceFor('a'), b: Speech.voiceFor('b'), en: Speech.voiceFor('en') };
    const options = (list, sel) => list.map((v) => `<option value="${esc(v.name)}" ${sel && v.name === sel.name ? 'selected' : ''}>${esc(v.name)}</option>`).join('');
    const accents = Speech.accents();
    const q = Speech.quality();
    // If the saved accent has no voice in this browser, show the one actually in use.
    const active = accents.find((a) => a.toLowerCase() === String(s.accent).toLowerCase()) || (cur.a ? Speech.langOf(cur.a) : '');
    root.innerHTML = `<section class="card">
      <h1>Settings</h1>
      ${q === 'natural' || (q === 'basic' && onPhone) ? '' : `<div class="banner ${q === 'none' ? 'bad' : ''}">${voiceMessage(q)}</div>`}
      <div class="field"><label for="accent">Accent<small>Which Spanish you hear and are checked against</small></label>
        <div class="ctl"><select id="accent">${accents.map((a) => `<option value="${a}" ${a === active ? 'selected' : ''}>${esc(ACCENTS[a] || a)} (${a})</option>`).join('') || '<option>No Spanish voices found</option>'}</select></div></div>
      <div class="field"><label for="voiceA">Voice 1<small>Phrases, and the first speaker</small></label>
        <div class="ctl"><select id="voiceA">${options(es, cur.a)}</select><button class="btn sm" data-act="testA">Test</button></div></div>
      <div class="field"><label for="voiceB">Voice 2<small>Your role in conversations</small></label>
        <div class="ctl"><select id="voiceB">${options(es, cur.b)}</select><button class="btn sm" data-act="testB">Test</button></div></div>
      <div class="field"><label for="rate">Speaking speed<small>1.0 is natural speed</small></label>
        <div class="ctl"><input type="range" id="rate" min="0.7" max="1.1" step="0.05" value="${s.rate}"><span>${Number(s.rate).toFixed(2)}×</span></div></div>
      <div class="field"><label for="sayEnglish">Read English prompts aloud<small>So you can practice without looking at the screen</small></label>
        <div class="ctl"><input type="checkbox" id="sayEnglish" ${s.sayEnglish ? 'checked' : ''}></div></div>
      <div class="field"><label for="voiceEn">English voice</label>
        <div class="ctl"><select id="voiceEn">${options(en, cur.en)}</select></div></div>
      <div class="field"><label for="mic">Microphone check<small>${Speech.canListen() ? 'Listens to your answer and compares it. It is strict and sometimes wrong: trust your own ear too.' : 'This browser cannot do speech recognition. You can still practice and check yourself.'}</small></label>
        <div class="ctl"><input type="checkbox" id="mic" ${s.mic ? 'checked' : ''} ${Speech.canListen() ? '' : 'disabled'}>
          ${Speech.canListen() ? '<button class="btn sm" data-act="testMic">Test: say “Hola, buenos días”</button>' : ''}<span class="small">${micResult}</span></div></div>
    </section>
    <section class="card">
      <h2>Your progress</h2>
      <p class="muted">${Store.serverOk
        ? 'Saved in this browser and in the file <code>progress.json</code> in your Spanish folder.'
        : Store.hosted
          ? 'Saved in this browser, on this device only. To continue on another device, save a backup file here and load it there. Save a backup now and then: clearing the browser\'s data also clears your progress.'
          : 'Saved in this browser only. Start Habla with “Start Habla.cmd” to also keep a copy in your Spanish folder.'}</p>
      <div class="row left">
        <button class="btn" data-act="export">Save a backup file</button>
        <label class="btn">Load a backup file<input type="file" id="importFile" accept="application/json,.json" hidden></label>
        <button class="btn rate-0" data-act="reset">Start over from day 1</button>
      </div>
    </section>`;
  }

  root.onchange = (e) => {
    const t = e.target;
    const s = settings();
    if (t.id === 'accent') { s.accent = t.value; s.voiceA = ''; s.voiceB = ''; }
    else if (t.id === 'voiceA') s.voiceA = t.value;
    else if (t.id === 'voiceB') s.voiceB = t.value;
    else if (t.id === 'voiceEn') s.voiceEn = t.value;
    else if (t.id === 'rate') s.rate = Number(t.value);
    else if (t.id === 'sayEnglish') s.sayEnglish = t.checked;
    else if (t.id === 'mic') { s.mic = t.checked; micBlocked = false; micFails = 0; }
    else if (t.id === 'importFile') {
      const file = t.files[0];
      if (!file) return;
      file.text().then((text) => {
        const data = JSON.parse(text);
        if (!data || typeof data !== 'object' || !data.cards || !data.done) throw new Error('not a Habla backup');
        Store.replace(data);
        toast('Backup loaded.');
        draw();
      }).catch(() => toast('That file is not a Habla backup.'));
      return;
    } else return;
    Store.save();
    draw();
  };

  root.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'testA' || act === 'testB') {
      Speech.stopAll();
      Speech.say('Hola, ¿cómo estás? Me gusta mucho hablar español.', act === 'testA' ? 'a' : 'b');
    } else if (act === 'testMic') {
      killFlows();
      micResult = 'Listening…';
      draw();
      const res = await Speech.listen({});
      micProblem(res.error);
      if (res.alternatives.length) { micBlocked = false; micFails = 0; }
      micResult = res.alternatives.length ? `I heard: “${esc(res.alternatives[0])}”` : `Nothing heard${res.error ? ` (${esc(res.error)})` : ''}.`;
      draw();
    } else if (act === 'export') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(Store.state, null, 1)], { type: 'application/json' }));
      a.download = `habla-backup-${Store.today()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } else if (act === 'reset') {
      if (window.confirm('Delete all progress and start again from day 1? This cannot be undone.')) {
        Store.reset();
        toast('Progress cleared.');
        draw();
      }
    }
  };

  const off = Speech.onVoices(draw);
  draw();
  return { destroy() { off(); root.onchange = null; root.onclick = null; } };
}

function MethodView(root) {
  const phrases = Course.weeks.reduce((n, w) => n + w.lessons.reduce((m, l) => m + l.phrases.length, 0), 0);
  const words = new Set();
  Course.weeks.forEach((w) => w.lessons.forEach((l) => {
    [...l.phrases.map((p) => p[0]), ...l.dialogue.map((d) => d[1]), ...l.build.map((b) => b[1])]
      .forEach((text) => flat(text).replace(/[^a-zñ\s]/g, ' ').split(/\s+/).forEach((x) => { if (x) words.add(x); }));
  }));
  const wordCount = Math.round(words.size / 50) * 50;
  const hours = Math.round((Course.days.length * 30) / 60);

  root.innerHTML = `<section class="card prose">
    <span class="kicker">Plan and method</span>
    <h1>How 30 minutes a day gets you speaking</h1>
    <p class="lead">${Course.days.length} sessions of 30 minutes is about ${hours} hours. That is not enough for fluency, and enough for real conversations about everyday things, if every minute goes into listening and speaking.</p>

    <h2>What is realistic</h2>
    <table>
      <tr><th>Benchmark</th><th>What it says</th><th>What it means for you</th></tr>
      <tr><td>US Foreign Service Institute</td><td>Spanish is in the easiest group for English speakers: 600 to 750 class hours to professional level.</td><td>Fluency is a multi-year goal. Basic communication is not.</td></tr>
      <tr><td>Language schools (CEFR level A1)</td><td>A1, the "survival" level, is usually taught in 60 to 100 hours, split over reading, writing, listening and speaking.</td><td>You skip reading and writing, so ${hours} focused hours can bring your <em>speaking and listening</em> to about A1.</td></tr>
      <tr><td>Word frequency (Davies, 2005)</td><td>The 1,000 most common words make up 87.8% of the words in spoken Spanish.</td><td>A small, well-chosen vocabulary goes a long way. This course uses about ${wordCount} word forms inside ${phrases} ready-made phrases.</td></tr>
      <tr><td>12-week study (Loewen, Isbell and Sporn, 2020)</td><td>Beginners studied Spanish with an app for 12 weeks, about 10 minutes a day. 59% rose at least one step on the oral proficiency scale. Study time was the strongest predictor.</td><td>Your plan has three times that study time, all of it spoken.</td></tr>
    </table>
    <p><strong>The goal for week 12:</strong> you can meet someone, talk about yourself, order, shop, ask the way, make plans, tell what you did, and solve a simple problem. Slowly and with mistakes, and successfully.</p>

    <h2>What works, and where you do it</h2>
    <table>
      <tr><th>Principle</th><th>Evidence</th><th>In your session</th></tr>
      <tr><td>To learn to speak, speak</td><td>Across 35 comparisons, teaching built on producing the language gave better productive knowledge on delayed tests than teaching built on understanding it (Shintani, Li and Ellis, 2013). A well-known listening-only method expects about 50 hours of input before you "know some common words" (Dreaming Spanish roadmap).</td><td>You talk in every step from day 1.</td></tr>
      <tr><td>Recall beats re-reading</td><td>Pulling an answer from memory strengthens it more than seeing it again: about half a standard deviation across 61 studies (Rowland, 2014).</td><td>English prompt → say the Spanish → check.</td></tr>
      <tr><td>Spread it out</td><td>Spaced practice has a medium-to-large effect on second-language learning, and longer gaps help long-term memory (Kim and Webb, 2022, 48 experiments).</td><td>30 minutes daily, not 3.5 hours on Sunday. Phrases return after 1, 3, 7, 14, 30 and 60 days.</td></tr>
      <tr><td>Balance four kinds of work</td><td>Nation's "four strands": input, output, deliberate study and fluency practice, in roughly equal parts.</td><td>The six steps of each lesson.</td></tr>
      <tr><td>Whole phrases, not single words</td><td>Learners who used ready-made phrases were judged more proficient speakers (Boers and colleagues, 2006).</td><td>You learn phrases first. Grammar comes as one short tip.</td></tr>
      <tr><td>Shadowing</td><td>Speaking along with a recording improved listening for lower-level learners (Hamada, 2016) and speaking measures over eight weeks (Foote and McDonough, 2017).</td><td>Step 5.</td></tr>
      <tr><td>Say the same thing again</td><td>Repeating a talk under time pressure builds lasting fluency (de Jong and Perfetti, 2011).</td><td>Step 6: speak, then speak again.</td></tr>
      <tr><td>Real conversation and feedback</td><td>Interaction has large effects on learning (Mackey and Goo, 2007). Conversation practice with AI partners: medium effect on speaking (Hou and Min, 2025). Speech-recognition feedback: medium effect on pronunciation (Ngo, Chen and Lai, 2024).</td><td>Day 7 missions, and the optional microphone check.</td></tr>
    </table>

    <h2>Your week</h2>
    <ul>
      <li><strong>Days 1 to 5: lessons.</strong> Warm-up, listen, learn about nine phrases, build new sentences, shadow and role-play, one minute of free talk.</li>
      <li><strong>Day 6: review.</strong> A listening test without text, a speaking review, and a check of what you can do.</li>
      <li><strong>Day 7: mission.</strong> A real conversation of 10 to 15 minutes with an AI voice partner or a person.</li>
    </ul>
    <p>Missed a day? Just do the next session. The plan has 84 days, so three months leaves you about a week of spare days.</p>

    <h2>Three rules</h2>
    <ol>
      <li><strong>Out loud, always.</strong> Thinking the answer does not train your mouth.</li>
      <li><strong>Every day beats longer sessions.</strong> If you only have 10 minutes, do the warm-up.</li>
      <li><strong>Do the Day 7 conversation.</strong> It is the hardest step and the one that turns phrases into communication.</li>
    </ol>

    <h2>Honest limits</h2>
    <ul>
      <li>The voices are synthetic. Studies found learners understood synthetic and human voices about equally well (Bione and Cardoso, 2020), but real people talk faster and less clearly. Add real voices from the <a href="#/listen">Listen</a> page.</li>
      <li>The microphone check is a help, not a judge. It hears a beginner's accent imperfectly. If it fails twice, compare with the model voice yourself and move on.</li>
      <li>The conversations use one man's role (Luis) for "you". If you are a woman, change the ending of words that describe you: <em>cansado → cansada</em>. The microphone check accepts both.</li>
    </ul>

    <h2>Sources</h2>
    <ul class="src">
      <li>US Department of State, Foreign Service Institute, <a href="https://www.state.gov/foreign-language-training/" target="_blank" rel="noopener">Foreign language training</a>.</li>
      <li>Cambridge English, <a href="https://support.cambridgeenglish.org/hc/en-gb/articles/202838506-Guided-learning-hours" target="_blank" rel="noopener">Guided learning hours</a>.</li>
      <li>Davies, M. (2005). <a href="https://www.mark-davies.org/articles/davies_26.pdf" target="_blank" rel="noopener">Vocabulary range and text coverage</a>.</li>
      <li>Loewen, S., Isbell, D. and Sporn, Z. (2020). <a href="https://doi.org/10.1111/flan.12454" target="_blank" rel="noopener">The effectiveness of app-based language instruction for developing receptive linguistic knowledge and oral communicative ability</a>. Foreign Language Annals. Funded by the app's maker.</li>
      <li><a href="https://www.dreaming.com/spanish" target="_blank" rel="noopener">Dreaming Spanish</a>, learning roadmap: level 2 ("you know some common words") at 50 hours of input.</li>
      <li>Shintani, N., Li, S. and Ellis, R. (2013). <a href="https://doi.org/10.1111/lang.12001" target="_blank" rel="noopener">Comprehension-based versus production-based grammar instruction: a meta-analysis</a>. Language Learning.</li>
      <li>Rowland, C. (2014). The effect of testing versus restudy on retention: a meta-analytic review. Psychological Bulletin 140(6).</li>
      <li>Kim, S. K. and Webb, S. (2022). <a href="https://doi.org/10.1111/lang.12479" target="_blank" rel="noopener">The effects of spaced practice on second language learning: a meta-analysis</a>. Language Learning.</li>
      <li>Nation, P. (2007). <a href="https://core.ac.uk/download/357330216.pdf" target="_blank" rel="noopener">The four strands</a>.</li>
      <li>Boers, F. and colleagues (2006). Formulaic sequences and perceived oral proficiency. Language Teaching Research 10(3).</li>
      <li>Hamada, Y. <a href="https://contact.teslontario.org/wp-content/uploads/2018/08/Hamada-Shadowing.pdf" target="_blank" rel="noopener">Shadowing</a> (summary of his 2016 study).</li>
      <li>Foote, J. and McDonough, K. (2017). <a href="https://core.ac.uk/download/211518436.pdf" target="_blank" rel="noopener">Using shadowing with mobile technology to improve L2 pronunciation</a>.</li>
      <li>de Jong, N. and Perfetti, C. (2011). <a href="https://doi.org/10.1111/j.1467-9922.2010.00620.x" target="_blank" rel="noopener">Fluency training in the ESL classroom</a>. Language Learning.</li>
      <li>Mackey, A. and Goo, J. (2007). <a href="https://eprints.lancs.ac.uk/id/eprint/59863/" target="_blank" rel="noopener">Interaction research in SLA: a meta-analysis and research synthesis</a>.</li>
      <li>Hou, Z. and Min, S. (2025). Dialogue-based computer-assisted language learning systems for second language speaking development: a three-level meta-analysis. ReCALL.</li>
      <li>Ngo, T., Chen, H. and Lai, K. (2024). <a href="https://www.cambridge.org/core/journals/recall/article/effectiveness-of-automatic-speech-recognition-in-eslefl-pronunciation-a-metaanalysis/A915444CF252B61D14961D2FE733822D" target="_blank" rel="noopener">The effectiveness of automatic speech recognition in ESL/EFL pronunciation: a meta-analysis</a>. ReCALL.</li>
      <li>Bione, T. and Cardoso, W. (2020). <a href="https://www.lltjournal.org/item-detail/944/" target="_blank" rel="noopener">Synthetic voices in the foreign language context</a>. Language Learning and Technology.</li>
    </ul>
  </section>`;
  return null;
}

/* =====================================================================
   Router and start-up
   ===================================================================== */

const ROUTES = { '': Home, day: DayView, phrases: PhrasesView, listen: ListenView, method: MethodView, settings: SettingsView };
let view = null;

function route() {
  killFlows();
  if (view && view.destroy) view.destroy();
  view = null;
  const [name = '', arg] = location.hash.replace(/^#\/?/, '').split('/');
  const make = ROUTES[name] || Home;
  document.body.dataset.view = ROUTES[name] ? name || 'home' : 'home';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.nav === (ROUTES[name] ? name : '')));
  view = make($('#app'), arg) || null;
}

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.matches && e.target.matches('input, textarea, select')) return;
  if (view && view.onKey && view.onKey(e)) e.preventDefault();
});

(async function start() {
  await Store.init();
  Speech.init(() => Store.state.settings);
  window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });
  route();
})();
