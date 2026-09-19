# TouchDesigner integration

```
 browser (SYNTH//MOTION)                bridge (node)                   TouchDesigner
 ┌──────────────────────┐   WebSocket   ┌───────────────┐   OSC / UDP   ┌──────────────────┐
 │ hand tracking, audio │ ── JSON ────▶ │ server/       │ ── :7000 ───▶ │ OSC In CHOP      │
 │ analyser, sequencer  │   @ 30 Hz     │ bridge.mjs    │               │                  │
 │                      │ ◀─ control ── │               │ ◀─ :7001 ──── │ OSC Out CHOP     │
 └──────────────────────┘               └──────┬────────┘               └──────────────────┘
                                               └── same JSON ──▶ WebSocket DAT (optional, ws://localhost:8787)
```

Browsers cannot send UDP, so `npm run bridge` runs a tiny relay. Ports are configurable:
`WS_PORT=8787 OSC_HOST=127.0.0.1 OSC_PORT=7000 OSC_IN_PORT=7001 npm run bridge`.

## Mode A — OSC In CHOP (recommended)

1. `npm run dev:all`
2. TouchDesigner: add an **OSC In CHOP**, *Network Port* `7000`. (Or run `build_network.py`, see the folder README.)
3. Web app → panel → **TouchDesigner → Send to bridge**.

### Address map (all floats unless noted)

| Address | Range | Meaning |
| --- | --- | --- |
| `/synthmotion/hands/count` *(int)* | 0–2 | hands currently tracked |
| `/synthmotion/lead/present`, `/rhythm/present` *(int)* | 0/1 | that hand is tracked |
| `/synthmotion/{lead,rhythm}/x` | 0–1 | palm x on screen, **mirrored** (0 = left of your screen) |
| `/synthmotion/{lead,rhythm}/y` | 0–1 | palm height (**1 = top**) |
| `/synthmotion/{lead,rhythm}/z` | 0–1 | closeness to the camera (hand size proxy) |
| `/synthmotion/{lead,rhythm}/pinch` | 0–1 | thumb–index pinch |
| `/synthmotion/{lead,rhythm}/open` | 0–1 | fist → spread fingers |
| `/synthmotion/{lead,rhythm}/roll` | −1…1 | hand tilt (fingers pointing left / right) |
| `/synthmotion/audio/{level,bass,mid,high}` | 0–1 | live analyser meters |
| `/synthmotion/note/midi` | 0–127 | current lead MIDI note |
| `/synthmotion/note/gate` *(int)* | 0/1 | lead note is sounding |
| `/synthmotion/beat/step` *(int)* | 0–15 | current 16th-note step |
| `/synthmotion/beat/bpm` | 80–160 | tempo |
| `/synthmotion/beat/intensity` | 0–1 | how many rhythm layers are active |

`lead` = the right-hand side of your screen (or your only hand), `rhythm` = the left-hand side. A hand's `x/y/z/…`
messages are only sent while `present` is 1. The whole frame is one OSC bundle at ~30 Hz.

OSC In CHOP names channels after the address without the leading `/` (e.g. `synthmotion/lead/x`). Use a **Select CHOP**
with pattern `synthmotion/lead/*` to pull a group.

### Sending values back (TD → browser)

Send OSC to UDP **7001** with these addresses (one float each):

| Address | Effect |
| --- | --- |
| `/synthmotion/control/hue` | 0–1, rotates the particle palette |
| `/synthmotion/control/bloom` | 0–3, bloom strength multiplier |
| `/synthmotion/control/pulse` | 0–2, triggers a visual pulse |

In TouchDesigner: an **OSC Out CHOP** (*Network Address* `127.0.0.1`, *Port* `7001`) fed by a CHOP whose channel is named
`synthmotion/control/hue` etc.

## Mode B — WebSocket DAT

The bridge also re-broadcasts the browser's JSON to every other WebSocket client, so TouchDesigner can consume it directly:
**WebSocket DAT**, *Network Address* `localhost`, *Port* `8787`, *Active* on. Each message is
`{"type":"frame","hands":[{"role":"lead","x":…}],"audio":{…},"note":{"midi":…,"gate":true},"step":3,"bpm":118,"intensity":0.6}`;
parse it in the DAT's `onReceiveText` callback with `json.loads`.

## Troubleshooting

* Header chip says **TD unreachable** → the bridge isn't running (`npm run bridge`) or the URL in the panel is wrong.
* Chip says **TD connected** but TD sees nothing → check the OSC In CHOP is *Active* and on port 7000; firewalls can block UDP.
* TouchDesigner on another machine: `OSC_HOST=<that machine's IP> npm run bridge`.
* Hosting the web app over HTTPS (e.g. a phone on your LAN) blocks `ws://localhost`; use a `wss://` bridge or open the app over `http://localhost`.

## What is tested

The OSC encoder/decoder, the address map, WebSocket → UDP forwarding, the fan-out to other WebSocket clients, and the
TD → browser control path are covered by `npm test` and `npm run test:e2e` (a UDP socket stands in for TouchDesigner).
`touchdesigner/build_network.py` itself has **not** been run inside TouchDesigner.
