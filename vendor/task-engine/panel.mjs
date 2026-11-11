// Task and control panel (works on a phone). Everything lives under /<token>/; a wrong token is always 404.
// Without `control` the panel is read-only. With it, POST /<token>/api/action/<name> performs the named action.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export function createPanel({engine, store, token, host = '127.0.0.1', port = 8790, limit = 30, control = null, onError = () => {}}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(token)) throw new Error('PANEL_TOKEN_INVALID');
  const html = fs.readFileSync(new URL('./panel.html', import.meta.url));
  const base = {'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"};
  const send = (res, code, type, body) => { res.writeHead(code, {...base, 'content-type': type}); res.end(body); };
  const json = (res, code, value) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(value));
  const tasks = () => store.taskIds().sort((a, b) => a - b).slice(-limit).map(id => { const {request, ...t} = engine.progress(id); return t; });
  async function action(req, res, name) {
    // A custom header plus a JSON content type cannot be sent cross-site without a CORS preflight, which is never answered.
    if (!control || req.headers['x-xq-panel'] !== '1' || !/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 404, 'text/plain', '');
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 32768) return json(res, 413, {ok: false, code: 'BODY_TOO_LARGE'}); }
    try { json(res, 200, {ok: true, result: await control.act(name, raw ? JSON.parse(raw) : {})}); }
    catch (e) { json(res, 400, {ok: false, code: String(e?.code || 'ACTION_FAILED'), message: String(e?.message || e).slice(0, 300)}); }
  }
  const server = http.createServer((req, res) => {
    Promise.resolve().then(() => {
      const parts = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean);
      if (!parts.length || !same(parts[0], token)) return send(res, 404, 'text/plain', '');
      const rest = parts.slice(1).join('/');
      if (req.method === 'POST' && rest.startsWith('api/action/')) return action(req, res, rest.slice('api/action/'.length));
      if (req.method !== 'GET') return send(res, 404, 'text/plain', '');
      if (!rest) return send(res, 200, 'text/html; charset=utf-8', html);
      if (rest === 'api/state') return json(res, 200, {at: new Date().toISOString(), tasks: tasks(), control: !!control,
        ...(control ? {status: control.status(), config: control.settings()} : {})});
      const m = rest.match(/^api\/artifact\/(\d+)\/([A-Za-z0-9_-]{1,32})$/);
      const step = m && engine.progress(Number(m[1]))?.steps.find(s => s.id === m[2]);
      if (step?.artifact) return send(res, 200, 'text/plain; charset=utf-8', store.readArtifact(step.artifact));
      send(res, 404, 'text/plain', '');
    }).catch(e => { onError(e); try { send(res, 500, 'text/plain', ''); } catch {} });
  });
  server.on('error', onError);       // port in use etc.: report only, never take the host down
  server.listen(port, host);
  return {server, close: () => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()); })};
}
