"""Read-only UIA attachment evidence, with no native imports or image conversion.

An ImageControl alone does NOT identify a file. A full source path and an
embedded text range spanning the whole draft are mandatory. Unsupported
providers fail closed; collect_evidence supplies a bounded read-only probe.
"""
from __future__ import annotations
import hashlib
import os
import time
from pathlib import Path
from wechat_boundary import SendNotAttempted, identity

MAX_BYTES=32*1024*1024
MAX_VALUE=4096

def fail(code):
    raise SendNotAttempted(code)

def file_stamp(path):
    path=Path(path).resolve(strict=True)
    before=path.stat()
    if not path.is_file() or before.st_size>MAX_BYTES:
        fail('attachment_source_limit')
    digest=hashlib.sha256()
    count=0
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(262144),b''):
            count+=len(block)
            if count>MAX_BYTES: fail('attachment_source_limit')
            digest.update(block)
    after=path.stat()
    if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):
        fail('attachment_source_changed')
    return (str(path),after.st_size,after.st_mtime_ns,digest.hexdigest())

def text_range(edit):
    try:
        pattern=edit.GetTextPattern()
        return pattern,pattern.DocumentRange
    except Exception: fail('attachment_text_pattern_unavailable')

def object_range(pattern,span,obj):
    # Local adapter for upstream wrapper parameter bugs. No global library patch.
    if hasattr(pattern,'pattern') and hasattr(span,'textRange'):
        embedded=pattern.pattern.RangeFromChild(obj.Element)
        document=span.textRange
    else:
        embedded=pattern.RangeFromChild(obj)
        document=span
    if embedded is None: fail('attachment_range_unavailable')
    return embedded,document

def children(span):
    try:
        result=list(span.GetChildren())
        if len(result)>8: fail('attachment_object_limit')
        return result
    except SendNotAttempted: raise
    except Exception: fail('attachment_children_unavailable')

def path_evidence(control, path):
    # A basename, arbitrary ImageControl, clipboard echo, or preview is insufficient.
    candidates=[]
    for field in ('Name','HelpText'):
        try: candidates.append((field,getattr(control,field)))
        except Exception: pass
    for getter in ('GetValuePattern','GetLegacyIAccessiblePattern'):
        try: candidates.append((getter,getattr(control,getter)().Value))
        except Exception: pass
    expected=os.path.normcase(os.path.normpath(str(path)))
    for field,value in candidates:
        if not isinstance(value,str) or len(value)>MAX_VALUE: continue
        if not os.path.isabs(value): continue
        # Do not resolve arbitrary UI strings or touch any UI-provided file.
        if os.path.normcase(os.path.normpath(value))==expected:
            return field,value
    fail('attachment_source_path_unavailable')

def empty_draft(adapter, edit):
    if adapter.input_value(edit)!='': fail('attachment_existing_draft')
    _,span=text_range(edit)
    if children(span) or span.GetText(MAX_VALUE+1)!='':
        fail('attachment_existing_draft')

def begin(adapter, path, edit):
    token=identity(edit)
    if not token: fail('input_identity_unavailable')
    empty_draft(adapter,edit)
    return {'path':str(Path(path).resolve()),'stamp':file_stamp(path),
        'edit':token,'target':adapter.target,'mode':adapter.mode,'hwnd':adapter.hwnd,
        'snapshot':None}

