// Pure geometry: 21 MediaPipe hand landmarks → a handful of musical control values.
// `aspect` = video width / height. Landmark x,y are normalized to the image, so x is
// scaled by `aspect` before any distance is measured to keep distances isotropic.
import { invLerp } from '../audio/theory.js';

export const LM = { WRIST: 0, THUMB_TIP: 4, INDEX_MCP: 5, INDEX_TIP: 8, MIDDLE_MCP: 9, MIDDLE_TIP: 12, RING_MCP: 13, RING_TIP: 16, PINKY_MCP: 17, PINKY_TIP: 20 };

const dist = (a, b, aspect) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);

/**
 * @param lm 21 landmarks {x,y,z} in image space (un-mirrored)
 * @param opts {aspect, mirror}  mirror=true flips x so the result matches a selfie view
 * @returns {x,y,size,pinch,open,roll,tips}
 *   x,y     palm centre, 0..1 (x mirrored if requested)
 *   size    wrist→middle-knuckle length as a fraction of image height (proxy for depth)
 *   pinch   0 (thumb far from index) … 1 (touching)
 *   open    0 (fist) … 1 (fingers spread straight)
 *   roll    -1 (fingers point left) … +1 (fingers point right); 0 = upright
 */
export function handFeatures(lm, { aspect = 16 / 9, mirror = true } = {}) {
  const palm = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];
  let cx = 0;
  let cy = 0;
  for (const i of palm) {
    cx += lm[i].x;
    cy += lm[i].y;
  }
  cx /= palm.length;
  cy /= palm.length;

  const size = dist(lm[LM.WRIST], lm[LM.MIDDLE_MCP], aspect) || 1e-6;

  const pinchRatio = dist(lm[LM.THUMB_TIP], lm[LM.INDEX_TIP], aspect) / size;
  const pinch = invLerp(1.0, 0.25, pinchRatio);

  const tips = [LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP, LM.PINKY_TIP];
  let reach = 0;
  for (const t of tips) reach += dist(lm[LM.WRIST], lm[t], aspect);
  const open = invLerp(1.05, 1.85, reach / tips.length / size);

  // angle of wrist→middle-knuckle from straight up, in isotropic space
  const dx = (lm[LM.MIDDLE_MCP].x - lm[LM.WRIST].x) * aspect * (mirror ? -1 : 1);
  const dy = lm[LM.WRIST].y - lm[LM.MIDDLE_MCP].y; // up is positive
  const roll = Math.max(-1, Math.min(1, Math.atan2(dx, dy) / (Math.PI / 2)));

  return { x: mirror ? 1 - cx : cx, y: cy, size, pinch, open, roll };
}
