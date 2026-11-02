import crypto from 'node:crypto';
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
// This is the host's existing text envelope, NOT a synthesized SDK request.
// The final transport guard compares it with the actual SDK-emitted text.
export function ownerPrompt(chat,m,prefix){return {role:'user',content:[{type:'text',text:prefix+JSON.stringify({chatKind:chat.mode,origin:'wechat-ui',messageId:m.id,sender:m.sender,text:m.text,media:m.media})}],source:{kind:'xiaoqian-wechat'}};}
export function installIngressBinding({core,ownerId,normalizeMessage,prefix}){
 const receipts=new WeakSet(),prior=core.ingest,priorCheck=core.isPreparedOwnerInput;let service,closed=false;
 const check=receipt=>!closed&&receipts.has(receipt)&&receipt.chatId===ownerId&&core.state(ownerId).binding===receipt.binding&&core.isTrustedDriverMessage(receipt.raw)&&!core.state(ownerId).messages[sha(receipt.sourceId)];
 core.isPreparedOwnerInput=check;
 const wrapped=async function(input){
  if(closed||input.chatId!==ownerId||input.messages?.length!==1)return prior.call(this,input);
  const raw=input.messages[0],chat=core.chats.get(ownerId);let m;
  try{m=normalizeMessage(raw);}catch{return prior.call(this,input);}
  if(!chat?.owner||chat.mode!=='private'||!core.isTrustedDriverMessage(raw)||m.role!=='user'||m.media.length||!/^[a-f0-9]{64}$/.test(m.id)||core.state(ownerId).messages[sha(m.id)]||/^(同意|拒绝|网页确认) /.test(m.text))return prior.call(this,input);
  const receipt=Object.freeze({chatId:ownerId,binding:core.state(ownerId).binding,sourceId:m.id,raw,message:ownerPrompt(chat,m,prefix)});receipts.add(receipt);
  try{const out=await service.beforeInput(receipt);if(['queued','uncertain','running'].includes(out?.status))return {status:'rotation_queued',accepted:0,duplicate:0,rejected:0,ackable:[],quarantined:[m.id]};return await prior.call(this,input);}finally{receipts.delete(receipt);}
 };
 core.ingest=wrapped;
 return {setService(s){service=s;},close(){closed=true;if(core.ingest===wrapped)core.ingest=prior;if(core.isPreparedOwnerInput===check)core.isPreparedOwnerInput=priorCheck;}};
}
