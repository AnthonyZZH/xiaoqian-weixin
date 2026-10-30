import {createNativeOrigin} from './native-origin.mjs';
import {digest} from '../state.mjs';
export function bindOwnerBilling({collector,getCore,agentCtx,agent,chat}){
 if(!collector||chat.owner!==true||chat.mode!=='private')return;
 const core=getCore(),binding=core.state(chat.id).binding;
 const current=()=>{
  const c=getCore(),now=c?.chats.get(chat.id);
  return !!(c&&!c.closed&&!c.store.data.paused&&now?.owner===true&&now.mode==='private'&&c.handles.get(chat.id)?.agent===agent&&
   c.state(chat.id).binding===binding&&digest(JSON.stringify([now.id,now.title,now.mode,now.owner]))===binding);
 };
 const tracker=createNativeOrigin({agent,lookupReceipt:nativeMessageId=>{const c=getCore();if(!current())return null;const g=Object.values(c.state(chat.id).replyPermits||{}).find(g=>g.nativeMessageId===nativeMessageId&&g.status==='open');return g&&Object.values(c.state(chat.id).messages||{}).some(m=>m.nativeMessageId===nativeMessageId)?{kind:g.kind}:null;}});
 tracker.attach(agentCtx);
 let dispose;try{dispose=collector.register({sessionId:agent.session.id,active:current,origin:tracker.snapshot,policy:()=>({binding,policyVersion:'core-91cf93a3/owner-private/v1'})});}catch(error){tracker.close();throw error;}
 const close=()=>{tracker.close();dispose();};agentCtx.effect(()=>close);return close;
}
