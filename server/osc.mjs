// Minimal OSC 1.0 encoder/decoder (float32 `f`, int32 `i`, string `s`) plus bundles.
// Enough for TouchDesigner's OSC In/Out CHOP/DAT; no dependencies.

const pad4 = (n) => (n + 3) & ~3;

function oscString(str) {
  const bytes = Buffer.from(str, 'utf8');
  const out = Buffer.alloc(pad4(bytes.length + 1)); // + null terminator, zero padded
  bytes.copy(out);
  return out;
}

/** @param args array of numbers (floats unless marked) | {i:int} | strings */
export function encodeMessage(address, args = []) {
  let tags = ',';
  const parts = [];
  for (const a of args) {
    if (typeof a === 'string') {
      tags += 's';
      parts.push(oscString(a));
    } else if (typeof a === 'object' && a !== null && 'i' in a) {
      tags += 'i';
      const b = Buffer.alloc(4);
      b.writeInt32BE(a.i | 0);
      parts.push(b);
    } else if (typeof a === 'boolean') {
      tags += 'i';
      const b = Buffer.alloc(4);
      b.writeInt32BE(a ? 1 : 0);
      parts.push(b);
    } else {
      tags += 'f';
      const b = Buffer.alloc(4);
      b.writeFloatBE(Number.isFinite(a) ? a : 0);
      parts.push(b);
    }
  }
  return Buffer.concat([oscString(address), oscString(tags), ...parts]);
}

/** Bundle of messages sent "immediately" (timetag 0…1). */
export function encodeBundle(messages) {
  const head = Buffer.alloc(16);
  head.write('#bundle\0', 0, 'latin1');
  head.writeUInt32BE(0, 8);
  head.writeUInt32BE(1, 12);
  const parts = [head];
  for (const m of messages) {
    const len = Buffer.alloc(4);
    len.writeInt32BE(m.length);
    parts.push(len, m);
  }
  return Buffer.concat(parts);
}

function readString(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  return [buf.toString('utf8', off, end), pad4(end + 1)];
}

/** Decode a packet into a flat list of {address, args}. Unknown arg types are skipped. */
export function decode(buf) {
  if (buf.length >= 8 && buf.toString('latin1', 0, 8) === '#bundle\0') {
    const out = [];
    let off = 16;
    while (off + 4 <= buf.length) {
      const len = buf.readInt32BE(off);
      off += 4;
      if (len <= 0 || off + len > buf.length) break;
      out.push(...decode(buf.subarray(off, off + len)));
      off += len;
    }
    return out;
  }
  const [address, tagOff] = readString(buf, 0);
  if (!address.startsWith('/')) return [];
  if (tagOff >= buf.length) return [{ address, args: [] }];
  const [tags, argOff] = readString(buf, tagOff);
  let o = argOff;
  const args = [];
  for (const t of tags.slice(1)) {
    if (t === 'f') {
      args.push(buf.readFloatBE(o));
      o += 4;
    } else if (t === 'i') {
      args.push(buf.readInt32BE(o));
      o += 4;
    } else if (t === 's') {
      const [s, n] = readString(buf, o);
      args.push(s);
      o = n;
    } else if (t === 'T') args.push(true);
    else if (t === 'F') args.push(false);
    else if (t === 'd') {
      args.push(buf.readDoubleBE(o));
      o += 8;
    } else break;
  }
  return [{ address, args }];
}

/**
 * Flatten a browser frame (see src/net/bridge.js) into OSC messages.
 * This is the single source of truth for the address space documented in docs/TOUCHDESIGNER.md.
 */
export function frameToMessages(frame, prefix = '/synthmotion') {
  const M = [];
  const push = (addr, ...args) => M.push(encodeMessage(`${prefix}${addr}`, args));
  const hands = Array.isArray(frame.hands) ? frame.hands : [];
  push('/hands/count', { i: hands.length });
  for (const role of ['lead', 'rhythm']) {
    const h = hands.find((x) => x.role === role);
    push(`/${role}/present`, { i: h ? 1 : 0 });
    if (!h) continue;
    for (const k of ['x', 'y', 'z', 'pinch', 'open', 'roll']) push(`/${role}/${k}`, h[k] ?? 0);
  }
  const a = frame.audio ?? {};
  for (const k of ['level', 'bass', 'mid', 'high']) push(`/audio/${k}`, a[k] ?? 0);
  const n = frame.note ?? {};
  push('/note/midi', n.midi ?? 0);
  push('/note/gate', { i: n.gate ? 1 : 0 });
  push('/beat/step', { i: frame.step ?? 0 });
  push('/beat/bpm', frame.bpm ?? 0);
  push('/beat/intensity', frame.intensity ?? 0);
  return M;
}
