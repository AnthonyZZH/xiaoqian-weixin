// 持久化：SQLite（任务、步骤、事件、聊天记录）+ 磁盘上的产物文件。
// 所有状态变更和它对应的事件写在同一个事务里；事件在提交之后才通知监听者。
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const now = () => new Date().toISOString();
const parse = v => (v == null ? null : JSON.parse(v));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,request TEXT NOT NULL,
  status TEXT NOT NULL,mock INTEGER NOT NULL,createdAt TEXT NOT NULL,startedAt TEXT,finishedAt TEXT);
CREATE TABLE IF NOT EXISTS steps(taskId INTEGER NOT NULL,id TEXT NOT NULL,ord INTEGER NOT NULL,title TEXT NOT NULL,
  tool TEXT NOT NULL,args TEXT NOT NULL,dependsOn TEXT NOT NULL,status TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,
  startedAt TEXT,finishedAt TEXT,error TEXT,artifact TEXT,PRIMARY KEY(taskId,id));
CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,taskId INTEGER NOT NULL,stepId TEXT,
  type TEXT NOT NULL,at TEXT NOT NULL,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_task ON events(taskId,seq);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,role TEXT NOT NULL,text TEXT NOT NULL,at TEXT NOT NULL);`;

export class Store {
  #depth = 0; #pending = [];
  onEvent = null;

  constructor(dataDir) {
    this.dir = path.resolve(dataDir);
    fs.mkdirSync(path.join(this.dir, 'artifacts'), {recursive: true});
    this.db = new DatabaseSync(path.join(this.dir, 'tasks.sqlite3'));
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.db.exec(SCHEMA);
  }
  close() { this.db.close(); }

  // 可重入事务。最外层提交后才把期间产生的事件发给监听者；回滚则丢弃。
  tx(fn) {
    if (this.#depth++ === 0) this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      if (--this.#depth === 0) { this.db.exec('COMMIT'); this.#flush(); }
      return out;
    } catch (e) {
      if (--this.#depth === 0) { this.db.exec('ROLLBACK'); this.#pending = []; }
      throw e;
    }
  }
  #flush() {
    const evs = this.#pending; this.#pending = [];
    for (const ev of evs) this.onEvent?.(ev);
  }

  event(taskId, stepId, type, data = {}) {
    const at = now();
    const seq = Number(this.db.prepare('INSERT INTO events(taskId,stepId,type,at,data) VALUES(?,?,?,?,?)')
      .run(taskId, stepId, type, at, JSON.stringify(data)).lastInsertRowid);
    this.#pending.push({seq, taskId, stepId, type, at, data});
    if (this.#depth === 0) this.#flush();
  }
  events(taskId, afterSeq = 0) {
    return this.db.prepare('SELECT * FROM events WHERE taskId=? AND seq>? ORDER BY seq').all(taskId, afterSeq)
      .map(r => ({...r, data: parse(r.data)}));
  }

  createTask({title, request, mock, steps}) {
    return this.tx(() => {
      const id = Number(this.db.prepare('INSERT INTO tasks(title,request,status,mock,createdAt) VALUES(?,?,?,?,?)')
        .run(title, request, 'queued', mock ? 1 : 0, now()).lastInsertRowid);
      const ins = this.db.prepare('INSERT INTO steps(taskId,id,ord,title,tool,args,dependsOn,status) VALUES(?,?,?,?,?,?,?,?)');
      steps.forEach((s, i) => ins.run(id, s.id, i, s.title, s.tool, JSON.stringify(s.args), JSON.stringify(s.dependsOn), 'pending'));
      this.event(id, null, 'task_created', {title, mock: !!mock,
        steps: steps.map(s => ({id: s.id, title: s.title, tool: s.tool, dependsOn: s.dependsOn}))});
      return id;
    });
  }
  getTask(id) {
    const t = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!t) return null;
    const steps = this.db.prepare('SELECT * FROM steps WHERE taskId=? ORDER BY ord').all(id)
      .map(s => ({...s, args: parse(s.args), dependsOn: parse(s.dependsOn)}));
    return {...t, mock: !!t.mock, steps};
  }
  taskIds(statuses) {
    const where = statuses ? `WHERE status IN (${statuses.map(() => '?').join(',')})` : '';
    // 之前已经开始过的任务（恢复、重试）排在从未开始的前面，其余按提交顺序
    return this.db.prepare(`SELECT id FROM tasks ${where} ORDER BY (startedAt IS NULL), id`).all(...(statuses || [])).map(r => r.id);
  }
  setTask(id, fields) { this.#update('tasks', fields, 'id=?', [id]); }
  setStep(taskId, id, fields) { this.#update('steps', fields, 'taskId=? AND id=?', [taskId, id]); }
  #update(table, fields, where, params) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE ${table} SET ${keys.map(k => k + '=?').join(',')} WHERE ${where}`).run(...keys.map(k => fields[k]), ...params);
  }

  // 产物：先写临时文件再改名，保证读到的要么是完整文件，要么没有。每次尝试一个文件，不覆盖旧的。
  writeArtifact(taskId, stepId, attempt, content, ext = 'md') {
    if (!/^[a-z0-9]{1,8}$/.test(ext)) ext = 'txt';
    const rel = `artifacts/task-${taskId}/${stepId}.a${attempt}.${ext}`, abs = path.join(this.dir, rel);
    fs.mkdirSync(path.dirname(abs), {recursive: true});
    fs.writeFileSync(abs + '.tmp', content, 'utf8');
    fs.renameSync(abs + '.tmp', abs);
    return rel;
  }
  artifactPath(rel) {
    const abs = path.resolve(this.dir, rel);
    if (!abs.startsWith(this.dir + path.sep)) throw new Error('ARTIFACT_PATH_OUTSIDE_DATA_DIR');
    return abs;
  }
  readArtifact(rel) { return fs.readFileSync(this.artifactPath(rel), 'utf8'); }
  hasArtifact(rel) { return !!rel && fs.existsSync(this.artifactPath(rel)); }

  addMessage(role, text) {
    const at = now();
    const id = Number(this.db.prepare('INSERT INTO messages(role,text,at) VALUES(?,?,?)').run(role, text, at).lastInsertRowid);
    return {id, role, text, at};
  }
  messages(limit = 200) {
    return this.db.prepare('SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT ?) ORDER BY id').all(limit).map(r => ({...r}));
  }
}
