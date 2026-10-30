"""Pure boundary helpers. No UI import; calls supplied, trusted adapter methods."""
from __future__ import annotations
import functools
import re
import time
from dataclasses import dataclass

MAX_TEXT=65536
MAX_CONTROLS=256
FOLD=re.compile(r'(?:\.{3}|…|展开全文|查看全文|显示全文|Read more)\s*$', re.I)

class SendNotAttempted(RuntimeError):
    def __init__(self, code='adapter_not_sent', cleanup='preserved'):
        self.code,self.cleanup=code,cleanup
        super().__init__(code)

class SendUncertain(RuntimeError):
    def __init__(self, code='adapter_send_unknown'):
        self.code=code
        super().__init__(code)

@dataclass
class SendTransaction:
    attempted: bool=False
    confirmed: bool=False
    owned: object=None
    prepared: object=None
    missing: tuple=()
    deadline: float=0

def identity(edit):
    try:
        value=tuple(edit.GetRuntimeId())
        return value if value else None
    except Exception:
        return None

def write_owned(adapter, edit, text):
    tx=adapter._boundary_tx
    if adapter.input_value(edit)!='':
        raise SendNotAttempted('draft_changed_before_write')
    token=identity(edit)
    if token is None: raise SendNotAttempted("input_identity_unavailable")
    tx.prepared=(edit,token,adapter.target,adapter.mode,adapter.hwnd,text)
    edit.GetValuePattern().SetValue(text,waitTime=0)
    # Partial/failed writes are not owned: never delete guessed substrings.
    if token is not None and adapter.input_value(edit)==text:
        tx.owned=(edit,token,adapter.target,adapter.mode,adapter.hwnd,text)

def begin_owned_edit(adapter, edit):
    tx=getattr(adapter,'_boundary_tx',None)
    if tx is None or tx.attempted:return None
    token=identity(edit);before=adapter.input_value(edit)
    if token is None:return None
    if before!='' and tx.owned!=(edit,token,adapter.target,adapter.mode,adapter.hwnd,before):return None
    return (token,adapter.target,adapter.mode,adapter.hwnd,before)

def finish_owned_edit(adapter, edit, evidence, expected):
    tx=getattr(adapter,'_boundary_tx',None)
    if tx is None or tx.attempted or evidence is None:return False
    token,target,mode,hwnd,before=evidence
    if (identity(edit)!=token or adapter.target!=target or adapter.mode!=mode or adapter.hwnd!=hwnd or adapter.input_value(edit)!=expected):return False
    tx.owned=(edit,token,target,mode,hwnd,expected)
    return True

def check_owned_before_click(adapter):
    tx=getattr(adapter,'_boundary_tx',None)
    if tx is None or tx.prepared is None:
        raise SendNotAttempted("draft_not_verified")
    if tx.prepared:
        edit,token,target,mode,hwnd,text=tx.prepared
        current=adapter.validate()
        if (identity(current)!=token or adapter.target!=target or adapter.mode!=mode or
            adapter.hwnd!=hwnd or adapter.input_value(current)!=text):
            raise SendNotAttempted('draft_changed_before_click')

def prepare_value(adapter, edit, expected):
    token=identity(edit)
    if token is None or not expected or adapter.input_value(edit)!=expected:
        raise SendNotAttempted("draft_not_verified")
    adapter._boundary_tx.prepared=(edit,token,adapter.target,adapter.mode,adapter.hwnd,expected)

def cleanup_owned(adapter, tx, foreground):
    if tx.attempted or tx.owned is None or time.monotonic()>tx.deadline:
        return 'preserved'
    edit,token,target,mode,hwnd,text=tx.owned
    try:
        current=adapter.validate()
        if (adapter.target!=target or adapter.mode!=mode or adapter.hwnd!=hwnd or
            foreground()!=hwnd or identity(current)!=token or adapter.input_value(current)!=text):
            return 'preserved'
        # No keystrokes or whole-chat clearing; compare the exact owned value again.
        if adapter.input_value(current)!=text:
            return 'preserved'
        current.GetValuePattern().SetValue('',waitTime=0)
        return 'cleared_owned' if adapter.input_value(current)=='' else 'cleanup_unconfirmed'
    except Exception:
        return 'cleanup_unconfirmed'

