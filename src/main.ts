import { contactList, onContact } from './track.js';
import { ICE_SERVERS } from './signal/ice.js';
import { ManualHandshake } from './signal/manual.js';
import { DEFAULT_NOSTR_RELAYS, NostrTransport } from './signal/nostr.js';
import { SignalSwarm } from './signal/swarm.js';
import type { PeerConn } from './signal/types.js';
import logoUrl from './logo.png';
import './style.css';

// ── Identity ────────────────────────────────────────────────────────────────

const selfId = `demo-${randomChars(10)}`;
const NAME_KEY = 'p2pdemo:name';
const ADJ = ['Quiet', 'Brave', 'Sunny', 'Swift', 'Clever', 'Lucky', 'Calm', 'Bold', 'Witty', 'Cosmic'];
const NOUN = ['Otter', 'Falcon', 'Badger', 'Panda', 'Lynx', 'Heron', 'Gecko', 'Moose', 'Koala', 'Raven'];
let myName = load(NAME_KEY) ?? `${pick(ADJ)} ${pick(NOUN)}`;

/** Most links the room keeps. Enough for a mesh, few enough to be polite. */
const ROOM_TARGET = 5;
const HERE_EVERY_MS = 8_000;
const ROSTER_TTL_MS = 25_000;
const FLOOD_TTL = 6;

// ── State ───────────────────────────────────────────────────────────────────

type Via = 'code' | 'room';
type LinkKind = 'same network' | 'across the internet' | 'relayed' | 'checking';

interface Link {
  conn: PeerConn;
  via: Via;
  name: string;
  since: number;
  kind: LinkKind;
  rtt: number | null;
}

interface RosterEntry {
  name: string;
  links: string[];
  seen: number;
}

const links = new Map<string, Link>();
const roster = new Map<string, RosterEntry>();
const seen = new Set<string>();
let swarm: SignalSwarm | null = null;
let roomJoinedAt = 0;
/** True once at least one relay answered, so the room status can say we are in. */
let roomReady = false;

/** What the report says. Only outcomes, never codes, names or addresses. */
const results: string[] = [];

// ── Connections ─────────────────────────────────────────────────────────────

const manual = new ManualHandshake({
  selfId,
  onConnection: (conn) => adopt(conn, 'code'),
  hasPeer: (id) => links.has(id),
});

function adopt(conn: PeerConn, via: Via): void {
  if (links.has(conn.peer)) {
    conn.close();
    return;
  }
  const link: Link = { conn, via, name: 'someone', since: Date.now(), kind: 'checking', rtt: null };
  links.set(conn.peer, link);
  conn.on('data', (d) => onMessage(conn.peer, d));
  conn.on('close', () => drop(conn.peer));
  conn.on('error', () => drop(conn.peer));
  send(conn, { t: 'hello', name: myName });
  setTimeout(() => void classify(conn.peer), 1500);
  if (via === 'room' && roomJoinedAt && !results.some((r) => r.startsWith('room:'))) {
    results.push(`room: first link after ${secs(Date.now() - roomJoinedAt)}`);
  }
  announce();
  render();
}

function drop(id: string): void {
  if (!links.delete(id)) return;
  announce();
  render();
}

function send(conn: PeerConn, msg: unknown): void {
  try { conn.send(msg); } catch { /* channel closing; its close handler cleans up */ }
}

/**
 * Work out what kind of path a link took, from the candidate pair ICE chose.
 * MeshConn keeps its RTCPeerConnection private; this read-only peek is the one
 * thing the demo needs that the release code doesn't expose.
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
    const local = stats.get(pair.localCandidateId as string) as { candidateType?: string } | undefined;
    const remote = stats.get(pair.remoteCandidateId as string) as { candidateType?: string } | undefined;
    const types = [local?.candidateType, remote?.candidateType];
    link.kind = types.includes('relay') ? 'relayed'
      : types.every((t) => t === 'host') ? 'same network'
      : 'across the internet';
    if (typeof pair.currentRoundTripTime === 'number') link.rtt = Math.round(pair.currentRoundTripTime * 1000);
    render();
  } catch { /* stats are a nicety */ }
}

// ── Gossip: hello, presence and chat ────────────────────────────────────────

