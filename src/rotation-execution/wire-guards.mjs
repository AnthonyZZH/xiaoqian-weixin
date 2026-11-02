import crypto from 'node:crypto';
export const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const check=(v,c)=>{if(!v)throw Error(c);};
export function modelFields(wire){let body;try{body=JSON.parse(wire.init.body);}catch{throw Error('ROTATION_WIRE_INVALID');}const {dsh_session_log,dsh_plugin_packages,...fields}=body;return {body,units:Buffer.byteLength(JSON.stringify(fields),'utf8')};}
const texts=body=>(body.messages??[]).flatMap(m=>m.role==='user'?(typeof m.content==='string'?[m.content]:(m.content??[]).filter(b=>b.type==='text').map(b=>b.text)):[]);
/** Guards actual final provider requests; never constructs an SDK request. */
export function createSummaryGuard({model,payload,guide,unitsUpper,isCurrent}){let calls=0;return wire=>{check(isCurrent(),'ROTATION_VERSION_CHANGED');check(++calls===1,'SUMMARY_PHYSICAL_ATTEMPT_LIMIT');const {body,units}=modelFields(wire);check(body.model===model&&body.max_tokens===1024&&body.thinking?.type==='disabled'&&(!body.tools||body.tools.length===0),'SUMMARY_WIRE_POLICY_CHANGED');check(texts(body).filter(t=>t===payload).length===1&&typeof body.system==='string'&&body.system.includes(guide),'SUMMARY_WIRE_INPUT_CHANGED');check(units<=unitsUpper,'SUMMARY_WIRE_EXCEEDS_BUDGET');return {sha256:hash(JSON.stringify(body)),units};};}
export function createColdGuard({model,input,handoff,unitsUpper,isCurrent}){let calls=0;return wire=>{check(isCurrent(),'ROTATION_NEW_ROUTE_CHANGED');check(++calls===1,'COLD_PHYSICAL_ATTEMPT_LIMIT');const {body,units}=modelFields(wire);check(body.model===model&&typeof body.system==='string'&&body.system.split(handoff).length===2,'COLD_HANDOFF_CHANGED');check(input.content.every(b=>b.type==='text')&&input.content.every(b=>texts(body).filter(t=>t===b.text).length===1),'COLD_ACTUAL_INPUT_CHANGED');check(units<=unitsUpper,'COLD_WIRE_EXCEEDS_BUDGET');return {sha256:hash(JSON.stringify(body)),units};};}
/** The installed rc4 transport calls budget.fetch before network. Supports both
 * installed admit() and newer admit(wire) without replacing their logic. */
export function createWireGuardRegistry(budget){
 check(budget?.transportAttached===true&&typeof budget.install==='function'&&typeof budget.fetch==='function','FINAL_TRANSPORT_NOT_ATTACHED');
 const prior=budget.fetch,owned=new Map();let closed=false;
 const wrapped=function(base,context,url,init){const row=owned.get(String(context.sessionId));if(row){row.inFetch=true;try{row.guard({context,url,init});return prior.call(this,base,context,url,init);}finally{row.inFetch=false;}}return prior.apply(this,arguments);};
 budget.fetch=wrapped;
 return {install(sessionId,guard,signal){check(!closed&&!owned.has(sessionId),'ROTATION_WIRE_SLOT_CONFLICT');const row={guard,inFetch:false};const release=budget.install(sessionId,{signal,admit(){check(row.inFetch,'FINAL_WIRE_GUARD_NOT_REACHED');}});owned.set(sessionId,row);return {close(){owned.delete(sessionId);release();},deny(){release.deny();}};},close(){closed=true;for(const id of owned.keys())budget.slots?.get(id)&&(budget.slots.get(id).blocked=true);if(!owned.size&&budget.fetch===wrapped)budget.fetch=prior;},status(){return {transportAttached:budget.transportAttached===true,actualFetchWrapped:budget.fetch===wrapped,slots:owned.size};}};
}
