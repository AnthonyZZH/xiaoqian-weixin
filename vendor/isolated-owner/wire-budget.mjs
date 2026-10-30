/** Same instance must be connected to the actual final provider fetch shim. */
export class TaskWireBudget{
 constructor(){this.slots=new Map();this.transportAttached=false;}
 install(sessionId,{admit,signal}){if(!this.transportAttached)throw Error('TASK_WIRE_BUDGET_NOT_CONNECTED');if(this.slots.has(sessionId))throw Error('TASK_SESSION_ALREADY_RUNNING');const slot={admit,signal,blocked:false};this.slots.set(sessionId,slot);const release=()=>{if(this.slots.get(sessionId)===slot)this.slots.delete(sessionId);};release.deny=()=>{slot.blocked=true;};return release;}
 async fetch(baseFetch,context,url,init){const s=this.slots.get(String(context.sessionId));if(s){if(s.blocked||s.signal.aborted)throw Error('TASK_CANCELLED');s.admit();init={...init,signal:init?.signal?AbortSignal.any([init.signal,s.signal]):s.signal};}return baseFetch(url,init);}
}
export const taskWireBudget=new TaskWireBudget();
