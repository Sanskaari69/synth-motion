// MediaPipe HandLandmarker wrapper + webcam helper. Models/wasm are served from /mediapipe
// (fetched by scripts/fetch-assets.mjs); if they're missing we fall back to the public CDNs.
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

const BASE = import.meta.env.BASE_URL;
const LOCAL = { wasm: `${BASE}mediapipe/wasm`, model: `${BASE}mediapipe/models/hand_landmarker.task` };
const CDN = {
  wasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm',
  model: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};

async function exists(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    const type = r.headers.get('content-type') ?? '';
    return r.ok && !type.includes('text/html'); // vite's SPA fallback answers 200 + html for missing files
  } catch {
    return false;
  }
}

export class HandTracker {
  constructor() {
    this.landmarker = null;
    this.delegate = null;
    this.source = null;
    this.lastVideoTime = -1;
    this.last = [];
  }

  async init(onStatus = () => {}) {
    const useLocal = (await exists(LOCAL.model)) && (await exists(`${LOCAL.wasm}/vision_wasm_internal.js`));
    const src = useLocal ? LOCAL : CDN;
    this.source = useLocal ? 'local' : 'cdn';
    onStatus(`loading hand model (${this.source})…`);
    const fileset = await FilesetResolver.forVisionTasks(src.wasm);
    const make = (delegate) =>
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: src.model, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    try {
      this.landmarker = await make('GPU');
      this.delegate = 'GPU';
    } catch (err) {
      console.warn('[tracker] GPU delegate unavailable, using CPU:', err?.message ?? err);
      this.landmarker = await make('CPU');
      this.delegate = 'CPU';
    }
    return this;
  }

  /** Run detection only when the video has produced a new frame; otherwise reuse the last result. */
  detect(video, nowMs) {
    if (!this.landmarker || video.readyState < 2) return this.last;
    if (video.currentTime === this.lastVideoTime) return this.last;
    this.lastVideoTime = video.currentTime;
    try {
      this.last = this.landmarker.detectForVideo(video, nowMs).landmarks ?? [];
    } catch (err) {
      console.warn('[tracker] detect failed:', err?.message ?? err);
    }
    return this.last;
  }

  /** Detect on a still image / canvas (used by the self-test). */
  detectImage(image) {
    const lm = this.landmarker;
    lm.setOptions({ runningMode: 'IMAGE' });
    const res = lm.detect(image);
    lm.setOptions({ runningMode: 'VIDEO' });
    return res.landmarks ?? [];
  }
}

export async function openCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no camera API (needs HTTPS or localhost).');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
  });
  video.srcObject = stream;
  video.playsInline = true;
  video.muted = true;
  await video.play();
  return stream;
}

export function closeCamera(video) {
  video.srcObject?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}
