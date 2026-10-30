import {ScheduleBridge} from './schedule-bridge.mjs';

// Deadline starts only after the wake has reached the Agent. No model call here.
export class OwnerDecisionBridge extends ScheduleBridge {
  constructor(driver,{onTimeout,decisionTimeoutMs=120000,setTimer=setTimeout,clearTimer=clearTimeout}={}){
    super(driver);this.onTimeout=onTimeout;this.decisionTimeoutMs=decisionTimeoutMs;
    this.setTimer=setTimer;this.clearTimer=clearTimer;this.deadlines=new Map();
  }
  clearDeadline(chatId){const item=this.deadlines.get(chatId);if(item){this.clearTimer(item.timer);this.deadlines.delete(chatId);}}
  arm(event){
    const claim=this.claims.get(event.chatId);if(!claim)return;
    this.clearDeadline(event.chatId);
    const deadline=Date.now()+this.decisionTimeoutMs;
    const timer=this.setTimer(()=>{void this.expire(event,claim).catch(()=>{});},this.decisionTimeoutMs);
    this.deadlines.set(event.chatId,{timer,deadline,event,claim});
  }
  async expire(event,claim){
    if(this.paused||this.claims.get(event.chatId)!==claim)return;
    try{
      const matched=await this.onTimeout(event);
      if(!matched)return;
      await this.request('schedule_finish',{targetId:event.chatId,eventId:claim.eventId,token:claim.token,outcome:'declined',decision:'decision_timeout'});
    }finally{
      this.clearDeadline(event.chatId);clearInterval(claim.timer);this.claims.delete(event.chatId);
      // A failed finish leaves an expiring claim; the durable scheduler records
      // abandoned_lease and gives a fresh future due without reusing this wake.
    }
  }
  async completed(chatId,wakeId){
    const claim=this.claims.get(chatId);
    if(!claim||claim.eventId!==wakeId||claim.reservation)return false;
    const result=await this.request('schedule_finish',{targetId:chatId,eventId:wakeId,token:claim.token,outcome:'declined',decision:'completed_without_decision'});
    if(!result.finished)return false;
    this.clearDeadline(chatId);clearInterval(claim.timer);this.claims.delete(chatId);return true;
  }
  async tick(onWake){return super.tick(async event=>{
    const result=await onWake(event);
    if(result?.status==='ok')this.arm(event);
    return result;
  });}
  async heard(chatId,args){try{return await super.heard(chatId,args);}finally{if(!this.claims.has(chatId))this.clearDeadline(chatId);}}
  async spoke(chatId,args){try{return await super.spoke(chatId,args);}finally{if(!this.claims.has(chatId))this.clearDeadline(chatId);}}
  async declined(chatId){try{return await super.declined(chatId);}finally{if(!this.claims.has(chatId))this.clearDeadline(chatId);}}
  async uncertain(chatId){try{return await super.uncertain(chatId);}finally{if(!this.claims.has(chatId))this.clearDeadline(chatId);}}
  pause(){for(const id of this.deadlines.keys())this.clearDeadline(id);super.pause();this.claims.clear();}
  resume(){super.resume();}
  close(){for(const id of this.deadlines.keys())this.clearDeadline(id);super.close();}
}

export async function expireOwnerWake(core,event){
  return core.serial(async()=>{
    const state=core.state(event.chatId);
    if(state.pendingWake?.wakeId!==event.wakeId)return false;
    state.pendingWake=null;
    for(const [key,grant] of Object.entries(state.replyPermits||{}))if(grant.kind==='proactive'&&grant.wakeId===event.wakeId)core.permits.close(event.chatId,key,'skipped');
    if(state.replyPermit?.kind==='proactive'&&state.replyPermit.wakeId===event.wakeId)state.replyPermit=null;
    core.store.save();
    core.store.audit('WAKE_DECISION_TIMEOUT',event.chatId,{wakeId:event.wakeId});
    return true;
  });
}
