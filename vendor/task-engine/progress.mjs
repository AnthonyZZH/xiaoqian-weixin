// 进度只从事件流重放得到，不读步骤表、不做估算。
// 引擎的每次状态变更都和事件写在同一个事务里，所以重放结果和表里的状态一致（测试里有校验）。
export function replay(events) {
  const t = {status: 'queued', title: '', mock: false, startedAt: null, finishedAt: null, lastSeq: 0, steps: []};
  const by = new Map();
  for (const ev of events) {
    t.lastSeq = ev.seq;
    const s = ev.stepId ? by.get(ev.stepId) : null, d = ev.data || {};
    switch (ev.type) {
      case 'task_created':
        t.title = d.title; t.mock = d.mock;
        t.steps = d.steps.map(x => ({...x, status: 'pending', attempt: 0}));
        for (const x of t.steps) by.set(x.id, x);
        break;
      case 'task_started': t.status = 'running'; t.startedAt ??= ev.at; break;
      case 'task_succeeded': case 'task_failed': case 'task_cancelled':
        t.status = ev.type.slice(5); t.finishedAt = ev.at; break;
      case 'task_requeued': case 'task_recovered': t.status = 'queued'; t.finishedAt = null; break;
      case 'step_started':
        Object.assign(s, {status: 'running', attempt: d.attempt, startedAt: ev.at, finishedAt: null,
          error: null, artifact: null, because: null, note: null, done: null, total: null});
        break;
      case 'step_progress':
        if (s.status === 'running' && s.attempt === d.attempt) Object.assign(s, {note: d.note ?? s.note, done: d.done ?? s.done, total: d.total ?? s.total});
        break;
      case 'step_succeeded': Object.assign(s, {status: 'succeeded', artifact: d.artifact, finishedAt: ev.at}); break;
      case 'step_failed': Object.assign(s, {status: 'failed', error: d.error, finishedAt: ev.at}); break;
      case 'step_cancelled': Object.assign(s, {status: 'cancelled', finishedAt: ev.at}); break;
      case 'step_blocked': Object.assign(s, {status: 'blocked', because: d.because}); break;
      case 'step_retry': case 'step_interrupted': case 'step_artifact_missing':
        Object.assign(s, {status: 'pending', artifact: null, error: null, because: null, finishedAt: null}); break;
    }
  }
  const counts = {total: t.steps.length, pending: 0, running: 0, succeeded: 0, failed: 0, blocked: 0, cancelled: 0};
  for (const s of t.steps) counts[s.status]++;
  return {...t, counts, percent: counts.total ? Math.round(counts.succeeded / counts.total * 100) : 0};
}
