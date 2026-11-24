'use strict';
const state = document.getElementById('state');
const detail = document.getElementById('detail');
const chats = document.getElementById('chats');
const updated = document.getElementById('updated');
const refresh = document.getElementById('refresh');
const access = document.getElementById('access');
const heading = document.getElementById('chat-heading');
const restart = document.getElementById('restart');
const actionNote = document.getElementById('action-note');
const taskSection = document.getElementById('task-section');
const tasks = document.getElementById('tasks');
const taskHistory = document.getElementById('task-history');
const taskHistoryLabel = document.getElementById('task-history-label');
const taskHistoryLatest = document.getElementById('task-history-latest');
const finishedTasks = document.getElementById('finished-tasks');
const taskLabels = new Map([
  ['queued', '排队中'], ['running', '执行中'], ['succeeded', '已完成'],
  ['failed', '失败'], ['cancelled', '已中断'],
]);
const pendingCancellations = new Map();
const stepLabels = new Map([
  ['pending', '等待中'], ['running', '执行中'], ['succeeded', '已完成'],
  ['blocked', '依赖阻塞'], ['failed', '失败'], ['cancelled', '已中断'],
]);
const stepSymbols = new Map([
  ['pending', '○'], ['running', '▶'], ['succeeded', '✓'],
  ['blocked', 'Ⅱ'], ['failed', '!'], ['cancelled', '×'],
]);
let taskSnapshot;
let clockAt = 0;
let clockObservedAt = 0;
let timer;
let sending = false;
let revision = 0;
let restarting = null;

function pageKey() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  return fragment.get('manage') || fragment.get('view');
}

function note(message) {
  actionNote.textContent = message;
  actionNote.hidden = !message;
}

function accessPrompt(message) {
  state.textContent = '需要查看码';
  state.classList.remove('ok');
  detail.textContent = message;
  chats.replaceChildren();
  tasks.replaceChildren();
  finishedTasks.replaceChildren();
  taskHistoryLatest.textContent = '';
  taskHistory.hidden = true;
  taskSection.hidden = true;
  taskSnapshot = null;
  pendingCancellations.clear();
  refresh.hidden = true;
  updated.textContent = '';
  access.hidden = false;
  heading.hidden = true;
  restart.hidden = true;
  note('');
}

function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function activeTask(task) {
  return task.status === 'queued' || task.status === 'running';
}

function duration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return Math.floor(minutes / 60) + '小时' + minutes % 60 + '分';
  if (minutes) return minutes + '分' + String(seconds % 60).padStart(2, '0') + '秒';
  return seconds + '秒';
}

function updateElapsed() {
  if (document.hidden) return;
  const now = clockAt ? clockAt + performance.now() - clockObservedAt : Date.now();
  for (const clock of tasks.querySelectorAll('[data-elapsed-start]')) {
    const value = duration(now - Number(clock.dataset.elapsedStart));
    if (clock.textContent !== value) clock.textContent = value;
  }
}

function elapsedLabel(task, steps) {
  const starts = steps.map(step => Date.parse(step.startedAt)).filter(Number.isFinite);
  const start = Number.isFinite(Date.parse(task.startedAt)) ? Date.parse(task.startedAt) : Math.min(...starts);
  const end = Date.parse(task.finishedAt);
  const live = activeTask(task);
  const running = task.status !== 'queued' && Number.isFinite(start);
  const since = running ? start : Date.parse(task.createdAt);
  if (!Number.isFinite(since) || (!live && (!running || !Number.isFinite(end) || end < since))) return null;
  const label = element('span', live ? (running ? '已运行 ' : '创建于 ') : '总用时 ');
  label.className = 'task-elapsed';
  if (live && !running) {
    label.append(element('strong', new Date(since).toLocaleString('zh-CN', {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false})));
  } else {
    const value = element('strong', live ? '' : duration(end - since));
    if (live) value.dataset.elapsedStart = String(since);
    label.append(value);
  }
  return label;
}

