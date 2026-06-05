import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

/**
 * Resolves true if a TCP connect succeeds within `timeoutMs`, false otherwise.
 * Used for localhost services where "port closed" really means "process not running."
 */
export function isPortOpen(host, port, timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * HEAD an HTTP(S) URL; resolves true if the response status is below `okBelow`
 * (default 400 — 2xx/3xx). For cloud URLs, TCP connect to :443 is always
 * "open" at the edge, so a real HTTP exchange is the only honest probe.
 *
 * `okBelow` lets callers loosen the bar — e.g. MCP edge functions only accept
 * POST, so HEAD returns 405; passing okBelow:500 treats that as "up".
 */
export function isHttpOk(url, { timeoutMs = 2000, headers = {}, method = 'HEAD', okBelow = 400 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let u;
    try { u = new URL(url); } catch { return finish(false); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: (u.pathname || '/') + (u.search || ''),
      headers,
      timeout: timeoutMs,
    }, (res) => {
      finish((res.statusCode ?? 0) < okBelow);
      res.resume();
    });
    req.on('timeout', () => { req.destroy(); finish(false); });
    req.on('error', () => finish(false));
    req.end();
  });
}

/**
 * Dispatch a probe based on a process descriptor. HTTPS URLs go through the
 * HTTP probe; everything else (postgresql:, http://localhost, etc) gets a
 * TCP connect.
 */
export function probeProc(proc, timeoutMs) {
  if (proc.configured === false || proc.host == null) return Promise.resolve(false);
  if (proc.scheme === 'https') {
    return isHttpOk(proc.url, {
      timeoutMs: timeoutMs ?? 2000,
      headers: proc.headers ?? {},
      okBelow: proc.okBelow ?? 400,
    });
  }
  return isPortOpen(proc.host, proc.port, timeoutMs ?? 1000);
}