def snapshot(adapter, context, edit):
    if (identity(edit)!=context['edit'] or adapter.target!=context['target'] or
        adapter.mode!=context['mode'] or adapter.hwnd!=context['hwnd']):
        fail('attachment_context_changed')
    pattern,span=text_range(edit)
    objects=children(span)
    if len(objects)!=1: fail('attachment_single_object_required')
    obj=objects[0]
    if getattr(obj,'ControlTypeName','') not in ('ImageControl','DocumentControl'):
        fail('attachment_control_unsupported')
    token=identity(obj)
    if not token: fail('attachment_identity_unavailable')
    source=path_evidence(obj,context['path'])
    try:
        embedded,document=object_range(pattern,span,obj)
        if document.CompareEndpoints(0,embedded,0)!=0 or document.CompareEndpoints(1,embedded,1)!=0:
            fail('attachment_mixed_draft')
        value=embedded.GetText(MAX_VALUE+1)
        if not isinstance(value,str) or len(value)>MAX_VALUE:
            fail('attachment_text_limit')
        if span.GetText(MAX_VALUE+1)!=value or adapter.input_value(edit)!=value:
            fail('attachment_value_mismatch')
    except SendNotAttempted: raise
    except Exception: fail('attachment_range_unavailable')
    return (token,source,value)

def verify(adapter,path,edit):
    context=getattr(adapter,'_attachment_context',None)
    if context is None or str(Path(path).resolve())!=context['path']:
        fail('attachment_context_missing')
    first=snapshot(adapter,context,edit)
    if snapshot(adapter,context,edit)!=first: fail('attachment_changed_during_read')
    if file_stamp(path)!=context['stamp']: fail('attachment_source_changed')
    if context['snapshot'] is not None and context['snapshot']!=first:
        fail('attachment_changed_before_click')
    context['snapshot']=first
    return first[2]

def prepare(adapter,path,edit):
    expected=adapter.verify_attachment_draft(path,edit)
    context=adapter._attachment_context
    if context['snapshot'] is None: fail('attachment_verifier_missing_evidence')
    # Empty ValuePattern is legal only when the verified embedded range proves an object.
    adapter._boundary_tx.prepared=(edit,context['edit'],adapter.target,adapter.mode,adapter.hwnd,expected)

def recheck(adapter,edit):
    context=getattr(adapter,'_attachment_context',None)
    if context is not None:
        verify(adapter,context['path'],edit)

def cleared(adapter,edit):
    if adapter.input_value(edit)!='': return False
    if getattr(adapter,'_attachment_context',None) is None: return True
    try:
        _,span=text_range(edit)
        return not children(span) and span.GetText(MAX_VALUE+1)==''
    except Exception: return False

def collect_evidence(edit):
    """Read only supplied editor; caller selects it. Never focuses/pastes/clicks.

    Run twice before/after a manual synthetic-file paste, without pressing Send.
    Only editor/object metadata is returned. No chat history or screenshots.
    """
    report={'schema':'attachment-uia-evidence-v1','edit_runtime_id':identity(edit),'objects':[]}
    def read(name,fn):
        try:
            value=fn()
            if isinstance(value,str): value=value[:MAX_VALUE]
            return value
        except Exception as exc: return {'unavailable':type(exc).__name__}
    report['edit_value']=read('value',lambda:edit.GetValuePattern().Value)
    try:
        pattern,span=text_range(edit)
        report['document_text']=read('text',lambda:span.GetText(MAX_VALUE+1))
        for obj in children(span):
            row={'runtime_id':identity(obj)}
            for field in ('ControlTypeName','ClassName','AutomationId','Name','HelpText'):
                row[field]=read(field,lambda field=field:getattr(obj,field))
            row['value']=read('value',lambda:obj.GetValuePattern().Value)
            row['legacy_value']=read('legacy',lambda:obj.GetLegacyIAccessiblePattern().Value)
            def range_value():return object_range(pattern,span,obj)[0].GetText(MAX_VALUE+1)
            def covers(endpoint):
                embedded,document=object_range(pattern,span,obj)
                return document.CompareEndpoints(endpoint,embedded,endpoint)==0
            row['range_text']=read('range',range_value)
            row['covers_start']=read('start',lambda:covers(0))
            row['covers_end']=read('end',lambda:covers(1))
            report['objects'].append(row)
    except SendNotAttempted as exc: report['unavailable']=exc.code
    return report
