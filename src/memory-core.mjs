// Portable, storage-free memory rules. The host owns authentication and transactions.
const DAY = 86_400_000;
const HOUR = 3_600_000;
const CLARITIES = ['vivid', 'clear', 'fuzzy', 'trace', 'forgotten'];
const QQ_SCOPE = /^qq:(g|p):([1-9]\d{4,11})$/;
const WECHAT_SCOPE = /^wechat:(g|p):([a-f0-9]{64})$/;

export function parseScope(scope) {
  if (scope === 'owner:private') return { kind: 'owner-private', id: 'owner' };
  const match = QQ_SCOPE.exec(scope) || WECHAT_SCOPE.exec(scope);
  if (!match) throw new TypeError('Invalid memory scope');
  const provider=scope.startsWith('wechat:')?'wechat':'qq';
  return { kind: `${provider}-${match[1] === 'g' ? 'group' : 'private'}`, id: match[2] };
}

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  return value;
}

// Only authenticated inbound events may call this. IDs must be stable platform IDs.
export function observedUserTurn({ id, scope, actor, text, at }) {
  parseScope(scope);
  requiredText(id, 'id'); requiredText(actor, 'actor'); requiredText(text, 'text');
  if (!Number.isFinite(at)) throw new TypeError('at must be a timestamp');
  return { id, scope, actor, role: 'user', text, at };
}

// The generated plan is intentionally absent from this API.
export function deliveredAssistantTurn({ scope, receipt, at }) {
  parseScope(scope);
  if (receipt?.status !== 'delivered') return null;
  requiredText(receipt.platformMessageId, 'platformMessageId');
  requiredText(receipt.text, 'delivered text');
  if (!Number.isFinite(at)) throw new TypeError('at must be a timestamp');
  return { id: `sent:${receipt.platformMessageId}`, scope, actor: 'assistant', role: 'assistant', text: receipt.text, at };
}

export function validateFactCandidate(candidate, batch) {
  if (!candidate || !Array.isArray(batch)) throw new TypeError('candidate and batch are required');
  parseScope(candidate.scope);
  requiredText(candidate.actor, 'actor');
  requiredText(candidate.key, 'fact key');
  requiredText(candidate.content, 'fact content');
  if (!Array.isArray(candidate.evidence) || candidate.evidence.length === 0) throw new Error('Fact has no evidence');
  const byId = new Map(batch.map(turn => [turn.id, turn]));
  const seen = new Set();
  const evidenceTurns = [];
  for (const evidence of candidate.evidence) {
    if (!evidence || seen.has(evidence.turnId)) throw new Error('Duplicate or invalid evidence ID');
    seen.add(evidence.turnId);
    const turn = byId.get(evidence.turnId);
    if (!turn || turn.role !== 'user' || turn.scope !== candidate.scope || turn.actor !== candidate.actor) {
      throw new Error('Evidence does not belong to the same authenticated speaker and scope');
    }
    if (typeof evidence.quote !== 'string' || evidence.quote.length < 2 || !turn.text.includes(evidence.quote)) {
      throw new Error('Evidence quote is not an exact substring of the user turn');
    }
    if (!Number.isFinite(turn.at)) throw new Error('Evidence timestamp is invalid');
    evidenceTurns.push(turn);
  }
  return { ...candidate, evidenceTurns };
}

export function evidenceSpread(validated) {
  const times = validated.evidenceTurns.map(turn => turn.at).sort((a, b) => a - b);
  const episodes = new Set(times.map(at => Math.floor(at / (6 * HOUR))));
  const days = new Set(times.map(at => Math.floor((at + 8 * HOUR) / DAY)));
  return { episodes: episodes.size, days: days.size, spanDays: (times.at(-1) - times[0]) / DAY };
}

// trustedOwnerRequest must come from authenticated host input, never model output.
export function classifyFact(validated, { trustedOwnerRequest = false } = {}) {
  const { kind, durability = 'developing', importance = 0.5 } = validated;
  if (!['preference', 'profile', 'relationship', 'goal', 'event'].includes(kind)) throw new TypeError('Invalid fact kind');
  if (!Number.isFinite(importance) || importance < 0 || importance > 1) throw new TypeError('Invalid importance');
  const spread = evidenceSpread(validated);
  let tier = 'medium';
  let basis = 'developing';
  if (trustedOwnerRequest && validated.scope === 'owner:private' && validated.actor === 'owner') {
    tier = 'long'; basis = 'owner-request';
  } else if (durability === 'landmark' && ['event', 'relationship'].includes(kind) && importance >= 0.85) {
    tier = 'long'; basis = 'landmark';
  } else if (durability === 'stable' && ['profile', 'relationship'].includes(kind) && importance >= 0.8) {
    tier = 'long'; basis = 'stable-identity';
  } else if (['profile', 'preference', 'relationship'].includes(kind) && spread.episodes >= 3 && spread.days >= 3 && spread.spanDays >= 7) {
    tier = 'long'; basis = 'repeated-evidence';
  } else if (durability === 'transient') {
    tier = 'short'; basis = 'transient';
  }
  return { tier, basis, spread };
}

