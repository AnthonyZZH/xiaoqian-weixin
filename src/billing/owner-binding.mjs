import {digest} from '../state.mjs';
export function bindOwnerBilling({collector,getCore,agentCtx,agent,chat}){
 if(!collector||chat.owner!==true||chat.mode!=='private')return;
 const core=getCore(),binding=core.state(chat.id).binding;
 const current=()=>{
  const c=getCore(),now=c?.chats.get(chat.id);
  return !!(c&&!c.closed&&!c.store.data.paused&&now?.owner===true&&now.mode==='private'&&c.handles.get(chat.id)?.agent===agent&&
   c.state(chat.id).binding===binding&&digest(JSON.stringify([now.id,now.title,now.mode,now.owner]))===binding);
 };
 const dispose=collector.register({sessionId:agent.session.id,active:current,policy:()=>({binding,policyVersion:'core-91cf93a3/owner-private/v1'})});
 agentCtx.effect(()=>dispose);return dispose;
}
