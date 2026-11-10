// 调度与执行引擎。
// 任务状态：queued → running → succeeded | failed | cancelled（failed/cancelled 可经 retry 回到 queued）
// 步骤状态：pending → running → succeeded | failed | cancelled；上游失败时 pending → blocked
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {now} from './store.mjs';
import {normalizePlan} from './plan.mjs';
import {replay} from './progress.mjs';

const BAD = new Set(['failed', 'blocked', 'cancelled']);
const fail = (code, msg) => { throw Object.assign(new Error(msg), {code}); };

export class Engine extends EventEmitter {
  #live = new Map();     // taskId → Map(stepId → {ctrl, attempt})，只存在于内存，代表「本进程正在执行」
  #stopped = true;

  constructor({store, tools, config}) {
    super();
    Object.assign(this, {store, tools, config});
    store.onEvent = ev => { try { this.emit('event', ev); } catch (e) { console.error('event listener failed', e); } };
  }

  start() {
    if (this.config.lock !== false) this.#lock();   // 宿主自己保证单实例时可以关掉
    this.#stopped = false;
    this.#recover();
    this.#pump();
  }
  // 停止本进程的执行，但不改持久化状态：没做完的步骤留给下次启动时恢复。
  stop() {
    this.#stopped = true;
    for (const live of this.#live.values()) for (const {ctrl} of live.values()) ctrl.abort(new Error('engine stopped'));
    this.#live.clear();
    try { if (fs.readFileSync(this.lockFile, 'utf8') === String(process.pid)) fs.rmSync(this.lockFile); } catch {}
  }

  // ---- 对外操作 ----
  submit(plan) {
    const p = normalizePlan(plan, this.tools, this.config);
    const id = this.store.createTask({title: p.title, request: p.request, mock: this.config.mode === 'mock', steps: p.steps});
    this.#pump();
    return this.progress(id);
  }

  cancel(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) fail('TASK_NOT_FOUND', `没有任务 #${taskId}`);
    if (!['queued', 'running'].includes(task.status)) fail('TASK_NOT_ACTIVE', `任务 #${taskId} 已经是「${task.status}」，不能取消`);
    const live = this.#live.get(taskId) ?? new Map();
    this.#live.delete(taskId);            // 先摘掉：这些步骤之后再返回结果也不会被采纳
    this.store.tx(() => {
      for (const s of task.steps) if (s.status === 'running' || s.status === 'pending') {
        this.store.setStep(taskId, s.id, {status: 'cancelled', finishedAt: now()});
        this.store.event(taskId, s.id, 'step_cancelled', {attempt: s.attempt, wasRunning: s.status === 'running'});
      }
      this.store.setTask(taskId, {status: 'cancelled', finishedAt: now()});
      this.store.event(taskId, null, 'task_cancelled', {});
    });
    for (const {ctrl} of live.values()) ctrl.abort(new Error('cancelled'));
    this.#pump();
    this.#advanceOthers(taskId);
    return this.progress(taskId);
  }

  // 重试失败（或被取消）的步骤。已成功的步骤和产物保留，不重跑。
  retry(taskId, stepId = null) {
    const task = this.store.getTask(taskId);
    if (!task) fail('TASK_NOT_FOUND', `没有任务 #${taskId}`);
    if (!['failed', 'cancelled'].includes(task.status)) fail('TASK_NOT_RETRYABLE', `任务 #${taskId} 现在是「${task.status}」，只有失败或已取消的任务可以重试`);
    const redo = task.steps.filter(s => ['failed', 'cancelled'].includes(s.status) && (!stepId || s.id === stepId));
    // 被打断的任务可能只剩没开始的步骤，这时没有失败步骤也允许继续
    if (!redo.length && (stepId || !task.steps.some(s => s.status === 'pending'))) fail('STEP_NOT_RETRYABLE', stepId ? `步骤 ${stepId} 不是失败状态，不需要重试` : '没有可重试的步骤');
    const reset = [...redo, ...task.steps.filter(s => s.status === 'blocked')];
    this.store.tx(() => {
      for (const s of reset) {
        this.store.setStep(taskId, s.id, {status: 'pending', error: null, artifact: null, finishedAt: null});
        this.store.event(taskId, s.id, 'step_retry', {previous: s.status, nextAttempt: s.attempt + 1});
      }
      this.store.setTask(taskId, {status: 'queued', finishedAt: null});
      this.store.event(taskId, null, 'task_requeued', {steps: redo.map(s => s.id)});
    });
    this.#pump();
    return {retried: redo.map(s => s.id), task: this.progress(taskId)};
  }

