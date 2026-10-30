import pathlib,sys,tempfile,unittest
from datetime import datetime
from random import Random
from owner_wake_policy import ScheduleConfig,Scheduler,price_band

def epoch(s): return datetime.fromisoformat(s+'+08:00').timestamp()

class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir=pathlib.Path(__file__).parent)
        self.path=pathlib.Path(self.tmp.name)/'synthetic.sqlite3'
        self.now=epoch('2026-10-30T00:00:00')
        self.cfg=ScheduleConfig.from_legacy({'owner':'synthetic-owner','chats':{'synthetic-owner':{'mode':'private'},'synthetic-group':{'mode':'group'}},'initiative_private':False,'initiative_group':True})
    def tearDown(self):self.tmp.cleanup()
    def scheduler(self):return Scheduler(self.path,self.cfg,clock=lambda:self.now,rng=Random(9))
    def due(self,s):return s.snapshot()['chats'][0]['next_at'] if len(s.snapshot()['chats'])==1 else next(r['next_at'] for r in s.snapshot()['chats'] if r['key']==self.cfg.chats[0].key)
    def event(self,s):
        self.now=self.due(s);return s.poll()[0]
    def test_boundaries(self):
        for t,b in [('08:59:59','offpeak'),('09:00:00','peak'),('11:59:59','peak'),('12:00:00','offpeak'),('13:59:59','offpeak'),('14:00:00','peak'),('17:59:59','peak'),('18:00:00','offpeak')]:
            self.assertEqual(price_band(epoch('2026-10-30T'+t)),b)
    def test_holiday_weekend_and_future(self):
        self.assertEqual(price_band(epoch('2026-10-01T10:00:00')),'offpeak')
        self.assertEqual(price_band(epoch('2026-10-10T10:00:00')),'offpeak')
        self.assertEqual(price_band(epoch('2027-01-04T10:00:00')),'calendar_unknown')
        self.now=epoch('2027-01-04T10:00:00');s=self.scheduler()
        self.assertEqual(s.poll(),[]);self.assertIsNotNone(s.next_wakeup())
        self.assertTrue(1080<=s.snapshot()['owner_wake_state'][0]['next_due']-self.now<=1920)
    def test_owner_only_and_ranges(self):
        s=self.scheduler();self.assertTrue(self.cfg.chats[0].enabled);self.assertFalse(self.cfg.chats[1].enabled)
        self.assertTrue(180<=self.due(s)-self.now<=420)
        self.now=epoch('2026-10-30T09:00:00');s.poll()
        self.assertTrue(1080<=self.due(s)-self.now<=1920)
        self.assertEqual(s.snapshot()['owner_wake_state'][0]['price_band'],'peak')
    def test_skip_persists_and_no_duplicate_wake(self):
        s=self.scheduler();e=self.event(s);c=s.claim(e.event_id,'mock')
        self.assertIsNotNone(c);self.assertIsNone(s.claim(e.event_id,'mock'))
        self.assertTrue(s.finish(e.event_id,c.token,'declined'))
        due=self.due(s);self.assertTrue(180<=due-self.now<=420)
        s2=self.scheduler();self.assertEqual(self.due(s2),due)
        self.assertEqual(s2.snapshot()['owner_wake_state'][0]['decision'],'declined')
        self.assertEqual(s2.poll(),[])
    def test_restart_missed_due_no_catchup(self):
        s=self.scheduler();self.now+=86400;s=self.scheduler()
        self.assertTrue(self.due(s)>self.now);self.assertEqual(s.poll(),[])
    def test_restart_claim_not_replayed(self):
        s=self.scheduler();e=self.event(s);s.claim(e.event_id,'mock');s=self.scheduler()
        self.assertEqual(s.poll(),[])
        self.assertEqual(s.snapshot()['owner_wake_audit'][0]['decision'],'abandoned_restart')
    def test_peak_to_offpeak_and_restart_band_change(self):
        self.now=epoch('2026-10-30T11:59:00');s=self.scheduler()
        self.now=epoch('2026-10-30T12:00:00');self.assertEqual(s.poll(),[])
        due=self.due(s);self.assertTrue(180<=due-self.now<=420)
        self.assertEqual(self.due(self.scheduler()),due)
        self.now=epoch('2026-10-30T14:00:00');s=self.scheduler()
        self.assertTrue(1080<=self.due(s)-self.now<=1920)
    def test_expired_claim_not_replayed(self):
        s=self.scheduler();e=self.event(s);s.claim(e.event_id,'mock');self.now+=61
        s.poll();self.assertIsNone(s.claim(e.event_id,'mock'));self.assertEqual(s.poll(),[])
        self.assertEqual(s.snapshot()['owner_wake_state'][0]['decision'],'abandoned_lease')
    def test_sent_then_repeat_checks_without_unanswered_cap(self):
        s=self.scheduler()
        for _ in range(3):
            e=self.event(s);c=s.claim(e.event_id,'mock');self.assertIsNotNone(s.prepare_send(e.event_id,c.token));self.assertTrue(s.finish(e.event_id,c.token,'sent'))
        self.assertEqual(s.snapshot()['owner_wake_state'][0]['decision'],'sent')
    def test_uncertain_never_replayed(self):
        s=self.scheduler();e=self.event(s);c=s.claim(e.event_id,'mock');s.prepare_send(e.event_id,c.token);s.finish(e.event_id,c.token,'uncertain')
        self.now+=86400;s=self.scheduler();self.assertEqual(s.poll(),[])
        self.assertIsNone(s.snapshot()['owner_wake_state'][0]['next_due'])
    def test_sleep_and_muted_still_win(self):
        s=self.scheduler();s.heard('synthetic-owner','private',source_id='mock-input',owner_sleep=True)
        self.now+=500;self.assertEqual(s.poll(),[])
        self.assertGreater(s.next_wakeup(),self.now)

if __name__=='__main__':unittest.main(verbosity=2)
