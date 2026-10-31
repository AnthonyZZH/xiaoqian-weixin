/** Feed attachments to current createOwnerSupplements via services.attachments.
 * Does not construct or register a second owner toolkit. No startup UI effects.
 */
import {createAttachmentIngress} from './attachment-ingress-pdf.mjs';
import {createDownloadBroker} from './download-broker-pdf.mjs';
import {createDriverUIAPort} from './broker-ui-port.mjs';
export function createDriverAttachmentIngress({spoolRoot,downloadRoot,ownerBindingId,ownerChatId,
 createAttachmentRegistry,isOwnerActive,acceptedProfile,invokeDriver,withDriverLease,
 timeoutMs=8000,pollMs=200}={}){
 if(acceptedProfile?.verified!==true||acceptedProfile?.nativeAcceptance!==true)throw Error('NATIVE_ACCEPTANCE_REQUIRED');
 if(typeof withDriverLease!=='function')throw Error('SHARED_DRIVER_LEASE_REQUIRED');
 const broker=createDownloadBroker({root:downloadRoot,uiPort:createDriverUIAPort(invokeDriver),
  profile:acceptedProfile,isOwnerActive,timeoutMs,pollMs});
 const ingress=createAttachmentIngress({root:spoolRoot,ownerBindingId,ownerChatId,createAttachmentRegistry,
  downloadBroker:broker,isOwnerActive});
 let pending=Promise.resolve();
 return Object.freeze({attachments:ingress.attachments,receiveOwnerFile(event,evidence){
  const next=pending.then(()=>withDriverLease(async()=>{
   const descriptor=await ingress.receive(event,evidence);
   return {descriptor,agentInput:ingress.agentInput(descriptor)};
  }));pending=next.catch(()=>{});return next;
 }});
}
