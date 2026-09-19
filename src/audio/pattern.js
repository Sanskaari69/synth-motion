// Pure rhythm-section logic: 16-step patterns, which layers are audible at a given
// intensity, and the bass / arp note choice. The engine only turns these into sound.
import { SCALES, DEFAULT_SCALE } from './theory.js';

export const STEPS = 16;

// 1 = hit, 2 = accent
export const PATTERNS = {
  kick: [2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 1, 2, 0, 0, 0],
  hat: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0],
  openHat: [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0],
  clap: [0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0],
  bass: [2, 0, 1, 0, 0, 1, 0, 1, 2, 0, 1, 0, 0, 1, 0, 0],
  arp: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
};

/** Thresholds at which each layer fades in as the "intensity" (left-hand openness) rises. */
export const LAYER_THRESHOLDS = { kick: 0.12, hat: 0.3, bass: 0.45, clap: 0.6, openHat: 0.7, arp: 0.82 };

export function activeLayers(intensity) {
  const out = {};
  for (const [k, t] of Object.entries(LAYER_THRESHOLDS)) out[k] = intensity >= t;
  return out;
}

export const stepSeconds = (bpm) => 60 / bpm / 4;

/** Bass root (MIDI) for a given bar; `bar` counts up forever, the progression repeats every 4. */
export function bassMidi(bar, rootMidi, scaleName = DEFAULT_SCALE) {
  const { prog } = SCALES[scaleName] ?? SCALES[DEFAULT_SCALE];
  return rootMidi + prog[((bar % prog.length) + prog.length) % prog.length];
}

/** Chord tones (semitones over the bass note) for the arp — triad from the scale where possible. */
export function arpNote(step, bassNoteMidi, scaleName = DEFAULT_SCALE) {
  const { steps } = SCALES[scaleName] ?? SCALES[DEFAULT_SCALE];
  const pool = [0, steps[Math.min(2, steps.length - 1)], steps[Math.min(4, steps.length - 1)], 12];
  const order = [0, 1, 2, 3, 2, 1, 2, 3];
  return bassNoteMidi + 12 + pool[order[step % order.length]];
}
