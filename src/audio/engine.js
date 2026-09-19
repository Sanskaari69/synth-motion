// Web Audio music engine.
//
//   lead  : 2 detuned saws + sub-ish square → resonant low-pass → VCA → dry / delay / reverb
//   drums : kick, closed + open hat, clap  (all synthesized, no samples)
//   bass  : saw + sine sub through an enveloped low-pass
//   arp   : triangle plucks on the chord tones
// The rhythm section is a 16-step look-ahead sequencer (scheduled ~120 ms ahead on the audio clock,
// so it stays tight even when the main thread hitches). Layers fade in with `intensity`.
import { midiToHz, degreeToMidi, DEFAULT_SCALE, clamp01, lerp } from './theory.js';
import { PATTERNS, STEPS, activeLayers, stepSeconds, bassMidi, arpNote } from './pattern.js';

const LOOKAHEAD = 0.12; // seconds scheduled ahead
const TICK_MS = 25;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.started = false;
    this.muted = false;
    this.params = {
      bpm: 118,
      scale: DEFAULT_SCALE,
      volume: 0.8,
      rootMidi: 57, // A3 — lead & bass are relative to this
      intensity: 0.6, // 0..1, drives which layers are audible
      space: 0.3, // 0..1, delay/reverb send
      bassCutoff: 0.5, // 0..1
    };
    this.lead = { gate: false, degree: 0, midi: 57, cutoff: 0.5, vibrato: 0, active: false };
    this.stepQueue = []; // {time, step} drained by consumers via popSteps()
    this.currentStep = 0;
    this.bar = 0;
    this._nextTime = 0;
    this._step = 0;
    this._timer = null;
    this._freq = new Uint8Array(256);
    this._time = new Uint8Array(512);
    this.meters = { level: 0, bass: 0, mid: 0, high: 0 };
  }

  async start() {
    if (!this.ctx) this._build();
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (!this.started) {
      this.started = true;
      this._nextTime = this.ctx.currentTime + 0.08;
      this._step = 0;
      this._timer = setInterval(() => this._schedule(), TICK_MS);
    }
    return this.ctx.state;
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
    this.started = false;
    this.ctx?.suspend();
  }

  // ───────────────────────────── graph ─────────────────────────────
  _build() {
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' }));

    this.master = ctx.createGain();
    this.master.gain.value = this.params.volume;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.ratio.value = 4;
    this.comp.attack.value = 0.005;
    this.comp.release.value = 0.16;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.6;
    this.master.connect(this.comp).connect(this.analyser).connect(ctx.destination);

    // effects: feedback delay (ping-ish, filtered) + generated-IR reverb
    this.delay = ctx.createDelay(2);
    this.delay.delayTime.value = (60 / this.params.bpm) * 0.75;
    const fb = ctx.createGain();
    fb.gain.value = 0.42;
    const fbLp = ctx.createBiquadFilter();
    fbLp.type = 'lowpass';
    fbLp.frequency.value = 2600;
    this.delay.connect(fbLp).connect(fb).connect(this.delay);
    this.delayReturn = ctx.createGain();
    this.delayReturn.gain.value = 0.5;
    this.delay.connect(this.delayReturn).connect(this.master);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(2.4, 3);
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 0.55;
    this.reverb.connect(this.reverbReturn).connect(this.master);

    this.delaySend = ctx.createGain(); // lead → delay
    this.reverbSend = ctx.createGain();
    this.delaySend.connect(this.delay);
    this.reverbSend.connect(this.reverb);

    this.rhythmBus = ctx.createGain();
    this.rhythmBus.gain.value = 0.9;
    this.rhythmBus.connect(this.master);
    this.rhythmBus.connect(this.reverbSend);

    // shared white-noise buffer for hats / claps
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    this._buildLead();
  }

  _impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  _buildLead() {
    const ctx = this.ctx;
    const mk = (type, detune) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = detune;
      o.start();
      return o;
    };
    this.oscA = mk('sawtooth', -9);
    this.oscB = mk('sawtooth', 9);
    this.oscC = mk('square', 0);
    const gA = ctx.createGain();
    const gB = ctx.createGain();
    const gC = ctx.createGain();
    gA.gain.value = 0.32;
    gB.gain.value = 0.32;
    gC.gain.value = 0.16;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 7;
    this.filter.frequency.value = 1200;
    this.vca = ctx.createGain();
    this.vca.gain.value = 0;
    this.oscA.connect(gA).connect(this.filter);
    this.oscB.connect(gB).connect(this.filter);
    this.oscC.frequency.value = 220;
    this.oscC.connect(gC).connect(this.filter);
    this.filter.connect(this.vca);
    this.vca.connect(this.master);
    this.vca.connect(this.delaySend);
    this.vca.connect(this.reverbSend);
    this.delaySend.gain.value = 0.3;
    this.reverbSend.gain.value = 0.3;

    // vibrato LFO → detune of all lead oscillators
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = 5.5;
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = 0;
    this.lfo.connect(this.lfoGain);
    for (const o of [this.oscA, this.oscB, this.oscC]) this.lfoGain.connect(o.detune);
    this.lfo.start();
  }

  // ───────────────────────────── controls ─────────────────────────────
  set(name, value) {
    this.params[name] = value;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (name === 'volume') this.master.gain.setTargetAtTime(this.muted ? 0 : value, t, 0.03);
    if (name === 'bpm') this.delay.delayTime.setTargetAtTime((60 / value) * 0.75, t, 0.1);
  }

  setMuted(m) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.params.volume, this.ctx.currentTime, 0.03);
  }

  /**
   * Called every frame with the controller output.
   * lead:  {present, gate, degree, y, roll, open}    rhythm: {present, x, y, open}
   */
  control({ lead, rhythm, autoBeat }) {
    if (!this.ctx || !this.started) return;
    const t = this.ctx.currentTime;
    const p = this.params;

    // ── lead voice
    const gate = lead.present && lead.gate;
    const midi = degreeToMidi(lead.degree < 0 ? 0 : lead.degree, p.scale, p.rootMidi);
    this.lead.midi = midi;
    this.lead.degree = lead.degree;
    const hz = midiToHz(midi);
    // portamento: quicker when attacking a fresh note, gliding between notes while held
    const glide = gate && this.lead.gate ? 0.035 : 0.004;
    for (const o of [this.oscA, this.oscB]) o.frequency.setTargetAtTime(hz, t, glide);
    this.oscC.frequency.setTargetAtTime(hz / 2, t, glide);

    // y (up = bright) → cutoff 250 Hz … 9 kHz, openness opens it a bit further
    const bright = clamp01(1 - lead.y + lead.open * 0.15);
    const cutoff = 250 * Math.pow(36, bright);
    this.filter.frequency.setTargetAtTime(cutoff, t, 0.03);
    this.lead.cutoff = bright;
    // roll → vibrato depth (cents)
    const vib = Math.abs(lead.roll) > 0.12 ? (Math.abs(lead.roll) - 0.12) * 90 : 0;
    this.lfoGain.gain.setTargetAtTime(vib, t, 0.06);
    this.lead.vibrato = vib;

    if (gate && !this.lead.gate) {
      this.vca.gain.cancelScheduledValues(t);
      this.vca.gain.setTargetAtTime(0.55, t, 0.012); // attack
      this.lead.onset = true;
    } else if (!gate && this.lead.gate) {
      this.vca.gain.cancelScheduledValues(t);
      this.vca.gain.setTargetAtTime(0, t, 0.14); // release
    }
    this.lead.gate = gate;
    this.lead.active = gate;

    // ── rhythm section conducted by the other hand (or automatic)
    if (rhythm.present) {
      p.intensity = rhythm.open;
      // x → key (12 semitones from A2), quantized
      const key = Math.min(11, Math.floor(clamp01(rhythm.x) * 12));
      p.rootMidi = 45 + key + 12; // A3 + key, wraps in an octave
      p.space = clamp01(1 - rhythm.y);
      p.bassCutoff = clamp01(1 - rhythm.y);
    } else {
      p.intensity += ((autoBeat ? 0.62 : 0) - p.intensity) * 0.05;
      p.space += (0.3 - p.space) * 0.05;
      p.bassCutoff += (0.5 - p.bassCutoff) * 0.05;
    }
    this.delaySend.gain.setTargetAtTime(0.15 + p.space * 0.55, t, 0.08);
    this.reverbSend.gain.setTargetAtTime(0.15 + p.space * 0.5, t, 0.08);
  }

  /** Drain step events that have reached the audio clock (for visuals / OSC). */
  popSteps() {
    if (!this.ctx) return [];
    const now = this.ctx.currentTime;
    const out = [];
    while (this.stepQueue.length && this.stepQueue[0].time <= now) out.push(this.stepQueue.shift());
    if (out.length) this.currentStep = out[out.length - 1].step;
    return out;
  }

  /** Consume the "note just started" edge (used to spawn visuals). */
  takeLeadOnset() {
    const o = !!this.lead.onset;
    this.lead.onset = false;
    return o;
  }

  updateMeters() {
    if (!this.ctx || !this.started) return this.meters;
    this.analyser.getByteFrequencyData(this._freq);
    this.analyser.getByteTimeDomainData(this._time);
    const avg = (a, b) => {
      let s = 0;
      for (let i = a; i < b; i++) s += this._freq[i];
      return s / ((b - a) * 255);
    };
    // 512-pt FFT @ 48 kHz ≈ 94 Hz per bin: 0–4 ≈ <400 Hz, 4–24 ≈ mids, 24–128 ≈ highs
    const target = { bass: avg(0, 4), mid: avg(4, 24), high: avg(24, 128) };
    let rms = 0;
    for (let i = 0; i < this._time.length; i++) {
      const v = (this._time[i] - 128) / 128;
      rms += v * v;
    }
    target.level = Math.sqrt(rms / this._time.length) * 2.2;
    for (const k of Object.keys(target)) this.meters[k] += (clamp01(target[k]) - this.meters[k]) * 0.5;
    return this.meters;
  }

  // ───────────────────────────── sequencer ─────────────────────────────
  _schedule() {
    if (!this.started) return;
    const now = this.ctx.currentTime;
    if (this._nextTime < now - 0.25) this._nextTime = now + 0.02; // tab was throttled: resync, don't burst
    while (this._nextTime < now + LOOKAHEAD) {
      this._playStep(this._step, this._nextTime);
      this.stepQueue.push({ time: this._nextTime, step: this._step, bar: this.bar });
      if (this.stepQueue.length > 64) this.stepQueue.shift();
      this._nextTime += stepSeconds(this.params.bpm);
      this._step = (this._step + 1) % STEPS;
      if (this._step === 0) this.bar++;
    }
  }

  _playStep(step, time) {
    const L = activeLayers(this.params.intensity);
    const hit = (name) => (L[name] ? PATTERNS[name][step] : 0);
    const k = hit('kick');
    if (k) this._kick(time, k === 2 ? 1 : 0.8);
    if (hit('hat')) this._hat(time, false);
    if (hit('openHat')) this._hat(time, true);
    if (hit('clap')) this._clap(time);
    const bassRoot = bassMidi(this.bar, this.params.rootMidi - 24, this.params.scale);
    const b = hit('bass');
    if (b) this._bass(time, bassRoot, b === 2);
    if (hit('arp')) this._arp(time, arpNote(step, bassRoot, this.params.scale), step);
  }

  _env(node, time, peak, attack, decay) {
    node.gain.cancelScheduledValues(time);
    node.gain.setValueAtTime(0.0001, time);
    node.gain.linearRampToValueAtTime(peak, time + attack);
    node.gain.exponentialRampToValueAtTime(0.0001, time + attack + decay);
  }

  _kick(time, vel) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, time);
    o.frequency.exponentialRampToValueAtTime(42, time + 0.13);
    this._env(g, time, 1.0 * vel, 0.002, 0.34);
    o.connect(g).connect(this.rhythmBus);
    o.start(time);
    o.stop(time + 0.4);
    // click
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const ng = ctx.createGain();
    this._env(ng, time, 0.25 * vel, 0.001, 0.012);
    n.connect(ng).connect(this.rhythmBus);
    n.start(time, Math.random() * 0.5);
    n.stop(time + 0.03);
  }

  _hat(time, open) {
    const ctx = this.ctx;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7200;
    const g = ctx.createGain();
    this._env(g, time, open ? 0.22 : 0.16, 0.001, open ? 0.22 : 0.045);
    n.connect(hp).connect(g).connect(this.rhythmBus);
    n.start(time, Math.random() * 0.5);
    n.stop(time + (open ? 0.3 : 0.08));
  }

  _clap(time) {
    const ctx = this.ctx;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1500;
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    for (let i = 0; i < 3; i++) {
      const t = time + i * 0.011;
      g.gain.linearRampToValueAtTime(0.5, t + 0.001);
      g.gain.exponentialRampToValueAtTime(0.05, t + 0.010);
    }
    g.gain.linearRampToValueAtTime(0.45, time + 0.034);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.24);
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.connect(bp).connect(g).connect(this.rhythmBus);
    n.start(time, Math.random() * 0.5);
    n.stop(time + 0.3);
  }

  _bass(time, midi, accent) {
    const ctx = this.ctx;
    const hz = midiToHz(midi);
    const o = ctx.createOscillator();
    const sub = ctx.createOscillator();
    o.type = 'sawtooth';
    sub.type = 'sine';
    o.frequency.value = hz;
    sub.frequency.value = hz;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 6;
    const top = lerp(300, 2200, this.params.bassCutoff) * (accent ? 1.3 : 1);
    f.frequency.setValueAtTime(top, time);
    f.frequency.exponentialRampToValueAtTime(90, time + 0.22);
    const g = ctx.createGain();
    this._env(g, time, accent ? 0.5 : 0.36, 0.006, 0.26);
    const sg = ctx.createGain();
    sg.gain.value = 0.7;
    o.connect(f);
    sub.connect(sg).connect(g);
    f.connect(g);
    g.connect(this.rhythmBus);
    o.start(time);
    sub.start(time);
    o.stop(time + 0.4);
    sub.stop(time + 0.4);
  }

  _arp(time, midi, step) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = midiToHz(midi);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 3200;
    const g = ctx.createGain();
    this._env(g, time, step % 4 === 0 ? 0.16 : 0.1, 0.003, 0.12);
    o.connect(f).connect(g);
    g.connect(this.rhythmBus);
    g.connect(this.delaySend);
    o.start(time);
    o.stop(time + 0.2);
  }
}
