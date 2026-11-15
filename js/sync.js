'use strict';

/* Progress that follows a person from one device to another.

   A device joins the family when the family link is opened on it once
   (…/#family=<key>). The key stays on the family's devices. From it the app makes
     - a sealing key: progress is encrypted (AES-GCM) before it leaves the device;
     - a signing key and one address per person: the sealed progress is kept as an
       "application data" note (Nostr NIP-78, kind 30078) on a few public relays.
   Relays are plain public servers that need no account. They only ever get sealed
   data, so they cannot read it, and only somebody with the key can write under it.

   Every device keeps its own full copy. The relays are where devices meet, not the
   only home of the data: if a relay loses something, the next device puts it back.
   Copies are combined (Store.combine), never simply replaced.

   The relays are listed in data/sync.js. Without that list, without a family key,
   or in a browser that lacks what is needed, nothing in this file does anything. */
const Sync = (() => {
  const cfg = window.SYNC || {};
  const relays = (Array.isArray(cfg.relays) ? cfg.relays : []).filter((u) => typeof u === 'string' && /^wss?:\/\/\S+$/.test(u));
  const site = typeof cfg.site === 'string' && cfg.site ? cfg.site : `${location.origin}${location.pathname}`;
  // (Store.absorb is missing when the browser still holds an older js/core.js in its cache.)
  const available = relays.length > 0 && typeof WebSocket === 'function' && typeof BigInt === 'function'
    && !!(window.crypto && window.crypto.subtle) && typeof Store !== 'undefined' && !Store.solo && typeof Store.absorb === 'function';

  const FAMILY = 'habla.family';    // the family key on this device, or "off" after "Disconnect"
  const TRUSTED = 'habla.sync.ok';  // notes whose signature this device has already checked
  const KEY_RE = /^[A-Za-z0-9_-]{22}$/;
  const KIND = 30078;
  const SUB = 'habla';
  const WAIT_MS = 5000;     // for a relay to connect and answer, and again for it to accept a note
  const GRACE_MS = 1200;    // after the first relay has answered, how long the slower ones get
  const PACE_MS = 90000;    // while somebody practices, send at most this often
  const FRESH_MS = 15000;   // what was fetched this recently is not fetched again
  const onThisComputer = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

  const get = (k) => { try { return window.localStorage.getItem(k); } catch { return null; } };
  const put = (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* full or blocked */ } };
  const secret = () => { const s = get(FAMILY); return s && KEY_RE.test(s) ? s : ''; };
  const linked = () => available && !!secret();
  const nowSec = () => Math.floor(Date.now() / 1000);

  /* ---------- bytes ---------- */
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const unhex = (s) => Uint8Array.from(s.match(/../g) || [], (h) => parseInt(h, 16));
  const cat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    parts.forEach((p) => { out.set(p, o); o += p.length; });
    return out;
  };
  const sha = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
  const b64 = (b) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const through = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

  /* ---------- signatures: BIP-340 Schnorr on the curve secp256k1, as Nostr notes need them ---------- */
  const P = 2n ** 256n - 2n ** 32n - 977n;
  const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
  const G = [0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n, 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n];
  const mod = (a, m = P) => ((a % m) + m) % m;
  const toBig = (b) => BigInt(`0x${hex(b) || '0'}`);
  const to32 = (n) => unhex(n.toString(16).padStart(64, '0'));
  function inv(number, m = P) {
    let a = mod(number, m); let b = m; let x = 0n; let y = 1n; let u = 1n; let v = 0n;
    while (a !== 0n) {
      const q = b / a; const r = b % a; const s = x - u * q; const t = y - v * q;
      b = a; a = r; x = u; y = v; u = s; v = t;
    }
    return mod(x, m);
  }
  function add(A, B) { // points are [x, y]; null is the point at infinity
    if (!A) return B;
    if (!B) return A;
    const [x1, y1] = A; const [x2, y2] = B;
    if (x1 === x2 && y1 !== y2) return null;
    const l = x1 === x2 ? mod(3n * x1 * x1 * inv(2n * y1)) : mod((y2 - y1) * inv(x2 - x1));
    const x3 = mod(l * l - x1 - x2);
    return [x3, mod(l * (x1 - x3) - y1)];
  }
  function mul(k, A = G) {
    let R = null;
    for (let n = k; n > 0n; n >>= 1n) { if (n & 1n) R = add(R, A); A = add(A, A); }
    return R;
  }
  function pow(base, e, m) {
    let r = 1n;
    for (let b = mod(base, m); e > 0n; e >>= 1n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; }
    return r;
  }
  async function tagged(tag, ...parts) { const t = await sha(enc.encode(tag)); return sha(cat(t, t, ...parts)); }

  // d: the secret number, already chosen so that its public point has an even y. px: that point's x.
  async function sign(msg, d, px, aux) {
    const t = to32(d ^ toBig(await tagged('BIP0340/aux', aux)));
    const k0 = mod(toBig(await tagged('BIP0340/nonce', t, px, msg)), N);
    const R = mul(k0);
    const k = R[1] % 2n === 0n ? k0 : N - k0;
    const e = mod(toBig(await tagged('BIP0340/challenge', to32(R[0]), px, msg)), N);
    return cat(to32(R[0]), to32(mod(k + e * d, N)));
  }
  async function verify(sig, msg, px) {
    const x = toBig(px); const c = mod(x * x * x + 7n); const y = pow(c, (P + 1n) / 4n, P);
    if (x >= P || mod(y * y) !== c) return false;
    const point = [x, y % 2n === 0n ? y : P - y];
    const r = toBig(sig.subarray(0, 32)); const s = toBig(sig.subarray(32));
    if (r >= P || s >= N) return false;
    const e = mod(toBig(await tagged('BIP0340/challenge', sig.subarray(0, 32), px, msg)), N);
    const R = add(mul(s), mul(N - e, point));
    return !!R && R[1] % 2n === 0n && R[0] === r;
  }
  const evenKey = (d0) => { const pt = mul(d0); return { d: pt[1] % 2n === 0n ? d0 : N - d0, px: to32(pt[0]) }; };

  // The first two official BIP-340 test vectors: true if this browser signs and checks correctly.
  async function check() {
    const V = [
      ['0000000000000000000000000000000000000000000000000000000000000003', '0000000000000000000000000000000000000000000000000000000000000000', '0000000000000000000000000000000000000000000000000000000000000000', 'e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0'],
      ['b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef', '0000000000000000000000000000000000000000000000000000000000000001', '243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89', '6896bd60eeae296db48a229ff71dfe071bde413e6d43f917dc8dcf8c78de33418906d11ac976abccb20b091292bff4ea897efcb639ea871cfa95f6de339e4b0a'],
    ];
    for (const [sk, aux, msg, want] of V) {
      const k = evenKey(toBig(unhex(sk)));
      const sig = await sign(unhex(msg), k.d, k.px, unhex(aux));
      if (hex(sig) !== want || !(await verify(sig, unhex(msg), k.px))) return false;
      sig[40] ^= 1;
      if (await verify(sig, unhex(msg), k.px)) return false;
    }
    return true;
  }

  /* ---------- the family key ---------- */
  let cache = null;
  async function keys() {
    const s = secret();
    if (!s) return null;
    if (cache && cache.secret === s) return cache.k;
    const raw = enc.encode(s);
    const from = (label) => sha(cat(enc.encode(`habla ${label} 1 `), raw));
    const k = evenKey(mod(toBig(await from('sign')), N - 1n) + 1n);
    k.pk = hex(k.px);
    k.aes = await crypto.subtle.importKey('raw', await from('seal'), 'AES-GCM', false, ['encrypt', 'decrypt']);
    k.slots = {};  // person id -> the address of their note
    k.people = {}; // and back
    for (const p of Store.profiles) {
      const slot = hex(await from(`slot ${p.id}`)).slice(0, 32);
      k.slots[p.id] = slot;
      k.people[slot] = p.id;
    }
    cache = { secret: s, k };
    return k;
  }

  /* ---------- sealing ---------- */
  // The first character says how the rest is packed: 1 = compressed, 0 = not.
  const canUnpack = (text) => text[0] === '0' || (text[0] === '1' && typeof DecompressionStream === 'function');
  async function seal(obj, k) {
    let data = enc.encode(JSON.stringify(obj));
    let how = '0';
    if (typeof CompressionStream === 'function' && typeof DecompressionStream === 'function') { data = await through(data, new CompressionStream('gzip')); how = '1'; }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return how + b64(cat(iv, new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k.aes, data))));
  }
  async function unseal(text, k) {
    try {
      const raw = unb64(text.slice(1));
      let data = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, k.aes, raw.subarray(12)));
      if (text[0] === '1') data = await through(data, new DecompressionStream('gzip'));
      const obj = JSON.parse(dec.decode(data));
      return obj && typeof obj === 'object' ? obj : null;
    } catch { return null; }
  }

  /* ---------- notes ---------- */
  const idOf = async (ev) => hex(await sha(enc.encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))));
  async function note(k, slot, content, at) {
    const ev = { pubkey: k.pk, created_at: at, kind: KIND, tags: [['d', slot]], content };
    ev.id = await idOf(ev);
    ev.sig = hex(await sign(unhex(ev.id), k.d, k.px, crypto.getRandomValues(new Uint8Array(32))));
    trust(ev.id);
    return ev;
  }
  // When two notes have the same address, relays keep the later one (on a tie, the lower id).
  const newerNote = (a, b) => (a.created_at !== b.created_at ? a.created_at > b.created_at : a.id < b.id);
  function slotOf(ev, k) {
    if (!ev || ev.kind !== KIND || ev.pubkey !== k.pk || typeof ev.content !== 'string' || !Number.isInteger(ev.created_at) || !Array.isArray(ev.tags)) return '';
    const d = ev.tags.find((t) => Array.isArray(t) && t[0] === 'd');
    return d && k.people[d[1]] ? d[1] : '';
  }
  let trusted = null;
  function trust(id) {
    if (!trusted) { try { trusted = JSON.parse(get(TRUSTED)) || []; } catch { trusted = []; } }
    if (!id || trusted.includes(id)) return;
    trusted.push(id);
    trusted = trusted.slice(-40);
    put(TRUSTED, JSON.stringify(trusted));
  }
  // A relay could hand out something the family never signed. The signature check is
  // slow on a phone, so a note that passed once is remembered.
  async function genuine(ev, k) {
    try {
      if (typeof ev.id !== 'string' || (await idOf(ev)) !== ev.id) return false;
      trust('');
      if (trusted.includes(ev.id)) return true;
      if (typeof ev.sig !== 'string' || !/^[0-9a-f]{128}$/.test(ev.sig) || !(await verify(unhex(ev.sig), unhex(ev.id), k.px))) return false;
    } catch { return false; }
    trust(ev.id);
    return true;
  }

  /* ---------- relays ---------- */
  // Connect, ask for the notes, and resolve when the relay has sent what it holds
  // (a "link"), or with null if it does not answer in time.
  function talk(url, filter) {
    return new Promise((resolve) => {
      let ws = null;
      let settled = false;
      const waiting = new Map();
      const link = {
        url,
        got: [],
        send(ev) {
          return new Promise((res) => {
            const timer = setTimeout(() => { waiting.delete(ev.id); res(false); }, WAIT_MS);
            waiting.set(ev.id, (ok) => { clearTimeout(timer); res(ok); });
            try { ws.send(JSON.stringify(['EVENT', ev])); } catch { clearTimeout(timer); waiting.delete(ev.id); res(false); }
          });
        },
        close() { try { ws.close(); } catch { /* already closed */ } },
      };
      const settle = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ok) { resolve(link); return; }
        link.close();
        resolve(null);
      };
      const timer = setTimeout(() => settle(false), WAIT_MS);
      try { ws = new WebSocket(url); } catch { settle(false); return; }
      ws.onopen = () => { try { ws.send(JSON.stringify(['REQ', SUB, filter])); } catch { settle(false); } };
      ws.onmessage = (m) => {
        let x;
        try { x = JSON.parse(m.data); } catch { return; }
        if (!Array.isArray(x)) return;
        if (x[0] === 'EVENT' && x[1] === SUB && x[2] && !settled) link.got.push(x[2]);
        else if (x[0] === 'EOSE' && x[1] === SUB) { try { ws.send(JSON.stringify(['CLOSE', SUB])); } catch { /* closing anyway */ } settle(true); }
        else if (x[0] === 'CLOSED' && x[1] === SUB) settle(false);
        else if (x[0] === 'OK' && waiting.has(x[1])) { const done = waiting.get(x[1]); waiting.delete(x[1]); done(x[2] === true); }
      };
      ws.onerror = () => settle(false);
      ws.onclose = () => { settle(false); Array.from(waiting.values()).forEach((done) => done(false)); waiting.clear(); };
    });
  }

  // The relays that answered. The slow ones get a little longer once the first has answered.
  function reach(filter) {
    return new Promise((resolve) => {
      const links = [];
      let over = false;
      let left = relays.length;
      let grace = null;
      const finish = () => { if (over) return; over = true; clearTimeout(cap); clearTimeout(grace); resolve(links); };
      const cap = setTimeout(finish, WAIT_MS + 500);
      relays.forEach((url) => talk(url, filter).then((link) => {
        left--;
        if (link && over) link.close();
        else if (link) { links.push(link); if (!grace) grace = setTimeout(finish, GRACE_MS); }
        if (!left) finish();
      }));
    });
  }

  /* ---------- one exchange with the relays ---------- */
  const state = { busy: 0, okAt: 0, failAt: 0, reached: 0 };
  const freshAt = {};          // person id -> when their progress was last fetched
  const watchers = new Set();
  // Call a snapshot: a watcher may redraw its view, which adds a new watcher.
  const tell = (learned) => Array.from(watchers).forEach((fn) => fn(!!learned));

  // Fetch what the relays hold for these people, combine it with this device's copy,
  // and send back whatever the relays lack. `fetched` is called as soon as this
  // device is up to date; the sending goes on after that.
  async function exchange(ids, fetched) {
    const k = await keys();
    if (!k) return false;
    const slots = ids.map((id) => k.slots[id]).filter(Boolean);
    if (!slots.length) return false;
    const links = await reach({ kinds: [KIND], authors: [k.pk], '#d': slots });
    try {
      if (!links.length) { state.failAt = Date.now(); return false; }
      const top = {};      // address -> the newest readable note on any relay, and the digest of what it holds
      const closed = {};   // address -> a note this device cannot read: writing there could destroy it
      const opened = new Map();
      let learned = false;
      for (const link of links) {
        link.has = {};
        for (const ev of link.got) {
          const slot = slotOf(ev, k);
          if (slot && (!link.has[slot] || newerNote(ev, link.has[slot]))) link.has[slot] = ev;
        }
        for (const slot of Object.keys(link.has)) {
          const ev = link.has[slot];
          if (!opened.has(ev.id)) {
            let theirs = null;
            if (await genuine(ev, k)) {
              theirs = await unseal(ev.content, k);
              if (!theirs && !canUnpack(ev.content)) closed[slot] = true;
            }
            opened.set(ev.id, theirs);
            if (theirs) {
              if (Store.absorb(k.people[slot], theirs)) learned = true;
              if (!top[slot] || newerNote(ev, top[slot].ev)) top[slot] = { ev, sum: Store.digest(theirs) };
            }
          }
          if (!opened.get(ev.id)) delete link.has[slot]; // not the family's, or damaged: as if the relay had nothing
        }
      }
      const now = Date.now();
      ids.forEach((id) => { freshAt[id] = now; });
      state.okAt = now;
      state.failAt = 0;
      state.reached = links.length;
      fetched(true);
      if (learned) tell(true);

      let all = true;
      for (const id of ids) {
        const slot = k.slots[id];
        const mine = slot && !closed[slot] ? Store.progress(id) : null;
        if (!mine) continue;
        const newest = top[slot];
        let ev;
        let to;
        if (!newest || Store.digest(mine) !== newest.sum) {
          // This device knows something the relays do not.
          ev = await note(k, slot, await seal(mine, k), Math.max(nowSec(), newest ? newest.ev.created_at + 1 : 0));
          to = links;
        } else {
          // Nothing new here. A relay that is behind gets the newest note passed on.
          ev = newest.ev;
          to = links.filter((link) => !link.has[slot] || link.has[slot].id !== ev.id);
        }
        if (!to.length) continue;
        const accepted = await Promise.all(to.map((link) => link.send(ev)));
        if (to === links && !accepted.some(Boolean)) all = false;
      }
      return all;
    } finally {
      links.forEach((link) => link.close());
    }
  }

  // Exchanges run one after another.
  let chain = Promise.resolve();
  let current = null;
  function run(ids, force) {
    let fetched;
    const read = new Promise((r) => { fetched = r; });
    const done = chain.then(async () => {
      const need = force ? ids : ids.filter((id) => Date.now() - (freshAt[id] || 0) >= FRESH_MS);
      if (!linked() || !need.length) { fetched(linked()); return linked(); }
      current = { ids: need, read };
      state.busy++;
      tell(false);
      try { return await exchange(need, fetched); } catch { return false; } finally {
        fetched(false);
        current = null;
        state.busy--;
        tell(false);
      }
    });
    chain = done;
    return { read, done };
  }

  /* ---------- when to exchange ---------- */
  const dirty = new Set(); // people whose progress changed here and is not on the relays yet
  let timer = null;
  let sentAt = 0;
  let retryMs = 60000;
  const plan = (ms) => { if (!timer) timer = setTimeout(() => { timer = null; flush(); }, ms); };

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!linked() || !dirty.size) return;
    const ids = Array.from(dirty);
    dirty.clear();
    sentAt = Date.now();
    run(ids, true).done.then((ok) => {
      if (ok) { retryMs = 60000; return; }
      ids.forEach((id) => dirty.add(id));
      plan(retryMs);
      retryMs = Math.min(retryMs * 2, 600000);
    });
  }

  // Progress changed on this device. During a session that happens every few seconds,
  // so it is sent at a calm pace; flush() sends at once when a session ends.
  function touch(id) {
    if (!linked()) return;
    dirty.add(id);
    plan(Math.max(3000, sentAt + PACE_MS - Date.now()));
  }

  const everybody = () => Store.profiles.map((p) => p.id);
  const pull = () => (linked() ? run(everybody(), false) : { read: Promise.resolve(false), done: Promise.resolve(false) });

  // Before a person starts: make sure this device has what their other devices know.
  // Resolves true when it does, false when the relays could not be reached.
  function upToDate(id) {
    if (!linked()) return Promise.resolve(true);
    if (Date.now() - (freshAt[id] || 0) < FRESH_MS) return Promise.resolve(true);
    if (current && current.ids.includes(id)) return current.read;
    return run([id], false).read;
  }

  /* ---------- joining and leaving ---------- */
  function link(key) {
    if (!available || !KEY_RE.test(key)) return '';
    const had = secret();
    if (had === key) return 'same';
    if (had && !window.confirm('This device is already connected with a different family link. Use the new link?')) return 'kept';
    put(FAMILY, key);
    if (secret() !== key) return ''; // storage is blocked: a connection would not last
    cache = null;
    dirty.clear();
    Object.keys(freshAt).forEach((id) => { delete freshAt[id]; });
    state.okAt = 0;
    state.failAt = 0;
    return 'joined';
  }

  function unlink() {
    clearTimeout(timer);
    timer = null;
    dirty.clear();
    cache = null;
    put(FAMILY, 'off'); // "off", not empty: on this computer the link is not picked up from the folder again
    tell(false);
  }

  // Looks for a family link: in the address, or (on this computer only) in the file
  // family-link.txt next to the app. Returns "joined" when this device was connected just now.
  async function start() {
    if (!available) return '';
    const m = /^#family=([A-Za-z0-9_-]{22})$/.exec(location.hash);
    if (m) {
      // The key must not stay in the address bar or in the browser's history.
      try { history.replaceState(null, '', location.pathname + location.search); } catch { location.hash = ''; }
      return link(m[1]);
    }
    if (onThisComputer && get(FAMILY) === null) {
      try {
        const r = await fetch('family-link.txt', { cache: 'no-store' });
        const found = r.ok ? /#family=([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/.exec(await r.text()) : null;
        if (found) return link(found[1]);
      } catch { /* no file: not connected */ }
    }
    return '';
  }

  if (available) {
    Store.watch(touch);
    document.addEventListener('visibilitychange', () => {
      if (!linked()) return;
      if (document.visibilityState === 'hidden') flush();
      else if (Date.now() - Math.max(state.okAt, state.failAt) > 5 * 60000) pull();
    });
    window.addEventListener('pagehide', flush);
  }

  return {
    available,
    linked,
    start,
    unlink,
    pull,
    upToDate,
    flush,
    check,
    address: () => (linked() ? `${site}#family=${secret()}` : ''),
    status: () => ({ linked: linked(), busy: state.busy > 0, okAt: state.okAt, failAt: state.failAt, reached: state.reached, relays: relays.length }),
    watch(fn) { watchers.add(fn); return () => watchers.delete(fn); },
  };
})();
