/** Driver IPC adapter. invoke is host-only, serialized and hard-time-bounded. */
export function createDriverUIAPort(invoke){
 if(typeof invoke!=='function')throw new Error('DRIVER_TRANSPORT_REQUIRED');
 const request=(command,card,scope)=>invoke(command,{card,scope:{
  ownerBindingId:scope.ownerBindingId,ownerChatId:scope.ownerChatId,maxBytes:scope.maxBytes,
  deadline:scope.deadline,destination:scope.destination,expectedIdentity:scope.expectedIdentity,
  evidenceId:scope.evidenceId}}, {signal:scope.signal,deadline:scope.deadline});
 return Object.freeze({inspect:(c,s)=>request('attachment_inspect',c,s),
  saveAs:(c,s)=>request('attachment_save_as',c,s),completion:(c,s)=>request('attachment_completion',c,s)});
}
