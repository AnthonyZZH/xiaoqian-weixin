"""Single worker-lane acquire. UI surface is trusted startup code, not request data."""
import hashlib,json
from .saved_file_native import require,SavedFileError
from .saved_file_identity import checked_path,WindowsFile,read_saved

def same_instance(broker,entry):
 b=broker.backend;ref=entry['ref'];c=entry['control']
 try:return b.chat==broker.chat and b.adapter.hwnd==ref['hwnd'] and b.module.window_pid(ref['hwnd'])==ref['wechatPid'] and c.ClassName==ref['className'] and list(c.GetRuntimeId())==ref['runtimeId']
 except Exception:return False

def acquire(broker,entry,mid,*,surface):
 require(entry['state']=='new','SAVED_FILE_ALREADY_ATTEMPTED')
 require(broker.current(entry),'SAVED_FILE_CONTROL_REDRAWN')
 require((entry['control'].Name or '').splitlines()[0]=='文件','SAVED_FILE_NATIVE_KIND_UNVERIFIED')
 entry['state']='unknown' # reserve before ANY native receive/location action
 transition=None;selection=None
 def failure(error):
  wrapped=error if isinstance(error,SavedFileError) else SavedFileError('SAVED_FILE_NATIVE_ACTION_UNKNOWN')
  if transition is not None and broker.current(entry):
   wrapped.native_receive_result=dict(kind='native-file-receive-only',completed=False,nativeReceiveVerified=True,
     sourceMessageId=mid,readId=broker.context['readId'],generation=broker.generation,nativeTransition=transition)
  return wrapped
 try:
  before=entry['control'].Name or ''
  if entry['ref'].get('received') is not True:
   require(before.splitlines().count('未下载')==1,'SAVED_FILE_RECEIVE_STATE_UNVERIFIED')
   surface.receive(entry) # exactly one native Download, never Download to/SaveAs/open
   after=entry['control'].Name or ''
   expected='\n'.join(x for x in before.splitlines() if x!='未下载')
   require(same_instance(broker,entry) and after==expected,'SAVED_FILE_RECEIVE_TRANSITION_UNKNOWN')
   transition={'beforeText':before,'afterText':after,'beforeSourceKey':entry['raw']['key'],
    'afterSourceKey':hashlib.sha256(json.dumps([entry['ref']['runtimeId'],'user',after],ensure_ascii=False).encode()).hexdigest(),
    'runtimeId':entry['ref']['runtimeId'],'hwnd':entry['ref']['hwnd'],'wechatPid':entry['ref']['wechatPid']}
   entry['ref'].update(received=True,nameSha256=hashlib.sha256(after.encode()).hexdigest())
  require(broker.current(entry),'SAVED_FILE_CONTROL_CHANGED')
  selection=surface.locate(entry) # native Show in folder -> foreground selected item only
  require(broker.current(entry),'SAVED_FILE_CONTROL_CHANGED')
  request=dict(root=surface.file_root,relativePath=selection['relativePath'],expectedBytes=selection['bytes'])
  root,target=checked_path(request);locked=WindowsFile(root,target)
  try:request['fileIdentity']=locked.identity
  finally:locked.close()
  stable=read_saved(request);stable.pop('base64') # no PDF body in private RPC/provenance
  require(broker.current(entry),'SAVED_FILE_CONTROL_CHANGED')
  entry['state']='completed'
  result=dict(kind='native-saved-file',mappingMethod='native-file-id',completed=True,sourceMessageId=mid,
    readId=broker.context['readId'],generation=broker.generation,accountId=surface.account_id,
    nativeFileId=json.dumps(stable['fileIdentity'],sort_keys=True),displayName=entry['ref']['displayName'],
    relativePath=selection['relativePath'],expectedBytes=stable['bytes'],fileIdentity=stable['fileIdentity'],
    sha256=stable['sha256'],exclusiveRead=stable['exclusiveRead'],nativeTransition=transition)
  return result
 except Exception as error:raise failure(error) from None
 finally:
  # Restore only UI owned by this acquire. An uncertain selection is not retried.
  try:surface.restore(selection)
  except Exception as error:raise failure(error) from None
