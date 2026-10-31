"""Real fake-worker processes only. Never imports or initializes real WeChat."""
from pathlib import Path
import json, sys, tempfile, unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'compat/vendor'))
from xiaoqian_driver.client import DriverClient
from xiaoqian_driver.protocol import DriverConfig,Chat,DriverError

class Tests(unittest.TestCase):
    def test_unknown_old_send_is_cached_while_independent_send_proceeds(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as root:
            config=DriverConfig(mode='fake',fake_options={'faults':{'send':{'action':'hang','generations':[1],'calls':[1]}}},command_timeout=5)
            client=DriverClient(root,config);chat=Chat('SYNTHETIC OWNER','private')
            try:
                self.assertTrue(client.health(timeout=5)['ready'])
                old=client.send(chat,'synthetic first',operation_id='synthetic-old',timeout=.3)
                self.assertEqual(old.status,'unknown');self.assertIsNone(client._process)
                self.assertEqual(client.send(chat,'synthetic new',operation_id='synthetic-new',timeout=5).status,'success')
                cached=client.send(chat,'synthetic first',operation_id='synthetic-old',timeout=5)
                self.assertEqual(cached.status,'unknown');self.assertTrue(cached.cached)
            finally:client.close()
            events=[json.loads(line) for line in Path(root,'fake-events.jsonl').read_text().splitlines()]
            self.assertEqual(sum(event['command']=='send' for event in events),2)

    def test_default_read_budget_is_distinct_from_explicit_deadline(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as root:
            config=DriverConfig(mode='fake',fake_options={'faults':{'read':{'action':'delay','seconds':.25,'generations':[1],'calls':[1,2]}}},command_timeout=.1)
            client=DriverClient(root,config);chat=Chat('SYNTHETIC OWNER','private')
            try:
                self.assertTrue(client.health(timeout=5)['ready'])
                self.assertEqual(client.read(chat).messages,())
                with self.assertRaises(DriverError):client.read(chat,timeout=.05)
                self.assertTrue(client.health(timeout=5)['ready'])
            finally:client.close()

if __name__=='__main__':unittest.main(verbosity=2)
