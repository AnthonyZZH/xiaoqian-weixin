import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, isAbsolute } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const MUTATIONS = new Set(['send_text', 'send_image']);
const OPERATIONS = new Set(['health', 'read', 'validate', 'switch', 'send_text', 'send_image', 'transcribe']);
const result = (status, code, rest = {}) => ({ status, code, ...rest });
const signature = (op, args) => createHash('sha256').update(JSON.stringify([op, args])).digest('hex');

/** One serial, restartable UI queue; model calls must never be placed here. */
export class DriverClient {
  constructor(options = {}) {
    this.options = options;
    this.mode = options.mode ?? 'mock';
    if (!['mock', 'live'].includes(this.mode)) throw new Error('DRIVER_MODE_INVALID');
    if (this.mode === 'live' && options.liveEnabled !== true) throw new Error('LIVE_DRIVER_NOT_ENABLED');
    this.targets = new Map();
    for (const t of options.targets ?? []) {
      if (!t || typeof t.id !== 'string' || !t.id || typeof t.title !== 'string' || !t.title || !['private','group'].includes(t.mode) || this.targets.has(t.id)) throw new Error('DRIVER_TARGET_INVALID');
      this.targets.set(t.id, { id:t.id, title:t.title, mode:t.mode, maxChars:t.maxChars ?? 500 });
    }
    if (!this.targets.size) throw new Error('DRIVER_TARGETS_REQUIRED');
    this.timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 10 || this.timeoutMs > 120000) throw new Error('DRIVER_TIMEOUT_INVALID');
    this.statePath = options.statePath;
    if (!this.statePath || !isAbsolute(this.statePath)) throw new Error('DRIVER_STATE_PATH_REQUIRED');
    this.state = { version:1, intents:{} };
    if (existsSync(this.statePath)) {
      try {
        this.state = JSON.parse(readFileSync(this.statePath, 'utf8'));
        if (this.state.version !== 1 || !this.state.intents || typeof this.state.intents !== 'object' || Array.isArray(this.state.intents)) throw new Error();
        for (const [key, row] of Object.entries(this.state.intents)) if (!key || !row || typeof row.signature !== 'string' || !['pending','unknown','ok','rejected'].includes(row.status)) throw new Error();
      } catch { throw new Error('DRIVER_STATE_INVALID'); }
    }
    this.queue = Promise.resolve(); this.proc = null; this.pending = null;
    this.paused = options.startPaused === true; this.closed = false; this.generation = 0;
  }
  _save() {
    mkdirSync(dirname(this.statePath), {recursive:true});
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { encoding:'utf8', mode:0o600 });
    renameSync(temporary, this.statePath);
  }
  pause() { this.paused = true; this._kill('DRIVER_PAUSED'); return result('paused','DRIVER_PAUSED'); }
  resume() { if (this.closed) return result('rejected','DRIVER_CLOSED'); this.paused = false; return result('ok','DRIVER_RESUMED'); }
  async close() { this.closed = true; this._kill('DRIVER_CLOSED'); await this.queue; }
  // Trusted operator API, deliberately not a model-callable worker operation.
  async reconcileSend(idempotencyKey, outcome) {
    const job = this.queue.then(() => {
      const row=this.state.intents[idempotencyKey];
      if(!row || !['pending','unknown'].includes(row.status) || !['sent','not_sent'].includes(outcome)) return result('rejected','DRIVER_RECONCILIATION_INVALID');
      const prior={...row}; row.status=outcome==='sent'?'ok':'rejected'; row.code=outcome==='sent'?'SEND_CONFIRMED_BY_OPERATOR':'SEND_NOT_SENT_CONFIRMED_BY_OPERATOR';
      try { this._save(); } catch { this.state.intents[idempotencyKey]=prior; return result('rejected','DRIVER_STATE_WRITE_FAILED'); }
      return result('ok','DRIVER_RECONCILED');
    });
    this.queue=job.catch(()=>undefined); return job;
  }
  call(operation, args = {}) {
    if (!OPERATIONS.has(operation) || !args || typeof args !== 'object' || Array.isArray(args)) return Promise.resolve(result('rejected','DRIVER_OPERATION_INVALID'));
    // Snapshot untrusted caller objects before asynchronous queuing.
    let captured; try { captured = JSON.parse(JSON.stringify(args)); } catch { return Promise.resolve(result('rejected','DRIVER_ARGUMENT_INVALID')); }
    const job = this.queue.then(() => this._call(operation, captured));
    this.queue = job.catch(() => undefined);
    return job;
  }
  async _call(operation, args) {
    if (this.closed) return result('rejected','DRIVER_CLOSED');
    if (this.paused && operation !== 'health') return result('paused','DRIVER_PAUSED');
    if (operation !== 'health' && !this.targets.has(args.targetId)) return result('rejected','DRIVER_TARGET_DENIED');
    if (['title','mode','target','chat'].some(k => Object.hasOwn(args,k))) return result('rejected','DRIVER_TARGET_OVERRIDE_DENIED');
    const mutating = MUTATIONS.has(operation);
    let key, hash;
    if (mutating) {
      key = args.idempotencyKey;
      if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,180}$/.test(key)) return result('rejected','DRIVER_IDEMPOTENCY_REQUIRED');
      hash = signature(operation,args);
      const old = this.state.intents[key];
      if (old) {
        if (old.signature !== hash) return result('rejected','DRIVER_IDEMPOTENCY_CONFLICT');
        return result(old.status === 'pending' ? 'unknown' : old.status, old.status === 'pending' || old.status === 'unknown' ? 'SEND_RECONCILIATION_REQUIRED' : old.code, {duplicate:true});
      }
      if (Object.values(this.state.intents).some(row => ['pending','unknown'].includes(row.status) && (!row.targetId || row.targetId === args.targetId))) return result('unknown','SEND_RECONCILIATION_REQUIRED');
      if (Object.keys(this.state.intents).length >= 10000) return result('rejected','DRIVER_INTENT_CAPACITY');
    }
    const ready = await this._ensure();
    if (ready.status !== 'ok') return ready;
    if (this.paused || this.closed) return result('paused','DRIVER_PAUSED');
    if (mutating) {
      this.state.intents[key] = { signature:hash, targetId:args.targetId, status:'pending', code:'SEND_RECONCILIATION_REQUIRED' };
      try { this._save(); } catch { delete this.state.intents[key]; return result('rejected','DRIVER_STATE_WRITE_FAILED'); }
    }
    const answer = await this._request(operation,args,mutating);
    if (mutating) {
      this.state.intents[key] = { signature:hash, targetId:args.targetId, status:['ok','rejected'].includes(answer.status) ? answer.status : 'unknown', code:answer.code };
      try { this._save(); } catch { return result('unknown','SEND_STATE_COMMIT_FAILED'); }
    }
    return answer;
  }
  async _ensure() {
    if (this.proc && !this.proc.killed) return result('ok','DRIVER_READY');
    const config = { mode:this.mode, targets:[...this.targets.values()], liveEnabled:this.options.liveEnabled === true,
      legacyDir:this.options.legacyDir, mediaRoot:this.options.mediaRoot, mock:this.options.mock ?? {} };
    // Deliberately do not pass API keys, SSH credentials or the parent environment wholesale.
    const env = {};
    for (const k of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']) if (process.env[k]) env[k] = process.env[k];
    env.PYTHONDONTWRITEBYTECODE = '1'; env.PYTHONIOENCODING = 'utf-8';
    const workerPath = this.options.workerPath ?? fileURLToPath(new URL('./worker.py', import.meta.url));
    const child = spawn(this.options.python ?? 'python', ['-u','-B',workerPath], { env, windowsHide:true, stdio:['pipe','pipe','pipe'] });
    this.proc = child; this.generation++;
    const lines = createInterface({input:child.stdout});
    lines.on('line', line => {
      if (this.proc !== child) return;
      if (line.length > 8 * 1024 * 1024) { this._kill('DRIVER_PROTOCOL_INVALID'); return; }
      let answer; try { answer=JSON.parse(line); } catch { this._kill('DRIVER_PROTOCOL_INVALID'); return; }
      const p = this.pending;
      if (!p || answer.id !== p.id || !['ok','error','unknown','rejected'].includes(answer.status) || typeof answer.code !== 'string') { this._kill('DRIVER_PROTOCOL_INVALID'); return; }
      clearTimeout(p.timer); this.pending=null; p.resolve(answer);
    });
    child.stderr.resume(); // Never forward raw exceptions or chat data to diagnostic logs.
    child.on('error', () => { if(this.proc===child) this._kill('DRIVER_START_FAILED'); });
    child.on('exit', () => { lines.close(); if(this.proc===child) this._kill('DRIVER_EXITED'); });
    return this._request('initialize',config,false);
  }
  _request(operation,args,mutating) {
    return new Promise(resolveAnswer => {
      const id=randomUUID();
      const timer=setTimeout(()=>this._kill('DRIVER_TIMEOUT'),this.timeoutMs);
      this.pending={id,mutating,timer,resolve:resolveAnswer};
      this.proc.stdin.write(JSON.stringify({id,operation,args})+'\n',error=>{ if(error) this._kill('DRIVER_WRITE_FAILED'); });
    });
  }
  _kill(code) {
    const proc=this.proc; this.proc=null;
    const p=this.pending; this.pending=null;
    if(p) { clearTimeout(p.timer); p.resolve(result(p.mutating?'unknown':'error',p.mutating?'SEND_RECONCILIATION_REQUIRED':code)); }
    if(proc) { try { proc.stdin.destroy(); proc.kill(); } catch {} }
  }
}
