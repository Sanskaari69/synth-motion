import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { WebSocket } from 'ws';
import { encodeMessage, encodeBundle, decode, frameToMessages } from '../server/osc.mjs';
import { startBridge } from '../server/bridge.mjs';

test('OSC message matches the spec byte-for-byte', () => {
  // From the OSC 1.0 spec examples: "/oscillator/4/frequency" ,f 440.0
  const b = encodeMessage('/oscillator/4/frequency', [440]);
  assert.equal(b.length % 4, 0);
  assert.equal(b.subarray(0, 24).toString('latin1'), '/oscillator/4/frequency\0');
  assert.equal(b.subarray(24, 28).toString('latin1'), ',f\0\0');
  assert.equal(b.readFloatBE(28), 440);
  assert.equal(b.length, 32);
});

test('encode → decode round trip (f, i, s, bundle)', () => {
  const msg = encodeMessage('/a/b', [0.5, { i: -3 }, 'hi', true]);
  const [d] = decode(msg);
  assert.equal(d.address, '/a/b');
  assert.deepEqual(d.args, [0.5, -3, 'hi', 1]);
  const bundle = encodeBundle([encodeMessage('/x', [1]), encodeMessage('/y', [{ i: 2 }])]);
  const out = decode(bundle);
  assert.deepEqual(out.map((m) => m.address), ['/x', '/y']);
  assert.deepEqual(out.map((m) => m.args[0]), [1, 2]);
});

test('frameToMessages emits the documented address space', () => {
  const frame = {
    type: 'frame',
    hands: [
      { role: 'lead', x: 0.7, y: 0.3, z: 0.5, pinch: 1, open: 0.8, roll: -0.2 },
      { role: 'rhythm', x: 0.2, y: 0.6, z: 0.4, pinch: 0, open: 1, roll: 0 },
    ],
    audio: { level: 0.3, bass: 0.5, mid: 0.2, high: 0.1 },
    note: { midi: 64, gate: true },
    step: 5,
    bpm: 118,
    intensity: 0.7,
  };
  const decoded = frameToMessages(frame).flatMap((m) => decode(m));
  const byAddr = Object.fromEntries(decoded.map((m) => [m.address, m.args[0]]));
  assert.equal(byAddr['/synthmotion/hands/count'], 2);
  assert.ok(Math.abs(byAddr['/synthmotion/lead/x'] - 0.7) < 1e-6);
  assert.equal(byAddr['/synthmotion/lead/pinch'], 1);
  assert.ok(Math.abs(byAddr['/synthmotion/rhythm/open'] - 1) < 1e-6);
  assert.equal(byAddr['/synthmotion/note/midi'], 64);
  assert.equal(byAddr['/synthmotion/note/gate'], 1);
  assert.equal(byAddr['/synthmotion/beat/step'], 5);
  assert.equal(byAddr['/synthmotion/beat/bpm'], 118);
  assert.ok(Math.abs(byAddr['/synthmotion/audio/bass'] - 0.5) < 1e-6);
  // a missing hand reports present=0 and no xyz
  const solo = frameToMessages({ hands: [{ role: 'lead', x: 0.5, y: 0.5 }] }).flatMap((m) => decode(m));
  assert.equal(solo.find((m) => m.address === '/synthmotion/rhythm/present').args[0], 0);
  assert.ok(!solo.some((m) => m.address === '/synthmotion/rhythm/x'));
});

const freeUdp = () =>
  new Promise((res) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address();
      res({ s, port });
    });
  });

test('bridge end-to-end: WebSocket frame → OSC/UDP; OSC control → WebSocket', async () => {
  const { s: td, port: oscPort } = await freeUdp(); // stands in for TouchDesigner's OSC In
  const inProbe = await freeUdp();
  const oscInPort = inProbe.port;
  inProbe.s.close();
  const wsProbe = await freeUdp();
  const wsPort = wsProbe.port; // free tcp/udp numbers rarely collide; good enough for a test
  wsProbe.s.close();

  const bridge = startBridge({ wsPort, oscPort, oscInPort, log: () => {} });
  await bridge.ready;

  const got = new Promise((res) => td.once('message', res));
  const app = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  const other = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  await Promise.all([new Promise((r) => app.once('open', r)), new Promise((r) => other.once('open', r))]);

  const relayed = new Promise((res) => other.once('message', (d) => res(JSON.parse(d.toString()))));
  const frame = { type: 'frame', hands: [{ role: 'lead', x: 0.25, y: 0.75, z: 0.1, pinch: 0.9, open: 0.5, roll: 0 }], audio: { level: 0.1, bass: 0.2, mid: 0.3, high: 0.4 }, note: { midi: 60, gate: true }, step: 3, bpm: 120, intensity: 0.5 };
  app.send(JSON.stringify(frame));

  const packet = await got;
  const msgs = decode(packet);
  const x = msgs.find((m) => m.address === '/synthmotion/lead/x');
  assert.ok(x && Math.abs(x.args[0] - 0.25) < 1e-6, 'lead/x arrives over UDP as OSC');
  assert.ok(msgs.find((m) => m.address === '/synthmotion/beat/bpm'));
  assert.equal((await relayed).hands[0].x, 0.25, 'JSON is fanned out to other websocket clients');

  // TouchDesigner → browser
  const control = new Promise((res) => app.once('message', (d) => res(JSON.parse(d.toString()))));
  const sender = dgram.createSocket('udp4');
  sender.send(encodeMessage('/synthmotion/control/hue', [0.42]), oscInPort, '127.0.0.1');
  const c = await control;
  assert.equal(c.type, 'control');
  assert.equal(c.name, 'hue');
  assert.ok(Math.abs(c.value - 0.42) < 1e-6);
  assert.equal(bridge.stats.framesIn, 1);
  assert.equal(bridge.stats.controlIn, 1);

  sender.close();
  td.close();
  app.close();
  other.close();
  await bridge.close();
});

test('bridge ignores malformed input', async () => {
  const p = await freeUdp();
  const port = p.port;
  p.s.close();
  const bridge = startBridge({ wsPort: port, oscPort: 1, oscInPort: port + 1 > 65535 ? 20000 : port + 1, log: () => {} });
  await bridge.ready;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => ws.once('open', r));
  ws.send('not json');
  ws.send(JSON.stringify({ type: 'nope' }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(bridge.stats.framesIn, 0);
  ws.close();
  await bridge.close();
});
