
import sys,pathlib,tempfile
from datetime import datetime
from random import Random
sys.path.insert(0,str(pathlib.Path(__file__).parent.parent/'vendor'))
from owner_wake_policy import ScheduleConfig,Scheduler
cfg=ScheduleConfig.from_legacy({'owner':'o','chats':{'o':{'mode':'private'}}})
now=datetime.fromisoformat('2026-10-30T20:00:00+08:00').timestamp()
with tempfile.TemporaryDirectory(dir=pathlib.Path(__file__).parent) as tmp:
 p=pathlib.Path(tmp)/'mock.sqlite'
 s=Scheduler(p,cfg,clock=lambda:now,rng=Random(2))
 now=s.snapshot()['owner_wake_state'][0]['next_due']
 event=s.poll()[0];claim=s.claim(event.event_id,'mock')
 assert s.finish(event.event_id,claim.token,'declined',decision='completed_without_decision')
 due=s.snapshot()['owner_wake_state'][0]['next_due']
 assert 180<=due-now<=420
 s=Scheduler(p,cfg,clock=lambda:now,rng=Random(3))
 assert s.snapshot()['owner_wake_state'][0]['decision']=='completed_without_decision'
 assert s.snapshot()['owner_wake_state'][0]['next_due']==due
 assert not s.finish(event.event_id,claim.token,'declined',decision='decision_timeout')
 assert s.snapshot()['owner_wake_state'][0]['next_due']==due
 assert s.snapshot()['owner_wake_audit'][0]['decision']=='completed_without_decision'
 assert s.poll()==[]
 print('PASS durable completion decision / next due survives restart; competing timeout cannot double-settle or reroll due')
