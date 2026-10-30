import {randomUUID} from 'node:crypto';

/** Durable policy lives in Python SQLite; this object only arms Host callbacks. */
export class ScheduleBridge {
  constructor(driver){this.driver=driver;this.claims=new Map();this.paused=true;}
  async request(operation,args={}){
    const result=await this.driver.call(operation,args);
    if(result.status!=='ok')throw new Error(result.code||'SCHEDULE_UNAVAILABLE');
    return result;
  }
  pause(){this.paused=true;for(const c of this.claims.values())clearInterval(c.timer);}
  resume(){this.paused=false;}
  close(){this.pause();this.claims.clear();}
  async heard(chatId,{text='',sourceId}={}){
    const result=await this.request('schedule_heard',{targetId:chatId,sourceId,text});
    const c=this.claims.get(chatId);if(c){clearInterval(c.timer);this.claims.delete(chatId);}
    return result;
  }
  async spoke(chatId,{opening=false,sourceId}={}){
    const c=this.claims.get(chatId);
    if(opening&&c){
      const result=await this.request('schedule_finish',{targetId:chatId,eventId:c.eventId,token:c.token,outcome:'sent'});
      if(!result.finished)throw new Error('SCHEDULE_RECEIPT_NOT_CONFIRMED');
      clearInterval(c.timer);this.claims.delete(chatId);return result;
    }
    return this.request('schedule_spoke',{targetId:chatId,sourceId:sourceId||randomUUID()});
  }
  async uncertain(chatId){
    const c=this.claims.get(chatId);if(!c)return;
    await this.request('schedule_finish',{targetId:chatId,eventId:c.eventId,token:c.token,outcome:'uncertain'});
    clearInterval(c.timer);this.claims.delete(chatId);
  }
  async declined(chatId){
    const c=this.claims.get(chatId);if(!c)throw new Error('SCHEDULE_CLAIM_REQUIRED');
    const result=await this.request('schedule_finish',{targetId:chatId,eventId:c.eventId,token:c.token,outcome:'declined'});
    if(!result.finished)throw new Error('SCHEDULE_DECLINE_NOT_CONFIRMED');
    clearInterval(c.timer);this.claims.delete(chatId);return result;
  }
  async reserveSend(chatId,{proactive=false}={}){
    if(!proactive)return {allowed:true};
    const c=this.claims.get(chatId);if(!c)return {allowed:false,reason:'claim_missing'};
    const result=await this.request('schedule_prepare',{targetId:chatId,eventId:c.eventId,token:c.token});
    if(!result.reservation)return {allowed:false,reason:'policy_rechecked'};
    c.reservation=result.reservation;clearInterval(c.timer);
    return {allowed:true,reservation:result.reservation};
  }
  async tick(onWake){
    if(this.paused)return [];
    const {events}=await this.request('schedule_poll');const outcomes=[];
    for(const event of events){
      if(this.paused)break;
      if(this.claims.has(event.chat_id))continue;
      const {claim}=await this.request('schedule_claim',{targetId:event.chat_id,eventId:event.event_id});
      if(!claim)continue;
      const c={eventId:event.event_id,token:claim.token,timer:null};this.claims.set(event.chat_id,c);
      c.timer=setInterval(async()=>{
        try{
          const result=await this.request('schedule_renew',{targetId:event.chat_id,eventId:c.eventId,token:c.token});
          if(!result.renewed){clearInterval(c.timer);this.claims.delete(event.chat_id);}
        }catch{clearInterval(c.timer);this.claims.delete(event.chat_id);}
      },20000);
      try{
        const result=await onWake({chatId:event.chat_id,wakeId:event.event_id,reason:'opening',
          idleMinutes:event.idle_minutes,unanswered:event.unanswered});
        outcomes.push({chatId:event.chat_id,status:result?.status||'delivered'});
      }catch(e){outcomes.push({chatId:event.chat_id,status:'uncertain'});}
    }
    return outcomes;
  }
  async nextWakeup(){return (await this.request('schedule_poll')).nextWakeup;}
}
