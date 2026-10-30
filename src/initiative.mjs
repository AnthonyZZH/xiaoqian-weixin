import path from 'node:path';
import { createHash } from 'node:crypto';
import { scopedDirectory, readJson, atomicJson, trustedChats } from './features.mjs';

const MINUTE = 60000, HOUR = 60 * MINUTE;
const SLEEP_WORDS = ['睡了','去睡','睡觉','晚安','困了','睡啦','睡咯','睡一会','睡会儿','上床','休息了'];
const HOLIDAYS_2026 = ['2026-01-01','2026-01-02', ...Array.from({length:9},(_,i)=>'2026-02-'+(i+15)),
  '2026-04-06', ...Array.from({length:5},(_,i)=>'2026-05-0'+(i+1)), '2026-06-19','2026-09-25',
  ...Array.from({length:7},(_,i)=>'2026-10-0'+(i+1))];
const defaults = {
  initiative_private: true, initiative_group: true, initiative_private_minutes: [60,480],
  initiative_group_minutes: [60,240], initiative_group_idle_minutes:40,
  initiative_quiet_hours: {private:'1-8',group:'1-8'}, initiative_max_unanswered:{private:2,group:2},
  initiative_private_chats:[], initiative_peak_periods:[['09:00','12:00'],['14:00','18:00']],
  initiative_peak_holidays:HOLIDAYS_2026, initiative_peak_minutes:[15,30], initiative_offpeak_minutes:[5,5],
  proactive:true, proactive_after_seconds:[150,240], proactive_window_seconds:1800,
  cooldown_seconds:180, hourly_limit:12, send_quiet_hours:'1-8',
};
const finite = value => typeof value === 'number' && Number.isFinite(value);
function range(value, fallback) {
  return Array.isArray(value) && value.length === 2 && value.every(finite) && value[0] >= 0 && value[1] >= value[0] ? value : fallback;
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function localParts(now, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:zone, year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'short'}).formatToParts(now).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  return {date:parts.year+'-'+parts.month+'-'+parts.day,minute:Number(parts.hour)*60+Number(parts.minute),hour:Number(parts.hour),weekday:parts.weekday};
}
function quietContains(now, spec, zone) {
  if (typeof spec !== 'string' || !/^\d{1,2}-\d{1,2}$/.test(spec)) return false;
  const [start,end]=spec.split('-').map(Number);
  if (start>23||end>23||start===end) return false;
  const hour=localParts(now,zone).hour;
  return start<end ? start<=hour&&hour<end : hour>=start||hour<end;
}
function quietEnd(now, spec, zone) {
  if (!quietContains(now,spec,zone)) return null;
  let candidate=Math.floor(now/MINUTE)*MINUTE+MINUTE;
  for(let i=0;i<26*60;i++,candidate+=MINUTE) if(!quietContains(candidate,spec,zone)) return candidate;
  throw new Error('QUIET_TIME_RESOLUTION_FAILED');
}
function emptyState() { return {version:1,paused:false,chats:{}}; }

