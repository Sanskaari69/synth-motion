import './style.css';
import { AudioEngine } from './audio/engine.js';
import { SCALES, DEFAULT_SCALE, noteName, clamp01, invLerp } from './audio/theory.js';
import { PATTERNS, STEPS, activeLayers } from './audio/pattern.js';
import { HandTracker, openCamera, closeCamera } from './tracking/tracker.js';
import { handFeatures } from './tracking/features.js';
import { demoHands } from './tracking/demo.js';
import { Controller, assignRoles } from './tracking/controller.js';
import { Visuals } from './visuals/scene.js';
import { TouchBridge } from './net/bridge.js';

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);

// ───────────────────────────── settings (localStorage is best-effort) ─────────────────────────────
const KEY = 'synth-motion:v1';
const defaults = { scale: DEFAULT_SCALE, bpm: 118, volume: 80, auto: true, backdrop: true, bloom: true, quality: 'auto', td: false, tdUrl: 'ws://localhost:8787' };
const settings = { ...defaults };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(KEY) ?? '{}'));
} catch {
  /* private mode etc. */
}
// `?bridge=ws://…` is a convenience for local use. Only loopback targets are honoured from the URL, so a crafted
// link can't make someone's browser stream their hand data to an arbitrary host (typing a URL in the panel is fine).
const isLoopbackWs = (u) => {
  try {
    const { protocol, hostname } = new URL(u);
    return /^wss?:$/.test(protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
};
if (qs.get('bridge') && isLoopbackWs(qs.get('bridge'))) {
  settings.tdUrl = qs.get('bridge');
  settings.td = true;
}
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
};

// ───────────────────────────── core objects ─────────────────────────────
const audio = new AudioEngine();
const controller = new Controller({ leadDegrees: 15 });
const visuals = new Visuals($('stage'));
const video = $('cam');
const bridge = new TouchBridge({ url: settings.tdUrl });
let tracker = null;
let mode = 'idle'; // idle | camera | demo
let running = false;

const state = { fps: 0, hands: 0, lastFrame: performance.now(), demoT: 0, cached: [], trackerMs: 0 };
window.__synth = { audio, visuals, controller, bridge, state, get mode() { return mode; }, get tracker() { return tracker; } }; // handy for debugging / tests

// ───────────────────────────── UI wiring ─────────────────────────────
for (const name of Object.keys(SCALES)) $('ctl-scale').add(new Option(name, name));
$('ctl-scale').value = SCALES[settings.scale] ? settings.scale : DEFAULT_SCALE;
$('ctl-bpm').value = settings.bpm;
$('ctl-vol').value = settings.volume;
$('ctl-auto').checked = settings.auto;
$('ctl-backdrop').checked = settings.backdrop;
$('ctl-bloom').checked = settings.bloom;
$('ctl-quality').value = settings.quality;
$('ctl-td').checked = settings.td;
$('ctl-td-url').value = settings.tdUrl;
$('out-bpm').textContent = settings.bpm;
$('out-vol').textContent = settings.volume;

const stepEls = Array.from({ length: STEPS }, () => $('steps').appendChild(document.createElement('i')));

function applySettings() {
  audio.params.scale = $('ctl-scale').value;
  audio.set('bpm', Number(settings.bpm));
  audio.set('volume', Number(settings.volume) / 100);
  visuals.setBloomEnabled(settings.bloom);
  visuals.setBackdrop(video, settings.backdrop && mode === 'camera');
}
const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
on('ctl-scale', 'change', (e) => { settings.scale = e.target.value; audio.params.scale = e.target.value; save(); });
on('ctl-bpm', 'input', (e) => { settings.bpm = +e.target.value; $('out-bpm').textContent = e.target.value; audio.set('bpm', +e.target.value); save(); });
on('ctl-vol', 'input', (e) => { settings.volume = +e.target.value; $('out-vol').textContent = e.target.value; audio.set('volume', e.target.value / 100); save(); });
on('ctl-auto', 'change', (e) => { settings.auto = e.target.checked; save(); });
on('ctl-backdrop', 'change', (e) => { settings.backdrop = e.target.checked; visuals.setBackdrop(video, e.target.checked && mode === 'camera'); save(); });
on('ctl-bloom', 'change', (e) => { settings.bloom = e.target.checked; visuals.setBloomEnabled(e.target.checked); save(); });
on('ctl-quality', 'change', (e) => {
  settings.quality = e.target.value;
  if (e.target.value === 'auto') { visuals.locked = false; visuals._slow = 0; } else visuals.applyQuality(+e.target.value, true);
  save();
});
on('ctl-td', 'change', (e) => { settings.td = e.target.checked; bridge.setEnabled(e.target.checked); save(); });
on('ctl-td-url', 'change', (e) => { settings.tdUrl = e.target.value.trim(); bridge.setUrl(settings.tdUrl); save(); });
on('btn-panel', 'click', () => togglePanel());
on('btn-mute', 'click', () => toggleMute());
on('btn-source', 'click', () => toggleSource());
on('btn-full', 'click', () => toggleFullscreen());
on('btn-hide', 'click', () => toggleHud());

function togglePanel(force) {
  const closed = force ?? !$('panel').classList.contains('closed');
  $('panel').classList.toggle('closed', closed);
  $('btn-panel').setAttribute('aria-expanded', String(!closed));
}
function toggleMute() {
  audio.setMuted(!audio.muted);
  $('btn-mute').firstChild.textContent = audio.muted ? 'Unmute ' : 'Mute ';
}
function toggleHud() {
  $('hud').classList.toggle('faded');
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (!running) return;
  if (k === 'm') toggleMute();
  else if (k === 'd') toggleSource();
  else if (k === 'f') toggleFullscreen();
  else if (k === 'h') toggleHud();
  else if (k === 'p') togglePanel();
});
// background tabs throttle timers → the look-ahead scheduler would stutter; pause audio instead
document.addEventListener('visibilitychange', () => {
  if (!audio.ctx || !audio.started) return;
  if (document.hidden) audio.ctx.suspend();
  else if (!audio.muted) audio.ctx.resume();
});

