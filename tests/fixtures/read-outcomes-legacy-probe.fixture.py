"""Synthetic reproduction of consumed-before-completion ordering; no UI/probe installation."""
from pathlib import Path
import json,hashlib,os,time
BASE=Path(__file__).parent
class Capture:
 def __init__(self,adapter,scope):self.adapter,self.scope=adapter,scope
 def restore(self):
  original=self.scope.get('_owner_card_original_read')
  if original and getattr(type(self.adapter).read,'_owner_card_probe',False):type(self.adapter).read=original
def begin(adapter,scope):
 arm=BASE/'armed.json'
 if not arm.exists():return None
 cfg=json.loads(arm.read_text(encoding='utf-8'))
 target=hashlib.sha256((adapter.mode+':'+adapter.target).encode()).hexdigest()
 if target!=cfg['targetHash']:return None
 os.replace(arm,BASE/'consumed.json')
 if time.time()>cfg['expiresAt']:
  Capture(adapter,scope).restore();return None
 return Capture(adapter,scope)
