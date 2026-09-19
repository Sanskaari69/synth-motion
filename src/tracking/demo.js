// Synthetic 21-point hands. Used by the no-camera demo mode AND by the unit tests
// (round-trip: build a hand with known pinch/open/roll, then check handFeatures recovers it).
import { lerp } from '../audio/theory.js';

// Hand-local coordinates in units of (wrist → middle knuckle), y up.
const MCP = { thumb: [-0.45, 0.25], index: [-0.35, 0.95], middle: [0, 1.0], ring: [0.32, 0.93], pinky: [0.62, 0.8] };
const FINGER_LEN = { index: 0.95, middle: 1.0, ring: 0.92, pinky: 0.75 };
const FINGERS = ['index', 'middle', 'ring', 'pinky'];

/**
 * @param o {cx,cy,size,open,pinch,roll,aspect,mirrored}
 *   cx,cy   palm position in *display* (mirrored) 0..1 space
 *   size    wrist→middle-knuckle length as fraction of image height
 *   open    0..1, pinch 0..1, roll −1..1 (fingers point right when +)
 * Returns raw (un-mirrored) image-space landmarks, like MediaPipe would.
 */
export function syntheticHand({ cx = 0.5, cy = 0.5, size = 0.14, open = 1, pinch = 0, roll = 0, aspect = 16 / 9, mirrored = true } = {}) {
  const local = new Array(21);
  local[0] = [0, 0];
  local[1] = [-0.45, 0.25];
  local[2] = [-0.75, 0.5];
  local[3] = [-0.95, 0.75];
  const ext = lerp(-0.1, 1, open);
  FINGERS.forEach((f, fi) => {
    const base = 5 + fi * 4;
    const [mx, my] = MCP[f];
    local[base] = [mx, my];
    const len = FINGER_LEN[f];
    for (let j = 1; j <= 3; j++) local[base + j] = [mx + 0.02 * j * (fi - 1), my + len * ext * (j / 3)];
  });
  // thumb tip glides from its open position onto the index tip
  const idxTip = local[8];
  const thumbOpen = [-1.2, 0.95];
  local[4] = [lerp(thumbOpen[0], idxTip[0] - 0.03, pinch), lerp(thumbOpen[1], idxTip[1] - 0.03, pinch)];

  const ang = roll * (Math.PI / 2);
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  // Wrist position such that the palm centre lands on (cx, cy)
  const centre = [0, 0]; // palm centre in local space (avg of palm points)
  for (const i of [0, 5, 9, 13, 17]) {
    centre[0] += local[i][0] / 5;
    centre[1] += local[i][1] / 5;
  }
  const rot = ([x, y]) => [x * c + y * s, -x * s + y * c];
  const rc = rot(centre);
  return local.map((p) => {
    const [rx, ry] = rot(p);
    const dx = (rx - rc[0]) * size; // in image-height units
    const dy = (ry - rc[1]) * size;
    const dispX = cx + dx / aspect; // display space
    const rawX = mirrored ? 1 - dispX : dispX;
    return { x: rawX, y: cy - dy, z: 0 };
  });
}

/** Two hands wandering on Lissajous paths, with periodic pinches — the no-camera demo. */
export function demoHands(t, aspect = 16 / 9) {
  const hands = [];
  // "lead" (right side of the display): sweeps pitch, pinches like playing notes
  const pinchWave = Math.sin(t * 2 * Math.PI * 0.8); // ~0.8 Hz: half the time pinched
  hands.push(
    syntheticHand({
      cx: 0.66 + 0.2 * Math.sin(t * 0.55),
      cy: 0.45 + 0.2 * Math.sin(t * 0.83 + 1),
      size: 0.15,
      open: 0.75 + 0.2 * Math.sin(t * 0.4),
      pinch: pinchWave > 0.3 ? 1 : 0,
      roll: 0.35 * Math.sin(t * 0.7),
      aspect,
    }),
  );
  // "rhythm" (left side): open/close slowly, sliding root
  hands.push(
    syntheticHand({
      cx: 0.28 + 0.12 * Math.sin(t * 0.21 + 2),
      cy: 0.55 + 0.15 * Math.sin(t * 0.33),
      size: 0.16,
      open: 0.5 + 0.5 * Math.sin(t * 0.25) ** 2,
      pinch: 0,
      roll: -0.2 * Math.sin(t * 0.5),
      aspect,
    }),
  );
  return hands;
}
