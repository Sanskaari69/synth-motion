// Turns raw hand features into stable musical controls.
//   • the right-hand side of the display plays the LEAD (pinch = note on, x = pitch, y = filter, roll = vibrato)
//   • the left-hand side conducts the RHYTHM section (openness = intensity, x = key, y = space/bass filter)
//   • a single hand always plays the lead
// Adds presence hold (survives ~150 ms of detector dropouts), smoothing and gate hysteresis.
import { clamp01, quantizeIndex } from '../audio/theory.js';

const HOLD = 0.15;
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);

/** 2 hands → left of the display conducts the rhythm, right plays the lead; 1 hand → lead. */
export function assignRoles(feats) {
  const sorted = [...feats].sort((a, b) => a.x - b.x);
  if (sorted.length >= 2) return { rhythm: sorted[0], lead: sorted[sorted.length - 1] };
  if (sorted.length === 1) return { lead: sorted[0], rhythm: null };
  return { lead: null, rhythm: null };
}

const blank = () => ({ present: false, weight: 0, x: 0.5, y: 0.5, size: 0.1, pinch: 0, open: 0, roll: 0, gate: false, degree: -1 });

export class Controller {
  constructor({ leadDegrees = 15 } = {}) {
    this.leadDegrees = leadDegrees;
    this.lead = blank();
    this.rhythm = blank();
    this._lastSeen = { lead: -Infinity, rhythm: -Infinity };
    this.time = 0;
  }

  /** @param feats array of handFeatures results (0–2 entries) */
  update(feats, dt) {
    this.time += dt;
    const { lead: leadRaw, rhythm: rhythmRaw } = assignRoles(feats);
    this._track('lead', leadRaw, dt);
    this._track('rhythm', rhythmRaw, dt);
    return { lead: this.lead, rhythm: this.rhythm };
  }

  _track(role, raw, dt) {
    const s = this[role];
    if (raw) {
      this._lastSeen[role] = this.time;
      const first = !s.present && s.weight < 0.01;
      const k = first ? 1 : ease(20, dt);
      s.x += (raw.x - s.x) * k;
      s.y += (raw.y - s.y) * k;
      s.size += (raw.size - s.size) * k;
      s.open += (raw.open - s.open) * (first ? 1 : ease(14, dt));
      s.roll += (raw.roll - s.roll) * (first ? 1 : ease(14, dt));
      s.pinch += (raw.pinch - s.pinch) * (first ? 1 : ease(30, dt)); // fast — it triggers notes
      s.present = true;
    } else if (this.time - this._lastSeen[role] > HOLD) {
      s.present = false;
    }
    s.weight += ((s.present ? 1 : 0) - s.weight) * ease(s.present ? 12 : 6, dt);
    if (s.weight < 0.005 && !s.present) s.weight = 0;

    if (role === 'lead') {
      if (!s.present) s.gate = false;
      else if (!s.gate && s.pinch > 0.65) s.gate = true;
      else if (s.gate && s.pinch < 0.35) s.gate = false;
      // x is already mirrored; map the middle 80% of the screen onto the keyboard
      const kx = clamp01((s.x - 0.1) / 0.8);
      s.degree = quantizeIndex(kx, this.leadDegrees, s.degree, 0.2);
    }
  }
}
