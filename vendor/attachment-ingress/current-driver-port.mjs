import {createDriverUIAPort} from './broker-ui-port.mjs';
import {createDriverAttachmentIngress} from './host-binding.mjs';
/** Existing durable driver RPC wrapper; does not expose native commands to Agents. */
export function bindCurrentDriverPort(driver,ownerChatId){
 return createDriverUIAPort(async(command,{card,scope},control)=>{
  const reply=await driver.call(command,{targetId:ownerChatId,card,scope},control);
  if(reply?.status!=='ok'||!reply.data)throw Error(reply?.code||'ATTACHMENT_RPC_FAILED');
  return reply.data;
 });
}
export function createCurrentHostIngress({driver,...options}){
 return createDriverAttachmentIngress({...options,invokeDriver:async(command,{card,scope},control)=>{
  const reply=await driver.call(command,{targetId:options.ownerChatId,card,scope},control);
  if(reply?.status!=='ok'||!reply.data)throw Error(reply?.code||'ATTACHMENT_RPC_FAILED');
  return reply.data;
 }});
}
