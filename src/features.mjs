import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const steering = /ignore\s+(all|previous)|system\s*prompt|prompt\s*injection|(?:执行|忽略|覆盖).{0,8}(?:指令|规则|提示)|(?:api[_ -]?key|password|密码|密钥)\s*[:：=]/iu;
const privateIdentifier = /\b\d{7,}\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u;

export function scopedDirectory(root, ...parts) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('STATE_ROOT_MUST_BE_ABSOLUTE');
  const resolved = path.resolve(root);
  let cursor = path.parse(resolved).root;
  for (const part of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor)) {
      if (fs.lstatSync(cursor).isSymbolicLink() || !fs.statSync(cursor).isDirectory()) throw new Error('UNSAFE_STATE_ROOT');
    } else fs.mkdirSync(cursor);
  }
  for (const part of parts) {
    if (!/^[a-zA-Z0-9_-]+$/.test(part)) throw new Error('UNSAFE_STATE_COMPONENT');
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor)) {
      if (fs.lstatSync(cursor).isSymbolicLink() || !fs.statSync(cursor).isDirectory()) throw new Error('UNSAFE_STATE_DIRECTORY');
    } else fs.mkdirSync(cursor);
  }
  return cursor;
}
export function readJson(file, fallback) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('UNSAFE_STATE_FILE');
    if (fs.statSync(file).size > 1024 * 1024) throw new Error('STATE_TOO_LARGE');
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) { if (error.code === 'ENOENT') return clone(fallback); throw error; }
}
export function atomicJson(file, data) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('UNSAFE_STATE_FILE');
  const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n', 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
export function trustedChats(chats) {
  if (!Array.isArray(chats)) throw new Error('CHATS_MUST_BE_EXPLICIT_RECORDS');
  const records = new Map();
  for (const chat of chats) {
    if (!chat || typeof chat.id !== 'string' || !chat.id || chat.id.length > 256 || !['private', 'group'].includes(chat.mode) ||
        typeof chat.title !== 'string' || !chat.title || typeof chat.owner !== 'boolean' || (chat.owner && chat.mode !== 'private') ||
        records.has(chat.id)) throw new Error('INVALID_CHAT_RECORD');
    records.set(chat.id, Object.freeze(clone(chat)));
  }
  if ([...records.values()].filter(c => c.owner).length > 1) throw new Error('MULTIPLE_OWNER_CHATS');
  return records;
}
function text(value, max, { empty = true, filtered = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new Error('INVALID_FEATURE_TEXT');
  const result = value.trim();
  if (filtered && (steering.test(result) || privateIdentifier.test(result))) throw new Error('MEMORY_CONTENT_REJECTED');
  return result;
}
function memoryData(input) {
  if (!input || !Array.isArray(input.facts) || input.facts.length > 500 || typeof input.style !== 'string') throw new Error('INVALID_MEMORY');
  const facts = [...new Set(input.facts.map(f => text(f, 240, { empty: false, filtered: true })))];
  return { facts, style: text(input.style, 600, { filtered: true }) };
}
function terms(value) {
  return (String(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).flatMap(w =>
    /[\u3400-\u9FFF]/u.test(w) && w.length > 1 ? [w, ...Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2))] : [w]);
}

/** Chat-scoped business storage. No main/private vault or arbitrary path interface. */
export class FeatureStore {
  constructor({ stateDir, chats, clock = Date.now, search = null, draw = null } = {}) {
    this.root = scopedDirectory(stateDir, 'features');
    this.chats = trustedChats(chats);
    this.clock = clock;
    this.adapters = { search, draw };
  }
  chat(id) { const chat = this.chats.get(id); if (!chat) throw new Error('CHAT_NOT_REGISTERED'); return chat; }
  namespace(id) {
    const chat = this.chat(id);
    return scopedDirectory(this.root, chat.owner ? 'owner' : chat.mode, hash([chat.mode, chat.id]));
  }
  _file(id) { return path.join(this.namespace(id), 'memory.json'); }
  readMemory(id) {
    const value = readJson(this._file(id), { version: 1, facts: [], style: '' });
    if (value.version !== 1) throw new Error('UNSUPPORTED_MEMORY_VERSION');
    const data = memoryData(value);
    return { ...clone(data), revision: hash(data) };
  }
  editMemory(id, { expectedRevision, facts, style } = {}) {
    const current = this.readMemory(id);
    if (expectedRevision !== current.revision) throw new Error('MEMORY_CONFLICT');
    const data = memoryData({ facts, style });
    if (hash(data) === current.revision) return current;
    const dir = this.namespace(id);
    if (fs.existsSync(this._file(id))) {
      const backupDir = scopedDirectory(dir, 'backups');
      atomicJson(path.join(backupDir, String(this.clock()) + '-' + randomUUID() + '.json'), { version: 1, facts: current.facts, style: current.style });
    }
    atomicJson(this._file(id), { version: 1, ...data });
    return { ...clone(data), revision: hash(data) };
  }
  appendMemory(id, facts) {
    if (!Array.isArray(facts)) throw new Error('INVALID_MEMORY');
    const current = this.readMemory(id);
    return this.editMemory(id, { expectedRevision: current.revision, facts: [...current.facts, ...facts], style: current.style });
  }
  queryMemory(id, query, { limit = 5 } = {}) {
    text(query, 2000);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('INVALID_QUERY_LIMIT');
    const data = this.readMemory(id), wanted = new Set(terms(query));
    return data.facts.map((fact, index) => ({ fact, index, score: terms(fact).filter(t => wanted.has(t)).length }))
      .filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, limit).map(row => row.fact);
  }
  persona(id) {
    const chat = this.chat(id), file = path.join(this.namespace(id), 'persona.json');
    const value = readJson(file, { version: 1, text: typeof chat.persona === 'string' ? chat.persona : '' });
    if (value.version !== 1) throw new Error('UNSUPPORTED_PERSONA_VERSION');
    return text(value.text, 12000);
  }
  setPersona(id, value) {
    const persona = text(value, 12000);
    atomicJson(path.join(this.namespace(id), 'persona.json'), { version: 1, text: persona });
    return persona;
  }
  /** Adapters are injected application capabilities, never inferred from chat text. */
  async search(id, query) {
    this.chat(id); text(query, 2000, { empty: false });
    if (typeof this.adapters.search !== 'function') throw new Error('SEARCH_UNAVAILABLE');
    const result = await this.adapters.search({ chatId: id, query });
    if (!Array.isArray(result) || result.length > 20) throw new Error('INVALID_SEARCH_RESULT');
    return result.map(item => ({ title: text(item.title, 500), url: text(item.url, 2000), snippet: text(item.snippet || '', 2000) }));
  }
  async draw(id, prompt) {
    const chat = this.chat(id); text(prompt, 4000, { empty: false });
    if (!chat.owner) throw new Error('OWNER_REQUIRED');
    if (typeof this.adapters.draw !== 'function') throw new Error('DRAW_UNAVAILABLE');
    return this.adapters.draw({ chatId: id, prompt });
  }
}
