"""Owner-only latest-page receipt; standard library imports remain cross-platform."""
import hashlib,hmac,json,secrets,uuid
from .protocol import Chat,DriverError
def encoded(value):return json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()
def client_options(client):
    owner=client.config.owner_edge_chat
    chats=tuple(c for c in client.config.allowed_chats if c==owner or c.mode=='group')
    client._edge_chats=chats
    client._owner_edge_chat=owner
    client._owner_edge_secret=secrets.token_bytes(32)
    if client.config.mode!='real' or not chats:return None
    return {'chats':[c.to_dict() for c in chats],'key':client._owner_edge_secret.hex()}
def configure(backend,options,allowed,expected_owner):
    chats=tuple(Chat(**value) for value in options.get('chats',[options.get('chat')]) if value is not None)
    key=bytes.fromhex(options['key'])
    if not chats or any(c not in allowed or not (c==expected_owner or c.mode=='group') for c in chats) or len(key)!=32:raise DriverError('owner_edge_config_invalid')
    backend._edge_chats=chats;backend._edge_owner=expected_owner
    backend._edge_secret=key;backend._edge_epoch=uuid.uuid4().hex;backend._edge_sequence=0
def verify(client,receipt,chat,rows):
    if not isinstance(receipt,dict) or chat not in getattr(client,'_edge_chats',()):return None
    proof=dict(receipt);signature=proof.pop('signature','')
    expected=hmac.new(client._owner_edge_secret,encoded(proof),hashlib.sha256).hexdigest()
    if not isinstance(signature,str) or not hmac.compare_digest(signature,expected):return None
    if proof.get('chat_key')!=chat.key or proof.get('page_digest')!=hashlib.sha256(encoded(rows)).hexdigest():return None
    return proof
def read_latest(backend,chat):
    # Runs inside the SAME worker/desktop lease/serial UI lane, never another controller.
    import uiautomation as auto
    adapter=backend._select(chat)
    module=backend.module
    edit=adapter.validate();draft=adapter.input_value(edit)
    listing=adapter.window.ListControl(AutomationId='chat_message_list')
    if not listing.Exists(.3):raise DriverError('owner_edge_list_missing')
    adapter.window.SetActive(waitTime=.05);listing.SetFocus()
    focused=auto.GetFocusedControl();inside=False
    for _ in range(8):
        if tuple(focused.GetRuntimeId())==tuple(listing.GetRuntimeId()):inside=True;break
        if focused.ControlTypeName=='EditControl':raise DriverError('owner_edge_edit_focus_denied')
        focused=focused.GetParentControl()
        if focused is None:break
    if not inside or module.foreground()!=adapter.hwnd:raise DriverError('owner_edge_focus_unverified')
    adapter.validate();auto.SendKeys('{Ctrl}{End}',waitTime=.1)
    adapter.validate();rows=adapter.read()
    if adapter.input_value(edit)!=draft:raise DriverError('owner_edge_draft_changed')
    # Same owner chat and worker own the view throughout the native action/read.
    adapter.validate()
    if module.foreground()!=adapter.hwnd:raise DriverError('owner_edge_foreground_changed')
    backend.rows={row.key:row for row in rows}
    result=[{'key':row.key,'text':row.text,'role':row.role,'sender':row.sender,
             'image_available':row.image is not None,'voice_available':row.voice is not None,'odd':row.odd} for row in rows]
    backend._edge_sequence+=1
    proof={'chat_key':chat.key,'page_digest':hashlib.sha256(encoded(result)).hexdigest(),'at_live_edge':True,
           'controller_epoch':backend._edge_epoch,'viewport_generation':chat.key+':latest-native-navigation',
           'sequence':backend._edge_sequence,'native_action':'focused_message_list_ctrl_end'}
    proof['signature']=hmac.new(backend._edge_secret,encoded(proof),hashlib.sha256).hexdigest()
    backend.last_controller_receipt=proof
    return result
