import hashlib,hmac,importlib.util,sys
from pathlib import Path
from types import SimpleNamespace
root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'compat/vendor'))
from xiaoqian_driver.protocol import Chat,DriverError
spec=importlib.util.spec_from_file_location('xiaoqian_driver.scope_fixture',root/'compat/vendor/xiaoqian_driver/owner_edge_controller.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
owner=Chat('fixture-owner','private');group=Chat('fixture-group','group');other=Chat('not-configured','group')
c=SimpleNamespace(config=SimpleNamespace(mode='real',allowed_chats=[owner,group],owner_edge_chat=owner));options=m.client_options(c);b=SimpleNamespace();m.configure(b,options,[owner,group],owner);assert b._edge_chats==(owner,group)
for chat in (owner,group):
 rows=[{'key':'fixture','text':'synthetic'}];proof={'chat_key':chat.key,'page_digest':hashlib.sha256(m.encoded(rows)).hexdigest(),'at_live_edge':True};proof['signature']=hmac.new(c._owner_edge_secret,m.encoded(proof),hashlib.sha256).hexdigest();assert m.verify(c,proof,chat,rows);assert m.verify(c,proof,other,rows) is None;assert m.verify(c,proof,chat,rows+[{}]) is None
try:m.configure(b,{'chats':[other.to_dict()],'key':options['key']},[owner,group],owner);raise AssertionError('unconfigured target accepted')
except DriverError:pass
print('PASS: configured private/group receipts, cross-chat denial, digest binding, unconfigured target rejection; no UI or model calls')
