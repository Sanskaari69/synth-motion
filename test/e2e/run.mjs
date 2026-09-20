// End-to-end tests in real headless Chrome (uses the installed Google Chrome via playwright-core).
//   npm run test:e2e            (starts its own Vite dev server and TouchDesigner bridge)
// Scenarios: demo mode + UI wiring, OSC bridge → UDP, and the *real* MediaPipe tracker on a still
// hand photo streamed through a fake getUserMedia. The photo is downloaded on first run (needs network).
import { chromium } from 'playwright-core';
import { createServer, build } from 'vite';
import dgram from 'node:dgram';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridge } from '../../server/bridge.mjs';
import { decode } from '../../server/osc.mjs';
import { serveDir } from './static-server.mjs';

const PHOTO_URL = 'https://storage.googleapis.com/mediapipe-tasks/hand_landmarker/woman_hands.jpg';
const results = [];
const check = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};

const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: 'error' });
await server.listen();
const DEV_URL = 'http://localhost:5199/';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });

async function open(viewport = { width: 1280, height: 720 }) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/WebSocket connection/.test(m.text()) && errors.push(m.text()));
  return { page, errors };
}

// ───────────── 1. demo mode + UI ─────────────
{
  console.log('\n# demo mode + UI');
  const { page, errors } = await open();
  const requested = [];
  page.on('request', (r) => requested.push(r.url()));
  await page.goto(DEV_URL);
  check('start overlay shown, HUD hidden', (await page.isVisible('#start')) && !(await page.isVisible('#hud')));
  await page.click('#btn-demo');
  await page.waitForTimeout(3000);
  check('overlay dismissed, HUD shown', !(await page.isVisible('#start')) && (await page.isVisible('#hud')));
  const S = () =>
    page.evaluate(() => {
      const s = window.__synth;
      return { params: { ...s.audio.params }, muted: s.audio.muted, gain: s.audio.master.gain.value, ctx: s.audio.ctx.state, level: s.audio.meters.level, step: s.audio.currentStep, hands: s.state.hands, fps: s.state.fps, mode: s.mode, quality: s.visuals.qualityName, locked: s.visuals.locked, bloom: s.visuals.bloom.enabled, faded: document.getElementById('hud').classList.contains('faded'), panelClosed: document.getElementById('panel').classList.contains('closed'), lead: s.controller.lead.present, rhythm: s.controller.rhythm.present };
    });
  let s = await S();
  check('AudioContext running and producing signal', s.ctx === 'running' && s.level > 0.01, `level=${s.level.toFixed(3)}`);
  const steps = await page.evaluate(async () => {
    const seen = new Set();
    const t0 = performance.now();
    while (performance.now() - t0 < 1500) {
      seen.add(window.__synth.audio.currentStep);
      await new Promise((r) => setTimeout(r, 20));
    }
    return [...seen];
  });
  check('sequencer advances through steps (1.5 s @ 118 bpm ≈ 11 sixteenths)', steps.length >= 6, `saw ${steps.length} distinct steps`);
  check('demo hands drive both roles', s.hands === 2 && s.lead && s.rhythm);
  check('renders at a usable frame rate', s.fps >= 25, `fps=${s.fps} (${s.quality})`);
  await page.selectOption('#ctl-scale', 'Dorian');
  await page.fill('#ctl-bpm', '140');
  await page.fill('#ctl-vol', '30');
  await page.waitForTimeout(300);
  s = await S();
  check('scale / tempo / volume controls reach the engine', s.params.scale === 'Dorian' && s.params.bpm === 140 && Math.abs(s.gain - 0.3) < 0.02);
  await page.click('#btn-mute');
  await page.waitForTimeout(400);
  check('mute silences master gain', (await S()).gain < 0.01);
  await page.keyboard.press('m');
  await page.waitForTimeout(400);
  check('M key unmutes', !(await S()).muted);
  await page.keyboard.press('h');
  check('H key hides HUD', (await S()).faded);
  await page.keyboard.press('h');
  await page.click('#btn-panel');
  check('panel button collapses panel', (await S()).panelClosed);
  await page.keyboard.press('p');
  await page.selectOption('#ctl-quality', '2');
  s = await S();
  check('quality → low pins governor and disables bloom', s.quality === 'low' && s.locked && !s.bloom);
  await page.selectOption('#ctl-quality', 'auto');
  // auto-beat: with no rhythm hand, intensity should climb to a groove (auto on) or fall to silence (auto off)
  const auto = await page.evaluate(async () => {
    const { audio } = window.__synth;
    const none = { present: false, x: 0.5, y: 0.5, open: 0 };
    const lead = { present: false, gate: false, degree: 0, y: 0.5, roll: 0, open: 0 };
    audio.params.intensity = 0.2;
    for (let i = 0; i < 200; i++) audio.control({ lead, rhythm: none, autoBeat: true });
    const on = audio.params.intensity;
    for (let i = 0; i < 400; i++) audio.control({ lead, rhythm: none, autoBeat: false });
    return { on, off: audio.params.intensity };
  });
  check('auto-beat raises intensity, off lowers it', auto.on > 0.5 && auto.off < 0.05, `on=${auto.on.toFixed(2)} off=${auto.off.toFixed(2)}`);
  check('settings persisted', await page.evaluate(() => JSON.parse(localStorage.getItem('synth-motion:v1')).scale === 'Dorian'));
  await page.fill('#ctl-td-url', 'ws://localhost:1'); // a port nothing listens on, whatever else is running on this machine
  await page.press('#ctl-td-url', 'Enter');
  await page.check('#ctl-td');
  await page.waitForTimeout(1200);
  const tdChip = await page.textContent('#chip-td');
  const tdCtx = (await S()).ctx;
  check('TD toggle without a bridge → warns, app survives', /unreachable|connecting/.test(tdChip) && tdCtx === 'running', `chip="${tdChip}", audio=${tdCtx}`);
  await page.uncheck('#ctl-td');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  check('mobile viewport: no horizontal overflow', !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)));
  await page.reload();
  check('reload restores saved scale', (await page.inputValue('#ctl-scale')) === 'Dorian');
  check('demo mode never downloads the MediaPipe bundle', !requested.some((u) => /tasks-vision|vision_bundle|hand_landmarker/.test(u)), requested.filter((u) => /vision|landmarker/.test(u)).join(', '));
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}

