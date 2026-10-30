import crypto from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createOwnerSessionStatus} from '../vendor/owner-tools/session-status/index.mjs';
import {createCoreSessionSource} from '../vendor/owner-tools/session-status/sources.mjs';

export const name = 'xiaoqian-owner-session-status-extension';
export const inject = ['xiaoqianBridge'];
export const TOOL_NAME = 'owner_sessions_status';
const active = new WeakMap();
const binding = chat => crypto.createHash('sha256').update(JSON.stringify([chat.id, chat.title, chat.mode, chat.owner])).digest('hex');
const requireValue = (value, code) => { if (!value) throw Error(code); };

/** Existing handles only. No bridge/session construction, file source or model calls. */
export function createStatusExtension({
  core, defineTool, intervalMs = 1000, clock = Date.now,
  scheduler = {setInterval, clearInterval}
} = {}) {
  requireValue(core?.chats instanceof Map && core.handles instanceof Map && core.capabilities && core.store?.data, 'EXISTING_CORE_REQUIRED');
  requireValue(typeof defineTool === 'function', 'DEFINE_TOOL_REQUIRED');
  requireValue(Number.isInteger(intervalMs) && intervalMs >= 100 && intervalMs <= 60000, 'STATUS_INTERVAL_INVALID');
  requireValue(typeof scheduler?.setInterval === 'function' && typeof scheduler?.clearInterval === 'function', 'STATUS_SCHEDULER_INVALID');
  requireValue(!active.has(core), 'STATUS_EXTENSION_ALREADY_ATTACHED');
  requireValue(core.capabilities.ownerNativeTools === undefined || Array.isArray(core.capabilities.ownerNativeTools), 'OWNER_CAPABILITIES_INVALID');

  const entries = new Map(), retiredContexts = new WeakSet();
  let closed = false, timer, addedCapability = false, logicalOnly = false, lastError = null;
  const valid = entry => {
    const chat = core.chats.get(entry.chatId), stored = core.store.data.chats?.[entry.chatId];
    return !closed && !core.closed && chat?.owner === true && chat.mode === 'private'
      && core.handles.get(entry.chatId)?.agent === entry.agent
      && entry.agent.ctx === entry.ctx && stored?.binding === entry.bindingId
      && binding(chat) === entry.bindingId;
  };
  const status = createOwnerSessionStatus({
    getManagedSessions: createCoreSessionSource(core, {clock}),
    clock, includeDisplayNames: false,
    isCurrentOwner: ({agent, bindingId}) => {
      const entry = [...entries.values()].find(value => value.agent === agent && value.bindingId === bindingId);
      return Boolean(entry && valid(entry) && core.store.data.paused === false
        && core.capabilities.ownerNativeTools?.includes(TOOL_NAME));
    }
  });

  function remove(entry, disposed = false) {
    entry.bound.revoke();
    if (entries.get(entry.chatId) === entry) entries.delete(entry.chatId);
    if (disposed || !entry.unregister) retiredContexts.add(entry.ctx);
    if (entry.unregister) {
      try {
        const result = entry.unregister();
        if (result?.then) result.catch(() => { logicalOnly = true; lastError = 'STATUS_UNREGISTER_FAILED'; });
      } catch { logicalOnly = true; lastError = 'STATUS_UNREGISTER_FAILED'; retiredContexts.add(entry.ctx); }
      entry.unregister = null;
    } else logicalOnly = true;
  }
  function ensureCapability() {
    const names = core.capabilities.ownerNativeTools;
    requireValue(names === undefined || Array.isArray(names), 'OWNER_CAPABILITIES_INVALID');
    if (!names?.includes(TOOL_NAME)) {
      if (names) names.push(TOOL_NAME);
      else core.capabilities.ownerNativeTools = [TOOL_NAME];
      addedCapability = true;
    }
  }
  function close() {
    if (closed) return;
    closed = true;
    if (timer !== undefined) scheduler.clearInterval(timer);
    for (const entry of [...entries.values()]) remove(entry);
    // Remove only our added name from the current array, preserving later changes.
    const names = core.capabilities.ownerNativeTools;
    if (addedCapability && Array.isArray(names)) {
      const index = names.indexOf(TOOL_NAME);
      if (index >= 0) names.splice(index, 1);
    }
    active.delete(core);
  }
  function refresh() {
    if (closed) return inspect();
    if (core.closed) { close(); return inspect(); }
    for (const entry of [...entries.values()]) if (!valid(entry)) remove(entry);
    for (const chat of core.chats.values()) {
      if (chat.owner !== true || chat.mode !== 'private' || entries.has(chat.id)) continue;
      const agent = core.handles.get(chat.id)?.agent, ctx = agent?.ctx;
      const bindingId = binding(chat);
      if (!agent || !ctx || retiredContexts.has(ctx) || typeof ctx.tools?.register !== 'function'
          || core.store.data.chats?.[chat.id]?.binding !== bindingId) continue;
      const bound = status.bind({agent, bindingId});
      const entry = {agent, ctx, bindingId, chatId: chat.id, bound, unregister: null};
      entries.set(chat.id, entry);
      try {
        ensureCapability();
        const result = ctx.tools.register(defineTool({
          name: TOOL_NAME,
          description: 'Read registered session status metadata. Owner private chat only; no message bodies, tool arguments, session creation or control actions.',
          parameters: {chatId: {type: 'string'}, offset: {type: 'number'}, limit: {type: 'number'}},
          output: {schema: {type: 'json'}, render: (_args, value) => [{type: 'text', text: JSON.stringify(value)}]},
          execute: bound.execute
        }));
        // A returned function is supported; undefined/opaque values are not guessed.
        if (typeof result === 'function') entry.unregister = result;
        else logicalOnly = true;
        ctx.effect?.(() => () => remove(entry, true));
      } catch {
        lastError = 'STATUS_REGISTRATION_FAILED';
        remove(entry, true);
      }
    }
    return inspect();
  }
  function inspect() {
    return {
      closed, boundOwners: entries.size, logicalRevocationOnly: logicalOnly,
      activeRegistrationsWithDisposer: [...entries.values()].filter(entry => entry.unregister).length,
      lastError, longTaskCoverage: false, scope: 'existing-owner-private-handles'
    };
  }
  const extension = Object.freeze({refresh, close, inspect});
  active.set(core, extension);
  try {
    refresh();
    if (!closed) {
      timer = scheduler.setInterval(() => {
        try { refresh(); } catch { lastError = 'STATUS_REFRESH_FAILED'; close(); }
      }, intervalMs);
      timer?.unref?.();
    }
  } catch (error) { close(); throw error; }
  return extension;
}

