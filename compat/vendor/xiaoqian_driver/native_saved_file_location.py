"""Passive native file-location observation; no download, UI action or file IO.

Values come only from native ValuePattern/LegacyIAccessible.Value on the exact
already-bound file-card control. A filename or a path in Name/Description is not
a location witness. Location alone never proves completed saved-file bytes.
"""
import ntpath
import re
from urllib.parse import urlsplit, unquote


class LocationError(ValueError):
    def __init__(self, code):
        self.code=code
        super().__init__(code)


def require(value, code):
    if not value:raise LocationError(code)


def normalize_location(value, root, display_name):
    require(isinstance(root,str) and re.match(r'^[A-Za-z]:[\\/]',root), 'SAVED_FILE_PINNED_ROOT_REQUIRED')
    root=root.replace('/','\\').rstrip('\\')
    parts=root.split('\\')
    legacy=[p.casefold() for p in parts[-2:]]==['filestorage','file']
    current=len(parts)>=5 and [p.casefold() for p in parts[-2:]]==['msg','file'] and parts[-4].casefold()=='xwechat_files'
    require(len(parts)>=5 and (legacy or current) and
            not any(p in ('.','..','') for p in parts[1:]), 'SAVED_FILE_PINNED_ROOT_REQUIRED')
    require(isinstance(value,str) and 1<=len(value)<=2048 and not re.search(r'[\x00-\x1f]',value), 'NATIVE_FILE_LOCATION_INVALID')
    if value.lower().startswith('file:'):
        parsed=urlsplit(value)
        require(parsed.scheme=='file' and not parsed.netloc and not parsed.query and not parsed.fragment and
                not re.search(r'%(?:2f|5c|00)',parsed.path,re.I), 'NATIVE_FILE_LOCATION_INVALID')
        try:value=unquote(parsed.path,encoding='utf-8',errors='strict')
        except UnicodeError:raise LocationError('NATIVE_FILE_LOCATION_INVALID') from None
        require(re.match(r'^/[A-Za-z]:/',value), 'NATIVE_FILE_LOCATION_INVALID')
        value=value[1:]
    value=value.replace('/','\\')
    require(re.match(r'^[A-Za-z]:\\',value) and not value.startswith(('\\\\','\\?\\','\\.\\')) and
            ':' not in value[2:] and not re.search(r'[\x00-\x1f<>"|?*]',value), 'NATIVE_FILE_LOCATION_INVALID')
    components=value.split('\\')[1:]
    require(all(p and p not in ('.','..') and not p.endswith(('.', ' ')) and
                not re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)',p,re.I) for p in components), 'NATIVE_FILE_LOCATION_INVALID')
    try:same_root=ntpath.commonpath([root,value]).casefold()==root.casefold()
    except ValueError:same_root=False
    require(same_root and value.casefold()!=root.casefold(), 'SAVED_FILE_ACCOUNT_OR_ROOT_MISMATCH')
    require(isinstance(display_name,str) and re.fullmatch(r'[^\\/:\x00-\x1f]{1,196}\.(txt|docx|pdf)',display_name,re.I) and
            ntpath.basename(value).casefold()==display_name.casefold(), 'NATIVE_FILE_NAME_MISMATCH')
    return ntpath.relpath(value,root)


def observe_file_location(control, *, root, display_name, context, is_current):
    """Host-only primitive. Caller owns the existing DesktopLease and read token.

    `context` is retained worker state, never tool JSON. No output is a completed
    descriptor. The caller must keep the result private to its canonical row.
    """
    require(callable(is_current) and is_current(context) is True, 'NATIVE_FILE_ROW_STALE')
    require(context.get('mode')=='private' and context.get('owner') is True and context.get('role')=='user' and
            re.fullmatch('[a-f0-9]{64}',context.get('messageId','')) and
            type(context.get('generation')) is int and context['generation']>0 and context.get('readId'), 'NATIVE_FILE_OWNER_CONTEXT_REQUIRED')
    require(control.ClassName=='mmui::ChatBubbleItemView' and list(control.GetRuntimeId())==context.get('rowRuntimeId'), 'NATIVE_FILE_ROW_CHANGED')
    observed=[]
    for getter in ('GetValuePattern','GetLegacyIAccessiblePattern'):
        try:
            pattern=getattr(control,getter)()
            value=pattern.Value
        except Exception:
            continue
        if isinstance(value,str) and value:
            # A present but unrecognized value is not interpreted as a filename,
            # URL, cache key, path fragment or directory-search instruction.
            observed.append((getter,normalize_location(value,root,display_name)))
    require(is_current(context) is True and list(control.GetRuntimeId())==context['rowRuntimeId'], 'NATIVE_FILE_ROW_STALE')
    require(observed,'NATIVE_FILE_LOCATION_UNAVAILABLE')
    unique={path.casefold() for _,path in observed}
    require(len(unique)==1,'NATIVE_FILE_LOCATION_AMBIGUOUS')
    return {'kind':'native-file-location-only','mappingStatus':'incomplete',
            'sourceMessageId':context['messageId'],'readId':context['readId'],'generation':context['generation'],
            'rowRuntimeId':list(context['rowRuntimeId']),'relativePath':observed[0][1],
            'locationProperties':[name for name,_ in observed],
            'completed':False,'fileKindVerified':False,
            'blockedBy':'NATIVE_FILE_KIND_COMPLETION_AND_EXACT_SIZE_UNAVAILABLE'}