function taskBody(task) {
  const body = document.createDocumentFragment();
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const header = document.createElement('header');
  const title = element('h3', task.title || ('任务 #' + task.id));
  const badge = element('span', taskLabels.get(task.status) || '状态未知');
  badge.className = 'task-badge';
  badge.dataset.status = task.status;
  header.append(title, badge);
  const meta = document.createElement('div');
  meta.className = 'task-meta';
  if (task.title) meta.append(element('span', '任务 #' + task.id));
  const elapsed = elapsedLabel(task, steps);
  if (elapsed) meta.append(elapsed);
  const progress = document.createElement('div');
  progress.className = 'task-progress';
  const parallel = task.status === 'running' ? steps.filter(step => step.status === 'running').length : 0;
  progress.append(element('span', parallel > 1 ? parallel + ' 步并行中' : '步骤进度'),
    element('span', '已完成 ' + task.completed + ' / ' + task.total));
  body.append(header, meta, progress);
  if (steps.length) {
    const segments = document.createElement('div');
    segments.className = 'step-segments';
    segments.setAttribute('aria-hidden', 'true');
    const timeline = document.createElement('ol');
    timeline.className = 'step-timeline';
    timeline.setAttribute('aria-label', '任务步骤');
    for (const step of steps) {
      const status = stepLabels.has(step.status) ? step.status : 'unknown';
      const segment = document.createElement('span');
      segment.dataset.status = status;
      segments.append(segment);
      const row = document.createElement('li');
      row.dataset.status = status;
      const marker = element('span', stepSymbols.get(status) || '?');
      marker.className = 'step-marker';
      marker.setAttribute('aria-hidden', 'true');
      const info = document.createElement('div');
      const label = element('span', step.title || '未命名步骤');
      label.className = 'step-title';
      const detail = element('span', (status === 'running' && step.phase) || stepLabels.get(status) || '状态未知');
      detail.className = 'step-state';
      const start = Date.parse(step.startedAt);
      const end = Date.parse(step.finishedAt);
      if (status === 'running' && task.status === 'running' && steps.length > 1 && Number.isFinite(start)) {
        const elapsed = document.createElement('span');
        elapsed.dataset.elapsedStart = String(start);
        detail.append(' · ', elapsed);
      } else if (Number.isFinite(start) && end >= start) {
        detail.append(' · ' + duration(end - start));
      }
      info.append(label, detail);
      row.append(marker, info);
      timeline.append(row);
    }
    body.append(segments, timeline);
  } else {
    const note = element('p', Array.isArray(task.steps) ? '暂无步骤记录。' : '暂时无法读取步骤明细。');
    note.className = 'steps-unavailable';
    body.append(note);
  }
  return body;
}

function taskCard(task, data, pending, existing) {
  const card = existing || document.createElement('article');
  card.className = 'task-card';
  card.dataset.taskId = task.id;
  const contentKey = JSON.stringify(task);
  if (card.contentKey !== contentKey) {
    const content = card.firstElementChild || document.createElement('div');
    content.replaceChildren(taskBody(task));
    if (!content.parentElement) card.prepend(content);
    card.contentKey = contentKey;
  }
  let cancel = card.querySelector('.cancel-task');
  if (data.manager && activeTask(task) && (task.canCancel || pending)) {
    if (!cancel) {
      cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'cancel-task';
      card.append(cancel);
    }
    cancel.textContent = pending ? '正在中断…' : '中断任务';
    cancel.disabled = sending || !!restarting || data.restarting || !data.instance || !task.version || pending;
    cancel.onclick = () => action('cancel-task', data.instance, task);
  } else cancel?.remove();
  return card;
}

function placeCards(container, nodes) {
  const keep = new Set(nodes);
  for (const child of Array.from(container.children)) if (!keep.has(child)) child.remove();
  nodes.forEach((node, index) => {
    const next = container.children[index] || null;
    if (next === node) return;
    if (node.parentElement === container && container.moveBefore) container.moveBefore(node, next);
    else container.insertBefore(node, next);
  });
}

