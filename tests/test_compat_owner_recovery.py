"""Synthetic regression tests for the deployed compatibility generation only."""
from pathlib import Path
import hashlib
import hmac
import sys
import tempfile
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'compat/vendor'))
from xiaoqian_driver import Chat, DriverClient, DriverConfig
from xiaoqian_driver.protocol import SendResult, DriverError
from xiaoqian_driver.state import StateStore
from xiaoqian_driver import snapshot_identity as identity
from xiaoqian_driver import owner_edge_controller as controller

OWNER=Chat('Synthetic owner')
GROUP=Chat('Synthetic group','group')
def row(key, text, **extra):
    return dict(key=key,text=text,role='user',sender='synthetic',**extra)

class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.path=Path(self.temp.name)/'state.sqlite'
        self.store=StateStore(self.path)
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(lambda:self.store.close())
        self.sequence=0
    def seed(self):
        old=self.store.ingest(OWNER,[row('old','persisted old')])
        self.store.ack([m.message_id for m in old.messages])
    def edge(self, rows, epoch='worker1', chat=OWNER):
        self.sequence+=1
        receipt=dict(chat_key=chat.key,page_digest=identity.page_digest(rows),
                     at_live_edge=True,controller_epoch=epoch,
                     viewport_generation='certified-latest',sequence=self.sequence)
        return self.store.ingest(chat,rows,recovery_receipt=receipt,
                                 verify_recovery=lambda supplied: supplied)
    def test_disjoint_large_page_shadows_then_new_tail_enters_once(self):
        self.seed()
        rows=[row('page','x'*12000)]
        self.assertFalse(self.store.ingest(OWNER,rows).messages)
        self.assertFalse(self.edge(rows).messages)
        result=self.edge([row('repaint','x'*12000),row('new','fresh')])
        self.assertEqual([m.text for m in result.messages],['fresh'])
        self.store.ack([m.message_id for m in result.messages])
        self.assertFalse(self.edge([row('again','x'*12000),row('again2','fresh')]).messages)
    def test_switch_epoch_does_not_replay_page(self):
        self.seed();self.edge([row('x','shadow')])
        self.assertFalse(self.edge([row('y','shadow'),row('z','uncertain')],epoch='worker2').messages)
        self.assertEqual([m.text for m in self.edge([row('y','shadow'),row('z','uncertain'),row('t','new')],epoch='worker2').messages],['new'])
    def test_history_does_not_replay_or_move_horizon(self):
        self.seed();self.edge([row('x','shadow')])
        self.assertFalse(self.store.ingest(OWNER,[row('rebuilt','persisted old')]).messages)
        self.assertEqual([m.text for m in self.edge([row('x','shadow'),row('y','new')]).messages],['new'])
    def test_new_identical_body_distinguished_by_order(self):
        self.seed();self.edge([row('x','anchor'),row('y','same')])
        result=self.edge([row('x','anchor'),row('y','same'),row('z','same')])
        self.assertEqual(len(result.messages),1)
        self.assertEqual(result.messages[0].source_key,'z')
    def test_chat_isolation(self):
        self.seed();self.edge([row('x','shadow')])
        group=self.store.ingest(GROUP,[row('g','group')]);self.store.ack([m.message_id for m in group.messages])
        self.edge([row('x','shadow'),row('y','new')])
        self.assertFalse(self.store.ingest(GROUP,[row('g2','group')]).messages)
    def test_ack_and_unknown_persist_after_restart(self):
        self.seed();self.edge([row('x','shadow')])
        result=self.edge([row('x','shadow'),row('y','new')]);self.store.ack([m.message_id for m in result.messages])
        self.store.reserve('operation','fingerprint',{'chat':OWNER.to_dict(),'text':'outgoing'})
        self.store.close();self.store=StateStore(self.path)
        self.assertFalse(self.edge([row('xx','shadow'),row('yy','new')]).messages)
        self.assertEqual(self.store.cached_send('operation','fingerprint').status,'unknown')
    def test_identity_format_change_quarantines_old_page(self):
        self.seed();self.edge([row('x','preview')])
        self.assertFalse(self.edge([row('x','full changed body')]).messages)
        self.assertEqual([m.text for m in self.edge([row('x','full changed body'),row('y','new')]).messages],['new'])
    def test_receipt_replay_rejected(self):
        self.seed();self.edge([row('x','shadow')]);self.sequence-=1
        with self.assertRaisesRegex(ValueError,'replayed'):self.edge([row('x','shadow')])
    def test_bounded_history_never_dispatches(self):
        self.seed();self.store.ingest(OWNER,[row('x','unknown')])
        with self.store.db:
            result=identity.bounded_history(self.store.db,OWNER,[[row('old','persisted old')]])
            self.assertTrue(result['found'])
            identity.bounded_history(self.store.db,OWNER,[[]]*5)
            with self.assertRaisesRegex(ValueError,'exhausted'):identity.bounded_history(self.store.db,OWNER,[[]])
        self.assertFalse(self.store.pending(OWNER))

class ControllerTests(unittest.TestCase):
    def test_owner_is_explicit_and_never_inferred_from_private(self):
        client=SimpleNamespace(config=DriverConfig(mode='real',allow_real=True,adapter_root='optional',allowed_chats=(OWNER,)))
        self.assertIsNone(controller.client_options(client))
        with self.assertRaisesRegex(ValueError,'owner_edge'):DriverConfig(allowed_chats=(GROUP,),owner_edge_chat=GROUP)
    def test_hmac_binds_chat_and_batch(self):
        config=DriverConfig(mode='real',allow_real=True,adapter_root='optional',allowed_chats=(OWNER,),owner_edge_chat=OWNER)
        client=SimpleNamespace(config=config);options=controller.client_options(client)
        backend=SimpleNamespace();controller.configure(backend,options,(OWNER,),OWNER)
        rows=[row('x','synthetic')]
        proof=dict(chat_key=OWNER.key,page_digest=identity.page_digest(rows),at_live_edge=True)
        proof['signature']=hmac.new(client._owner_edge_secret,controller.encoded(proof),hashlib.sha256).hexdigest()
        self.assertIsNotNone(controller.verify(client,proof,OWNER,rows))
        self.assertIsNone(controller.verify(client,proof,OWNER,[row('x','tampered')]))
        self.assertIsNone(controller.verify(client,proof,GROUP,rows))
        with self.assertRaises(DriverError):controller.configure(SimpleNamespace(),options,(OWNER,),None)
    def test_fake_ipc_roundtrip_and_unknown_not_retried(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temp:
            config=DriverConfig(allowed_chats=(OWNER,),owner_edge_chat=OWNER,
                fake_options={'snapshots':{OWNER.key:[row('a','hello')]},
                              'faults':{'send':{'action':'unknown'}}})
            with DriverClient(temp,config) as client:
                self.assertEqual(client.health()['mode'],'fake')
                result=client.read(OWNER);self.assertEqual(len(result.messages),1)
                client.ack([m.message_id for m in result.messages]);self.assertFalse(client.read(OWNER).messages)
                self.assertEqual(client.send(OWNER,'reply',operation_id='stable').status,'unknown')
                self.assertTrue(client.send(OWNER,'reply',operation_id='stable').cached)

if __name__=='__main__':unittest.main(verbosity=2)
