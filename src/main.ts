import { contactList, onContact } from './track.js';
import { ICE_SERVERS } from './signal/ice.js';
import { ManualHandshake, decodeCode } from './signal/manual.js';
import type { PeerConn } from './signal/types.js';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import logoUrl from './logo.png';
import './style.css';

/** Where invite links point when this copy was opened from disk. */
const HOSTED_URL = 'https://swompythesecond.github.io/p2p-demo-browsercoin/';
const FLOOD_TTL = 6;
const NAME_KEY = 'p2pdemo:name';

const selfId = `demo-${randomChars(10)}`;
const ADJ = ['Quiet', 'Brave', 'Sunny', 'Swift', 'Clever', 'Lucky', 'Calm', 'Bold', 'Witty', 'Cosmic'];
const NOUN = ['Otter', 'Falcon', 'Badger', 'Panda', 'Lynx', 'Heron', 'Gecko', 'Moose', 'Koala', 'Raven'];
let myName = load(NAME_KEY) ?? `${pick(ADJ)} ${pick(NOUN)}`;

const fromDisk = location.protocol === 'file:';
const pageUrl = fromDisk ? HOSTED_URL : location.origin + location.pathname;

// ── State ───────────────────────────────────────────────────────────────────

type LinkKind = 'same network' | 'across the internet' | 'relayed' | 'checking';

interface Link {
  conn: PeerConn;
  name: string;
  kind: LinkKind;
  rtt: number | null;
}

interface Mine {
  mode: 'invite' | 'reply';
  code: string;
  /** For a reply: whose invite it answers, and when we made it. */
  forPeer?: string;
  since?: number;
}

const links = new Map<string, Link>();
const seen = new Set<string>();
/** Outcomes for the Discord report. Never codes, names or addresses. */
const results: string[] = [];

/** What the left card shows: our own invite, or a reply to someone's invite. */
let mine: Mine | null = null;
let busy = false;

const manual = new ManualHandshake({
  selfId,
  onConnection: adopt,
  hasPeer: (id) => links.has(id),
});

// ── DOM ─────────────────────────────────────────────────────────────────────

const $ = <T extends Element = HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;
$<HTMLImageElement>('[data-logo]').src = logoUrl;

const qrCanvas = $<HTMLCanvasElement>('[data-qr]');
const mineTitle = $('[data-mine-title]');
const mineHint = $('[data-mine-hint]');
const mineMsg = $('[data-mine-msg]');
const mineText = $<HTMLTextAreaElement>('[data-mine-text]');
const copyMine = $<HTMLButtonElement>('[data-copy-mine]');
const shareMine = $<HTMLButtonElement>('[data-share-mine]');
const theirIn = $<HTMLTextAreaElement>('[data-their-in]');
const theirMsg = $('[data-their-msg]');
const chatIn = $<HTMLInputElement>('[data-chat-in]');
const nameInput = $<HTMLInputElement>('[data-name]');

// ── Your code (left card) ───────────────────────────────────────────────────

let making = false;

async function makeInvite(): Promise<void> {
  if (making) return;
  making = true;
  flash(mineMsg, 'Making your code…', 'muted');
  copyMine.disabled = true;
  try {
    const code = await manual.createInvite();
    await showMine({ mode: 'invite', code });
    flash(mineMsg, 'Ready. Waiting for your friend.', 'muted');
  } catch (e) {
    flash(mineMsg, errorText(e), 'red');
    results.push(`could not make a code: ${errorText(e).slice(0, 60)}`);
  } finally {
    making = false;
  }
}

/** Invites travel as a link, so a phone camera scan opens this page with the code filled in. */
function shareable(m: Mine): string {
  return m.mode === 'invite' ? `${pageUrl}#${m.code}` : m.code;
}

