// 只读任务面板（手机可看）。所有地址都在 /<token>/ 之下，token 不对一律 404；只接受 GET，不提供任何操作。
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export function createPanel({engine, store, token, host = '127.0.0.1', port = 8790, limit = 30, onError = () => {}}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(token)) throw new Error('PANEL_TOKEN_INVALID');
  const html = fs.readFileSync(new URL('./panel.html', import.meta.url));
  const base = {'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"};
  const send = (res, code, type, body) => { res.writeHead(code, {...base, 'content-type': type}); res.end(body); };
  const server = http.createServer((req, res) => {
    try {
      const parts = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean);
      if (req.method !== 'GET' || !parts.length || !same(parts[0], token)) return send(res, 404, 'text/plain', '');
      const rest = parts.slice(1).join('/');
      if (!rest) return send(res, 200, 'text/html; charset=utf-8', html);
      if (rest === 'api/state') {
        const tasks = engine.snapshot().slice(-limit).map(({request, ...t}) => t);
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({at: new Date().toISOString(), tasks}));
      }
      const m = rest.match(/^api\/artifact\/(\d+)\/([A-Za-z0-9_-]{1,32})$/);
      const step = m && engine.progress(Number(m[1]))?.steps.find(s => s.id === m[2]);
      if (step?.artifact) return send(res, 200, 'text/plain; charset=utf-8', store.readArtifact(step.artifact));
      send(res, 404, 'text/plain', '');
    } catch (e) { onError(e); try { send(res, 500, 'text/plain', ''); } catch {} }
  });
  server.on('error', onError);       // 端口被占用等：只报告，不影响宿主
  server.listen(port, host);
  return {server, close: () => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()); })};
}
