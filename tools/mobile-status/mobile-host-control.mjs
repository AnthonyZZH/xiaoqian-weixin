import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {createMobileBackgroundTasks} from './mobile-background-tasks.mjs';
import {latestInput, replyPanel, retryPanelReply} from '../../src/panel-replies.mjs';

export const name = 'xiaoqian-mobile-control';
export const inject = ['xiaoqianBridge', 'sessionPersistence'];

function recentReads(directory) {
  const records = [];
  for (const file of ['read-outcomes-node.jsonl.previous','read-outcomes-node.jsonl']) {
    let fd;
    try {
      fd = fs.openSync(path.join(directory,file), 'r');
      const size = fs.fstatSync(fd).size;
      const tail = Buffer.alloc(Math.min(64 * 1024,size));
      const n = fs.readSync(fd,tail,0,tail.length,size-tail.length);
      for (const line of tail.toString('utf8',0,n).split('\n')) {
        try { const row = JSON.parse(line); if (row.phase === 'terminal' && row.controller_pid === process.pid) records.push(row); } catch {}
      }
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return records;
}

export async function apply(ctx) {
  const {core,inboxMode} = ctx.xiaoqianBridge;
  const backgroundTasks = createMobileBackgroundTasks(ctx.xiaoqianBridge.ownerTasks);
  const driverDir = path.resolve(core.store.dir,'../driver');
  const stored = new Map();
  const reads = () => inboxMode === 'top-private' ? [] : recentReads(driverDir);
  function options() {
    let listening;
    if (inboxMode === 'top-private') {
      listening = false;
      try {
        const watch = JSON.parse(fs.readFileSync(path.join(driverDir,'top-private-status.json'),'utf8'));
        const age = Date.now()-Date.parse(watch.at);
        listening = watch.pid === process.pid && watch.outcome === 'listening' && age >= 0 && age < 65000;
      } catch {}
    }
    // Only the newer top-private inbox identifies additional private chats as trusted.
    return {listening, stored, trustedPrivate:inboxMode === 'top-private'};
  }
  // Read the latest receipt without waking an idle agent. Only metadata stays cached.
  async function loadIdleInputs() {
    const inactive = new Set();
    for (const chat of core.chats.values()) {
      const state = core.store.data.chats[chat.id];
      if (!state?.created || core.handles.has(chat.id)) continue;
      const id = state.sessionId;
      inactive.add(id);
      if (stored.has(id)) continue;
      const handle = await ctx.sessionPersistence.open(id,'read');
      try {
        const {events} = await handle.read();
        const input = latestInput({id, seq:events.length, eventAt:i=>events[i]},state);
        stored.set(id,input ? {key:input.key,receipt:input.receipt,at:input.at} : null);
      } finally { await handle.close(); }
    }
    for (const id of stored.keys()) if (!inactive.has(id)) stored.delete(id);
  }
  const dir = path.join(process.env.LOCALAPPDATA,'Xiaoqian','MobileStatus');
  const ticket = path.join(dir,'native.json');
  const token = randomBytes(32).toString('hex');
  const instance = randomUUID();
  const credential = Buffer.from('Bearer ' + token);
  let restarting = false, submitting = 0;
  const canRestart = process.env.XQ_MOBILE_RESTARTABLE === '1' && process.listenerCount('SIGTERM') > 0;
  const server = http.createServer(async (req,res) => {
    const json = (status,data) => { res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); };
    const presented = Buffer.from(req.headers.authorization || '');
    if (presented.length !== credential.length || !timingSafeEqual(credential,presented)) return json(403,{});
    try {
      if (req.method === 'GET' && req.url === '/state') {
        await loadIdleInputs();
        let tasks = null;
        try { tasks = backgroundTasks.list(); } catch (err) { ctx.logger?.warn?.('移动面板暂时无法读取任务列表',err.code); }
        return json(200,{instance,canRestart,restarting,tasks,conversations:replyPanel(core,reads(),options()).map(
          ({id,phase,receivedAt,version,canRetry})=>({id,phase,receivedAt,version,canRetry:!restarting && canRetry}))});
      }
      if (req.method !== 'POST' || !['/restart','/retry','/review-image-draft','/cancel-task'].includes(req.url)) return json(404,{});
      let raw='';
      for await (const chunk of req) { raw+=chunk; if(raw.length>1024) return json(413,{}); }
      const body = JSON.parse(raw);
      if (body.instance !== instance || restarting) return json(409,{message:'小千已重启或正在重启，请刷新。'});
      if (req.url === '/cancel-task') {
        if (!backgroundTasks.cancel(body)) return json(409,{message:'任务已结束、已重试或不再可中断，请刷新。'});
        return json(200,{message:'已中断任务 #' + body.id + '，已完成步骤的产物已保留。'});
      }
      if (req.url === '/review-image-draft') {
        if (typeof core.requestImageReview !== 'function') return json(404,{});
        submitting++;
        try {
          const result=await core.requestImageReview(body.chatId,body.deliveryId,body.mediaId);
          return json(200,result);
        } finally { submitting--; }
      }
      if (req.url === '/retry') {
        submitting++;
        try { await retryPanelReply(core,body,reads,options); }
        catch { return json(409,{message:'无法确认提交，或消息状态已变化。请刷新并核对回复回执。'}); }
        finally { submitting--; }
        return json(202,{message:'已提交重新回复，正在等待发送回执。'});
      }
      if (!canRestart) return json(409,{message:'当前启动器不支持手机重启。'});
      if (submitting || Object.values(core.store.data.chats).some(chat=>Object.values(chat.deliveries || {}).some(r=>r.status==='sending'))) {
        return json(409,{message:'正在提交或发送微信回复，请等回执更新后再重启。'});
      }
      restarting = true;
      // Let the normal host shutdown dispose the WeChat bridge and release its lock.
      // The foreground launcher recognizes exit code 75 and starts exactly one replacement.
      res.once('finish',()=>setImmediate(()=>{
        process.once('exit',()=>{process.exitCode=75;});
        process.emit('SIGTERM');
      }));
      return json(202,{message:'正在重启小千。'});
    } catch { return json(503,{message:'本机暂时无法读取或确认状态。'}); }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try {
    fs.mkdirSync(dir,{recursive:true});
    const tmp = ticket + '.' + instance + '.tmp';
    fs.writeFileSync(tmp,JSON.stringify({pid:process.pid,port:server.address().port,token,instance}),{flag:'wx',mode:0o600});
    fs.renameSync(tmp,ticket);
  } catch (err) {server.close(); throw err;}
  ctx.effect(()=>()=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();}));
}
