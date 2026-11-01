import os,sys,unittest,tempfile,hashlib,json,sqlite3,threading
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'compat/vendor'))
from xiaoqian_driver.saved_file_native import NativeSavedFileBroker,SavedFileError
from xiaoqian_driver.saved_file_transition import commit_received_transition
from xiaoqian_driver.snapshot_identity import token
from xiaoqian_driver.protocol import Chat,digest,DriverError

class FixtureSurface:
 def __init__(self,root,data):self.file_root=str(root);self.account_id='fixture-account';self.data=data;self.receives=0;self.locates=0;self.restores=0;self.fail=None
 def receive(self,entry):
  self.receives+=1
  if self.fail=='receive':raise SavedFileError('SAVED_FILE_RECEIVE_COMPLETION_UNKNOWN')
  entry['control'].Name=entry['control'].Name.replace('\n未下载','')
 def locate(self,entry):
  self.locates+=1
  if self.fail=='locate':raise SavedFileError('SAVED_FILE_EXPLORER_NOT_FOREGROUND')
  return dict(relativePath='2026-11/fixture.pdf',bytes=len(self.data))
 def restore(self,_):self.restores+=1

@unittest.skipUnless(os.name=='nt','Windows native handle identity integration')
class AcquireTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent);assert Path(self.temp.name).resolve().parent==Path(__file__).resolve().parent;self.addCleanup(self.temp.cleanup)
  self.root=Path(self.temp.name)/'xwechat_files/fixture-account/msg/file';(self.root/'2026-11').mkdir(parents=True)
  self.data=b'%PDF-1.4\nsynthetic fixture\n';(self.root/'2026-11/fixture.pdf').write_bytes(self.data)
 def fixture(self,received=False):
  chat=Chat('TEST_OWNER');name='文件\nfixture.pdf\n27.5K'+('' if received else '\n未下载')+'\n微信电脑版';rid=[1,2,3]
  c=SimpleNamespace(Name=name,ClassName='mmui::ChatBubbleItemView',GetRuntimeId=lambda:rid)
  ref=dict(kind='file',received=received,hwnd=99,wechatPid=44,runtimeId=rid,className=c.ClassName,nameSha256=hashlib.sha256(name.encode()).hexdigest(),displayName='fixture.pdf')
  key=hashlib.sha256(json.dumps([rid,'user',name],ensure_ascii=False).encode()).hexdigest();raw=dict(key=key,text=name,role='user',native_ref=ref)
  backend=SimpleNamespace(chat=chat,_edge_owner=chat,adapter=SimpleNamespace(hwnd=99),module=SimpleNamespace(window_pid=lambda _:44,foreground=lambda:99),rows={key:SimpleNamespace(native_row=c)})
  broker=NativeSavedFileBroker(backend,7);broker.begin_read(chat,[raw],dict(readId='fresh',generation=7));surface=FixtureSurface(self.root,self.data);broker.test_surface=surface
  mid=digest([chat.key,'canonical']);args=dict(readId='fresh',generation=7,handle=dict(sourceKey=key,messageId=mid,chatKey=chat.key,generation=7,token=token(raw)))
  return chat,c,broker,surface,args,raw
 def test_unreceived_download_once_locate_and_stable_hash(self):
  chat,c,b,s,a,raw=self.fixture();out=b.dispatch(chat,'saved_file_acquire',a)
  self.assertEqual((s.receives,s.locates,s.restores),(1,1,1));self.assertEqual(out['sha256'],hashlib.sha256(self.data).hexdigest());self.assertEqual(out['expectedBytes'],len(self.data));self.assertNotIn('base64',out);self.assertTrue(out['completed']);self.assertIsNotNone(out['nativeTransition'])
  with self.assertRaisesRegex(SavedFileError,'ALREADY_ATTEMPTED'):b.dispatch(chat,'saved_file_acquire',a)
  self.assertEqual(s.receives,1)
 def test_existing_received_pdf_is_never_downloaded_again(self):
  chat,c,b,s,a,raw=self.fixture(True);out=b.dispatch(chat,'saved_file_acquire',a)
  self.assertEqual(s.receives,0);self.assertEqual(s.locates,1);self.assertIsNone(out['nativeTransition'])
 def test_uncertain_receive_is_not_retried(self):
  chat,c,b,s,a,raw=self.fixture();s.fail='receive'
  with self.assertRaises(SavedFileError):b.dispatch(chat,'saved_file_acquire',a)
  with self.assertRaisesRegex(SavedFileError,'ALREADY_ATTEMPTED'):b.dispatch(chat,'saved_file_acquire',a)
  self.assertEqual(s.receives,1);self.assertEqual(s.restores,1)
 def test_locate_failure_does_not_repeat_receive(self):
  chat,c,b,s,a,raw=self.fixture();s.fail='locate'
  with self.assertRaises(SavedFileError):b.dispatch(chat,'saved_file_acquire',a)
  with self.assertRaises(SavedFileError):b.dispatch(chat,'saved_file_acquire',a)
  self.assertEqual((s.receives,s.locates),(1,1))
 def test_redraw_before_action_rejects(self):
  chat,c,b,s,a,raw=self.fixture();c.GetRuntimeId=lambda:[9,9,9]
  with self.assertRaises(SavedFileError):b.dispatch(chat,'saved_file_acquire',a)
  self.assertEqual(s.receives+s.locates,0)
 def test_old_generation_other_chat_rejects_before_action(self):
  for change in ('generation','chat'):
   chat,c,b,s,a,raw=self.fixture()
   if change=='generation':a['generation']=6
   else:chat=Chat('OTHER')
   with self.assertRaises(SavedFileError):b.dispatch(chat,'saved_file_acquire',a)
   self.assertEqual(s.receives+s.locates,0)
 def test_native_receive_alias_keeps_real_canonical(self):
  chat,c,b,s,a,raw=self.fixture();out=b.dispatch(chat,'saved_file_acquire',a)
  db=sqlite3.connect(':memory:');self.addCleanup(db.close);db.executescript('CREATE TABLE identity_observation(chat TEXT,items TEXT);CREATE TABLE snapshot_identity(chat TEXT,items TEXT);')
  item=dict(key='canonical',raw=raw['key'],token=token(raw))
  for table in ('identity_observation','snapshot_identity'):db.execute('INSERT INTO '+table+' VALUES(?,?)',(chat.key,json.dumps([item])))
  state=SimpleNamespace(db=db,lock=threading.RLock());commit_received_transition(state,chat,out,a['handle'])
  new=json.loads(db.execute('SELECT items FROM identity_observation').fetchone()[0])[0]
  self.assertEqual(digest([chat.key,new['key']]),out['sourceMessageId']);self.assertEqual(new['raw'],out['nativeTransition']['afterSourceKey']);self.assertNotEqual(new['raw'],raw['key'])
 def test_completed_receive_alias_survives_later_location_failure(self):
  chat,c,b,s,a,raw=self.fixture();s.fail='locate'
  with self.assertRaises(SavedFileError) as caught:b.dispatch(chat,'saved_file_acquire',a)
  partial=caught.exception.native_receive_result
  self.assertFalse(partial['completed']);self.assertTrue(partial['nativeReceiveVerified'])
  db=sqlite3.connect(':memory:');self.addCleanup(db.close);db.executescript('CREATE TABLE identity_observation(chat TEXT,items TEXT);CREATE TABLE snapshot_identity(chat TEXT,items TEXT);')
  db.execute('INSERT INTO identity_observation VALUES(?,?)',(chat.key,json.dumps([dict(key='canonical',raw=raw['key'],token=token(raw))])))
  commit_received_transition(SimpleNamespace(db=db,lock=threading.RLock()),chat,partial,a['handle'])
  item=json.loads(db.execute('SELECT items FROM identity_observation').fetchone()[0])[0]
  self.assertEqual(item['raw'],partial['nativeTransition']['afterSourceKey']);self.assertEqual(s.receives,1)
 def test_profile_bound_to_other_wechat_instance_rejects_before_ui(self):
  from xiaoqian_driver.saved_file_surface import NativeFileSurface
  backend=SimpleNamespace(_native_saved_profile=dict(verified=True,evidenceId='TEST',allowNativeReceive=True,hwnd=99,wechatPid=45),adapter=SimpleNamespace(hwnd=99),module=SimpleNamespace(window_pid=lambda _:44))
  with self.assertRaisesRegex(SavedFileError,'INSTANCE_CHANGED'):NativeFileSurface(backend)
 def test_unverified_ui_profile_rejects_before_ui_import(self):
  from xiaoqian_driver.saved_file_surface import NativeFileSurface
  with self.assertRaisesRegex(SavedFileError,'PROFILE_NOT_VERIFIED'):NativeFileSurface(SimpleNamespace(_native_saved_profile=None))
 def test_transition_cannot_be_arbitrary_edited_text(self):
  chat,c,b,s,a,raw=self.fixture();out=b.dispatch(chat,'saved_file_acquire',a);out['nativeTransition']['afterText']='different file body'
  with self.assertRaises(DriverError):commit_received_transition(None,chat,out,a['handle'])

if __name__=='__main__':unittest.main()