bridge.onStatus = (s) => {
  const chip = $('chip-td');
  chip.textContent = { off: 'TD off', connecting: 'TD connecting…', connected: 'TD connected', error: 'TD unreachable' }[s];
  chip.className = 'chip' + (s === 'connected' ? ' ok' : s === 'error' ? ' warn' : '');
  $('td-state').textContent = { off: 'off', connecting: 'connecting…', connected: 'connected', error: 'not reachable — run npm run bridge' }[s];
};
// TouchDesigner → visuals: /synthmotion/control/<name> <value>
bridge.onControl = (name, v) => {
  if (name === 'hue') visuals.setHue(v);
  else if (name === 'bloom') visuals.setBloomBoost(Math.max(0, Math.min(3, v)));
  else if (name === 'pulse') visuals.beatPulse(Math.max(0, Math.min(2, v)));
};
bridge.onStatus('off');

// ───────────────────────────── sources ─────────────────────────────
function setMode(m) {
  mode = m;
  $('chip-mode').textContent = m === 'camera' ? 'camera' : m === 'demo' ? 'demo hands' : '—';
  $('btn-source').firstChild.textContent = m === 'camera' ? 'Use demo ' : 'Use camera ';
  visuals.setBackdrop(video, settings.backdrop && m === 'camera');
}

async function startCamera() {
  const msg = $('start-msg');
  msg.classList.remove('err');
  $('btn-cam').disabled = true;
  try {
    msg.textContent = 'Requesting camera…';
    await openCamera(video);
    msg.textContent = 'Loading hand-tracking model…';
    tracker ??= await new HandTracker().init((s) => (msg.textContent = s));
    state.cached = [];
    setMode('camera');
    return true;
  } catch (err) {
    console.error('[camera]', err);
    closeCamera(video);
    const denied = err?.name === 'NotAllowedError';
    msg.classList.add('err');
    msg.textContent = denied
      ? 'Camera permission was denied. Allow it in your browser, or try the demo.'
      : err?.name === 'NotFoundError'
        ? 'No camera found. Try the demo instead.'
        : `Could not start tracking: ${err?.message ?? err}`;
    return false;
  } finally {
    $('btn-cam').disabled = false;
  }
}

async function begin(source) {
  // audio must start inside the click handler (autoplay policy)
  const audioPromise = audio.start().catch((e) => console.warn('[audio]', e));
  let ok = true;
  if (source === 'camera') ok = await startCamera();
  else setMode('demo');
  if (!ok) return;
  await audioPromise;
  applySettings();
  bridge.setEnabled(settings.td);
  $('start').classList.add('gone');
  $('hud').hidden = false;
  if (matchMedia('(max-width: 720px)').matches) togglePanel(true);
  setTimeout(() => ($('start').hidden = true), 600);
  if (!running) {
    running = true;
    state.lastFrame = performance.now();
    requestAnimationFrame(frame);
  }
}
on('btn-cam', 'click', () => begin('camera'));
on('btn-demo', 'click', () => begin('demo'));

async function toggleSource() {
  if (mode === 'camera') {
    closeCamera(video);
    setMode('demo');
  } else {
    const ok = await startCamera().catch(() => false);
    if (!ok) setMode('demo');
  }
}