// ───────────── 1b. camera permission denied ─────────────
{
  console.log('\n# camera permission denied');
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const uncaught = [];
  page.on('pageerror', (e) => uncaught.push(e.message));
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
  });
  await page.goto(DEV_URL);
  await page.click('#btn-cam');
  await page.waitForTimeout(600);
  const msg = (await page.textContent('#start-msg').catch(() => '')) ?? '';
  check('denied camera shows a clear, actionable message', /permission was denied/i.test(msg), msg.trim().slice(0, 60));
  check('app stays on the start screen with buttons re-enabled', (await page.isVisible('#start')) && !(await page.isDisabled('#btn-cam')));
  await page.click('#btn-demo');
  await page.waitForTimeout(1500);
  check('demo still starts after a denied camera', (await page.evaluate(() => window.__synth.mode)) === 'demo' && (await page.isVisible('#hud')));
  check('no uncaught exceptions', uncaught.length === 0, uncaught.slice(0, 2).join(' | '));
  await page.close();
}

// ───────────── 2. TouchDesigner bridge ─────────────
{
  console.log('\n# TouchDesigner bridge (browser → WebSocket → OSC/UDP, and back)');
  const oscPort = 17000;
  const bridge = startBridge({ wsPort: 18787, oscPort, oscInPort: 17001, log: () => {} });
  await bridge.ready;
  const td = dgram.createSocket('udp4');
  const got = [];
  td.on('message', (b) => got.push(...decode(b)));
  await new Promise((r) => td.bind(oscPort, '127.0.0.1', r));
  const { page, errors } = await open();
  await page.goto(`${DEV_URL}?bridge=ws://localhost:18787`);
  await page.click('#btn-demo');
  await page.waitForTimeout(4000);
  check('page reports TD connected', (await page.textContent('#chip-td')) === 'TD connected');
  const addrs = new Set(got.map((m) => m.address));
  check('24+ OSC addresses arrive over UDP', addrs.size >= 24, `${addrs.size} addresses`);
  const leadX = got.filter((m) => m.address === '/synthmotion/lead/x').map((m) => m.args[0]);
  check('lead/x is a valid 0..1 float', leadX.length > 10 && leadX.every((v) => v >= 0 && v <= 1), `${leadX.length} samples`);
  check('send rate ≈ 30 Hz', bridge.stats.framesIn > 60 && bridge.stats.framesIn < 200, `${bridge.stats.framesIn} frames in ~4 s`);
  // TD → browser: hue control
  const c = dgram.createSocket('udp4');
  const { encodeMessage } = await import('../../server/osc.mjs');
  c.send(encodeMessage('/synthmotion/control/hue', [0.37]), 17001, '127.0.0.1');
  await page.waitForTimeout(500);
  check('OSC /control/hue from TD reaches visuals', Math.abs(await page.evaluate(() => window.__synth.visuals.hue) - 0.37) < 1e-4);
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  c.close(); td.close(); await page.close(); await bridge.close();
}