async function showMine(m: Mine): Promise<void> {
  mine = m;
  const invite = m.mode === 'invite';
  mineTitle.textContent = invite ? '1. Your code' : '1. Send this back';
  mineHint.textContent = invite
    ? 'Let your friend scan the QR, or send them the link below.'
    : 'Your friend scans the QR or pastes the text into their page. You connect the moment they do.';
  copyMine.textContent = invite ? 'Copy link' : 'Copy reply';
  copyMine.disabled = false;
  shareMine.hidden = typeof navigator.share !== 'function';
  mineText.value = shareable(m);
  await QRCode.toCanvas(qrCanvas, shareable(m), {
    width: 240,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#0d0f17', light: '#ffffff' },
  });
  qrCanvas.removeAttribute('style'); // the library sets a fixed size; CSS sizes it instead
}

copyMine.addEventListener('click', () => mine && copy(copyMine, shareable(mine)));
// One tap selects the whole code, so copying by hand never grabs half of it.
mineText.addEventListener('focus', () => mineText.select());
mineText.addEventListener('click', () => mineText.select());
shareMine.addEventListener('click', () => {
  if (mine) void navigator.share({ text: shareable(mine) }).catch(() => { /* sheet closed */ });
});

// ── Your friend's code (right card) ─────────────────────────────────────────

/** Accept a bare code, a code with stray whitespace, or one of our invite links. */
function extractCode(raw: string): string {
  const t = raw.trim();
  const hash = t.indexOf('#');
  return (hash >= 0 ? t.slice(hash + 1) : t).replace(/\s+/g, '');
}

async function useTheirCode(raw: string): Promise<void> {
  const code = extractCode(raw);
  if (!code || busy) return;
  const decoded = decodeCode(code);
  if (decoded === null) return flash(theirMsg, "That doesn't look like a code. Copy the whole thing and try again.", 'red');
  if (decoded === 'incomplete') return flash(theirMsg, 'That code looks cut off. Copy the whole thing and try again.', 'red');
  if (decoded === 'version') return flash(theirMsg, 'That code comes from a newer version of this page. Reload and try again.', 'red');
  if (decoded.peerId === selfId) return flash(theirMsg, "That's your own code. Your friend needs it, not you.", 'red');
  if (links.has(decoded.peerId)) return flash(theirMsg, "You're already connected to them.", 'green');

  busy = true;
  const t0 = Date.now();
  try {
    if (/^a=setup:actpass$/m.test(decoded.sdp)) {
      // Their invite: answer it. The link opens once they use our reply.
      flash(theirMsg, 'Making your reply…', 'muted');
      const reply = await manual.acceptInvite(code);
      await showMine({ mode: 'reply', code: reply, forPeer: decoded.peerId, since: Date.now() });
      flash(mineMsg, 'Waiting for your friend to use your reply.', 'muted');
      flash(theirMsg, 'Got it. Now send your reply back to them.', 'green');
      results.push('joined a friend: made a reply');
    } else {
      // Their reply to our invite: this finishes the handshake.
      if (mine?.mode !== 'invite' || !manual.currentInvite()) {
        flash(theirMsg, 'That is a reply code. Put it into the page that made the original code.', 'red');
        return;
      }
      flash(theirMsg, 'Connecting…', 'muted');
      await manual.completeInvite(code);
      flash(theirMsg, 'Connected.', 'green');
      results.push(`invited a friend: connected in ${secs(Date.now() - t0)}`);
      void makeInvite();
    }
    theirIn.value = '';
  } catch (e) {
    flash(theirMsg, errorText(e), 'red');
    results.push(`failed: ${errorText(e).slice(0, 80)}`);
    if (!manual.currentInvite() && mine?.mode === 'invite') void makeInvite();
  } finally {
    busy = false;
    render();
  }
}

$('[data-go]').addEventListener('click', () => void useTheirCode(theirIn.value));
// A complete, valid code needs no button press.
theirIn.addEventListener('input', () => {
  const d = decodeCode(extractCode(theirIn.value));
  if (d && typeof d === 'object') void useTheirCode(theirIn.value);
});

