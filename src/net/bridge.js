// Browser side of the TouchDesigner bridge (see server/bridge.mjs and docs/TOUCHDESIGNER.md).
// Sends a JSON frame ~30×/s and receives {type:'control', name, value} messages coming back from TD.
export class TouchBridge {
  constructor({ url = 'ws://localhost:8787', rate = 30 } = {}) {
    this.url = url;
    this.interval = 1000 / rate;
    this.enabled = false;
    this.status = 'off'; // off | connecting | connected | error
    this.onStatus = () => {};
    this.onControl = () => {};
    this._ws = null;
    this._last = 0;
    this._retry = 0;
    this._timer = null;
    this.sent = 0;
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) this._connect();
    else this._close('off');
  }

  setUrl(url) {
    this.url = url;
    if (this.enabled) {
      this._close('connecting');
      this._connect();
    }
  }

  _setStatus(s) {
    if (s !== this.status) {
      this.status = s;
      this.onStatus(s);
    }
  }

  _connect() {
    clearTimeout(this._timer);
    if (!this.enabled || this._ws) return;
    this._setStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this._setStatus('error');
      return;
    }
    this._ws = ws;
    ws.onopen = () => {
      this._retry = 0;
      this._setStatus('connected');
    };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === 'control') this.onControl(m.name, m.value);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      this._ws = null;
      if (!this.enabled) return;
      this._setStatus('error');
      this._retry = Math.min(this._retry + 1, 5);
      this._timer = setTimeout(() => this._connect(), 500 * 2 ** this._retry);
    };
    ws.onerror = () => ws.close();
  }

  _close(status) {
    clearTimeout(this._timer);
    const ws = this._ws;
    this._ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    this._setStatus(status);
  }

  /** Call every render frame; it throttles itself. */
  send(frame, now = performance.now()) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    if (now - this._last < this.interval) return;
    this._last = now;
    this._ws.send(JSON.stringify({ type: 'frame', t: now, ...frame }));
    this.sent++;
  }
}
