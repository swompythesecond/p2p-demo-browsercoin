// The only lines that differ from browserCoin's src/net/signal/: the hex
// helpers sdp.ts imported from elsewhere in the browserCoin tree.

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
