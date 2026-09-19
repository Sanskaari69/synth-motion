// Pure music-theory helpers (no Web Audio), shared by the engine and the tests.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** `steps` are semitone offsets; `prog` is a 4-bar bass progression in semitones from the root. */
export const SCALES = {
  'Minor Pentatonic': { steps: [0, 3, 5, 7, 10], prog: [0, 8, 3, 10] },
  'Natural Minor': { steps: [0, 2, 3, 5, 7, 8, 10], prog: [0, 8, 3, 10] },
  Dorian: { steps: [0, 2, 3, 5, 7, 9, 10], prog: [0, 0, 5, 3] },
  Phrygian: { steps: [0, 1, 3, 5, 7, 8, 10], prog: [0, 1, 0, 10] },
  'Harmonic Minor': { steps: [0, 2, 3, 5, 7, 8, 11], prog: [0, 8, 5, 7] },
  Major: { steps: [0, 2, 4, 5, 7, 9, 11], prog: [0, 7, 9, 5] },
  Lydian: { steps: [0, 2, 4, 6, 7, 9, 11], prog: [0, 2, 7, 4] },
};
export const DEFAULT_SCALE = 'Minor Pentatonic';

export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const noteName = (m) => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

/** Scale degree (0-based, may exceed the scale length → next octave) to a MIDI note. */
export function degreeToMidi(degree, scaleName, rootMidi) {
  const { steps } = SCALES[scaleName] ?? SCALES[DEFAULT_SCALE];
  const n = steps.length;
  const oct = Math.floor(degree / n);
  const idx = ((degree % n) + n) % n;
  return rootMidi + oct * 12 + steps[idx];
}

/**
 * Map v∈[0,1] to a cell index in [0,count) with hysteresis so the note doesn't flutter
 * when the hand sits on a boundary. `hyst` is the fraction of a cell you must overshoot.
 */
export function quantizeIndex(v, count, prev = -1, hyst = 0.2) {
  const x = Math.min(Math.max(v, 0), 0.999999) * count;
  const raw = Math.floor(x);
  if (prev < 0 || prev >= count) return raw;
  if (raw === prev) return prev;
  // only leave the previous cell once we're `hyst` cells past its edge
  const lo = prev - hyst;
  const hi = prev + 1 + hyst;
  return x >= lo && x < hi ? prev : raw;
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => clamp01((v - a) / (b - a));
