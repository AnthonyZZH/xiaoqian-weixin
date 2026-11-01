import {createNativeImageInput} from './native-image-input.mjs';
import {createDriverNativeImageHost} from './driver-native-image-host.mjs';
import {createGroupImagePreflight} from './group-image-preflight.mjs';
import {routedImageInput} from './routed-image-input.mjs';
import {WeChatCore} from './core.mjs';
import {normalizeMessage,requireValue} from './policy.mjs';
import {digest} from './state.mjs';

/** Trusted startup integration of the r11 routing algorithm, not a model tool.
 * The existing synchronous text policy remains host-owned. This function does
 * not install a profile, pause/restart anything, read history, or call a model.
 */
export function installScopedGroupImages({bridge,attachments,groupId,decideTopic,topicIdleMs}={}){
 const {core,driver}=bridge||{};
 requireValue(core&&!core.closed&&core.store.data.paused&&driver?.paused===true&&!driver.child&&!driver.pending,'IMAGE_STARTUP_QUIESCENCE_REQUIRED');
 requireValue(core.imageInput&&driver.options?.mediaAllowStaticCapture===true,'IMAGE_STARTUP_NOT_AUTHORIZED');
 const owners=[...core.chats.values()].filter(c=>c.owner===true&&c.mode==='private');
 requireValue(owners.length===1,'OWNER_IMAGE_BINDING_REQUIRED');
 const owner=owners[0],group=core.chat(groupId);
 requireValue(group.mode==='group'&&group.owner!==true,'GROUP_IMAGE_BINDING_INVALID');
 requireValue(!core.capabilities.groupImagePreflights?.size,'GROUP_IMAGE_GATE_ALREADY_INSTALLED');
 const previous={input:core.imageInput,gates:core.capabilities.groupImagePreflights,groupIds:driver.options.groupImageIds};
 const gate=createGroupImagePreflight({core,normalizeMessage,nativeIngest:WeChatCore.prototype.ingest,groupId,decideTopic,topicIdleMs});
 let input;
 const getScope=chatId=>{
  const c=core.chats.get(chatId);if(!c)return null;const s=core.state(chatId);
  const inScope=chatId===owner.id&&c.owner&&c.mode==='private'||chatId===group.id&&c===group&&c.mode==='group'&&!c.owner;
  return {active:!!inScope&&core.imageInput===input&&!core.closed&&!core.store.data.paused&&!s.rotationFence&&!s.rotationUncertain&&!(c.mode==='group'&&s.groupPaused)&&s.binding===digest(JSON.stringify([c.id,c.title,c.mode,c.owner])),
   binding:s.binding,sessionId:s.sessionId,owner:c.owner,mode:c.mode,groupEpoch:s.groupEpoch||0,
   groupRouteKey:c.mode==='group'?digest(JSON.stringify([s.groupEpoch,s.topicEpoch,s.groupTopic])):null,
   provider:core.model.provider,model:core.model.model};
 };
 input=routedImageInput(createNativeImageInput({attachments,provider:createDriverNativeImageHost(driver),getScope}),
  {ownerChatId:owner.id,groupChatId:group.id,getGroupGate:()=>core.capabilities.groupImagePreflights?.get(group.id)});
 const restoreIngest=gate.install();
 core.capabilities.groupImagePreflights=new Map([[group.id,gate]]);
 driver.options.groupImageIds=[group.id];core.imageInput=input;
 let closed=false;
 return ()=>{if(closed)return;closed=true;gate.close();restoreIngest();
  if(core.capabilities.groupImagePreflights?.get(group.id)===gate)core.capabilities.groupImagePreflights=previous.gates;
  if(core.imageInput===input)core.imageInput=previous.input;
  driver.options.groupImageIds=previous.groupIds;
 };
}
