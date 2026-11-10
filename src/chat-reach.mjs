// A chat whose window cannot be opened (group renamed etc.) used to fail silently: tell the owner once.
// A successful poll returns an ingest receipt (no status field); only driver error results count as failures.
export function isFailedPoll(r){return !!r&&typeof r.status==='string'&&!['ok','rotation_queued','paused'].includes(r.status)&&!Array.isArray(r.ackable);}
export function createReachWatch({chats,audit,wake,report,ms=180000,minFailures=20,now=Date.now}){
  const reach={},owner=chats.find(o=>o.owner&&o.mode==='private'),limit=Math.max(60000,ms);
  const watch=(c,r)=>{
    if(r?.status==='paused')return;
    if(!isFailedPoll(r)){if(reach[c.id]?.notified){try{audit('CHAT_REACHABLE',c.id,{});}catch{}}delete reach[c.id];return;}
    const v=reach[c.id]??={since:now(),failures:0,code:String(r.code||r.status).slice(0,80),shown:c.wechatName||c.title,notified:false};
    v.failures++;
    if(v.notified||v.failures<minFailures||now()-v.since<limit)return;
    v.notified=true;report('CHAT_UNREACHABLE',{code:v.code,stack:c.id+' shown='+v.shown});try{audit('CHAT_UNREACHABLE',c.id,{reason:v.code});}catch{}
    if(owner&&owner.id!==c.id)Promise.resolve().then(()=>wake(owner.id,{wakeId:'unreachable:'+c.id+':'+v.since,reason:'chat_unreachable',
      note:'聊天「'+v.shown+'」已经连续 '+Math.round(limit/60000)+' 分钟打不开（'+v.code+'），多半是群被改名了。请用 wechat_reply 告诉主人这件事和解决方法：在小千微信里给这个群设备注为「'+v.shown+'」，或者让 Claude 把配置里的 wechatName 改成新群名。'})).catch(e=>report('CHAT_UNREACHABLE_NOTIFY_FAILED',e));
  };
  return {reach,watch,down:()=>Object.values(reach).filter(v=>v.notified)};
}