function tokens(text) {
  const result = new Set();
  for (const part of String(text || '').toLowerCase().match(/[a-z0-9_]{2,}|[\u4e00-\u9fff]+/g) || []) {
    if (/^[a-z0-9_]+$/.test(part)) result.add(part);
    else for (let index = 0; index < part.length - 1; index++) result.add(part.slice(index, index + 2));
  }
  return [...result].slice(0, 24);
}

export function dailyText(card) {
  const clarity = card.daily?.clarity;
  if (clarity === 'forgotten') return '';
  if (clarity === 'clear') return card.content.slice(0, 200);
  if (clarity === 'fuzzy') return `${card.content.slice(0, 42)}（细节不清）`;
  if (clarity === 'trace') return `${card.content.replace(/^\[QQ [^\]]+\]\s*/, '').split(/[\n。！？]/)[0].slice(0, 22)}（只剩印象）`;
  if (clarity === 'vivid') return card.content;
  throw new TypeError('Invalid clarity');
}

export function selectDailyCards(cards, { scope, query = '', maxCards = 12, maxChars = 6000 }) {
  const viewer = parseScope(scope);
  const terms = tokens(query);
  const scored = cards.filter(card => {
    if (card.scope !== scope || card.confirmed !== true || card.status !== 'active') return false;
    if (!CLARITIES.includes(card.daily?.clarity) || card.daily.clarity === 'forgotten') return false;
    if (card.visibility === 'subject-private') {
      return (viewer.kind === 'qq-private' || viewer.kind === 'wechat-private') && card.subjectId === viewer.id ||
        viewer.kind === 'owner-private' && card.subjectId === 'owner';
    }
    return card.visibility === 'scope';
  }).map(card => {
    const text = dailyText(card);
    const hits = terms.filter(term => text.toLowerCase().includes(term)).length;
    return { card, text, score: hits * 3 + (card.importance || 0) + (card.pinned ? 2 : 0) };
  }).sort((a, b) => b.score - a.score || (b.card.lastEvidenceAt || 0) - (a.card.lastEvidenceAt || 0));
  const selected = [];
  let remaining = maxChars;
  for (const item of scored) {
    if (selected.length >= maxCards) break;
    if (item.text.length > remaining) continue;
    selected.push(item);
    remaining -= item.text.length;
  }
  return selected;
}

export function maintenanceDay(at) { return Math.floor((at + 4 * HOUR) / DAY); }

function targetClarity(card, at) {
  if (card.status !== 'active' || card.confirmed !== true) return 'forgotten';
  if (card.pinned) return 'vivid';
  const d = card.daily;
  const age = Math.max(0, (at - Math.max(d.evidenceAt, d.recalledAt || 0)) / DAY);
  const ongoing = card.kind === 'goal' && card.goalState === 'ongoing' && (card.dueAt == null || card.dueAt > at);
  const ended = card.kind === 'goal' && !ongoing;
  const protectedMemory = !ended && (card.tier === 'long' || card.scope === 'owner:private' && card.importance >= 0.65);
  if (!protectedMemory && !ongoing && age > 60 && card.importance < 0.5) return 'forgotten';
  const threshold = { short: 2, medium: 7, long: 30 }[card.tier];
  const penalty = { short: 2, medium: 0.35, long: 0.12 }[card.tier];
  if (threshold === undefined) throw new TypeError('Invalid tier');
  let retention = card.importance * 100 + Math.min(12, (d.recallCount || 0) * 2) + (age <= 7 ? 18 : 0) + (age <= 2 ? 8 : 0) - Math.max(0, age - threshold) * penalty;
  if (protectedMemory) retention = Math.max(46, retention);
  if (ongoing) retention = Math.max(50, retention);
  if (age <= 7 && !ended) retention = Math.max(46, retention);
  if (ended) retention = Math.min(23, retention);
  return retention >= 68 ? 'vivid' : retention >= 46 ? 'clear' : retention >= 24 ? 'fuzzy' : retention >= 12 ? 'trace' : 'forgotten';
}

// Returns a full pre-change archive and a daily-only update. The caller commits both atomically.
export function planDailyMaintenance(card, now) {
  parseScope(card.scope);
  if (!Number.isFinite(now) || !card.daily || !CLARITIES.includes(card.daily.clarity)) throw new TypeError('Invalid maintenance input');
  const today = maintenanceDay(now);
  if (card.daily.day >= today || card.daily.clarity === 'forgotten') return null;
  const archive = { ...card, daily: { ...card.daily } };
  const next = { ...card.daily, day: today };
  const days = Math.min(30, today - card.daily.day);
  for (let index = 0; index < days; index++) {
    const at = (today - days + index + 1) * DAY - 4 * HOUR;
    const wanted = targetClarity(card, at);
    const currentIndex = CLARITIES.indexOf(next.clarity);
    const wantedIndex = CLARITIES.indexOf(wanted);
    next.clarity = CLARITIES[currentIndex + Math.sign(wantedIndex - currentIndex)];
    if (next.clarity === 'forgotten') break;
  }
  return { archive, next: { cardId: card.id, ...next } };
}

export function commitDailyMaintenance(plan, repository) {
  if (!plan) return false;
  if (typeof repository?.transaction !== 'function') throw new TypeError('Atomic transaction is required');
  repository.transaction(tx => {
    tx.appendFullArchive(plan.archive);
    tx.updateDaily(plan.next);
  });
  return true;
}
