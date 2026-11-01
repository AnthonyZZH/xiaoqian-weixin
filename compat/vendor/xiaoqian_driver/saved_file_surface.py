"""Bounded native WeChat receive/show-in-folder surface. No document opens."""
import time,os
from .saved_file_native import require,SavedFileError
from .native_saved_file_location import normalize_location

class NativeFileSurface:
 def __init__(self,backend):
  self.backend=backend;profile=getattr(backend,'_native_saved_profile',None)
  require(isinstance(profile,dict) and profile.get('verified') is True and profile.get('evidenceId') and profile.get('allowNativeReceive') is True,'SAVED_FILE_PROFILE_NOT_VERIFIED')
  self.file_root=profile.get('fileRoot');self.account_id=profile.get('accountId');self.profile=profile
  require(backend.adapter.hwnd==profile.get('hwnd') and backend.module.window_pid(backend.adapter.hwnd)==profile.get('wechatPid'),'SAVED_FILE_PROFILE_INSTANCE_CHANGED')
  require(isinstance(self.file_root,str) and isinstance(self.account_id,str),'SAVED_FILE_PROFILE_NOT_VERIFIED')
  from pathlib import Path
  require(Path(self.file_root).parent.parent.name==self.account_id,'SAVED_FILE_ACCOUNT_ROOT_MISMATCH')
  self.opened_hwnd=None;self.previous_explorers=set();self.draft=None
 def _validate(self,entry):
  b=self.backend;a=b.adapter
  require(b.module.foreground()==a.hwnd,'SAVED_FILE_OWNER_NOT_FOREGROUND')
  edit=a.validate();draft=a.input_value(edit)
  if self.draft is None:self.draft=draft
  require(draft==self.draft,'SAVED_FILE_DRAFT_CHANGED')
  require(list(entry['control'].GetRuntimeId())==entry['ref']['runtimeId'],'SAVED_FILE_CONTROL_REDRAWN')
 def _menu(self,entry,label):
  self._validate(entry)
  entry['control'].RightClick(waitTime=.05)
  import uiautomation as auto
  # Accept native semantic menus only. No same-name controls elsewhere in chats.
  matches=[];count=0
  def walk(c,depth,in_menu=False):
   nonlocal count
   if depth>6 or count>=200:return
   count+=1
   if c.IsOffscreen:return
   menu=in_menu or c.ControlTypeName=='MenuControl'
   if menu and c.ControlTypeName=='MenuItemControl' and c.Name==label and c.ProcessId==entry['ref']['wechatPid']:matches.append(c)
   for child in c.GetChildren():walk(child,depth+1,menu)
  for top in auto.GetRootControl().GetChildren():
   if top.ProcessId==entry['ref']['wechatPid']:walk(top,0)
  require(len(matches)==1,'SAVED_FILE_NATIVE_MENU_UNVERIFIED')
  action=matches[0].GetInvokePattern();require(action is not None,'SAVED_FILE_NATIVE_MENU_NOT_INVOKABLE')
  action.Invoke() # exact native Download or Show in folder only
 def receive(self,entry):
  before=entry['control'].Name or '';expected='\n'.join(x for x in before.splitlines() if x!='未下载')
  self._menu(entry,'下载') # excludes 下载到… / 另存为… / 默认双击
  deadline=time.monotonic()+6
  while time.monotonic()<deadline:
   self._validate(entry)
   if (entry['control'].Name or '')==expected:return
   time.sleep(.05)
  raise SavedFileError('SAVED_FILE_RECEIVE_COMPLETION_UNKNOWN')
 def locate(self,entry):
  import comtypes.client
  windows=comtypes.client.CreateObject('Shell.Application',dynamic=True).Windows()
  for n in range(int(windows.Count)):
   try:self.previous_explorers.add(int(windows.Item(n).HWND))
   except Exception:pass
  self._menu(entry,'在文件夹中显示')
  deadline=time.monotonic()+3
  while time.monotonic()<deadline:
   hwnd=self.backend.module.foreground()
   if self.backend.module.class_name(hwnd)=='CabinetWClass':break
   time.sleep(.05)
  require(self.backend.module.class_name(hwnd)=='CabinetWClass','SAVED_FILE_EXPLORER_NOT_FOREGROUND')
  self.opened_hwnd=hwnd
  # A reused Explorer selection is not independent completion evidence.
  require(hwnd not in self.previous_explorers,'SAVED_FILE_EXISTING_EXPLORER_UNVERIFIED')
  selected=[]
  for n in range(int(windows.Count)):
   window=windows.Item(n)
   if int(window.HWND)!=hwnd:continue
   items=window.Document.SelectedItems();require(int(items.Count)>0,'NATIVE_FILE_PATH_NOT_EXPOSED');require(int(items.Count)==1,'SAVED_FILE_SELECTION_NOT_UNIQUE')
   item=items.Item(0);require(item.IsFileSystem and not item.IsFolder,'SAVED_FILE_SELECTION_NOT_FILE')
   selected.append(dict(relativePath=normalize_location(str(item.Path),self.file_root,entry['ref']['displayName']),bytes=int(item.Size)))
  require(len(selected)==1,'SAVED_FILE_EXPLORER_NOT_UNIQUE');return selected[0]
 def restore(self,selection):
  # Never close a pre-existing user Explorer. No shortcut enters the document.
  import uiautomation as auto
  foreground=self.backend.module.foreground()
  require(foreground in (self.backend.adapter.hwnd,self.opened_hwnd),'SAVED_FILE_FOREGROUND_CHANGED')
  if self.opened_hwnd and self.opened_hwnd not in self.previous_explorers:
   window=auto.ControlFromHandle(self.opened_hwnd)
   require(window.ClassName=='CabinetWClass','SAVED_FILE_EXPLORER_CHANGED')
   window.GetWindowPattern().Close()
  self.backend.adapter.window.SetActive(waitTime=.05)
  if self.draft is not None:self._validate({'control':self.backend.adapter.window,'ref':{'runtimeId':list(self.backend.adapter.window.GetRuntimeId())}})