// ───────────── 3. real MediaPipe tracker on a real photo ─────────────
{
  console.log('\n# camera path: MediaPipe on a still photo of two hands');
  const cache = join(tmpdir(), 'synth-motion-e2e');
  const file = join(cache, 'hands.jpg');
  let photo = null;
  try {
    if (!existsSync(file)) {
      mkdirSync(cache, { recursive: true });
      const res = await fetch(PHOTO_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    }
    photo = readFileSync(file).toString('base64');
  } catch (e) {
    console.log(`SKIP  could not fetch the sample photo (${e.message})`);
  }
  if (photo) {
    const { page, errors } = await open();
    await page.addInitScript((b64) => {
      navigator.mediaDevices.getUserMedia = async () => {
        const img = new Image();
        img.src = `data:image/jpeg;base64,${b64}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const g = c.getContext('2d');
        setInterval(() => g.drawImage(img, 0, 0), 33);
        return c.captureStream(30);
      };
    }, photo);
    await page.goto(DEV_URL);
    await page.click('#btn-cam');
    await page.waitForFunction(() => window.__synth.state.hands >= 2, null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const r = await page.evaluate(() => { const s = window.__synth; return { mode: s.mode, hands: s.state.hands, delegate: s.tracker?.delegate, source: s.tracker?.source, lead: s.controller.lead.present, rhythm: s.controller.rhythm.present, ms: s.state.trackerMs, fps: s.state.fps, level: s.audio.meters.level }; });
    check('camera mode active, model loaded locally', r.mode === 'camera' && r.source === 'local', `delegate=${r.delegate}`);
    check('MediaPipe finds both hands in the photo', r.hands === 2 && r.lead && r.rhythm);
    check('detection is real-time on this machine', r.ms < 60 && r.fps >= 15, `${r.ms.toFixed(0)} ms/detect, ${r.fps} fps`);
    check('tracked hands produce sound', r.level > 0.01);
    check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.close();
  }
}

// ───────────── 4. production build, served the way Vercel serves it ─────────────
{
  console.log('\n# production build + vercel.json (headers, MediaPipe assets, real getUserMedia)');
  const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  const out = join(tmpdir(), 'synth-motion-dist');
  rmSync(out, { recursive: true, force: true });
  await build({ logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
  const site = await serveDir(out, vercel);
  const head = async (p) => { const r = await fetch(site.url + p, { method: 'HEAD' }); return { status: r.status, h: r.headers }; };

  const doc = await head('');
  check('vercel.json: camera allowed by Permissions-Policy', /camera=\(self\)/.test(doc.h.get('permissions-policy') ?? ''), doc.h.get('permissions-policy'));
  check('vercel.json: security headers present', doc.h.get('x-content-type-options') === 'nosniff' && !!doc.h.get('referrer-policy'));
  const model = await head('mediapipe/models/hand_landmarker.task');
  const wasm = await head('mediapipe/wasm/vision_wasm_internal.wasm');
  check('hand model is in the build and revalidates (not cached forever)', model.status === 200 && Number(model.h.get('content-length')) > 1e6 && /must-revalidate/.test(model.h.get('cache-control') ?? ''), `${(Number(model.h.get('content-length')) / 1e6).toFixed(1)} MB`);
  check('wasm is served as application/wasm', wasm.status === 200 && wasm.h.get('content-type') === 'application/wasm', `${(Number(wasm.h.get('content-length')) / 1e6).toFixed(1)} MB`);
  const html = await (await fetch(site.url)).text();
  const asset = /\/assets\/[^"']+\.js/.exec(html)?.[0];
  check('hashed JS assets are cached immutably', !!asset && /immutable/.test((await head(asset.slice(1))).h.get('cache-control') ?? ''), asset);
  const largest = Math.max(Number(model.h.get('content-length')), Number(wasm.h.get('content-length')));
  check('largest asset is far below Vercel per-file limits', largest < 50e6, `${(largest / 1e6).toFixed(1)} MB`);
  check('unknown path is a real 404 (so the model-exists probe can fall back)', (await head('mediapipe/models/nope.task')).status === 404);

  // Fake *device* (real getUserMedia through Chrome, real <video>) - proves the Permissions-Policy doesn't block the camera
  const fakeCam = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const runCam = async (label, base, allow404 = false) => {
    const page = await fakeCam.newPage({ viewport: { width: 1280, height: 720 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !(allow404 && /404/.test(m.text())) && errs.push(m.text())); // the model-exists probe 404s by design when files are absent
    await page.goto(base);
    await page.click('#btn-cam');
    await page.waitForFunction(() => window.__synth?.mode === 'camera', null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const r = await page.evaluate(() => { const s = window.__synth, v = document.getElementById('cam'); return { mode: s.mode, source: s.tracker?.source, delegate: s.tracker?.delegate, vw: v.videoWidth, hands: s.state.hands, fps: s.state.fps, msg: document.getElementById('start-msg').textContent }; });
    check(`${label}: real camera stream opens and tracker loads`, r.mode === 'camera' && r.vw > 0, `${r.vw}px video, source=${r.source}, delegate=${r.delegate}${r.mode !== 'camera' ? ', msg=' + r.msg : ''}`);
    check(`${label}: no page errors (0 hands expected from the test pattern)`, errs.length === 0 && r.hands === 0, errs.slice(0, 2).join(' | '));
    await page.close();
    return r;
  };
  const prod = await runCam('prod build', site.url);
  check('prod build loads MediaPipe from its own /mediapipe files', prod.source === 'local');

  // Simulate a failed postinstall download: same build without /mediapipe
  const noAssets = join(tmpdir(), 'synth-motion-dist-no-mediapipe');
  rmSync(noAssets, { recursive: true, force: true });
  cpSync(out, noAssets, { recursive: true });
  rmSync(join(noAssets, 'mediapipe'), { recursive: true, force: true });
  const site2 = await serveDir(noAssets, vercel);
  const fb = await runCam('no local model', site2.url, true);
  check('missing local model → falls back to the public CDN and still works', fb.source === 'cdn');
  await fakeCam.close();

  // demo mode on the production build
  const { page, errors } = await open();
  await page.goto(site.url);
  await page.click('#btn-demo');
  await page.waitForTimeout(3000);
  check('prod build: demo mode runs at speed with audio', await page.evaluate(() => window.__synth.state.fps >= 25 && window.__synth.audio.ctx.state === 'running'));
  check('prod build: no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  // the ?bridge= URL parameter must not accept non-loopback targets
  await page.goto(`${site.url}?bridge=ws://evil.example:1`);
  check('?bridge= ignores non-loopback hosts', await page.evaluate(() => document.getElementById('ctl-td-url').value !== 'ws://evil.example:1' && !document.getElementById('ctl-td').checked));
  await page.close();
  await site.close();
  await site2.close();
}

await browser.close();
await server.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
