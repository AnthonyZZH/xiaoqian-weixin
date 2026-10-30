import {digest} from './state.mjs';
import {requireValue} from './policy.mjs';

// Grants come from durable bridge input and native session events, never tool arguments.
export class ReplyPermits {
  constructor(core){this.core=core;this.active=new Map();}
  table(id){return this.core.state(id).replyPermits??={};}
  issue(id,{sourceId,nativeMessageId,kind='incoming',wakeId}){
    const key=digest(kind+':'+sourceId),table=this.table(id);
    if(!table[key])table[key]={nativeMessageId,kind,remaining:kind==='proactive'?1:5,status:'open',...(wakeId?{wakeId}:{})};
    return key;
  }
  attach(id,ctx,agent){
    // Migration is restricted to actual pending bridge inputs, not old transcript text.
    for(const m of agent.inbox?.nextTurn||[]){
      if(m.source?.kind!=='xiaoqian-wechat'||m.role!=='user')continue;
      try{
        const body=m.content.find(b=>b.type==='text')?.text;
        const envelope=JSON.parse(body.slice(body.indexOf('\n')+1));
        const receipt=this.core.state(id).messages[digest(envelope.messageId)];
        if(receipt?.status==='accepted')this.issue(id,{sourceId:envelope.messageId,nativeMessageId:m.id});
      }catch{/* A malformed/foreign pending message receives no send capability. */}
    }
    if(typeof ctx.on!=='function')return; // Direct embedding/tests use explicit bridge grants.
    ctx.on('session/event',(session,event)=>{
      if(session!==agent.session)return;
      if(event.type==='turn/start')this.active.set(id,{agent,turn:event.data.turn,grantId:null});
      const active=this.active.get(id);
      if(!active||active.agent!==agent)return;
      if(event.type==='user/message'){
        const hit=Object.entries(this.table(id)).find(([,g])=>g.nativeMessageId===event.data.id&&g.status==='open');
        if(hit){active.grantId=hit[0];hit[1].turn=active.turn;this.core.store.save();}
      }
      if(event.type==='turn/end'&&event.data.turn===active.turn){
        this.close(id,active.grantId,'turn-ended');this.active.delete(id);
      }
    });
  }
  context(id,agent){
    const active=this.active.get(id);
    return {nativeTurn:true,grantId:active?.agent===agent?active.grantId:null,turn:active?.turn};
  }
  consume(id,context={}){
    const table=this.table(id);
    const key=context.nativeTurn?context.grantId:Object.keys(table).find(k=>table[k].status==='open'&&table[k].remaining>0);
    const grant=key&&table[key];
    if(context.nativeTurn){const active=this.active.get(id);requireValue(active?.grantId===key&&active?.turn===context.turn,'NO_REPLY_PERMIT');}
    requireValue(grant?.status==='open'&&grant.remaining>0,'NO_REPLY_PERMIT');
    grant.remaining--;this.core.store.save();return {...context,grantId:key,grantKind:grant.kind,wakeId:grant.wakeId};
  }
  close(id,key,reason){
    const grant=key&&this.table(id)[key];
    if(grant){if(grant.status==='open')grant.status=reason;grant.remaining=0;this.core.store.save();}
  }
}