  progress(taskId) {
    const t = this.store.getTask(taskId);
    return t && {id: t.id, request: t.request, createdAt: t.createdAt, ...replay(this.store.events(taskId))};
  }
  snapshot() { return this.store.taskIds().sort((a, b) => a - b).map(id => this.progress(id)); }

  // ---- 内部 ----
  get lockFile() { return path.join(this.store.dir, 'engine.lock'); }
  #lock() {
    let pid = null;
    try { pid = Number(fs.readFileSync(this.lockFile, 'utf8')); } catch {}
    if (pid && pid !== process.pid) {
      let alive = true;
      try { process.kill(pid, 0); } catch (e) { alive = e.code === 'EPERM'; }
      if (alive) fail('ENGINE_ALREADY_RUNNING', `数据目录正被进程 ${pid} 使用：${this.store.dir}`);
    }
    fs.writeFileSync(this.lockFile, String(process.pid));
  }

  // 启动时恢复：上次进程里「执行中」的步骤其实已经没人在跑。
  // onInterrupted='retry'（默认）：退回 pending 自动重做；成功的步骤保留。
  // onInterrupted='fail'：步骤可能有副作用时用。被打断的步骤记为失败，整个任务停在失败，等人明确重试，绝不自动重跑。
  #recover() {
    for (const id of this.store.taskIds(['running', 'queued'])) {
      const task = this.store.getTask(id);
      if (this.config.onInterrupted === 'fail') {
        this.store.tx(() => {
          const cut = task.steps.filter(s => s.status === 'running');
          for (const s of cut) {
            const error = 'INTERRUPTED 进程重启时这一步正在执行，没有自动重跑';
            this.store.setStep(id, s.id, {status: 'failed', error, finishedAt: now()});
            this.store.event(id, s.id, 'step_failed', {attempt: s.attempt, error, interrupted: true});
          }
          this.store.setTask(id, {status: 'failed', finishedAt: now()});
          this.store.event(id, null, 'task_failed', {failed: cut.map(s => s.id), blocked: [], interrupted: true, final: null});
        });
        continue;
      }
      this.store.tx(() => {
        let touched = task.status === 'running';
        for (const s of task.steps) {
          if (s.status === 'running') {
            this.store.setStep(id, s.id, {status: 'pending', startedAt: null});
            this.store.event(id, s.id, 'step_interrupted', {attempt: s.attempt});
          } else if (s.status === 'succeeded' && !this.store.hasArtifact(s.artifact)) {
            this.store.setStep(id, s.id, {status: 'pending', artifact: null});
            this.store.event(id, s.id, 'step_artifact_missing', {artifact: s.artifact});
            touched = true;
          }
        }
        if (touched) {
          this.store.setTask(id, {status: 'queued'});
          this.store.event(id, null, 'task_recovered', {previous: task.status});
        }
      });
    }
  }

  // 有空位就把排队的任务拉起来。
  #pump() {
    if (this.#stopped) return;
    for (const id of this.store.taskIds(['queued'])) {
      if (this.#live.size >= this.config.maxParallelTasks) break;
      if (this.#live.has(id) || this.store.getTask(id).status !== 'queued') continue;   // 递归的 pump 可能已经处理过
      this.#live.set(id, new Map());
      this.store.tx(() => {
        const t = this.store.getTask(id);
        this.store.setTask(id, {status: 'running', startedAt: t.startedAt || now()});
        this.store.event(id, null, 'task_started', {});
      });
      this.#advance(id);
    }
  }

  // 任务内调度：标记被阻塞的步骤 → 启动所有依赖已满足的步骤 → 没有可做的就收尾。
  #advance(taskId) {
    const live = this.#live.get(taskId);
    if (this.#stopped || !live) return;
    const task = this.store.getTask(taskId), by = new Map(task.steps.map(s => [s.id, s]));
    this.store.tx(() => {
      for (let changed = true; changed;) {
        changed = false;
        for (const s of task.steps) {
          const because = s.status === 'pending' && s.dependsOn.find(d => BAD.has(by.get(d).status));
          if (!because) continue;
          s.status = 'blocked'; changed = true;
          this.store.setStep(taskId, s.id, {status: 'blocked'});
          this.store.event(taskId, s.id, 'step_blocked', {because});
        }
      }
    });
    let waiting = 0;      // 依赖已满足、但被并发上限挡住的步骤
    for (const s of task.steps) {
      if (s.status !== 'pending' || !s.dependsOn.every(d => by.get(d).status === 'succeeded')) continue;
      if (live.size >= this.config.maxParallelStepsPerTask || this.#stepsLive() >= (this.config.maxParallelSteps ?? Infinity)) waiting++;
      else this.#startStep(task, s);
    }
    if (live.size || waiting) return;
    const ok = task.steps.every(s => s.status === 'succeeded');
    this.#live.delete(taskId);
    this.store.tx(() => {
      this.store.setTask(taskId, {status: ok ? 'succeeded' : 'failed', finishedAt: now()});
      this.store.event(taskId, null, ok ? 'task_succeeded' : 'task_failed', {
        failed: task.steps.filter(s => s.status === 'failed').map(s => s.id),
        blocked: task.steps.filter(s => s.status === 'blocked').map(s => s.id),
        final: ok ? task.steps.at(-1).artifact : null});
    });
    this.#pump();
  }

  #stepsLive() { let n = 0; for (const live of this.#live.values()) n += live.size; return n; }
  // 有全局步骤上限时，一个任务腾出名额后，其他在等名额的任务也要推进一次
  #advanceOthers(taskId) {
    if (this.config.maxParallelSteps == null) return;
    for (const id of [...this.#live.keys()]) if (id !== taskId) this.#advance(id);
  }

  #startStep(task, step) {
    const live = this.#live.get(task.id), attempt = step.attempt + 1, ctrl = new AbortController(), t0 = Date.now();
    live.set(step.id, {ctrl, attempt});
    step.status = 'running';
    this.store.tx(() => {
      this.store.setStep(task.id, step.id, {status: 'running', attempt, startedAt: now(), finishedAt: null, error: null, artifact: null});
      this.store.event(task.id, step.id, 'step_started', {attempt, tool: step.tool});
    });
    // 取消、重启之后，旧的那次执行就不再是「当前」，它的进度和结果一律丢弃
    const current = () => !this.#stopped && this.#live.get(task.id)?.get(step.id)?.attempt === attempt;
    const failed = err => {
      const error = err?.name === 'TimeoutError' ? `STEP_TIMEOUT 超过 ${this.config.stepTimeoutMs}ms` : String(err?.message || err).slice(0, 500);
      this.store.tx(() => {
        this.store.setStep(task.id, step.id, {status: 'failed', error, finishedAt: now()});
        this.store.event(task.id, step.id, 'step_failed', {attempt, error, ms: Date.now() - t0});
      });
    };
    const settle = (ok, payload) => {
      if (!current()) return;
      live.delete(step.id);
      try {
        if (!ok) failed(payload);
        else {
          const content = typeof payload === 'string' ? payload : payload?.content;
          if (typeof content !== 'string') throw new Error('TOOL_RETURNED_NO_CONTENT');
          const artifact = this.store.writeArtifact(task.id, step.id, attempt, content, payload?.ext);
          this.store.tx(() => {
            this.store.setStep(task.id, step.id, {status: 'succeeded', artifact, finishedAt: now()});
            this.store.event(task.id, step.id, 'step_succeeded', {attempt, artifact, bytes: Buffer.byteLength(content), ms: Date.now() - t0});
          });
        }
      } catch (e) { failed(e); }
      this.#advance(task.id);
      this.#advanceOthers(task.id);
    };
    const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(this.config.stepTimeoutMs)]);
    const aborted = new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason), {once: true}));
    const run = async () => {
      const tool = this.tools.get(step.tool);
      if (!tool) throw new Error(`TOOL_NOT_FOUND ${step.tool}`);
      const inputs = step.dependsOn.map(d => {
        const dep = task.steps.find(s => s.id === d);
        return {id: d, title: dep.title, content: this.store.readArtifact(dep.artifact)};
      });
      return tool.run(step.args, {
        signal, inputs, mock: this.config.mode === 'mock',
        task: {id: task.id, title: task.title, request: task.request},
        step: {id: step.id, title: step.title, attempt},
        progress: p => { if (current()) this.store.event(task.id, step.id, 'step_progress', {attempt, ...(typeof p === 'string' ? {note: p} : p)}); },
      });
    };
    Promise.race([run(), aborted]).then(out => settle(true, out), err => settle(false, err));
  }
}
