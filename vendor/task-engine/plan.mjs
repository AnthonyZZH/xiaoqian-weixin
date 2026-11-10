// 计划校验：步骤 id、工具、依赖是否合法，是否有环；并自动追加最后的「汇总交付」步骤。
const bad = msg => { throw Object.assign(new Error(msg), {code: 'PLAN_INVALID'}); };

// 按依赖把步骤分层：同一层互不依赖，可以并行。有环时抛错。
export function waves(steps) {
  const left = new Map(steps.map(s => [s.id, new Set(s.dependsOn)])), out = [];
  while (left.size) {
    const wave = [...left].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (!wave.length) bad(`步骤之间存在循环依赖：${[...left.keys()].join('、')}`);
    for (const id of wave) left.delete(id);
    for (const deps of left.values()) for (const id of wave) deps.delete(id);
    out.push(wave);
  }
  return out;
}

// finalTool：自动追加的最后一步用哪个工具（传 null 则不追加）；finalForSingle=false 时，只有一步的任务不追加。
export function normalizePlan(plan, tools, {maxSteps = 20, finalTool = 'summarize', finalForSingle = true} = {}) {
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) bad('计划里没有步骤');
  if (plan.steps.length > maxSteps) bad(`步骤太多（${plan.steps.length}），上限 ${maxSteps}`);
  const ids = new Set();
  const steps = plan.steps.map((s, i) => {
    const id = String(s?.id ?? `s${i + 1}`);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) bad(`步骤 id 不合法：${id}`);
    if (id === 'final') bad('步骤 id「final」保留给汇总交付');
    if (ids.has(id)) bad(`步骤 id 重复：${id}`);
    ids.add(id);
    if (!tools.has(s.tool)) bad(`步骤 ${id} 用了不存在的工具：${s.tool}（可用：${[...tools.keys()].join('、')}）`);
    return {id, title: String(s.title || id).slice(0, 200), tool: s.tool,
      args: s.args && typeof s.args === 'object' ? s.args : {}, dependsOn: [...new Set((s.dependsOn || []).map(String))]};
  });
  for (const s of steps) for (const d of s.dependsOn) {
    if (d === s.id) bad(`步骤 ${s.id} 依赖了自己`);
    if (!ids.has(d)) bad(`步骤 ${s.id} 依赖了不存在的步骤 ${d}`);
  }
  const w = waves(steps);
  if (finalTool && (steps.length > 1 || finalForSingle)) steps.push({id: 'final', title: '汇总交付', tool: finalTool, args: {}, dependsOn: steps.map(s => s.id)});
  const title = String(plan.title || steps[0].title).slice(0, 80);
  return {title, request: String(plan.request || title), steps, waves: w};
}
