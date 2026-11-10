"""Group rename: message identity must stay bound to the configured title, not the shown name."""
import hashlib, json, sys, unittest
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / 'vendor'))
from xiaoqian_driver.protocol import Chat, Message, digest
from xiaoqian_driver import snapshot_identity


class ChatIdentity(unittest.TestCase):
    def test_legacy_key_unchanged(self):
        self.assertEqual(Chat('老群名', 'group').key, digest({'name': '老群名', 'mode': 'group'}))
        self.assertEqual(Chat('老群名', 'group').to_dict(), {'name': '老群名', 'mode': 'group'})

    def test_rename_keeps_key_and_message_ids(self):
        old, renamed = Chat('老群名', 'group'), Chat('新群名', 'group', '老群名')
        self.assertEqual(renamed.key, old.key)
        row = {'key': 'row-1', 'text': 'hi', 'role': 'user', 'sender': 'a'}
        self.assertEqual(Message.from_row(renamed, row).message_id, Message.from_row(old, row).message_id)

    def test_roundtrip_and_identity_collapse(self):
        c = Chat('新群名', 'group', '老群名')
        self.assertEqual(Chat(**c.to_dict()), c)
        self.assertEqual(Chat('同名', 'group', '同名'), Chat('同名', 'group'))

    def test_outbound_identity_hash_matches_key(self):
        c = Chat('新群名', 'group', '老群名')
        class DB:
            def execute(self, sql, args): self.args = args
        db = DB()
        snapshot_identity.remember_send(db, 'op', {'chat': c.to_dict(), 'text': 'x'})
        self.assertEqual(db.args[1], c.key)


if __name__ == '__main__':
    unittest.main()
