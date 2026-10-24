// The only lines that differ from browserCoin's src/net/signal/: the three
// helpers those files imported from elsewhere in the browserCoin tree.
import { sha256 as nobleSha256 } from '@noble/hashes/sha2';

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('invalid hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const h = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(h)) throw new Error('invalid hex char');
    out[i] = h;
  }
  return out;
}

/**
 * A separate network name, so demo traffic lands on its own Nostr topic and
 * can never be mistaken for, or mixed into, the real browserCoin network.
 */
export const BROWSERCOIN_NETWORK = 'browsercoin-p2p-demo-v1';
