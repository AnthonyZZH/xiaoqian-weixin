export class PolicyError extends Error { constructor(code){super(code);this.code=code;} }
export function requireValue(condition,code){ if(!condition) throw new PolicyError(code); }
export function validateChats(chats) {
  requireValue(Array.isArray(chats)&&chats.length>0,'CHATS_REQUIRED');
  const ids=new Set(),titles=new Set();let owners=0;
  for(const c of chats){
    requireValue(c&&typeof c.id==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(c.id),'CHAT_ID_INVALID');
    requireValue(!['__proto__','constructor','prototype'].includes(c.id),'CHAT_ID_RESERVED');
    requireValue(!ids.has(c.id)&&typeof c.title==='string'&&c.title.length>0&&c.title.length<=200,'CHAT_INVALID');
    requireValue(['private','group'].includes(c.mode),'CHAT_MODE_INVALID');
    requireValue(!titles.has(c.mode+':'+c.title),'CHAT_AMBIGUOUS');
    requireValue(!c.owner||c.mode==='private','GROUP_OWNER_DENIED');
    if(c.owner)owners++; ids.add(c.id);titles.add(c.mode+':'+c.title);
  }
  requireValue(owners<=1,'MULTIPLE_OWNERS_DENIED');
  return new Map(chats.map(c=>[c.id,Object.freeze({...c,owner:c.owner===true})]));
}
export function normalizeMessage(m) {
  requireValue(m&&typeof m.id==='string'&&m.id.length>0&&m.id.length<=256,'MESSAGE_ID_INVALID');
  requireValue(typeof m.text==='string'&&m.text.length<=32000,'MESSAGE_TEXT_INVALID');
  return {id:m.id,text:m.text,legacyMessageIds:Array.isArray(m.legacyMessageIds)?m.legacyMessageIds.filter(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x)).slice(0,3):[],role:m.role==='assistant'?'assistant':'user',sender:typeof m.sender==='string'?m.sender.slice(0,200):'',media:Array.isArray(m.media)?m.media.filter(x=>x&&typeof x.id==='string').map(x=>({id:x.id,kind:x.kind==='static_preview'?'static_preview':'attachment'})):[]};
}
export const socialTools=['wechat_reply','wechat_skip','wechat_status','wechat_memory_search','wechat_memory_read','wechat_sticker_search','wechat_describe_image'];
export const ownerTools=[...socialTools,'wechat_relay','wechat_memory_edit','wechat_memory_confirm','wechat_sticker_review','wechat_persona','wechat_control','wechat_search','wechat_draw','wechat_task','wechat_task_status'];
export function allowedTools(chat,capabilities={}) {
  const names=(chat.owner?ownerTools:socialTools).filter(name=>{
    // Hide only the unconfigured legacy submission; status and isolated tasks remain available.
    if(name==='wechat_task'&&Array.isArray(capabilities.taskManager?.tools)&&capabilities.taskManager.tools.length===0)return false;
    if(name==='wechat_search')return typeof capabilities.search==='function'&&!(chat.owner&&capabilities.ownerSearchTool);
    if(name==='wechat_draw')return typeof capabilities.draw==='function';
    if(name==='wechat_describe_image')return typeof capabilities.describeImage==='function';
    return true;
  });
  return new Set([...names,
    ...(chat.webSearch===true&&typeof capabilities.search==='function'?['wechat_search']:[]),
    ...(chat.drawEnabled===true&&typeof capabilities.draw==='function'?['wechat_draw']:[]),
    ...(chat.owner?(capabilities.ownerNativeTools||[]):[])]);
}
export function authorize(chat,name) {
  requireValue((chat.owner?ownerTools:socialTools).includes(name)||
    name==='wechat_search'&&chat.webSearch===true||
    name==='wechat_draw'&&chat.drawEnabled===true,'TOOL_SCOPE_DENIED');
}
export function textArg(v,limit=12000) { requireValue(typeof v==='string'&&v.trim().length>0&&v.length<=limit,'TEXT_INVALID');return v; }
