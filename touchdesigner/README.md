# TouchDesigner integration

See [`docs/TOUCHDESIGNER.md`](../docs/TOUCHDESIGNER.md) for the full guide (address map, both connection modes, troubleshooting).

Quick start:

```bash
npm run dev:all          # web app + OSC bridge
```

1. In TouchDesigner, open the Textport and run `exec(open('/absolute/path/to/touchdesigner/build_network.py').read())`.
2. In the web app, open the panel → **TouchDesigner → Send to bridge**. The header chip turns green: `TD connected`.
3. `osc_in` in `/project1/synthmotion` now shows live channels.

`build_network.py` has **not** been run inside TouchDesigner by this repo's author (see the note in the file); the OSC/WebSocket transport it relies on *is* covered by automated tests.