function renderTasks(data) {
  taskSection.hidden = false;
  const rows = Array.isArray(data.tasks) ? data.tasks : null;
  const pending = new Set();
  for (const [id, request] of pendingCancellations) {
    const row = rows?.find(task => task.id === id);
    if (request.instance !== data.instance || (rows && (!row || !activeTask(row) || row.version !== request.version)) || Date.now() - request.at > 30000) {
      pendingCancellations.delete(id);
    } else {
      pending.add(id);
    }
  }
  const snapshot = JSON.stringify([rows, data.manager, data.instance, data.restarting, !!restarting, sending, [...pending]]);
  if (snapshot === taskSnapshot) return;
  taskSnapshot = snapshot;
  const cards = new Map(Array.from(taskSection.querySelectorAll('.task-card'), card => [card.dataset.taskId, card]));
  const active = [];
  const finished = [];
  let latestFinished;
  for (const row of rows || []) {
    const group = activeTask(row) ? active : finished;
    if (group === finished && !latestFinished) latestFinished = row;
    group.push(taskCard(row, data, pending.has(row.id), cards.get(row.id)));
  }
  if (!active.length) {
    const message = element('p', rows ? '当前没有进行中的任务。' : '暂时无法读取后台任务。');
    message.className = 'task-empty';
    active.push(message);
  }
  placeCards(tasks, active);
  placeCards(finishedTasks, finished);
  taskHistoryLabel.textContent = '最近结束的任务（' + finished.length + '）';
  taskHistoryLatest.hidden = !latestFinished || rows.some(activeTask);
  taskHistoryLatest.textContent = taskHistoryLatest.hidden ? ''
    : (taskLabels.get(latestFinished.status) || '状态未知') + ' · ' + (latestFinished.title || '任务 #' + latestFinished.id);
  taskHistory.hidden = !finished.length;
}

function chatCard(chat, data) {
  const card = document.createElement('article');
  const header = document.createElement('header');
  const badge = element('span', chat.health === '正常' ? '读取正常' : chat.health);
  badge.className = ['正常','首行监听中'].includes(chat.health) ? 'pill ok' : 'pill';
  header.append(element('h3', chat.name), badge);
  const list = document.createElement('dl');
  for (const [label, value] of [['最近读取', chat.lastRead], ['最近收信', chat.lastReceived], ['最近一条的回复', chat.reply]]) {
    const dd = element('dd', value);
    if (label === '最近一条的回复') dd.className = 'phase';
    list.append(element('dt', label), dd);
  }
  card.append(header, list);
  if (data.manager) {
    const retry = element('button','强制重新回复');
    retry.type = 'button';
    retry.className = 'retry';
    retry.disabled = sending || !!restarting || !chat.canRetry;
    retry.addEventListener('click',()=>action('retry', data.instance, chat));
    card.append(retry);
    if (!chat.canRetry && data.instance) {
      const reason = !chat.version ? '尚无可重新回复的来信' : chat.reply.includes('核实')
        ? '发送或处理结果待核实' : '当前消息或监听状态暂不允许重新回复';
      card.append(element('small', reason));
    }
  }
  return card;
}

