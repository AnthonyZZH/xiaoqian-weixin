import {createHash} from 'node:crypto';

const active = status => status === 'queued' || status === 'running';
const generation = `(SELECT MAX(e.seq) FROM events e WHERE e.taskId=t.id
  AND e.type IN ('task_created','task_requeued','task_recovered'))`;

function versionFor(row) {
  if (!row?.generation || !active(row.status)) return null;
  return createHash('sha256').update([row.id, row.createdAt, row.generation].join('/')).digest('hex');
}

export function createMobileBackgroundTasks(ownerTasks) {
  if (!ownerTasks) return {list: () => null, cancel: () => false};
  const {store, engine} = ownerTasks;
  const summary = store.db.prepare(`
    WITH visible(id) AS (
      SELECT id FROM tasks WHERE status IN ('queued','running')
      UNION ALL
      SELECT id FROM (SELECT id FROM tasks WHERE status IN ('succeeded','failed','cancelled')
                      ORDER BY finishedAt DESC, id DESC LIMIT 10)
    )
    SELECT t.id, t.title, t.status, t.createdAt, ${generation} AS generation,
           COUNT(s.id) AS total, COUNT(CASE WHEN s.status='succeeded' THEN 1 END) AS completed
    FROM visible JOIN tasks t USING (id) LEFT JOIN steps s ON s.taskId=t.id
    GROUP BY t.id
    ORDER BY CASE t.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
             COALESCE(t.finishedAt,t.createdAt) DESC, t.id DESC`);
  const target = store.db.prepare(`SELECT t.id, t.createdAt, t.status, ${generation} AS generation
                                   FROM tasks t WHERE t.id=?`);
  return {
    list() {
      return summary.all().map(row => {
        const version = versionFor(row);
        return {id: String(row.id), title: row.title.slice(0,80), status: row.status,
                createdAt: row.createdAt, completed: row.completed, total: row.total,
                version, canCancel: version !== null};
      });
    },
    cancel({id, version}) {
      if (typeof id !== 'string' || !/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))
          || typeof version !== 'string' || !/^[0-9a-f]{64}$/.test(version)) return false;
      // The host is the sole engine writer. No yield between the generation check and cancellation.
      if (versionFor(target.get(Number(id))) !== version) return false;
      return engine.cancel(Number(id)).status === 'cancelled';
    }
  };
}
