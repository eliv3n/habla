// Tests the relays in data/sync.js (or the ones named on the command line) with
// random throwaway data: store a note of realistic size, read it back, replace it,
// delete it. Nothing of the family's is sent. Needs Node 22 or newer.
//
//   node tools/check-relays.mjs
//   node tools/check-relays.mjs wss://relay.example.com wss://another.example.org
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const G = [0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n, 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n];
const mod = (a, m = P) => ((a % m) + m) % m;
function inv(number, m = P) {
  let a = mod(number, m); let b = m; let x = 0n; let y = 1n; let u = 1n; let v = 0n;
  while (a !== 0n) { const q = b / a; const r = b % a; const s = x - u * q; const t = y - v * q; b = a; a = r; x = u; y = v; u = s; v = t; }
  return mod(x, m);
}
function add(A, B) {
  if (!A) return B;
  if (!B) return A;
  const [x1, y1] = A; const [x2, y2] = B;
  if (x1 === x2 && y1 !== y2) return null;
  const l = x1 === x2 ? mod(3n * x1 * x1 * inv(2n * y1)) : mod((y2 - y1) * inv(x2 - x1));
  const x3 = mod(l * l - x1 - x2);
  return [x3, mod(l * (x1 - x3) - y1)];
}
function mul(k, A = G) { let R = null; for (let n = k; n > 0n; n >>= 1n) { if (n & 1n) R = add(R, A); A = add(A, A); } return R; }
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));
const toBig = (b) => BigInt(`0x${hex(b)}`);
const to32 = (n) => unhex(n.toString(16).padStart(64, '0'));
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; parts.forEach((p) => { out.set(p, o); o += p.length; }); return out; };
const enc = new TextEncoder();
const sha = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
async function tagged(tag, ...parts) { const t = await sha(enc.encode(tag)); return sha(cat(t, t, ...parts)); }
async function sign(msg, d0) {
  const pt = mul(d0);
  const d = pt[1] % 2n === 0n ? d0 : N - d0;
  const px = to32(pt[0]);
  const t = to32(d ^ toBig(await tagged('BIP0340/aux', crypto.getRandomValues(new Uint8Array(32)))));
  const k0 = mod(toBig(await tagged('BIP0340/nonce', t, px, msg)), N);
  const R = mul(k0);
  const k = R[1] % 2n === 0n ? k0 : N - k0;
  const e = mod(toBig(await tagged('BIP0340/challenge', to32(R[0]), px, msg)), N);
  return cat(to32(R[0]), to32(mod(k + e * d, N)));
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let relays = process.argv.slice(2);
if (!relays.length) {
  const box = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'data', 'sync.js'), 'utf8'), box);
  relays = (box.window.SYNC && box.window.SYNC.relays) || [];
}
if (!relays.length) { console.log('No relays to check.'); process.exit(1); }

const secret = mod(toBig(crypto.getRandomValues(new Uint8Array(32))), N - 1n) + 1n;
const pubkey = hex(to32(mul(secret)[0]));
const address = hex(crypto.getRandomValues(new Uint8Array(16)));
async function note(kind, tags, content, at) {
  const id = await sha(enc.encode(JSON.stringify([0, pubkey, at, kind, tags, content])));
  return { id: hex(id), pubkey, created_at: at, kind, tags, content, sig: hex(await sign(id, secret)) };
}
const filler = () => `1${Buffer.from(crypto.getRandomValues(new Uint8Array(10500))).toString('base64')}`; // about 14 KB, like a finished course
const now = Math.floor(Date.now() / 1000);
const first = await note(30078, [['d', address]], filler(), now);
const second = await note(30078, [['d', address]], filler(), now + 1);
const removal = await note(5, [['a', `30078:${pubkey}:${address}`], ['e', second.id]], '', now + 2);

async function check(url) {
  const out = { url, ok: false };
  const t0 = performance.now();
  let ws;
  try {
    ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cannot connect')); setTimeout(() => rej(new Error('no answer when connecting')), 7000); });
    out.connectMs = Math.round(performance.now() - t0);
    const waiters = [];
    ws.onmessage = (m) => { let msg; try { msg = JSON.parse(m.data); } catch { return; } waiters.slice().forEach((w) => w(msg)); };
    const wait = (pick) => new Promise((res) => {
      const w = (msg) => { const r = pick(msg); if (r !== undefined) { waiters.splice(waiters.indexOf(w), 1); res(r); } };
      waiters.push(w);
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); res('no answer'); }, 7000);
    });
    const store = (ev) => { const p = wait((m) => (m[0] === 'OK' && m[1] === ev.id ? (m[2] ? 'ok' : `refused: ${m[3]}`) : undefined)); ws.send(JSON.stringify(['EVENT', ev])); return p; };
    const read = (sub) => {
      const got = [];
      const p = wait((m) => {
        if (m[0] === 'EVENT' && m[1] === sub) { got.push(m[2].id); return undefined; }
        if (m[0] === 'EOSE' && m[1] === sub) return got;
        if (m[0] === 'CLOSED' && m[1] === sub) return `closed: ${m[2]}`;
        return undefined;
      });
      ws.send(JSON.stringify(['REQ', sub, { kinds: [30078], authors: [pubkey], '#d': [address] }]));
      return p.then((r) => { ws.send(JSON.stringify(['CLOSE', sub])); return r; });
    };
    out.store = await store(first);
    if (out.store === 'ok') {
      const a = await read('a');
      out.read = Array.isArray(a) ? (a.length === 1 && a[0] === first.id ? 'ok' : `returned ${a.length} notes`) : a;
      out.replace = await store(second);
      const b = await read('b');
      out.replaced = Array.isArray(b) ? (b.length === 1 && b[0] === second.id ? 'ok' : `returned ${b.length} notes`) : b;
      await store(removal);
      out.ok = out.read === 'ok' && out.replace === 'ok' && out.replaced === 'ok';
    }
  } catch (e) { out.error = e.message; }
  try { ws.close(); } catch { /* not open */ }
  return out;
}

const results = await Promise.all(relays.map(check));
for (const r of results) {
  const detail = r.ok ? `connects in ${r.connectMs} ms` : r.error || Object.entries(r).filter(([k, v]) => !['url', 'ok', 'connectMs'].includes(k) && v !== 'ok').map(([k, v]) => `${k}: ${v}`).join(', ');
  console.log(`${r.ok ? 'GOOD' : 'BAD '}  ${r.url}  (${detail})`);
}
const bad = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - bad} of ${results.length} relays work.`);
process.exit(bad ? 1 : 0);
