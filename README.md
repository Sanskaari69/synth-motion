# SYNTH//MOTION

**Play a synthesizer with your bare hands.** Your webcam tracks both hands; a Web Audio engine turns them into a lead
synth and a full rhythm section; a Three.js scene reacts to every note; and a small bridge streams everything to
**TouchDesigner** over OSC.

```
webcam ─▶ MediaPipe hand landmarks ─▶ features/controller ─┬─▶ Web Audio synth + sequencer ─▶ speakers
                                                            ├─▶ Three.js particles / skeletons / bloom
                                                            └─▶ WebSocket ─▶ bridge ─▶ OSC/UDP ─▶ TouchDesigner
```

## Run it

Requires **Node 22** and, for the camera, a browser on `http://localhost` or HTTPS.

```bash
npm install          # also copies the MediaPipe wasm and downloads the hand model (~8 MB) into public/mediapipe
npm run dev          # http://localhost:5173  (if the port is busy Vite picks the next one and prints it)
npm run dev:all      # same + the TouchDesigner bridge
```

Click **Start with camera** (or **Try demo**, which uses two synthetic hands and needs no camera). Turn your sound on.

* If `npm install` fails with `EACCES` on `~/.npm` (an old root-owned cache), either fix it once with
  `sudo chown -R "$(id -u):$(id -g)" ~/.npm` or run `npm install --cache ./.npm-cache`.
* If the model can't be downloaded at install time, the app falls back to the jsDelivr / Google Storage CDNs at runtime
  (the panel/console shows nothing special; camera mode just needs internet then).

## How to play

| Hand | Gesture | Effect |
| --- | --- | --- |
| **Right** (right of your screen; also your only hand) | **pinch** thumb + index | note on / off (hysteresis: no stutter) |
| | move **← →** | pitch, quantized to the chosen scale over ~3 octaves |
| | move **↑ ↓** | filter brightness (up = brighter) |
| | **tilt** the hand | vibrato depth |
| **Left** | **open palm / fist** | intensity: kick → hats → bass → clap → open hat → arp fade in |
| | move **← →** | key (12 semitones), the bass follows |
| | move **↑ ↓** | delay/reverb amount and bass filter |

No left hand? **Auto beat** (on by default) plays a groove so one hand is enough.
Keys: `M` mute · `D` demo/camera · `F` fullscreen · `H` hide UI · `P` panel. Settings persist in `localStorage`.

## Project layout

```
src/tracking/   tracker.js (MediaPipe + webcam) · features.js (landmarks → pinch/open/roll, pure)
                controller.js (roles, smoothing, gate hysteresis, pure) · demo.js (synthetic hands)
src/audio/      engine.js (Web Audio graph + look-ahead sequencer) · theory.js · pattern.js (pure)
src/visuals/    scene.js (GPU particles, skeletons, ripples, bloom, adaptive quality)
src/net/        bridge.js (browser side of the TouchDesigner link)
server/         bridge.mjs (WebSocket ⇄ OSC/UDP) · osc.mjs (OSC 1.0 encoder/decoder, no deps)
touchdesigner/  build_network.py (network builder) · README.md
docs/           TOUCHDESIGNER.md (address map, both connection modes, troubleshooting)
test/           unit tests (node:test) · e2e/run.mjs (headless Chrome)
```

## TouchDesigner

`npm run dev:all`, add an **OSC In CHOP** on port `7000`, tick **Send to bridge** in the panel. You get 24+ channels
(hand positions, pinch/open/roll, audio meters, note, beat step, bpm) and can send `hue` / `bloom` / `pulse` back.
Full guide: [`docs/TOUCHDESIGNER.md`](docs/TOUCHDESIGNER.md).

## Tests

```bash
npm test            # 21 unit tests: geometry round-trips, music theory, controller, OSC codec, bridge over real sockets
npm run test:e2e    # 50 checks in real headless Chrome (see below)
```

`test:e2e` needs Google Chrome installed, and network access on first run (it downloads a sample hand photo from Google's
MediaPipe docs to a temp folder, and one scenario loads MediaPipe from the CDN). It covers: UI wiring and audio running,
a denied camera, the OSC bridge in both directions over real UDP/WebSocket sockets, MediaPipe finding two hands in a photo,
and — against the **production build served with the headers from `vercel.json`** — camera permission policy, asset MIME
types/caching, a real `getUserMedia` stream (Chrome's fake camera device), and the CDN fallback when the local model is missing.

## Performance & limits (measured on an M1 Mac, Chrome)

* Demo mode: 60 fps at *high* (60k particles + bloom). With live tracking: ~30 fps; MediaPipe (GPU delegate) takes ~20 ms per frame on the main thread.
* An adaptive governor steps quality *high → medium → low* if frames stay slow; pin it in the panel.
* Detection runs on the main thread, so very slow machines lose smoothness in camera mode first.
* Hand roles are decided by screen position (left half = rhythm, right half = lead), not by MediaPipe's handedness label; crossing your hands swaps roles.
* **Not verified**: gesture feel and latency with a live human hand (tests use a still photo, synthetic hands and Chrome's fake camera), Safari/Firefox, a real Vercel deployment, and `touchdesigner/build_network.py` inside TouchDesigner.

## Deploy to Vercel

It's a static Vite app; `vercel.json` sets the framework, the camera `Permissions-Policy`, security headers and caching.

**How the MediaPipe files ship:** `public/mediapipe/` (≈27 MB: a ~10 MB wasm, a ~8 MB hand model, loaders) is *not* in git.
`npm ci`'s `postinstall` script recreates it on Vercel during the install step, and it ends up inside `dist/`. Each file is
well under Vercel's limits. If the model download fails at build time the site still works: the browser loads MediaPipe
from the public CDNs instead. `/mediapipe/*` is served with `must-revalidate` (filenames aren't hashed); `/assets/*` is
immutable (hashed).

**Option A: GitHub integration** (auto-deploys on each push): vercel.com/new → import `Sanskaari69/synth-motion` → Deploy.
Framework, install, build and output settings are picked up from `vercel.json`.

**Option B: CLI**

```bash
npx vercel login          # once (opens the browser)
npx vercel --prod         # first run asks to link/create the project; accept the defaults
```

The camera needs HTTPS, which Vercel provides. The TouchDesigner bridge is a local process: from the deployed site
Chrome and Firefox can still reach `ws://localhost:8787` (Safari blocks it). `?bridge=ws://…` in the URL is honoured only
for loopback hosts; type any other URL into the panel yourself.

## Build

`npm run build` → `dist/` (static; serve over HTTPS or localhost for camera access).
