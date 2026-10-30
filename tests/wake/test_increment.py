import pathlib,tempfile,unittest
from datetime import datetime
from random import Random
from owner_wake_policy import ScheduleConfig,Scheduler,price_band

def ep(s):return datetime.fromisoformat(s+'+08:00').timestamp()

class IncrementTests(unittest.TestCase):
    def test_explicit_master_disabled_has_no_due_or_events(self):
        cfg=ScheduleConfig.from_legacy({'owner':'owner','chats':{'owner':{'mode':'private'},'group':{'mode':'group'}},'initiative_enabled':False})
        with tempfile.TemporaryDirectory(dir=pathlib.Path(__file__).parent) as tmp:
            now=ep('2026-10-30T10:00:00')
            s=Scheduler(pathlib.Path(tmp)/'s.db',cfg,clock=lambda:now,rng=Random(2))
            self.assertFalse(any(p.enabled for p in cfg.chats));self.assertEqual(s.poll(),[]);self.assertIsNone(s.next_wakeup());self.assertIsNone(s.snapshot()['owner_wake_state'][0]['next_due'])
    def test_unknown_calendar_weekday_weekend(self):
        cfg=ScheduleConfig.from_legacy({'owner':'owner','chats':{'owner':{'mode':'private'}}})
        with tempfile.TemporaryDirectory(dir=pathlib.Path(__file__).parent) as tmp:
            now=ep('2027-01-04T10:00:00')
            s=Scheduler(pathlib.Path(tmp)/'s.db',cfg,clock=lambda:now,rng=Random(2))
            row=s.snapshot()['owner_wake_state'][0]
            self.assertEqual(price_band(now),'calendar_unknown')
            self.assertEqual(row['price_band'],'calendar_unknown')
            self.assertTrue(1080<=row['next_due']-now<=1920)
            now=ep('2027-01-09T10:00:00')
            s.poll();row=s.snapshot()['owner_wake_state'][0]
            self.assertEqual(row['price_band'],'offpeak')
            self.assertTrue(180<=row['next_due']-now<=420)
    def test_timeout_persists_and_reschedules(self):
        cfg=ScheduleConfig.from_legacy({'owner':'owner','chats':{'owner':{'mode':'private'}}})
        with tempfile.TemporaryDirectory(dir=pathlib.Path(__file__).parent) as tmp:
            now=ep('2026-10-30T00:00:00')
            s=Scheduler(pathlib.Path(tmp)/'s.db',cfg,clock=lambda:now,rng=Random(2))
            now=s.snapshot()['owner_wake_state'][0]['next_due'];e=s.poll()[0];c=s.claim(e.event_id,'mock',lease_seconds=300)
            now+=120
            self.assertTrue(s.finish(e.event_id,c.token,'declined',decision='decision_timeout'))
            row=s.snapshot()['owner_wake_state'][0]
            self.assertEqual(row['decision'],'decision_timeout')
            self.assertTrue(180<=row['next_due']-now<=420)
            self.assertEqual(s.snapshot()['owner_wake_audit'][0]['decision'],'decision_timeout')
            self.assertEqual(s.poll(),[])

if __name__=='__main__':unittest.main()
