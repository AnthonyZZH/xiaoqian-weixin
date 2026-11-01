import base64,contextlib,io,json,sqlite3,sys,tempfile,time,types,unittest
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'compat/vendor'))
from xiaoqian_driver.protocol import Chat,DriverConfig,digest,DriverError
from xiaoqian_driver.client import DriverClient
from xiaoqian_driver.image_native import NativeImageBroker,SyntheticSurface,ImageError
from xiaoqian_driver.image_transport import prepare
from xiaoqian_driver.snapshot_identity import token

class Tests(unittest.TestCase):
 def broker(self,fixture=None,clock=None):
  chat=Chat('SYNTHETIC OWNER','private');raw={'key':'native-raw','text':'[image]','role':'user','sender':'synthetic','image_available':True}
  backend=SimpleNamespace(rows={})
  broker=NativeImageBroker(backend,7,mode='fake',fixture=fixture or {'pixel':[0,255,0,255]},**({'clock':clock} if clock else {}))
  meta=broker.begin_read(chat,[raw]);mid=digest([chat.key,'ordered-canonical'])
  args={**meta,'handle':{'chatKey':chat.key,'sourceKey':raw['key'],'messageId':mid,'generation':7,'token':token(raw)}}
  return broker,chat,args,raw
 def test_current_read_issues_opaque_one_use_capture(self):
  broker,chat,args,raw=self.broker();proof=broker.dispatch(chat,'image_inspect',args)
  self.assertGreaterEqual(len(proof['ticket']),32);self.assertNotIn('rgba',proof)
  args['ticket']=proof['ticket'];frame=broker.dispatch(chat,'image_capture',args)
  self.assertEqual(bytes([0,255,0,255])*4,base64.b64decode(frame['rgba']))
  self.assertTrue(broker.dispatch(chat,'image_current',args)['current'])
  with self.assertRaisesRegex(ImageError,'ALREADY_ATTEMPTED'):broker.dispatch(chat,'image_capture',args)
 def test_unknown_capture_never_retries(self):
  broker,chat,args,_=self.broker({'captureError':True});args['ticket']=broker.dispatch(chat,'image_inspect',args)['ticket']
  with self.assertRaisesRegex(ImageError,'CAPTURE_ERROR'):broker.dispatch(chat,'image_capture',args)
  with self.assertRaisesRegex(ImageError,'CAPTURE_UNKNOWN'):broker.dispatch(chat,'image_capture',args)
 def test_new_read_generation_scope_token_role_and_expiry_reject(self):
  for mutation,code in [(lambda a:a.update(generation=8),'GENERATION_STALE'),(lambda a:a.update(readId='old'),'READ_STALE'),
   (lambda a:a['handle'].update(chatKey='foreign'),'CHAT_CHANGED'),(lambda a:a['handle'].update(token='forged'),'ROW_STALE'),
   (lambda a:a['handle'].update(messageId='not-canonical'),'CANONICAL_REQUIRED')]:
   broker,chat,args,_=self.broker();mutation(args)
   with self.assertRaisesRegex(ImageError,code):broker.dispatch(chat,'image_inspect',args)
  now=[1.0];broker,chat,args,_=self.broker(clock=lambda:now[0]);now[0]=10
  with self.assertRaisesRegex(ImageError,'EXPIRED'):broker.dispatch(chat,'image_inspect',args)
  broker,chat,args,raw=self.broker();broker.begin_read(chat,[raw])
  with self.assertRaisesRegex(ImageError,'READ_STALE'):broker.dispatch(chat,'image_inspect',args)
 def test_real_mode_cannot_activate_json_fake_fixture(self):
  broker=NativeImageBroker(SimpleNamespace(),1,mode='real',fixture={'pixel':[1,2,3,4]})
  self.assertIsNone(broker.surface)
 def test_pure_row_surface_uses_same_worker_capability_and_no_image_child(self):
  from test_row_image_surface import fixture
  f=fixture();raw={'key':'native-row','role':'user','text':'[image]','sender':'SYNTHETIC','image_available':True}
  backend=f.surface.backend;backend.rows={raw['key']:f.message}
  broker=NativeImageBroker(backend,7,mode='fake',surface=f.surface)
  meta=broker.begin_read(f.chat,[raw]);self.assertEqual([],f.api.calls);mid=digest([f.chat.key,'ordered-canonical'])
  args={**meta,'handle':{'chatKey':f.chat.key,'sourceKey':raw['key'],'messageId':mid,'generation':7,'token':token(raw)}}
  proof=broker.dispatch(f.chat,'image_inspect',args);args['ticket']=proof['ticket']
  capture=broker.dispatch(f.chat,'image_capture',args)
  self.assertEqual(f.photo.tobytes(),base64.b64decode(capture['rgba']));self.assertEqual([],f.row.GetChildren())
  with self.assertRaisesRegex(ImageError,'ALREADY_ATTEMPTED'):broker.dispatch(f.chat,'image_capture',args)
 def test_trusted_real_row_profile_selects_row_surface_not_nonexistent_image_control(self):
  from unittest.mock import patch
  from test_row_image_surface import fixture
  f=fixture();backend=f.surface.backend;backend._load=lambda chat:f.adapter;backend._native_image_profile=f.profile
  broker=NativeImageBroker(backend,7,mode='real')
  with patch('xiaoqian_driver.native_image_surface.NativeRowImageSurface',return_value=f.surface) as constructor:
    broker.before_read(f.chat);constructor.assert_called_once_with(backend,{**f.profile,'groupChatKeys':[]})
  self.assertIs(broker.surface,f.surface);self.assertTrue(f.adapter.native_image_enabled)
 def test_canonical_alias_is_resolved_from_current_observation_not_rehashed_raw_key(self):
  chat=Chat('SYNTHETIC OWNER');mid=digest([chat.key,'ordered-canonical'])
  db=sqlite3.connect(':memory:');self.addCleanup(db.close)
  db.executescript('CREATE TABLE inbox(chat_key TEXT,message_id TEXT,payload TEXT);CREATE TABLE snapshot_identity(chat TEXT,items TEXT);CREATE TABLE identity_observation(chat TEXT,items TEXT);')
  db.execute('INSERT INTO inbox VALUES(?,?,?)',(chat.key,mid,json.dumps({'role':'user'})))
  db.execute('INSERT INTO identity_observation VALUES(?,?)',(chat.key,json.dumps([{'key':'ordered-canonical','raw':'current-native-key','token':'fingerprint','shadow':False}])))
  client=SimpleNamespace(config=SimpleNamespace(allowed_chats=(chat,)),_generation=7,_image_snapshot_generation=7,
    last_image_read={'readId':'read-1','generation':7},_state=SimpleNamespace(lock=contextlib.nullcontext(),db=db))
  args={'messageId':mid,'readId':'read-1','generation':7,'handle':{'sourceKey':'forged'}}
  prepared=prepare(client,chat,args);self.assertEqual('current-native-key',prepared['handle']['sourceKey'])
  self.assertNotEqual(mid,digest([chat.key,'current-native-key']))
  db.execute('UPDATE identity_observation SET items=?',(json.dumps([{'key':'ordered-canonical','raw':'old','token':'old','shadow':True}]),))
  db.execute('INSERT INTO snapshot_identity VALUES(?,?)',(chat.key,json.dumps([{'key':'ordered-canonical','raw':'stale','token':'old'}])))
  with self.assertRaisesRegex(ImageError,'IDENTITY_DEFERRED'):prepare(client,chat,args)
 def test_real_client_worker_ipc_generates_read_provenance_and_rejects_replay_restart(self):
  chat=Chat('SYNTHETIC OWNER');raw={'key':'native-row','role':'user','sender':'SYNTHETIC','text':'[image]','image_available':True}
  with tempfile.TemporaryDirectory(dir=ROOT/'tests') as directory:
   cfg=DriverConfig(mode='fake',allowed_chats=(chat,),command_timeout=5,startup_timeout=5,
      fake_options={'snapshots':{chat.key:[raw]},'native_image_fixture':{'pixel':[20,40,60,255]}})
   client=DriverClient(directory,cfg)
   try:
    read=client.read(chat);meta=client.last_image_read;self.assertEqual(1,meta['generation']);self.assertTrue(meta['readId'])
    mid=read.messages[0].message_id
    args={'messageId':mid,'readId':meta['readId'],'generation':meta['generation']}
    proof=client.native_image_command(chat,'image_inspect',args);args['ticket']=proof['ticket']
    frame=client.native_image_command(chat,'image_capture',args);self.assertEqual(16,len(base64.b64decode(frame['rgba'])))
    self.assertEqual(mid,frame['messageId'])
    with self.assertRaisesRegex(DriverError,'ALREADY_ATTEMPTED'):client.native_image_command(chat,'image_capture',args)
    client.read(chat)
    with self.assertRaisesRegex(DriverError,'READ_STALE'):client.native_image_command(chat,'image_current',args)
    client._submit('restart',{},5)
    with self.assertRaisesRegex(DriverError,'FRESH_READ_REQUIRED'):client.native_image_command(chat,'image_current',args)
   finally:client.close()
 def test_rpc_only_admits_owner_private_or_single_explicit_group(self):
  from unittest.mock import patch
  source=ROOT/'compat/driver/bridge_rpc.py'
  calls=[]
  class Client:
   def __init__(self,*a):pass
   def close(self):pass
   def native_image_command(self,*a,**kw):calls.append(a);return {'synthetic':True}
  class Schedule:
   @staticmethod
   def from_legacy(value):return value
  fakeMedia=types.ModuleType('xiaoqian_media');fakeMedia.MediaLibrary=lambda *a,**kw:object()
  fakeSchedule=types.ModuleType('owner_wake_policy');fakeSchedule.ScheduleConfig=Schedule;fakeSchedule.Scheduler=lambda *a:object()
  for owner,mode,enabled,groups,expected in [(True,'group',True,[],'IMAGE_CHAT_NOT_AUTHORIZED'),(False,'private',True,[],'IMAGE_CHAT_NOT_AUTHORIZED'),(True,'private',False,[],'STATIC_CAPTURE_NOT_ENABLED'),(False,'group',True,[],'IMAGE_CHAT_NOT_AUTHORIZED'),(False,'group',True,['test'],'NATIVE_IMAGE'),(True,'private',True,[],'NATIVE_IMAGE')]:
   calls.clear()
   config={'mode':'fake','state_dir':str(ROOT/'tests'),'media_root':str(ROOT/'tests'),'schedule_path':'synthetic',
     'media_allow_static_capture':enabled,'group_image_ids':groups,'chats':[{'id':'test','title':'SYNTHETIC','mode':mode,'owner':owner}]}
   requests=[{'id':1,'operation':'initialize','args':{'config':config}},{'id':2,'operation':'image_capture','args':{'targetId':'test'}}]
   output=io.StringIO()
   with patch.dict(sys.modules,{'xiaoqian_media':fakeMedia,'owner_wake_policy':fakeSchedule}):
    ns={'__file__':str(source),'__name__':'synthetic_rpc'};exec(compile(source.read_text(encoding='utf-8'),str(source),'exec'),ns)
    ns['DriverClient']=Client
    with patch.object(sys,'stdin',io.StringIO('\n'.join(map(json.dumps,requests)))),contextlib.redirect_stdout(output):ns['serve']()
   rows=[json.loads(line) for line in output.getvalue().splitlines()]
   self.assertEqual(expected,rows[-1]['code']);self.assertEqual(1 if expected=='NATIVE_IMAGE' else 0,len(calls))

if __name__=='__main__':unittest.main(verbosity=2)