// ───────────────────────────── landmark plumbing ─────────────────────────────
/** raw MediaPipe (un-mirrored, video-space) → mirrored screen-space via a "contain" fit. */
function toScreen(lm, va, sa) {
  return lm.map((p) => {
    let x = 1 - p.x;
    let y = p.y;
    if (va > sa) y = 0.5 + (y - 0.5) * (sa / va);
    else x = 0.5 + (x - 0.5) * (va / sa);
    return { x, y, z: p.z };
  });
}

// ───────────────────────────── main loop ─────────────────────────────
const last = { lead: null, rhythm: null };
let fpsAcc = 0;
let fpsN = 0;
let uiTick = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const realDt = (now - state.lastFrame) / 1000;
  const dt = Math.min(realDt, 0.1); // clamp for simulation; fps below uses the real frame time
  state.lastFrame = now;
  const sa = innerWidth / innerHeight;

  // 1) hands → screen-space landmark sets
  let sets = [];
  if (mode === 'camera') {
    const t0 = performance.now();
    const raw = tracker ? tracker.detect(video, now) : [];
    state.trackerMs += (performance.now() - t0 - state.trackerMs) * 0.1;
    const va = video.videoWidth ? video.videoWidth / video.videoHeight : 16 / 9;
    sets = raw.map((lm) => toScreen(lm, va, sa));
  } else if (mode === 'demo') {
    state.demoT += dt;
    sets = demoHands(state.demoT, sa);
  }
  const feats = sets.map((lm) => ({ ...handFeatures(lm, { aspect: sa, mirror: false }), lm }));
  state.hands = feats.length;

  // 2) controls → audio
  const roles = assignRoles(feats);
  const ctl = controller.update(feats, dt);
  audio.control({ lead: ctl.lead, rhythm: ctl.rhythm, autoBeat: settings.auto });
  const meters = audio.updateMeters();

  // 3) audio events → visuals
  const L = activeLayers(audio.params.intensity);
  for (const s of audio.popSteps()) {
    stepEls.forEach((el, i) => el.classList.toggle('now', i === s.step));
    if (L.kick && PATTERNS.kick[s.step]) {
      visuals.hit('rhythm', 0.9);
      visuals.beatPulse(0.9);
      visuals.rippleAt('rhythm', 2.6, 0.9);
    } else if (L.clap && PATTERNS.clap[s.step]) visuals.beatPulse(0.5);
  }
  if (audio.takeLeadOnset()) {
    visuals.hit('lead', 1);
    visuals.rippleAt('lead', 2.2, 1.0);
  }

  // 4) render
  for (const role of ['lead', 'rhythm']) if (roles[role]) last[role] = { lm: roles[role].lm, f: roles[role] };
  visuals.update(dt, {
    hands: { lead: last.lead, rhythm: last.rhythm },
    weights: { lead: ctl.lead.weight, rhythm: ctl.rhythm.weight },
    audio: meters,
  });

  // 5) TouchDesigner
  if (bridge.status === 'connected') {
    const hands = [];
    for (const role of ['lead', 'rhythm']) {
      const c = ctl[role];
      if (c.present) hands.push({ role, x: c.x, y: 1 - c.y, z: clamp01(invLerp(0.05, 0.3, c.size)), pinch: c.pinch, open: c.open, roll: c.roll });
    }
    bridge.send({
      hands,
      audio: { level: meters.level, bass: meters.bass, mid: meters.mid, high: meters.high },
      note: { midi: audio.lead.midi, gate: ctl.lead.gate },
      step: audio.currentStep,
      bpm: audio.params.bpm,
      intensity: audio.params.intensity,
    });
  }

  // 6) HUD (throttled)
  fpsAcc += realDt;
  fpsN++;
  uiTick += dt;
  if (uiTick > 0.25) {
    uiTick = 0;
    state.fps = Math.round(fpsN / fpsAcc);
    fpsAcc = fpsN = 0;
    $('chip-fps').textContent = `${state.fps} fps · ${visuals.qualityName}`;
    $('chip-fps').className = 'chip' + (state.fps < 30 ? ' warn' : '');
    $('chip-hands').textContent = `${state.hands} hand${state.hands === 1 ? '' : 's'}`;
    $('chip-hands').className = 'chip' + (state.hands ? ' ok' : '');
  }
  const noteEl = $('note');
  noteEl.textContent = ctl.lead.present ? noteName(audio.lead.midi) : '—';
  noteEl.classList.toggle('on', ctl.lead.gate);
  $('m-bass').style.transform = `scaleY(${Math.max(0.05, meters.bass)})`;
  $('m-mid').style.transform = `scaleY(${Math.max(0.05, Math.min(1, meters.mid * 2))})`;
  $('m-high').style.transform = `scaleY(${Math.max(0.05, Math.min(1, meters.high * 4))})`;
}

visuals.onQuality = (name) => {
  if (settings.quality === 'auto') $('ctl-quality').value = 'auto';
  console.info('[visuals] quality →', name);
};
