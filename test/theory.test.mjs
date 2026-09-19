import test from 'node:test';
import assert from 'node:assert/strict';
import { degreeToMidi, quantizeIndex, midiToHz, noteName, SCALES } from '../src/audio/theory.js';
import { activeLayers, bassMidi, stepSeconds, arpNote, PATTERNS, STEPS } from '../src/audio/pattern.js';

test('midiToHz: A4 = 440, octave doubles', () => {
  assert.equal(midiToHz(69), 440);
  assert.ok(Math.abs(midiToHz(81) - 880) < 1e-9);
});

test('noteName', () => {
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(69), 'A4');
  assert.equal(noteName(61), 'C#4');
});

test('degreeToMidi wraps into octaves and stays inside the scale', () => {
  const root = 57; // A3
  assert.equal(degreeToMidi(0, 'Minor Pentatonic', root), 57);
  assert.equal(degreeToMidi(4, 'Minor Pentatonic', root), 67);
  assert.equal(degreeToMidi(5, 'Minor Pentatonic', root), 69); // next octave root
  assert.equal(degreeToMidi(-1, 'Minor Pentatonic', root), 55); // one below root: b7 of previous octave
  for (const [name, { steps }] of Object.entries(SCALES)) {
    for (let d = 0; d < 20; d++) {
      const pc = (degreeToMidi(d, name, root) - root) % 12;
      assert.ok(steps.includes(pc), `${name} degree ${d}`);
    }
  }
});

test('quantizeIndex: covers range, clamps, and has hysteresis', () => {
  assert.equal(quantizeIndex(0, 10), 0);
  assert.equal(quantizeIndex(1, 10), 9);
  assert.equal(quantizeIndex(-5, 10), 0);
  assert.equal(quantizeIndex(0.5, 10), 5);
  // sitting just past the 4|5 boundary while on 4 → stays on 4
  assert.equal(quantizeIndex(0.505, 10, 4, 0.2), 4);
  // well past it → moves
  assert.equal(quantizeIndex(0.53, 10, 4, 0.2), 5);
  // and back: just under the boundary while on 5 → stays on 5
  assert.equal(quantizeIndex(0.495, 10, 5, 0.2), 5);
});

test('layers fade in with intensity', () => {
  assert.deepEqual(Object.values(activeLayers(0)).filter(Boolean), []);
  const mid = activeLayers(0.5);
  assert.ok(mid.kick && mid.hat && mid.bass && !mid.clap && !mid.arp);
  assert.ok(Object.values(activeLayers(1)).every(Boolean));
});

test('pattern helpers', () => {
  assert.ok(Math.abs(stepSeconds(120) - 0.125) < 1e-12);
  for (const p of Object.values(PATTERNS)) assert.equal(p.length, STEPS);
  assert.equal(bassMidi(0, 45, 'Natural Minor'), 45);
  assert.equal(bassMidi(1, 45, 'Natural Minor'), 53);
  assert.equal(bassMidi(4, 45, 'Natural Minor'), 45); // repeats every 4 bars
  assert.ok(arpNote(3, 45) > 45);
});
