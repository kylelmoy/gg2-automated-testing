//=============================================================================
// bridge.js - a client for the AgentBridge inside one running game.
//
// Framing, ids and timeouts, and nothing more: the runner owns the only
// connection to each game and makes one call at a time.
//
// Wire format: uint32 little-endian length, then that many bytes, both ways.
// A request is "#<id> <VERB> <args>"; the reply is "#<id> OK[ <text>]" or
// "#<id> ERR <text>". Replies are matched by id, never by order: a CANCEL is
// answered ahead of the deferred STEP or WAIT it cancels.
//
// The game accepts ONE client at a time. A second one sits in the accept
// backlog and every call times out - so nothing else may be connected to a
// game the runner started.
//=============================================================================

const net = require('net');

const HOST = '127.0.0.1';

class BridgeError extends Error {}

class Bridge {
  constructor(port) {
    this.port = port;
    this.sock = null;
    this.rx = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
  }

  connect(timeoutMs = 5000) {
    if (this.sock) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const sock = net.connect({ port: this.port, host: HOST });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new BridgeError(`could not connect to the bridge on port ${this.port}`));
      }, timeoutMs);
      sock.once('connect', () => {
        clearTimeout(timer);
        this.sock = sock;
        sock.setNoDelay(true);
        sock.on('data', (d) => this.onData(d));
        sock.on('close', () => this.onClose('the game closed the connection'));
        sock.on('error', (e) => this.onClose(e.message));
        resolve();
      });
      sock.once('error', (e) => {
        clearTimeout(timer);
        reject(new BridgeError(`could not connect to the bridge on port ${this.port}: ${e.message}`));
      });
    });
  }

  onData(d) {
    this.rx = Buffer.concat([this.rx, d]);
    while (this.rx.length >= 4) {
      const len = this.rx.readUInt32LE(0);
      if (this.rx.length < 4 + len) return;
      const body = this.rx.subarray(4, 4 + len).toString('latin1');
      this.rx = this.rx.subarray(4 + len);
      const m = /^#(\d+) ([\s\S]*)$/.exec(body);
      if (!m) continue;
      const slot = this.pending.get(Number(m[1]));
      if (!slot) continue; // the reply to a call that already gave up
      this.pending.delete(Number(m[1]));
      clearTimeout(slot.timer);
      slot.resolve(m[2]);
    }
  }

  onClose(reason) {
    if (!this.sock) return;
    this.sock.removeAllListeners();
    this.sock.destroy();
    this.sock = null;
    for (const slot of this.pending.values()) {
      clearTimeout(slot.timer);
      slot.reject(new BridgeError(`lost the bridge on port ${this.port}: ${reason}`));
    }
    this.pending.clear();
  }

  // Send one request and resolve with the reply text after the id: "OK ..." or
  // "ERR ...". Rejects only for transport failures and timeouts.
  async raw(request, timeoutMs = 10000) {
    await this.connect();
    const id = this.nextId++;
    const body = Buffer.from(`#${id} ${request}`, 'latin1');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A deferred STEP or WAIT keeps the bridge busy until it finishes;
        // cancel it so the next call is not held behind it.
        if (/^(STEP|WAIT)\b/.test(request)) this.raw('CANCEL', 2000).catch(() => {});
        reject(new BridgeError(`no reply from port ${this.port} after ${timeoutMs}ms: ${request.slice(0, 80)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(Buffer.concat([head, body]));
    });
  }

  // Like raw, but "ERR ..." rejects, and the "OK " is stripped.
  async call(request, timeoutMs) {
    const reply = await this.raw(request, timeoutMs);
    if (reply.startsWith('ERR')) throw new BridgeError(reply.slice(4));
    return reply.replace(/^OK ?/, '');
  }

  close() {
    this.onClose('closed by the runner');
  }
}

module.exports = { Bridge, BridgeError };
