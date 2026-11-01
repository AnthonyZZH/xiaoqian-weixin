const error=()=>Object.assign(Error('IMAGE_AUTO_EXTERNAL_NOT_AUTHORIZED'),{code:'IMAGE_AUTO_EXTERNAL_NOT_AUTHORIZED'});
/** Only code-owned opaque group preflight claims may enter native image input. */
export function routedImageInput(inner,{ownerChatId,groupChatId,getGroupGate}={}){
 if(typeof inner?.prepare!=='function'||typeof inner?.content!=='function'||!ownerChatId||typeof getGroupGate!=='function')throw Error('IMAGE_ROUTING_DEPENDENCY_REQUIRED');
 const prepared=new WeakSet();
 return Object.freeze({
  prepare(input){
   if(input?.chatId===ownerChatId)return inner.prepare(input);
   const p=input?.groupPreflight,gate=getGroupGate();
   if(input?.chatId!==groupChatId||!p||p.gate!==gate||!gate||p.message?.id!==input.message?.id||prepared.has(p.message)||gate.hasClaimedImage(p.ticket,p.message)!==true)throw error();
   prepared.add(p.message);return inner.prepare(input);
  },
  content(...args){return inner.content(...args);},
  isUncertainFailure(error){return inner.isUncertainFailure?.(error)===true;}
 });
}
