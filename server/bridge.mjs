// SYNTH//MOTION ⇄ TouchDesigner bridge.
//
//   browser ──(WebSocket JSON @30 Hz)──▶ bridge ──(OSC/UDP)──▶ TouchDesigner  (OSC In CHOP, port 7000)
//                                            └──(same JSON)──▶ other WebSocket clients (TD WebSocket DAT)
//   TouchDesigner ──(OSC/UDP :7001)──▶ bridge ──(JSON)──▶ browser   (/synthmotion/control/<name> <float>)
//
// Browsers can't send UDP, hence this tiny relay. Configure with env vars:
//   WS_PORT=8787  OSC_HOST=127.0.0.1  OSC_PORT=7000  OSC_IN_PORT=7001
import dgram from 'node:dgram';
import { WebSocketServer, WebSocket } from 'ws';
import { encodeBundle, frameToMessages, decode } from './osc.mjs';

export function startBridge({
  wsPort = Number(process.env.WS_PORT ?? 8787),
  oscHost = process.env.OSC_HOST ?? '127.0.0.1',
  oscPort = Number(process.env.OSC_PORT ?? 7000),
  oscInPort = Number(process.env.OSC_IN_PORT ?? 7001),
  host = process.env.WS_HOST ?? '127.0.0.1',
  log = console.log,
} = {}) {
  const udp = dgram.createSocket('udp4');
  const wss = new WebSocketServer({ port: wsPort, host });
  const stats = { framesIn: 0, oscOut: 0, controlIn: 0 };

  const ready = new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });

  wss.on('connection', (ws) => {
    log(`[bridge] client connected (${wss.clients.size} total)`);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (frame.type !== 'frame') return;
      stats.framesIn++;
      const packet = encodeBundle(frameToMessages(frame));
      udp.send(packet, oscPort, oscHost, (err) => {
        if (!err) stats.oscOut++;
      });
      // fan out to every *other* socket (TouchDesigner WebSocket DAT, other tabs, …)
      for (const c of wss.clients) if (c !== ws && c.readyState === WebSocket.OPEN) c.send(data.toString());
    });
    ws.on('close', () => log(`[bridge] client left (${wss.clients.size} total)`));
  });

  // TouchDesigner → browser
  const inSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  inSock.on('message', (buf) => {
    for (const { address, args } of decode(buf)) {
      const m = /^\/synthmotion\/control\/([\w-]+)$/.exec(address);
      if (!m || typeof args[0] !== 'number') continue;
      stats.controlIn++;
      const msg = JSON.stringify({ type: 'control', name: m[1], value: args[0] });
      for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
    }
  });
  inSock.on('error', (e) => log(`[bridge] OSC-in socket error: ${e.message}`));
  inSock.bind(oscInPort, host);

  return {
    ready,
    stats,
    wss,
    close: () =>
      new Promise((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => {
          udp.close();
          inSock.close();
          resolve();
        });
      }),
  };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const b = startBridge();
  b.ready
    .then(() => {
      const p = (k, d) => process.env[k] ?? d;
      console.log(`[bridge] ws://127.0.0.1:${p('WS_PORT', 8787)}  →  OSC udp://${p('OSC_HOST', '127.0.0.1')}:${p('OSC_PORT', 7000)}   ←  OSC in :${p('OSC_IN_PORT', 7001)}`);
    })
    .catch((e) => {
      console.error(`[bridge] failed to start: ${e.message}`);
      process.exit(1);
    });
}