/** Native profile adapter: requires the bridge service already provided by src/index. */
export async function apply(ctx, config = {}, dependencies = {}) {
  if (config.enabled !== true) return;
  requireValue(typeof ctx.effect === 'function', 'PLUGIN_LIFECYCLE_REQUIRED');
  const core = ctx.get?.('xiaoqianBridge')?.core;
  requireValue(core, 'EXISTING_BRIDGE_SERVICE_REQUIRED');
  let defineTool = dependencies.defineTool;
  if (!defineTool) {
    requireValue(config.nativePackageRoot === undefined || path.isAbsolute(config.nativePackageRoot), 'ABSOLUTE_NATIVE_PACKAGE_ROOT_REQUIRED');
    ({defineTool} = await import(config.nativePackageRoot
      ? pathToFileURL(path.join(config.nativePackageRoot, 'dsh-tools/lib/index.js')).href
      : '@deepseek-ai/dsh-tools'));
  }
  const extension = createStatusExtension({
    core, defineTool, intervalMs: config.intervalMs ?? 1000,
    ...(dependencies.scheduler ? {scheduler: dependencies.scheduler} : {})
  });
  try { ctx.effect(() => () => extension.close()); }
  catch (error) { extension.close(); throw error; }
  // Cordis rc.4 accepts void or an effect disposer here, never an API object.
  // ctx.effect above already owns cleanup for provider reload/unload.
  return;
}
