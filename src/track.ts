/**
 * Records every outside host this page opens a connection to, so the page can
 * show its own network activity instead of asking people to take our word for
 * it. Imported first in main.ts, before any code that could open a socket.
 *
 * WebSocket and fetch cover everything this page can reach on its own. The
 * one thing they can't see is STUN, which the browser runs internally when a
 * peer connection gathers addresses; main.ts lists those from the ICE config.
 */

export interface Contact {
  host: string;
  kind: 'websocket' | 'fetch';
  first: number;
  count: number;
}

const contacts = new Map<string, Contact>();
const listeners = new Set<() => void>();

function record(url: string | URL, kind: Contact['kind']): void {
  let host: string;
  try {
    const u = new URL(String(url), location.href);
    if (u.protocol === 'file:' || u.protocol === 'data:' || u.protocol === 'blob:') return;
    if (u.host === location.host) return;
    host = u.host;
  } catch {
    return;
  }
  const key = `${kind}:${host}`;
  const c = contacts.get(key);
  if (c) c.count++;
  else contacts.set(key, { host, kind, first: Date.now(), count: 1 });
  for (const fn of listeners) fn();
}

const NativeWebSocket = window.WebSocket;
class TrackedWebSocket extends NativeWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    record(url, 'websocket');
    super(url, protocols);
  }
}
window.WebSocket = TrackedWebSocket;

const nativeFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  record(input instanceof Request ? input.url : input, 'fetch');
  return nativeFetch(input, init);
};

export function contactList(): Contact[] {
  return [...contacts.values()].sort((a, b) => a.first - b.first);
}

export function onContact(fn: () => void): void {
  listeners.add(fn);
}