// Images: upload, drop, or paste a screenshot of their QR.
$<HTMLInputElement>('[data-upload]').addEventListener('change', (ev) => {
  const input = ev.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) void useImage(file);
});
const theirCard = $('[data-theirs]');
theirCard.addEventListener('dragover', (ev) => { ev.preventDefault(); theirCard.classList.add('drop'); });
theirCard.addEventListener('dragleave', () => theirCard.classList.remove('drop'));
theirCard.addEventListener('drop', (ev) => {
  ev.preventDefault();
  theirCard.classList.remove('drop');
  const file = [...(ev.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
  if (file) void useImage(file);
});
document.addEventListener('paste', (ev) => {
  const file = [...(ev.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
  if (!file) return;
  ev.preventDefault();
  void useImage(file);
});

async function useImage(file: Blob): Promise<void> {
  flash(theirMsg, 'Reading the QR code…', 'muted');
  const text = await readQr(file).catch(() => null);
  if (!text) {
    flash(theirMsg, "Couldn't find a QR code in that image. Try a sharper or closer screenshot.", 'red');
    results.push('qr image: no code found');
    return;
  }
  results.push('qr image: read ok');
  theirIn.value = text;
  void useTheirCode(text);
}

/** Decode a QR from an image, trying a few sizes since screenshots vary wildly. */
async function readQr(file: Blob): Promise<string | null> {
  const bmp = await createImageBitmap(file);
  const tried = new Set<number>();
  for (const max of [1600, 3200, 800]) {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    if (tried.has(w)) continue;
    tried.add(w);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0, w, h);
    const hit = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
    if (hit?.data) return hit.data;
  }
  return null;
}

// ── Links and chat ──────────────────────────────────────────────────────────

function adopt(conn: PeerConn): void {
  if (links.has(conn.peer)) {
    conn.close();
    return;
  }
  links.set(conn.peer, { conn, name: 'your friend', kind: 'checking', rtt: null });
  conn.on('data', (d) => onMessage(conn.peer, d));
  conn.on('close', () => drop(conn.peer));
  conn.on('error', () => drop(conn.peer));
  send(conn, { t: 'hello', name: myName });
  setTimeout(() => void classify(conn.peer), 1500);

  if (mine?.mode === 'reply' && mine.forPeer === conn.peer) {
    results.push(`joined a friend: connected ${secs(Date.now() - (mine.since ?? Date.now()))} after making the reply`);
    flash(theirMsg, 'Connected.', 'green');
    void makeInvite();
  }
  render();
  $('[data-connected]').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function drop(id: string): void {
  if (!links.delete(id)) return;
  render();
}

function send(conn: PeerConn, msg: unknown): void {
  try { conn.send(msg); } catch { /* closing; the close handler cleans up */ }
}

function onMessage(from: string, data: unknown): void {
  if (!data || typeof data !== 'object') return;
  const m = data as Record<string, unknown>;
  const link = links.get(from);
  if (!link) return;
  if (m.t === 'hello' && typeof m.name === 'string') {
    link.name = cleanName(m.name) || link.name;
    render();
    return;
  }
  // Chat floods across links, so friends of friends see it too.
  if (m.t !== 'chat' || typeof m.id !== 'string' || typeof m.text !== 'string' || seen.has(m.id)) return;
  remember(m.id);
  showChat(cleanName(String(m.name ?? '')), m.text.slice(0, 280), false);
  const ttl = typeof m.ttl === 'number' ? Math.min(m.ttl, FLOOD_TTL) : 0;
  if (ttl > 1) for (const [id, l] of links) if (id !== from) send(l.conn, { ...m, ttl: ttl - 1 });
}

function remember(id: string): void {
  seen.add(id);
  if (seen.size > 2000) seen.delete(seen.values().next().value as string);
}

$('[data-chat-form]').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const text = chatIn.value.trim().slice(0, 280);
  if (!text || links.size === 0) return;
  const id = randomChars(12);
  remember(id);
  for (const l of links.values()) send(l.conn, { t: 'chat', id, name: myName, text, ttl: FLOOD_TTL });
  showChat(myName, text, true);
  chatIn.value = '';
});

function showChat(name: string, text: string, isMine: boolean): void {
  const log = $('[data-chat-log]');
  const line = document.createElement('p');
  line.className = isMine ? 'msg mine' : 'msg';
  const who = document.createElement('b');
  who.textContent = name || 'someone';
  line.append(who, document.createTextNode(` ${text}`));
  log.append(line);
  while (log.children.length > 200) log.firstElementChild?.remove();
  log.scrollTop = log.scrollHeight;
}

nameInput.value = myName;
nameInput.addEventListener('change', () => {
  myName = cleanName(nameInput.value) || myName;
  nameInput.value = myName;
  save(NAME_KEY, myName);
  for (const l of links.values()) send(l.conn, { t: 'hello', name: myName });
});

/**
 * What kind of path a link took, from the candidate pair ICE chose. MeshConn
 * keeps its RTCPeerConnection private; this read-only peek is the one thing
 * the demo needs that the release code doesn't expose.
 */
async function classify(id: string): Promise<void> {
  const link = links.get(id);
  const pc = (link?.conn as unknown as { pc?: RTCPeerConnection } | undefined)?.pc;
  if (!link || !pc) return;
  try {
    const stats = await pc.getStats();
    let pair: Record<string, unknown> | undefined;
    stats.forEach((s: Record<string, unknown>) => {
      if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') {
        pair = stats.get(s.selectedCandidatePairId) as Record<string, unknown> | undefined;
      }
    });
    if (!pair) {
      stats.forEach((s: Record<string, unknown>) => {
        if (s.type === 'candidate-pair' && (s.selected === true || s.nominated === true) && s.state === 'succeeded') pair ??= s;
      });
    }
    if (!pair) return;
    const types = [pair.localCandidateId, pair.remoteCandidateId]
      .map((cid) => (stats.get(cid as string) as { candidateType?: string } | undefined)?.candidateType);
    link.kind = types.includes('relay') ? 'relayed'
      : types.every((t) => t === 'host') ? 'same network'
      : 'across the internet';
    if (typeof pair.currentRoundTripTime === 'number') link.rtt = Math.round(pair.currentRoundTripTime * 1000);
    render();
  } catch { /* stats are a nicety */ }
}
setInterval(() => {
  for (const id of links.keys()) void classify(id);
  // Invites expire after a while; never leave a dead code on screen.
  if (mine?.mode === 'invite' && !busy && !manual.currentInvite()) void makeInvite();
}, 10_000);

// ── Rendering ───────────────────────────────────────────────────────────────

function render(): void {
  $('[data-connected]').hidden = links.size === 0;
  $('[data-connected-title]').textContent = links.size === 1
    ? `Connected to ${[...links.values()][0]!.name}`
    : `Connected to ${links.size} friends`;
  $('[data-links]').replaceChildren(...[...links.values()].map((l) => {
    const li = document.createElement('li');
    const name = document.createElement('b');
    name.textContent = l.name;
    const meta = document.createElement('span');
    meta.className = 'muted text-sm';
    meta.textContent = `  ${l.kind}${l.rtt != null ? `, ${l.rtt} ms` : ''}, no server in between`;
    li.append(name, meta);
    return li;
  }));
  $('[data-report]').textContent = reportText();
}

function renderContacts(): void {
  const list = contactList();
  const ours = list.filter((c) => /(^|\.)browsercoin\.org$/i.test(c.host.split(':')[0]!));
  $('[data-servers-count]').textContent = String(ours.length);
  $('[data-servers-pill]').classList.toggle('bad', ours.length > 0);

  const items = list.map((c) => {
    const li = document.createElement('li');
    li.innerHTML = '<b></b> <span class="muted text-sm"></span>';
    li.querySelector('b')!.textContent = c.host;
    li.querySelector('span')!.textContent = c.kind === 'websocket' ? 'WebSocket' : 'web request';
    return li;
  });
  const stun = document.createElement('li');
  stun.innerHTML = '<b>STUN</b> <span class="muted text-sm"></span>';
  stun.querySelector('span')!.textContent =
    `your browser asks one of these "what is my public address?" when making a code. They see your IP and nothing else: ${ICE_SERVERS.map((s) => String(s.urls).replace(/^stun:/, '').replace(/:\d+$/, '')).join(', ')}`;
  if (list.length === 0) {
    const none = document.createElement('li');
    none.innerHTML = '<b>Nothing else</b> <span class="muted text-sm">This page has contacted no other server since it loaded.</span>';
    items.push(none);
  }
  $('[data-contacts]').replaceChildren(stun, ...items);
}

function reportText(): string {
  return [
    'browserCoin p2p test report',
    `browser: ${browserLabel()}`,
    `opened from: ${fromDisk ? 'disk' : 'website'}`,
    `webrtc: ${typeof RTCPeerConnection === 'function' ? 'yes' : 'NO'}`,
    `links now: ${links.size}${links.size ? ` (${[...links.values()].map((l) => l.kind).join(', ')})` : ''}`,
    ...(results.length ? results.map((r) => `- ${r}`) : ['- nothing tried yet']),
  ].join('\n');
}

$('[data-copy-report]').addEventListener('click', (ev) => copy(ev.currentTarget as HTMLButtonElement, reportText()));

$('[data-origin]').textContent = fromDisk
  ? 'You opened this page from your own disk, so no web host is involved either.'
  : `This page was loaded once from ${location.host}. Nothing it does goes back there. Save it and open the file to drop the web host too.`;
$('[data-save]').hidden = fromDisk;
$('[data-save]').addEventListener('click', async () => {
  try {
    const html = await (await fetch(location.href)).text();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    a.download = 'browsercoin-p2p-test.html';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch {
    alert('Could not download it. Use your browser\'s "Save page as" instead.');
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

onContact(renderContacts);
renderContacts();
render();

// Opened from a friend's invite link: answer it straight away. Clear the hash
// so a reload doesn't try to reuse a code that is already spent.
const fromLink = extractCode(location.hash.slice(1));
if (fromLink) history.replaceState(null, '', location.pathname + location.search);
if (fromLink && typeof decodeCode(fromLink) === 'object') {
  theirIn.value = fromLink;
  void useTheirCode(fromLink).then(() => { if (!mine) void makeInvite(); });
} else {
  void makeInvite();
}

// ── Small helpers ───────────────────────────────────────────────────────────

function flash(el: HTMLElement, text: string, cls: 'green' | 'red' | 'muted'): void {
  el.textContent = text;
  el.className = `status ${cls}`;
}

function copy(btn: HTMLButtonElement, text: string): void {
  void navigator.clipboard.writeText(text).then(() => {
    const old = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = old), 1200);
  }, () => {
    btn.textContent = 'Copy failed';
  });
}

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)) || 'Something went wrong.';
}

function cleanName(s: string): string {
  return s.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24);
}

function secs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function randomChars(n: number): string {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return [...crypto.getRandomValues(new Uint8Array(n))].map((x) => a[x % a.length]).join('');
}

function pick<T>(xs: T[]): T {
  return xs[Math.floor(Math.random() * xs.length)]!;
}

function load(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}

function save(k: string, v: string): void {
  try { localStorage.setItem(k, v); } catch { /* private mode; the name lasts this session */ }
}

function browserLabel(): string {
  const ua = navigator.userAgent;
  const v = (re: RegExp): string => re.exec(ua)?.[1] ?? '';
  const b = /Edg\//.test(ua) ? `Edge ${v(/Edg\/(\d+)/)}`
    : /Firefox\//.test(ua) ? `Firefox ${v(/Firefox\/(\d+)/)}`
    : /Chrome\//.test(ua) ? `Chrome ${v(/Chrome\/(\d+)/)}`
    : /Safari\//.test(ua) ? `Safari ${v(/Version\/(\d+)/)}`
    : 'other';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'other OS';
  return `${b} on ${os}`;
}