function onMessage(from: string, data: unknown): void {
  if (!data || typeof data !== 'object') return;
  const m = data as Record<string, unknown>;
  const link = links.get(from);
  if (!link) return;

  if (m.t === 'hello' && typeof m.name === 'string') {
    link.name = cleanName(m.name);
    render();
    return;
  }

  if (typeof m.id !== 'string' || seen.has(m.id) || typeof m.from !== 'string') return;
  remember(m.id);

  if (m.t === 'here' && Array.isArray(m.links)) {
    if (m.from !== selfId) {
      roster.set(m.from, {
        name: cleanName(String(m.name ?? '')),
        links: m.links.filter((x): x is string => typeof x === 'string').slice(0, 32),
        seen: Date.now(),
      });
      render();
    }
  } else if (m.t === 'chat' && typeof m.text === 'string') {
    showChat(cleanName(String(m.name ?? '')), m.text.slice(0, 280), false);
  } else {
    return;
  }

  const ttl = typeof m.ttl === 'number' ? Math.min(m.ttl, FLOOD_TTL) : 0;
  if (ttl > 1) {
    for (const [id, l] of links) if (id !== from) send(l.conn, { ...m, ttl: ttl - 1 });
  }
}

function flood(msg: Record<string, unknown>): void {
  const id = randomChars(12);
  remember(id);
  for (const l of links.values()) send(l.conn, { ...msg, id, from: selfId, ttl: FLOOD_TTL });
}

function announce(): void {
  flood({ t: 'here', name: myName, links: [...links.keys()] });
}

function remember(id: string): void {
  seen.add(id);
  if (seen.size > 2000) seen.delete(seen.values().next().value as string);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, r] of roster) if (now - r.seen > ROSTER_TTL_MS) roster.delete(id);
  if (links.size > 0) announce();
  for (const id of links.keys()) void classify(id);
  render();
}, HERE_EVERY_MS);

// ── Nostr test room ─────────────────────────────────────────────────────────

async function joinRoom(): Promise<void> {
  if (swarm) return;
  roomJoinedAt = Date.now();
  const s = new SignalSwarm({
    selfId,
    wantsPeers: () => links.size < ROOM_TARGET,
    onConnection: (conn) => adopt(conn, 'room'),
    hasPeer: (id) => links.has(id),
  });
  swarm = s;
  setRoomUi(true);
  flash(roomMsg, 'Connecting to relays and looking for people…', 'muted');
  try {
    await s.start([new NostrTransport(DEFAULT_NOSTR_RELAYS)]);
    if (swarm === s) roomReady = true;
  } catch {
    if (swarm === s) {
      swarm = null;
      setRoomUi(false);
      flash(roomMsg, 'Could not reach any Nostr relay. Your network may block them. The code method still works.', 'red');
      results.push('room: no relay reachable');
    }
  }
  render();
}

function leaveRoom(): void {
  swarm?.stop();
  swarm = null;
  roomReady = false;
  roomJoinedAt = 0;
  for (const [id, l] of links) {
    if (l.via !== 'room') continue;
    links.delete(id);
    l.conn.close();
  }
  setRoomUi(false);
  flash(roomMsg, 'Left the room.', 'muted');
  announce();
  render();
}

// ── DOM ─────────────────────────────────────────────────────────────────────

const $ = <T extends Element = HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

$<HTMLImageElement>('[data-logo]').src = logoUrl;

const nameInput = $<HTMLInputElement>('[data-name]');
nameInput.value = myName;
nameInput.addEventListener('change', () => {
  myName = cleanName(nameInput.value) || myName;
  nameInput.value = myName;
  save(NAME_KEY, myName);
  for (const l of links.values()) send(l.conn, { t: 'hello', name: myName });
  announce();
});

// Tabs in the code card.
for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('[data-tab]')) t.classList.toggle('active', t === tab);
    for (const p of document.querySelectorAll<HTMLElement>('[data-pane]')) p.hidden = p.dataset.pane !== tab.dataset.tab;
  });
}

const inviteOut = $<HTMLTextAreaElement>('[data-invite-out]');
const replyIn = $<HTMLInputElement>('[data-reply-in]');
const inviteIn = $<HTMLInputElement>('[data-invite-in]');
const replyOut = $<HTMLTextAreaElement>('[data-reply-out]');
const inviteMsg = $('[data-invite-msg]');
const joinMsg = $('[data-join-msg]');
const roomMsg = $('[data-room-msg]');
const canShare = typeof navigator.share === 'function';

