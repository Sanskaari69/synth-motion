import test from 'node:test';
import assert from 'node:assert/strict';
import { handFeatures } from '../src/tracking/features.js';
import { syntheticHand, demoHands } from '../src/tracking/demo.js';
import { Controller } from '../src/tracking/controller.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

for (const aspect of [16 / 9, 4 / 3, 9 / 16]) {
  test(`features recover position/openness/pinch/roll (aspect ${aspect.toFixed(2)})`, () => {
    const f = handFeatures(syntheticHand({ cx: 0.3, cy: 0.6, open: 1, pinch: 0, roll: 0, aspect }), { aspect });
    near(f.x, 0.3, 1e-6, 'x mirrored/display space');
    near(f.y, 0.6, 1e-6, 'y');
    assert.ok(f.open > 0.95, `open hand → open≈1 (${f.open})`);
    assert.ok(f.pinch < 0.05, `apart → pinch≈0 (${f.pinch})`);
    near(f.roll, 0, 0.01, 'upright');

    const fist = handFeatures(syntheticHand({ open: 0, aspect }), { aspect });
    assert.ok(fist.open < 0.1, `fist → open≈0 (${fist.open})`);

    const pinched = handFeatures(syntheticHand({ pinch: 1, aspect }), { aspect });
    assert.ok(pinched.pinch > 0.95, `touching → pinch≈1 (${pinched.pinch})`);

    const right = handFeatures(syntheticHand({ roll: 0.5, aspect }), { aspect });
    near(right.roll, 0.5, 0.02, 'roll right');
    const left = handFeatures(syntheticHand({ roll: -0.5, aspect }), { aspect });
    near(left.roll, -0.5, 0.02, 'roll left');
  });
}

test('features are monotonic in open and pinch', () => {
  let prev = -1;
  for (let o = 0; o <= 1.001; o += 0.1) {
    const v = handFeatures(syntheticHand({ open: o })).open;
    assert.ok(v >= prev - 1e-9);
    prev = v;
  }
  prev = -1;
  for (let p = 0; p <= 1.001; p += 0.1) {
    const v = handFeatures(syntheticHand({ pinch: p })).pinch;
    assert.ok(v >= prev - 1e-9);
    prev = v;
  }
});

test('size shrinks with distance', () => {
  const near_ = handFeatures(syntheticHand({ size: 0.25 })).size;
  const far = handFeatures(syntheticHand({ size: 0.1 })).size;
  assert.ok(near_ > far * 2);
});

test('mirror flag flips x', () => {
  const raw = syntheticHand({ cx: 0.2, mirrored: true });
  near(handFeatures(raw, { mirror: true }).x, 0.2, 1e-6, 'mirrored');
  near(handFeatures(raw, { mirror: false }).x, 0.8, 1e-6, 'unmirrored');
});

const feat = (x, extra = {}) => ({ x, y: 0.5, size: 0.15, pinch: 0, open: 1, roll: 0, ...extra });

test('controller: one hand plays lead; two hands split lead (right) / rhythm (left)', () => {
  const c = new Controller();
  let out = c.update([feat(0.3)], 1 / 60);
  assert.ok(out.lead.present && !out.rhythm.present);
  out = c.update([feat(0.25), feat(0.75)], 1 / 60);
  assert.ok(out.lead.present && out.rhythm.present);
  for (let i = 0; i < 120; i++) out = c.update([feat(0.25), feat(0.75)], 1 / 60);
  assert.ok(out.lead.x > 0.7 && out.rhythm.x < 0.3);
});

test('controller: gate has hysteresis and drops when the hand leaves (after the hold)', () => {
  const c = new Controller();
  const step = (pinch, n = 10) => {
    let o;
    for (let i = 0; i < n; i++) o = c.update([feat(0.6, { pinch })], 1 / 60);
    return o.lead;
  };
  assert.equal(step(0).gate, false);
  assert.equal(step(0.5).gate, false, '0.5 is inside the dead band');
  assert.equal(step(1).gate, true);
  assert.equal(step(0.5).gate, true, 'dead band keeps it on');
  assert.equal(step(0).gate, false);
  step(1);
  // hand disappears: survives a short dropout, then releases
  let o = c.update([], 1 / 60);
  assert.equal(o.lead.gate, true, 'brief dropout should not cut the note');
  for (let i = 0; i < 20; i++) o = c.update([], 1 / 60);
  assert.equal(o.lead.gate, false);
  assert.equal(o.lead.present, false);
  for (let i = 0; i < 120; i++) o = c.update([], 1 / 60);
  assert.equal(o.lead.weight, 0);
});

test('controller: degree stays in range and is stable for a still hand', () => {
  const c = new Controller({ leadDegrees: 15 });
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(c.update([feat(0.5 + (i % 2) * 0.004)], 1 / 60).lead.degree);
  assert.ok(seen.size <= 2 && [...seen].every((d) => d >= 0 && d < 15));
});

test('demo hands: two hands, 21 landmarks, all inside the frame over time', () => {
  for (let t = 0; t < 60; t += 0.5) {
    const hs = demoHands(t);
    assert.equal(hs.length, 2);
    for (const h of hs) {
      assert.equal(h.length, 21);
      for (const p of h) assert.ok(p.x > -0.1 && p.x < 1.1 && p.y > -0.1 && p.y < 1.1, `t=${t} (${p.x},${p.y})`);
    }
  }
});
