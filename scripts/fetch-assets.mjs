// Copies the MediaPipe WASM runtime out of node_modules and downloads the
// (free, Google-hosted) .task models into public/mediapipe so the app runs
// offline. Everything here is best-effort: at runtime the app falls back to
// the jsDelivr / Google Storage CDNs if these files are missing.
import { cp, mkdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'public/mediapipe');

const MODELS = {
  'hand_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  'face_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
};

async function copyWasm() {
  const src = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
  if (!existsSync(src)) return console.warn('[assets] wasm folder not found, skipping');
  await mkdir(resolve(out, 'wasm'), { recursive: true });
  await cp(src, resolve(out, 'wasm'), { recursive: true });
  console.log('[assets] copied MediaPipe wasm');
}

async function fetchModels() {
  await mkdir(resolve(out, 'models'), { recursive: true });
  for (const [name, url] of Object.entries(MODELS)) {
    const dest = resolve(out, 'models', name);
    if (existsSync(dest) && (await stat(dest)).size > 100_000) continue;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      console.log(`[assets] downloaded ${name}`);
    } catch (err) {
      console.warn(`[assets] could not download ${name} (${err.message}) — the app will use the CDN at runtime`);
    }
  }
}

try {
  await copyWasm();
  await fetchModels();
} catch (err) {
  console.warn('[assets] skipped:', err.message);
}
