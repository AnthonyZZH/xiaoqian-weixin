"""Canonical binding for the current worker's image capability, inside client FIFO."""
import json,re
from .image_native import ImageError
from .protocol import digest

COMMANDS=('image_inspect','image_capture','image_current')
def require(ok,code):
    if not ok:raise ImageError(code)
def resolve_current(client,chat,mid):
    require(chat in client.config.allowed_chats,'IMAGE_CHAT_DENIED')
    require(isinstance(mid,str) and re.fullmatch('[a-f0-9]{64}',mid),'IMAGE_CANONICAL_REQUIRED')
    with client._state.lock:
        row=client._state.db.execute('SELECT payload FROM inbox WHERE chat_key=? AND message_id=?',(chat.key,mid)).fetchone()
        require(row is not None,'IMAGE_MESSAGE_UNKNOWN')
        require(json.loads(row[0]).get('role')=='user','IMAGE_INCOMING_REQUIRED')
        current=[r for r in getattr(client,'last_native_rows',[]) if r.get('id')==mid and r.get('readId')==(getattr(client,'last_image_read',None) or {}).get('readId') and r.get('generation')==client._generation]
        if len(current)==1:
            return {'raw':current[0]['sourceKey'],'token':current[0]['rawToken']}
        matches=[]
        for table in ('identity_observation','snapshot_identity'):
            try:observation=client._state.db.execute('SELECT items FROM '+table+' WHERE chat=?',(chat.key,)).fetchone()
            except Exception:continue
            if observation:
                matches=[item for item in json.loads(observation[0]) if not item.get('shadow') and digest([chat.key,item['key']])==mid]
                break # Never recover a shadow/deferred row from an old viewport.
        require(len(matches)==1,'IMAGE_IDENTITY_DEFERRED')
        return matches[0]
def prepare(client,chat,args):
    require(getattr(client,'_image_snapshot_generation',None)==client._generation,'IMAGE_FRESH_READ_REQUIRED')
    context=getattr(client,'last_image_read',None)
    require(isinstance(context,dict) and args.get('generation')==client._generation and context.get('generation')==client._generation,'IMAGE_GENERATION_STALE')
    require(args.get('readId')==context.get('readId'),'IMAGE_READ_STALE')
    item=resolve_current(client,chat,args.get('messageId'))
    return {'chat':chat.to_dict(),'readId':context['readId'],'generation':client._generation,'ticket':args.get('ticket'),
      'handle':{'chatKey':chat.key,'sourceKey':item['raw'],'messageId':args['messageId'],'generation':client._generation,'token':item['token']}}
def current_source_key(client,chat,mid):
    try:return resolve_current(client,chat,mid)['raw']
    except ImageError:return None
