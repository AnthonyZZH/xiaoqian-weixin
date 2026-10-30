"""Serial JSON-lines UI worker. No models, network clients, timers or autonomous sends.
Live UI imports occur ONLY after explicit initialize(mode=live, liveEnabled=True).
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import sys
import time

MAX_LINE = 8 * 1024 * 1024
MUTATIONS = {'send_text', 'send_image'}
class Denied(Exception):
    def __init__(self, code): self.code = code

def stable_id(target, row):
    # Include full trusted target identity and adapter row key; never truncate names.
    material = [target['id'], target['mode'], target['title'], str(row.get('key', '')),
                str(row.get('role', 'user')), str(row.get('sender', '')), str(row.get('text', ''))]
    return hashlib.sha256(json.dumps(material, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()

def normalized(target, rows):
    output=[]
    for row in rows:
        if not isinstance(row, dict) or row.get('role') not in ('user','assistant','system'): continue
        value={'id':stable_id(target,row), 'targetId':target['id'], 'role':row['role'],
               'sender':str(row.get('sender',''))[:200], 'text':str(row.get('text',''))[:20000],
               'kind':row.get('kind','text'), 'odd':bool(row.get('odd',False))}
        if row.get('media'): value['media']=row['media']
        output.append(value)
    return output

class Worker:
    def __init__(self):
        self.config=None; self.targets={}; self.adapter=None; self.auto_context=None; self.voices={}
    def initialize(self, config):
        if self.config is not None: raise Denied('DRIVER_ALREADY_INITIALIZED')
        if config.get('mode') not in ('mock','live'): raise Denied('DRIVER_MODE_INVALID')
        for t in config.get('targets',[]):
            if not isinstance(t,dict) or not t.get('id') or not t.get('title') or t.get('mode') not in ('private','group') or t['id'] in self.targets: raise Denied('DRIVER_TARGET_INVALID')
            self.targets[t['id']]=t
        if not self.targets: raise Denied('DRIVER_TARGETS_REQUIRED')
        if config['mode']=='live':
            if config.get('liveEnabled') is not True: raise Denied('LIVE_DRIVER_NOT_ENABLED')
            legacy=Path(config.get('legacyDir',''))
            if not legacy.is_absolute() or not (legacy/'wechat_adapter.py').is_file(): raise Denied('DRIVER_LEGACY_SOURCE_REQUIRED')
            sys.path.insert(0,str(legacy))
            # No settings or private runtime data is loaded by this module.
            import wechat_adapter
            self.adapter_module=wechat_adapter
            self.auto_context=wechat_adapter.auto.UIAutomationInitializerInThread()
            self.auto_context.__enter__()
        self.config=config
        return {'status':'ok','code':'DRIVER_READY','mode':config['mode']}
    def target(self,args):
        if any(k in args for k in ('title','mode','target','chat')): raise Denied('DRIVER_TARGET_OVERRIDE_DENIED')
        t=self.targets.get(args.get('targetId'))
        if t is None: raise Denied('DRIVER_TARGET_DENIED')
        return t
    def activate(self,t):
        if self.adapter is None: self.adapter=self.adapter_module.WeChatAdapter(t['title'],t['mode'],t.get('maxChars',500))
        self.adapter.set_target(t['title'],t['mode'])
        if self.adapter.current() != (t['title'],t['mode']=='private'):
            self.adapter.open_chat(t['title'])
        self.adapter.validate()
    def media_path(self,args):
        path=Path(args.get('path',''))
        root=Path(self.config.get('mediaRoot',''))
        if not path.is_absolute() or not root.is_absolute(): raise Denied('DRIVER_MEDIA_ROOT_REQUIRED')
        if path.is_symlink() or root.is_symlink(): raise Denied('DRIVER_MEDIA_LINK_DENIED')
        real=path.resolve(); base=root.resolve()
        if not real.is_relative_to(base) or not real.is_file(): raise Denied('DRIVER_MEDIA_DENIED')
        # Reject directory junctions/symlinks within the configured asset root.
        for parent in (path, *path.parents):
            if parent == root.parent: break
            if parent.is_symlink() or (hasattr(parent,'is_junction') and parent.is_junction()): raise Denied('DRIVER_MEDIA_LINK_DENIED')
        if real.suffix.lower() not in ('.png','.jpg','.jpeg','.gif','.webp','.apng'): raise Denied('DRIVER_MEDIA_TYPE_DENIED')
        if real.stat().st_size > 25*1024*1024: raise Denied('DRIVER_MEDIA_TOO_LARGE')
        return real
    def handle(self,op,args):
        if op=='initialize': return self.initialize(args)
        if self.config is None: raise Denied('DRIVER_NOT_INITIALIZED')
        if op=='health': return {'status':'ok','code':'DRIVER_HEALTHY','mode':self.config['mode']}
        if op not in ('read','validate','switch','send_text','send_image','transcribe'): raise Denied('DRIVER_OPERATION_INVALID')
        t=self.target(args)
        if op=='send_text':
            text=args.get('text'); at=args.get('at',[])
            if not isinstance(text,str) or not text or '\n' in text or '\r' in text or len(text)>t.get('maxChars',500): raise Denied('DRIVER_TEXT_INVALID')
            if not isinstance(at,list) or len(at)>10 or any(not isinstance(m,str) or not m or len(m)>200 for m in at): raise Denied('DRIVER_MENTION_INVALID')
            if at and t['mode']!='group': raise Denied('DRIVER_MENTION_PRIVATE_DENIED')
        if op=='send_image': path=self.media_path(args)
        if self.config['mode']=='mock':
            mock=self.config.get('mock',{})
            if op in mock.get('hangOperations',[]): time.sleep(3600)
            delay=mock.get('delayMs',0)
            if isinstance(delay,(int,float)) and delay>0: time.sleep(min(delay,30000)/1000)
            if op in mock.get('crashOperations',[]): os._exit(44)
            if op in mock.get('unknownOperations',[]): return {'status':'unknown','code':'SEND_RECONCILIATION_REQUIRED'}
            if op=='read':
                return {'status':'ok','code':'DRIVER_READ','messages':normalized(t,mock.get('messages',{}).get(t['id'],[]))}
            if op=='transcribe': return {'status':'ok','code':'DRIVER_TRANSCRIBED','text':mock.get('transcriptions',{}).get(args.get('messageId'),'')}
            return {'status':'ok','code':'DRIVER_SIMULATED','simulated':True,'targetId':t['id']}
        self.activate(t)
        if op in ('validate','switch'): return {'status':'ok','code':'DRIVER_TARGET_VALIDATED','targetId':t['id']}
        if op=='read':
            rows=[]; self.voices={}
            for row in self.adapter.read():
                raw={'key':row.key,'text':row.text,'role':row.role,'sender':row.sender,'odd':row.odd,'kind':'text'}
                mid=stable_id(t,raw)
                if row.voice is not None:
                    raw['kind']='voice'; self.voices[mid]=(t['id'],row)
                if row.image is not None:
                    raw['kind']='image'
                    # Screenshots are previews only, never represented as original animation.
                    if self.config.get('mediaRoot'):
                        base=Path(self.config['mediaRoot']).resolve(); base.mkdir(parents=True,exist_ok=True)
                        preview=base/(mid+'.preview.png'); row.image.save(preview,format='PNG')
                        raw['media']={'path':str(preview),'kind':'static_preview','originalAvailable':False,'animationPreserved':False}
                rows.append(raw)
            return {'status':'ok','code':'DRIVER_READ','messages':normalized(t,rows)}
        if op=='transcribe':
            cached=self.voices.get(args.get('messageId'))
            if cached is None or cached[0]!=t['id']: raise Denied('DRIVER_VOICE_REFERENCE_EXPIRED')
            text=self.adapter.transcribe(cached[1],timeout=7.0)
            return {'status':'ok','code':'DRIVER_TRANSCRIBED','text':str(text)[:20000]}
        if op=='send_text':
            missing=self.adapter.send(args['text'],at=args.get('at',[]),max_chars=t.get('maxChars',500))
            return {'status':'ok','code':'DRIVER_SENT','missingMentions':missing}
        if op=='send_image':
            self.adapter.send_image(path)
            return {'status':'ok','code':'DRIVER_SENT','originalFileUsed':True,'animationDeliveryVerified':False}

if __name__=='__main__':
    worker=Worker()
    for line in sys.stdin:
        ident=None; op=None
        try:
            if len(line)>MAX_LINE: raise Denied('DRIVER_REQUEST_TOO_LARGE')
            req=json.loads(line); ident=req.get('id'); op=req.get('operation'); args=req.get('args',{})
            if not isinstance(ident,str) or not isinstance(args,dict): raise Denied('DRIVER_PROTOCOL_INVALID')
            answer=worker.handle(op,args)
        except Denied as exc: answer={'status':'rejected','code':exc.code}
        except BaseException:
            # Once a send was dispatched any raw adapter exception is conservatively uncertain.
            answer={'status':'unknown' if op in MUTATIONS else 'error','code':'SEND_RECONCILIATION_REQUIRED' if op in MUTATIONS else 'DRIVER_UI_FAILED'}
        answer['id']=ident
        print(json.dumps(answer,ensure_ascii=False,separators=(',',':')),flush=True)
