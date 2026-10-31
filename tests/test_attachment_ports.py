"""Synthetic actual-worker attachment boundaries; never opens a desktop."""
from pathlib import Path
import base64,hashlib,json,sqlite3,sys,tempfile,threading,time,types,unittest,uuid
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'compat'/'vendor'))
from xiaoqian_driver.client import DriverClient
from xiaoqian_driver.protocol import Chat,DriverConfig,DriverError
from xiaoqian_driver.attachment_transport import AttachmentError,prepare,parse_verified,register_native_port
SCRATCH=ROOT/'.test-scratch'/'attachment-ports';SCRATCH.mkdir(parents=True,exist_ok=True)
class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(dir=SCRATCH);self.root=Path(self.tmp.name);self.chat=Chat(name='SYNTHETIC_FILE_OWNER',mode='private');self.group=Chat(name='SYNTHETIC_GROUP',mode='group');self.client=None
 def tearDown(self):
  if self.client:self.client.close()
  self.tmp.cleanup()
 def start(self,fixture=True):
  options={'snapshots':{self.chat.key:[{'key':'synthetic-file-row','text':'sample.txt','role':'user','sender':'synthetic'}]}}
  if fixture:options['attachment_fixture']={'base64':base64.b64encode(b'synthetic document bytes').decode()}
  self.client=DriverClient(self.root/'state',DriverConfig(mode='fake',allowed_chats=(self.chat,self.group),owner_edge_chat=self.chat,command_timeout=5,startup_timeout=3,fake_options=options));self.client.read(self.chat)
  row=self.client._state.db.execute('SELECT message_id FROM inbox WHERE chat_key=?',(self.chat.key,)).fetchone();self.assertIsNotNone(row)
  self.card={'sourceMessageId':row[0],'displayName':'sample.txt'}
  self.scope={'ownerBindingId':'synthetic-binding','ownerChatId':'owner','maxBytes':1024}
  return self.client
 def command(self,op,card=None,scope=None,chat=None):return self.client.attachment_command(chat or self.chat,op,card or self.card,scope or self.scope,timeout=3)
 def test_actual_worker_canonical_save_completion_and_no_replay(self):
  self.start();proof=self.command('attachment_inspect');self.assertTrue(proof['verified']);self.assertEqual(proof['sourceMessageId'],self.card['sourceMessageId'])
  destination=self.root/'state'/'attachment-downloads'/str(uuid.uuid4())/(str(uuid.uuid4())+'.txt');scope=dict(self.scope,destination=str(destination),expectedIdentity=proof['identityToken'])
  self.assertTrue(self.command('attachment_save_as',scope=scope)['actionAttempted'])
  with self.assertRaisesRegex(DriverError,'ATTACHMENT_SAVE_ALREADY_ATTEMPTED'):self.command('attachment_save_as',scope=scope)
  completed=self.command('attachment_completion',scope=scope);self.assertTrue(completed['verified']);self.assertEqual(completed['sha256'],hashlib.sha256(b'synthetic document bytes').hexdigest())
  parsed=parse_verified(destination.parents[1],completed,owner_binding_id='synthetic-binding',chat_id='owner',message_id=self.card['sourceMessageId'],parser=lambda b,e:{'text':b.decode()});self.assertEqual(parsed['text'],'synthetic document bytes')
  destination.write_bytes(b'changed')
  with self.assertRaises(AttachmentError):parse_verified(destination.parents[1],completed,owner_binding_id='synthetic-binding',chat_id='owner',message_id=self.card['sourceMessageId'],parser=lambda b,e:{})
 def test_actual_worker_native_port_remains_disabled(self):
  self.start(fixture=False)
  with self.assertRaisesRegex(DriverError,'NATIVE_ACCEPTANCE_REQUIRED'):self.command('attachment_inspect')
 def test_unknown_canonical_and_group_and_stale_generation_denied(self):
  self.start()
  for op in ['attachment_inspect','attachment_save_as','attachment_completion']:
   with self.assertRaisesRegex(DriverError,'ATTACHMENT_MESSAGE_UNKNOWN'):self.command(op,card={'sourceMessageId':'f'*64,'displayName':'sample.txt'})
  with self.assertRaisesRegex(DriverError,'OWNER_PRIVATE_REQUIRED'):self.command('attachment_inspect',chat=self.group)
  self.client._attachment_snapshot_generation=-1
  with self.assertRaisesRegex(DriverError,'ATTACHMENT_FRESH_READ_REQUIRED'):self.command('attachment_inspect')
 def test_actual_worker_path_escape_and_explicit_command_denied(self):
  self.start()
  with self.assertRaisesRegex(DriverError,'ATTACHMENT_PATH_DENIED'):self.command('attachment_save_as',scope=dict(self.scope,destination=str(self.root/'outside.txt')))
  with self.assertRaisesRegex(DriverError,'attachment_command_denied'):self.command('unregistered')
 def test_current_shadow_observation_cannot_fall_back_to_old_snapshot(self):
  db=sqlite3.connect(':memory:');key='synthetic-stable-key';mid=hashlib.sha256(json.dumps([self.chat.key,key],ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
  db.executescript('CREATE TABLE inbox(chat_key TEXT,message_id TEXT,payload TEXT);CREATE TABLE identity_observation(chat TEXT,items TEXT);CREATE TABLE snapshot_identity(chat TEXT,items TEXT);')
  db.execute('INSERT INTO inbox VALUES(?,?,?)',(self.chat.key,mid,json.dumps({'role':'user'})))
  old=[{'key':key,'raw':'synthetic-row','token':'synthetic-token'}];db.execute('INSERT INTO snapshot_identity VALUES(?,?)',(self.chat.key,json.dumps(old)));db.execute('INSERT INTO identity_observation VALUES(?,?)',(self.chat.key,'[]'))
  fake=types.SimpleNamespace(config=types.SimpleNamespace(allowed_chats=(self.chat,)),_generation=1,_attachment_snapshot_generation=1,_state=types.SimpleNamespace(lock=threading.RLock(),db=db))
  try:
   with self.assertRaisesRegex(AttachmentError,'ATTACHMENT_IDENTITY_DEFERRED'):prepare(fake,self.chat,{'sourceMessageId':mid,'displayName':'sample.txt'},{'ownerBindingId':'synthetic-binding','maxBytes':1024},time.monotonic()+3)
  finally:db.close()
 def test_unaccepted_native_registration_denied(self):
  with self.assertRaisesRegex(AttachmentError,'NATIVE_ACCEPTANCE_REQUIRED'):register_native_port(types.SimpleNamespace(),types.SimpleNamespace(),{'verified':True})
if __name__=='__main__':unittest.main()