function showCode(out: HTMLTextAreaElement, copy: string, share: string, code: string): void {
  out.value = code;
  const copyBtn = $<HTMLButtonElement>(copy);
  const shareBtn = $<HTMLButtonElement>(share);
  copyBtn.disabled = !code;
  shareBtn.hidden = !canShare;
  shareBtn.disabled = !code;
}

$('[data-mk-invite]').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget as HTMLButtonElement;
  btn.disabled = true;
  flash(inviteMsg, 'Gathering connection details…', 'muted');
  try {
    showCode(inviteOut, '[data-copy-invite]', '[data-share-invite]', await manual.createInvite());
    flash(inviteMsg, 'Send this code to your friend, then paste their reply below.', 'green');
  } catch (e) {
    flash(inviteMsg, errorText(e), 'red');
    results.push(`code: could not create invite (${errorText(e).slice(0, 60)})`);
  } finally {
    btn.disabled = false;
  }
});

$('[data-finish]').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget as HTMLButtonElement;
  const code = replyIn.value.trim();
  if (!code) return flash(inviteMsg, 'Paste the reply code your friend sent you.', 'red');
  btn.disabled = true;
  const t0 = Date.now();
  flash(inviteMsg, 'Connecting…', 'muted');
  try {
    await manual.completeInvite(code);
    replyIn.value = '';
    showCode(inviteOut, '[data-copy-invite]', '[data-share-invite]', '');
    flash(inviteMsg, `Connected in ${secs(Date.now() - t0)}. No server involved. Say hi in the chat below.`, 'green');
    results.push(`code (inviter): connected in ${secs(Date.now() - t0)}`);
  } catch (e) {
    showCode(inviteOut, '[data-copy-invite]', '[data-share-invite]', manual.currentInvite() ?? '');
    flash(inviteMsg, errorText(e), 'red');
    results.push(`code (inviter): failed, ${errorText(e).slice(0, 70)}`);
  } finally {
    btn.disabled = false;
    render();
  }
});

$('[data-accept]').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget as HTMLButtonElement;
  const code = inviteIn.value.trim();
  if (!code) return flash(joinMsg, 'Paste the invite code your friend sent you.', 'red');
  btn.disabled = true;
  flash(joinMsg, 'Gathering connection details…', 'muted');
  try {
    const reply = await manual.acceptInvite(code);
    showCode(replyOut, '[data-copy-reply]', '[data-share-reply]', reply);
    inviteIn.value = '';
    flash(joinMsg, 'Now send this reply back. You connect as soon as they paste it.', 'green');
    const before = links.size;
    const t0 = Date.now();
    // The joiner has no "connect" moment of its own; note it when the link lands.
    const watch = setInterval(() => {
      if (links.size > before) {
        clearInterval(watch);
        flash(joinMsg, 'Connected. No server involved. Say hi in the chat below.', 'green');
        results.push(`code (joiner): connected ${secs(Date.now() - t0)} after making the reply`);
        render();
      } else if (Date.now() - t0 > 15 * 60_000) clearInterval(watch);
    }, 500);
  } catch (e) {
    flash(joinMsg, errorText(e), 'red');
    results.push(`code (joiner): failed, ${errorText(e).slice(0, 70)}`);
  } finally {
    btn.disabled = false;
  }
});

for (const [btnSel, src] of [['[data-copy-invite]', inviteOut], ['[data-copy-reply]', replyOut]] as const) {
  $(btnSel).addEventListener('click', (ev) => copy(ev.currentTarget as HTMLButtonElement, src.value));
}
for (const [btnSel, src] of [['[data-share-invite]', inviteOut], ['[data-share-reply]', replyOut]] as const) {
  $(btnSel).addEventListener('click', () => {
    void navigator.share({ text: src.value }).catch(() => { /* user closed the sheet */ });
  });
}

$('[data-join-room]').addEventListener('click', () => void joinRoom());
$('[data-leave-room]').addEventListener('click', leaveRoom);

function setRoomUi(inRoom: boolean): void {
  $<HTMLButtonElement>('[data-join-room]').hidden = inRoom;
  $<HTMLButtonElement>('[data-leave-room]').hidden = !inRoom;
}

// Chat.
const chatIn = $<HTMLInputElement>('[data-chat-in]');
$('[data-chat-form]').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const text = chatIn.value.trim().slice(0, 280);
  if (!text || links.size === 0) return;
  flood({ t: 'chat', name: myName, text });
  showChat(myName, text, true);
  chatIn.value = '';
});