/** Timing and delivery state only: never calls a model, controls UI, or starts a background loop. */
export class InitiativeStore {
  constructor({stateDir,chats,clock=Date.now,rng=Math.random,timeZone='Asia/Shanghai',config={}}={}) {
    this.root=scopedDirectory(stateDir,'initiative');
    this.file=path.join(this.root,'initiative.json');
    this.chats=trustedChats(chats); this.clock=clock; this.rng=rng; this.timeZone=timeZone;
    localParts(this.now(),timeZone); // Fail at setup if the host lacks this IANA zone.
    this.config={...defaults,...structuredClone(config)};
    this.state=readJson(this.file,emptyState());
    if(this.state.version!==1||typeof this.state.paused!=='boolean'||!this.state.chats||Array.isArray(this.state.chats)) throw new Error('INVALID_INITIATIVE_STATE');
    for(const [id,s] of Object.entries(this.state.chats)) {
      if(!this.chats.has(id)) continue; // Removed chats cannot become delivery targets.
      if(!s||!finite(s.lastActivity)||!finite(s.nextAt)||!Number.isInteger(s.unanswered)||s.unanswered<0||
        !finite(s.sleepUntil)||!Array.isArray(s.reservations)||!s.reservations.every(finite)||
        (s.claim!=null&&(!s.claim||typeof s.claim.id!=='string'||!['pending','uncertain'].includes(s.claim.status)))) throw new Error('INVALID_INITIATIVE_STATE');
    }
  }
  now() { const now=this.clock(); if(!finite(now)||now<0) throw new Error('INVALID_CLOCK'); return now; }
  chat(id) {const chat=this.chats.get(id);if(!chat)throw new Error('CHAT_NOT_REGISTERED');return chat;}
  save(){scopedDirectory(this.root);atomicJson(this.file,this.state);}
  random(value,fallback,scale=MINUTE){
    const [low,high]=range(value,fallback), sample=this.rng();
    if(!finite(sample)||sample<0||sample>=1)throw new Error('INVALID_RANDOM_SOURCE');
    return (low+(high-low)*sample)*scale;
  }
  next(chat,now,afterActivity=true){
    let delay;
    if(chat.owner){
      const p=localParts(now,this.timeZone),periods=this.config.initiative_peak_periods;
      const minute=s=>{if(typeof s!=='string'||!/^\d\d:\d\d$/.test(s))throw new Error();const [h,m]=s.split(':').map(Number);if(h>23||m>59)throw new Error();return h*60+m;};
      let peak=!['Sat','Sun'].includes(p.weekday)&&!this.config.initiative_peak_holidays.includes(p.date);
      try{peak=peak&&periods.some(([start,end])=>minute(start)<=p.minute&&p.minute<minute(end));}catch{peak=true;}
      delay=this.random(peak?this.config.initiative_peak_minutes:this.config.initiative_offpeak_minutes,peak?[15,30]:[5,5]);
    } else delay=this.random(chat.mode==='group'?this.config.initiative_group_minutes:this.config.initiative_private_minutes,chat.mode==='group'?[60,240]:[60,480]);
    if(chat.mode==='group'&&afterActivity)delay+=Math.max(0,Number(this.config.initiative_group_idle_minutes)||0)*MINUTE;
    return now+delay;
  }
  ensure(id){
    const chat=this.chat(id);let s=this.state.chats[id];if(!s){
      const now=this.now();s=this.state.chats[id]={lastActivity:now,lastIncoming:0,nextAt:this.next(chat,now),unanswered:0,sleepUntil:0,
        nextFollowupAt:0,followupUsed:true,reservations:[],claim:null};this.save();
    }return s;
  }
  heard(id,{text=''}={}){
    const chat=this.chat(id),s=this.ensure(id),now=this.now();
    s.lastActivity=now;s.lastIncoming=now;s.unanswered=0;s.nextAt=this.next(chat,now);s.claim=null;
    s.nextFollowupAt=chat.owner?now+this.random(this.config.proactive_after_seconds,[150,240],1000):0;
    s.followupUsed=!chat.owner;
    if(chat.owner)s.sleepUntil=SLEEP_WORDS.some(w=>String(text).includes(w))?now+5*HOUR:0;
    this.save();return this.describe(id);
  }
  spoke(id,{opening=false}={}){
    const chat=this.chat(id),s=this.ensure(id),now=this.now();s.lastActivity=now;s.nextAt=this.next(chat,now);
    if(opening)s.unanswered++;else if(chat.owner){s.followupUsed=false;s.nextFollowupAt=now+this.random(this.config.proactive_after_seconds,[150,240],1000);}
    s.claim=null;this.save();return this.describe(id);
  }
  declined(id){const s=this.ensure(id);s.nextAt=this.next(this.chat(id),this.now(),false);s.followupUsed=true;s.claim=null;this.save();}
  sleep(id,until){if(!this.chat(id).owner)throw new Error('OWNER_REQUIRED');if(!finite(until)||until<this.now())throw new Error('INVALID_SLEEP_UNTIL');this.ensure(id).sleepUntil=until;this.save();}
  wake(id){this.ensure(id).sleepUntil=0;this.save();}
  ownerAsleep(){const owner=[...this.chats.values()].find(c=>c.owner);return owner?this.ensure(owner.id).sleepUntil>this.now():false;}
  pause(){this.state.paused=true;this.save();}
  resume(){this.state.paused=false;this.save();}
  eligible(chat){return chat.mode==='group'?this.config.initiative_group:
    this.config.initiative_private&&(chat.owner||this.config.initiative_private_chats.includes(chat.id));}
  reason(id){
    const chat=this.chat(id),s=this.ensure(id),now=this.now();
    if(this.state.paused||s.claim||!this.eligible(chat)||(chat.owner&&now<s.sleepUntil))return null;
    const maximum=this.config.initiative_max_unanswered?.[chat.mode]??2;
    if(s.unanswered>=maximum)return null;
    const end=quietEnd(now,this.config.initiative_quiet_hours?.[chat.mode],this.timeZone);
    if(end!==null){s.nextAt=Math.max(s.nextAt,end);this.save();return null;}
    if(chat.owner&&this.config.proactive&&!s.followupUsed&&s.nextFollowupAt<=now&&s.lastIncoming>0&&now-s.lastIncoming<=this.config.proactive_window_seconds*1000)return 'followup';
    const earliest=chat.mode==='group'?s.lastActivity+Math.max(0,Number(this.config.initiative_group_idle_minutes)||0)*MINUTE:0;
    return Math.max(s.nextAt,earliest)<=now?'opening':null;
  }
  due(){return [...this.chats.keys()].filter(id=>this.reason(id)).sort((a,b)=>this.ensure(a).nextAt-this.ensure(b).nextAt||a.localeCompare(b));}
  describe(id){const s=this.ensure(id);return {chatId:id,idleMinutes:Math.max(0,Math.floor((this.now()-s.lastActivity)/MINUTE)),
    unanswered:s.unanswered,nextAt:s.nextAt,sleepUntil:s.sleepUntil,paused:this.state.paused,claim:s.claim?{...s.claim}:null};}
  /** Persist before enqueue. Crashes between enqueue and ack hold an uncertain claim for explicit reconciliation. */
  async tick(onWake){
    if(typeof onWake!=='function')throw new Error('WAKE_CALLBACK_REQUIRED');
    const results=[];
    for(const id of this.due()){
      const reason=this.reason(id);if(!reason)continue;
      const s=this.ensure(id),wakeId=digest(id+'\0'+reason+'\0'+(reason==='followup'?s.nextFollowupAt:s.nextAt));
      s.claim={id:wakeId,status:'pending',createdAt:this.now(),reason};this.save();
      const event={...this.describe(id),wakeId,reason};
      try{
        await onWake(event);
        // heard()/spoke() may have cleared this claim while delivery was awaited.
        if(s.claim?.id===wakeId){s.nextAt=this.next(this.chat(id),this.now(),false);s.followupUsed=true;s.claim=null;this.save();}
        results.push({chatId:id,wakeId,status:'delivered'});
      }catch{
        if(s.claim?.id===wakeId){s.claim.status='uncertain';this.save();}
        results.push({chatId:id,wakeId,status:'uncertain'});
      }
    }return results;
  }
  resolveWake(id,wakeId,{delivered}={}){
    if(typeof delivered!=='boolean')throw new Error('KNOWN_DELIVERY_OUTCOME_REQUIRED');
    const s=this.ensure(id);if(s.claim?.id!==wakeId)throw new Error('WAKE_CLAIM_MISMATCH');
    s.claim=null;if(delivered){s.nextAt=this.next(this.chat(id),this.now(),false);s.followupUsed=true;}this.save();
  }
  /** Called at final send boundary. Keep reservations even when UI delivery is uncertain. */
  reserveSend(id,{proactive=true}={}){
    const chat=this.chat(id),s=this.ensure(id),now=this.now();
    if(this.state.paused)return {allowed:false,reason:'paused'};
    if(chat.owner&&proactive&&now<s.sleepUntil)return {allowed:false,reason:'asleep'};
    if(!proactive||chat.owner)return {allowed:true};
    if(quietContains(now,this.config.send_quiet_hours,this.timeZone))return {allowed:false,reason:'quiet'};
    s.reservations=s.reservations.filter(t=>t>now-HOUR);
    if(s.reservations.length>=this.config.hourly_limit)return {allowed:false,reason:'hourly_limit'};
    if(s.reservations.some(t=>now-t<this.config.cooldown_seconds*1000))return {allowed:false,reason:'cooldown'};
    s.reservations.push(now);this.save();return {allowed:true};
  }
}