async function action(kind, instance, target) {
  if (sending || restarting || !instance) return;
  const cancel = kind === 'cancel-task';
  if (cancel && pendingCancellations.has(target.id)) return;
  let prompt = '重启这台电脑上的小千？正在处理的回复可能中断。';
  if (kind === 'retry') prompt = '为「' + target.name + '」在 ' + target.lastReceived + ' 的消息重新生成并发送一次文字回复？';
  if (cancel) prompt = '确定中断任务 #' + target.id + (target.title ? '「' + target.title + '」' : '') + '？';
  if (!window.confirm(prompt)) return;
  const key = pageKey();
  sending = true;
  revision++;
  taskSnapshot = null;
  restart.disabled = true;
  document.querySelectorAll('.retry, .cancel-task').forEach(b=>{b.disabled=true;});
  note('正在提交…');
  const abort = new AbortController();
  const timeout = setTimeout(()=>abort.abort(),14000);
  try {
    const payload = target ? {instance,id:target.id,version:target.version} : {instance};
    const response = await fetch('/api/'+kind, {method:'POST',credentials:'omit',cache:'no-store',signal:abort.signal,
      headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const body = await response.json().catch(()=>({}));
    if (key !== pageKey()) return;
    if (kind === 'restart' && response.ok) restarting = {instance,at:Date.now()};
    if (cancel && response.ok) {
      pendingCancellations.set(target.id, {instance, version:target.version, at:Date.now()});
      note('任务 #' + target.id + ' 的中断请求已提交。');
    } else if (cancel && response.status === 409) {
      note('任务状态已变化，请查看刷新后的状态。');
    } else if (cancel && response.status === 403) {
      note('中断请求未获授权，请使用管理链接。');
    } else {
      note(cancel ? '中断结果待确认，请查看最新状态。' : body.message || '操作未确认，请查看最新状态。');
    }
  } catch {
    if (key === pageKey()) note('操作结果待确认，请查看最新状态。');
  } finally {
    clearTimeout(timeout);
    sending = false;
    update();
  }
}

async function update() {
  clearTimeout(timer);
  if (refresh.disabled || document.hidden || sending) return;
  const key = pageKey();
  if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key)) {
    accessPrompt('打开你的专属链接，或输入小千状态页的查看码。');
    return;
  }
  refresh.disabled = true;
  const requestRevision = revision;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 12000);
  try {
    const response = await fetch('/api/status', {cache:'no-store', credentials:'omit', headers:{Authorization:'Bearer ' + key}, signal:abort.signal});
    if (requestRevision !== revision || key !== pageKey()) return;
    if (response.status === 401) {
      accessPrompt('查看码无效，请重新打开专属链接或输入查看码。');
      return;
    }
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (requestRevision !== revision || key !== pageKey()) return;
    if (restarting && data.instance && data.instance !== restarting.instance) {
      restarting = null;
      note('小千已重新启动。');
    } else if (restarting && Date.now()-restarting.at>90000) {
      restarting = null;
      note('尚未确认重启完成，请查看本机运行状态。');
    }
    access.hidden = true;
    refresh.hidden = false;
    heading.hidden = false;
    state.textContent = restarting || data.restarting ? '正在重启' : data.status;
    state.classList.toggle('ok', data.status === '运行中');
    detail.textContent = data.manager && !data.instance && !restarting && !data.status.includes('停止')
      ? data.detail + ' · 正在连接本机控制服务' : data.detail;
    restart.hidden = !data.manager;
    restart.disabled = sending || !!restarting || !data.canRestart;
    restart.onclick = ()=>action('restart',data.instance);
    chats.replaceChildren(...data.chats.map(chat=>chatCard(chat,data)));
    if (Number.isFinite(data.at) && data.at !== clockAt) {
      clockAt = data.at;
      clockObservedAt = performance.now();
    }
    renderTasks(data);
    updateElapsed();
    const time = new Date(data.at).toLocaleTimeString('zh-CN', {hour12:false});
    updated.textContent = '更新于 ' + time + ' · 每 2 秒刷新';
  } catch {
    if (requestRevision !== revision || key !== pageKey()) return;
    state.textContent = '状态暂不可用';
    state.classList.remove('ok');
    detail.textContent = '正在等待电脑回应，稍后会自动重试。';
    chats.replaceChildren();
    taskSnapshot = null;
    tasks.replaceChildren();
    finishedTasks.replaceChildren();
    taskHistoryLatest.textContent = '';
    taskHistory.hidden = true;
    taskSection.hidden = true;
    restart.disabled = true;
    updated.textContent = '';
  } finally {
    clearTimeout(timeout);
    refresh.disabled = false;
    if (!document.hidden && key !== pageKey()) update();
    else if (!document.hidden && access.hidden) timer = setTimeout(update, 2000);
  }
}

// Keep this tab's choice when the user reloads the page.
try { taskHistory.open = sessionStorage.getItem('xiaoqian-task-history-open') === '1'; } catch {}
taskHistory.addEventListener('toggle', () => {
  try { sessionStorage.setItem('xiaoqian-task-history-open', taskHistory.open ? '1' : '0'); } catch {}
});
refresh.addEventListener('click', update);
access.addEventListener('submit', event => {
  event.preventDefault();
  const code = document.getElementById('code');
  history.replaceState(null, '', '#view=' + encodeURIComponent(code.value.trim()));
  code.value = '';
  access.hidden = true;
  update();
});
window.addEventListener('hashchange', () => {
  revision++;
  restarting = null;
  accessPrompt('正在核对访问权限。');
  update();
});
document.addEventListener('visibilitychange', update);
setInterval(updateElapsed, 1000);
update();