function showChat(name: string, text: string, mine: boolean): void {
  const log = $('[data-chat-log]');
  const line = document.createElement('p');
  line.className = mine ? 'msg mine' : 'msg';
  const who = document.createElement('b');
  who.textContent = name || 'someone';
  line.append(who, document.createTextNode(` ${text}`));
  log.append(line);
  while (log.children.length > 200) log.firstElementChild?.remove();
  log.scrollTop = log.scrollHeight;
}

// Save the page.
const fromDisk = location.protocol === 'file:';
$('[data-origin]').textContent = fromDisk
  ? 'You opened this page from your own disk. No web host is involved at all right now.'
  : `This page was loaded once from ${location.host}. After that, nothing it does goes back there. Save it and open the file to drop the web host too.`;
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

// Report.
$('[data-copy-report]').addEventListener('click', (ev) => copy(ev.currentTarget as HTMLButtonElement, reportText()));

function reportText(): string {
  const kinds = [...links.values()].map((l) => `${l.via}/${l.kind}`);
  return [
    'browserCoin p2p test report',
    `browser: ${browserLabel()}`,
    `opened from: ${fromDisk ? 'disk' : 'website'}`,
    `webrtc: ${typeof RTCPeerConnection === 'function' ? 'yes' : 'NO'}`,
    `links now: ${links.size}${kinds.length ? ` (${kinds.join(', ')})` : ''}`,
    `people seen in network: ${networkIds().length}`,
    `relays up: ${swarm ? swarm.status()[0]?.endpoints.filter((e) => e.up).length ?? 0 : 'not in room'}`,
    ...(results.length ? results.map((r) => `- ${r}`) : ['- nothing tried yet']),
  ].join('\n');
}

// ── Rendering ───────────────────────────────────────────────────────────────

function networkIds(): string[] {
  const ids = new Set<string>([selfId, ...links.keys(), ...roster.keys()]);
  return [...ids];
}

function render(): void {
  const ids = networkIds();
  const others = ids.length - 1;
  $('[data-net-summary]').textContent = links.size === 0
    ? 'Not connected to anyone yet.'
    : `Linked directly to ${links.size} ${links.size === 1 ? 'browser' : 'browsers'}, ${others} ${others === 1 ? 'other browser' : 'other browsers'} in this network.`;

  chatIn.disabled = links.size === 0;
  $<HTMLButtonElement>('[data-chat-send]').disabled = links.size === 0;
  if (links.size > 0 && chatIn.placeholder !== 'Say hi') chatIn.placeholder = 'Say hi';
  if (links.size === 0) chatIn.placeholder = 'Connect to someone first';

  const ul = $('[data-links]');
  ul.replaceChildren(...[...links.values()].map((l) => {
    const li = document.createElement('li');
    const name = document.createElement('b');
    name.textContent = l.name;
    const meta = document.createElement('span');
    meta.className = 'muted text-sm';
    meta.textContent = ` ${l.via === 'code' ? 'via code' : 'via room'}, ${l.kind}${l.rtt != null ? `, ${l.rtt} ms` : ''}`;
    li.append(name, meta);
    return li;
  }));

  drawGraph(ids);
  renderRelays();
  if (swarm && roomReady) {
    const inRoom = [...links.values()].filter((l) => l.via === 'room').length;
    flash(roomMsg, inRoom > 0
      ? `In the room and linked to ${inRoom} ${inRoom === 1 ? 'person' : 'people'} through it. New people get linked in automatically.`
      : 'In the room. Waiting for someone else to show up. Ask a friend to join too.', inRoom > 0 ? 'green' : 'muted');
  }
  $('[data-report]').textContent = reportText();
}