def guarded_send(method, foreground):
    @functools.wraps(method)
    def wrapped(adapter,*args,**kwargs):
        if getattr(adapter,'_boundary_tx',None) is not None:
            raise SendNotAttempted('nested_send_not_allowed')
        tx=SendTransaction(deadline=time.monotonic()+4.0)
        adapter._boundary_tx=tx
        try:
            result=method(adapter,*args,**kwargs)
            if not tx.confirmed:
                if tx.attempted: raise SendUncertain()
                raise SendNotAttempted('send_not_clicked')
            return result
        except Exception as exc:
            if tx.confirmed:
                # Focus restoration can fail after an independently confirmed click.
                return list(tx.missing)
            if tx.attempted:
                raise SendUncertain() from None
            cleanup=cleanup_owned(adapter,tx,foreground)
            code=exc.code if isinstance(exc,SendNotAttempted) else 'adapter_not_sent'
            raise SendNotAttempted(code,cleanup) from None
        finally:
            adapter._boundary_tx=None
    return wrapped

def mark_click(adapter):
    tx=getattr(adapter,'_boundary_tx',None)
    if tx is None: raise SendNotAttempted('missing_send_transaction')
    # Set immediately before invoking the irreversible UI click, not on press_send entry.
    tx.attempted=True

def mark_confirmed(adapter):
    adapter._boundary_tx.confirmed=True

def text_evidence(item, controls, preview):
    """Only row/body TextPattern evidence can establish accessible completeness.

    No expansion clicks or clipboard copy. Missing/bounded/changing evidence is deferred.
    A hard process deadline remains necessary for a blocked native UIA call.
    """
    preview=str(preview or '')
    anchor=FOLD.sub('',preview).rstrip()
    candidates=[]
    deadline=time.monotonic()+0.5
    selected=[item]+[c for c in controls[:MAX_CONTROLS]
        if getattr(c,'ControlTypeName','')=='TextControl' and isinstance(getattr(c,'Name',None),str) and (not anchor or c.Name.startswith(anchor))]
    reason='full_text_unverified'
    for control in selected[:8]:
        if time.monotonic()>deadline: break
        try:
            span=control.GetTextPattern().DocumentRange
            value=span.GetText(MAX_TEXT+1)
            if not isinstance(value,str) or not value: continue
            if anchor and not value.startswith(anchor): continue
            if len(value.encode('utf-16-le',errors='surrogatepass'))//2>MAX_TEXT:
                candidates.append((value[:MAX_TEXT],False,'text_pattern','text_limit'))
                continue
            if FOLD.search(value) or (FOLD.search(preview) and len(value)<=len(anchor)):
                candidates.append((value,False,'text_pattern','collapsed_text'))
                continue
            again=span.GetText(MAX_TEXT+1)
            if again!=value:
                reason='text_changed_during_read'
                continue
            candidates.append((value,True,'text_pattern',''))
        except Exception:
            continue
    names=[getattr(c,'Name','') for c in controls[:MAX_CONTROLS]
        if getattr(c,'ControlTypeName','')=='TextControl']
    values=[v for v in [preview]+names if isinstance(v,str) and (not anchor or v.startswith(anchor))]
    visible=max(values,key=len,default=preview)
    if candidates:
        best=max(candidates,key=lambda row:(len(row[0]),row[1]))
        # Longer matching evidence is authoritative evidence of a truncated short candidate.
        if len(visible)>len(best[0]):
            return visible[:MAX_TEXT],False,'visible_name','full_text_unverified'
        distinct={row[0] for row in candidates if len(row[0])==len(best[0])}
        if len(distinct)>1:
            return best[0],False,best[2],'conflicting_text_patterns'
        return best
    return visible[:MAX_TEXT],False,'visible_name',('text_limit' if len(visible)>MAX_TEXT else reason)