function drawGraph(ids: string[]): void {
  const svg = $<SVGSVGElement>('[data-graph]');
  const shown = [selfId, ...ids.filter((i) => i !== selfId).sort()].slice(0, 24);
  const W = 400, H = 300, cx = W / 2, cy = H / 2;
  const r = shown.length <= 1 ? 0 : Math.min(115, 40 + shown.length * 10);
  const pos = new Map<string, { x: number; y: number }>();
  shown.forEach((id, i) => {
    const a = -Math.PI / 2 + (i / shown.length) * Math.PI * 2;
    pos.set(id, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  });

  const edges = new Set<string>();
  const addEdge = (a: string, b: string): void => {
    if (pos.has(a) && pos.has(b) && a !== b) edges.add([a, b].sort().join('|'));
  };
  for (const id of links.keys()) addEdge(selfId, id);
  for (const [id, e] of roster) for (const other of e.links) addEdge(id, other);

  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag: string, attrs: Record<string, string | number>): SVGElement => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };
  const kids: SVGElement[] = [];
  for (const e of edges) {
    const [a, b] = e.split('|') as [string, string];
    const pa = pos.get(a)!, pb = pos.get(b)!;
    const mine = a === selfId || b === selfId;
    kids.push(el('line', { x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, class: mine ? 'edge mine' : 'edge' }));
  }
  for (const id of shown) {
    const p = pos.get(id)!;
    const me = id === selfId;
    kids.push(el('circle', { cx: p.x, cy: p.y, r: me ? 11 : 8, class: me ? 'node me' : links.has(id) ? 'node linked' : 'node' }));
    const label = el('text', { x: p.x, y: p.y + (p.y > cy ? 24 : -16), class: 'label' });
    label.textContent = me ? `${myName} (you)` : links.get(id)?.name ?? roster.get(id)?.name ?? 'someone';
    kids.push(label);
  }
  svg.replaceChildren(...kids);
}

function renderRelays(): void {
  const ul = $('[data-relays]');
  if (!swarm) return void ul.replaceChildren();
  const eps = swarm.status()[0]?.endpoints ?? [];
  ul.replaceChildren(...eps.map((e) => {
    const li = document.createElement('li');
    li.className = e.up ? 'up' : 'down';
    li.textContent = e.url.replace('wss://', '');
    return li;
  }));
}

function renderContacts(): void {
  const list = contactList();
  const ours = list.filter((c) => /(^|\.)browsercoin\.org$/i.test(c.host.split(':')[0]!));
  $('[data-servers-count]').textContent = String(ours.length);
  $('[data-servers-pill]').classList.toggle('bad', ours.length > 0);

  const ul = $('[data-contacts]');
  const items: HTMLLIElement[] = list.map((c) => {
    const li = document.createElement('li');
    const what = c.kind === 'websocket' && DEFAULT_NOSTR_RELAYS.some((u) => u.endsWith(c.host))
      ? 'Nostr relay, passes introductions for the test room'
      : c.kind === 'websocket' ? 'WebSocket' : 'web request';
    li.innerHTML = '<b></b> <span class="muted text-sm"></span>';
    li.querySelector('b')!.textContent = c.host;
    li.querySelector('span')!.textContent = what;
    return li;
  });
  const stun = document.createElement('li');
  stun.innerHTML = '<b>STUN servers</b> <span class="muted text-sm"></span>';
  stun.querySelector('span')!.textContent =
    `asked "what is my public address?" when you make a code or join the room: ${ICE_SERVERS.map((s) => String(s.urls).replace(/^stun:/, '').replace(/:\d+$/, '')).join(', ')}`;
  items.push(stun);
  if (list.length === 0) {
    const none = document.createElement('li');
    none.innerHTML = '<b>Nothing yet</b> <span class="muted text-sm">The page has not contacted anything since it loaded.</span>';
    items.unshift(none);
  }
  ul.replaceChildren(...items);
}

onContact(renderContacts);
renderContacts();
render();
setInterval(renderRelays, 2000);

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
    btn.textContent = 'Copy failed, select and copy by hand';
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
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => a[x % a.length]).join('');
}

function pick<T>(xs: T[]): T {
  return xs[Math.floor(Math.random() * xs.length)]!;
}

function load(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}

function save(k: string, v: string): void {
  try { localStorage.setItem(k, v); } catch { /* private mode; name lasts this session */ }
}

function browserLabel(): string {
  const ua = navigator.userAgent;
  const b = /Edg\/(\d+)/.exec(ua) ? `Edge ${/Edg\/(\d+)/.exec(ua)![1]}`
    : /Firefox\/(\d+)/.exec(ua) ? `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}`
    : /Chrome\/(\d+)/.exec(ua) ? `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}`
    : /Version\/(\d+).*Safari/.exec(ua) ? `Safari ${/Version\/(\d+)/.exec(ua)![1]}`
    : 'other';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'other OS';
  return `${b} on ${os}`;
}
