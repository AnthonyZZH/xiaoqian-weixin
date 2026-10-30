"""Ordered snapshot identity reconciliation. No UI imports, no permanent text blacklist."""
import hashlib,json,uuid
from dataclasses import replace

def token(row):
    # Timestamp must be adapter-supplied evidence, not wall-clock receive time.
    return hashlib.sha256(json.dumps([row.get('sender',''),row['role'],row['text'],
        row.get('timestamp','')],ensure_ascii=False,separators=(',',':')).encode()).hexdigest()

def initialize(db):
    db.executescript("""CREATE TABLE IF NOT EXISTS snapshot_identity(chat TEXT PRIMARY KEY,items TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbound_identity(op TEXT PRIMARY KEY,chat TEXT,body TEXT,status TEXT);
    CREATE TABLE IF NOT EXISTS outbound_claim(op TEXT PRIMARY KEY,chat TEXT,rowkey TEXT); CREATE TABLE IF NOT EXISTS identity_deferred(chat TEXT PRIMARY KEY,reason TEXT,count INTEGER);""")

def remember_send(db,operation_id,payload):
    chat=payload.get('chat');text=payload.get('text')
    if not isinstance(chat,dict) or not isinstance(text,str):return
    chat_key=hashlib.sha256(json.dumps(chat,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    body=hashlib.sha256(text.encode()).hexdigest()
    db.execute("INSERT OR IGNORE INTO outbound_identity VALUES(?,?,?,'pending')",(operation_id,chat_key,body))

def reconcile(db,chat,rows):
    # Entire operation is inside StateStore's existing lock/transaction.
    saved=db.execute('SELECT items FROM snapshot_identity WHERE chat=?',(chat.key,)).fetchone()
    if saved:
        old=json.loads(saved[0])
    else:
        # Seed from existing persisted inbox, retaining old IDs and their ACKs.
        prior=db.execute('SELECT payload FROM inbox WHERE chat_key=? ORDER BY sequence DESC LIMIT 512',(chat.key,)).fetchall()
        old=[]
        for (payload,) in reversed(prior):
            p=json.loads(payload);old.append({'token':token(p),'key':p['source_key'],'raw':p['source_key']})
    if not rows:return [],None
    current=[token(row) for row in rows]
    if not old:
        items=[{'token':t,'key':r['key'],'raw':r['key']} for t,r in zip(current,rows)]
    else:
        # All consistent contiguous alignments, excluding a zero-overlap guess.
        candidates=[]
        for offset in range(-len(current)+1,len(old)):
            pairs=[(i,offset+i) for i in range(len(current)) if 0<=offset+i<len(old)]
            def same_occurrence(i,j):
                if current[i]==old[j]['token']:return True
                row=rows[i]
                if row.get('text_complete') is not True or row['key']!=old[j].get('raw'):return False
                pending=db.execute('SELECT payload FROM inbox WHERE message_id=? AND chat_key=? AND acked=0',(hashlib.sha256(json.dumps([chat.key,old[j]['key']],ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest(),chat.key)).fetchone()
                if not pending:return False
                previous=json.loads(pending[0]);prefix=previous.get('text','').rstrip('…')
                return previous.get('text_complete') is False and previous.get('role')==row['role'] and previous.get('sender','')==row.get('sender','') and bool(prefix) and row['text'].startswith(prefix) and len(row['text'])>=len(prefix)
            if all(same_occurrence(i,j) for i,j in pairs):
                aliases=sum(rows[i]['key']==old[j].get('raw') for i,j in pairs)
                candidates.append(((len(pairs),aliases),offset))
        if not candidates:
            # Without any order anchor, a regenerated old page and new messages are
            # indistinguishable. Preserve old state and defer this page.
            return [],'snapshot_without_order_anchor'
        score=max(n for n,_ in candidates)
        offsets=[o for n,o in candidates if n==score]
        if len(offsets)!=1:return [],'ambiguous_repeated_snapshot'
        offset=offsets[0];items=[]
        for i,t in enumerate(current):
            j=offset+i
            if 0<=j<len(old):items.append({**old[j],'raw':rows[i]['key'],'token':t})
            elif j>=len(old):items.append({'token':t,'key':'ordered:'+uuid.uuid4().hex,'raw':rows[i]['key']})
            else:return [],'unanchored_history_prefix'
    result=[]
    for row,item in zip(rows,items):
        # Only identity changes. Keep current raw key for media/transcription handles.
        result.append((row,item['key']))
    db.execute('INSERT OR REPLACE INTO snapshot_identity VALUES(?,?)',(chat.key,json.dumps(items[-512:])))
    return result,None

def messages(db,chat,rows,Message,digest):
    previous=db.execute('SELECT items FROM snapshot_identity WHERE chat=?',(chat.key,)).fetchone()
    known={r['key'] for r in json.loads(previous[0])} if previous else set()
    aligned,reason=reconcile(db,chat,rows)
    if reason:
        db.execute('INSERT INTO identity_deferred VALUES(?,?,1) ON CONFLICT(chat) DO UPDATE SET reason=excluded.reason,count=count+1',(chat.key,reason))
    result=[]
    for row,key in aligned:
        message=Message.from_row(chat,row)
        message=replace(message,message_id=digest([chat.key,key]))
        # Assistant direction is retained even if the UI changes its RuntimeId.
        # A recent outgoing-body collision without independent direction evidence
        # is quarantined, never silently relabelled as assistant.
        collision=db.execute("SELECT op FROM outbound_identity WHERE chat=? AND body=? AND status IN ('pending','success','unknown') AND op NOT IN (SELECT op FROM outbound_claim) LIMIT 1",
            (chat.key,hashlib.sha256(row['text'].encode()).hexdigest())).fetchone()
        if collision and key not in known:
            db.execute('INSERT INTO outbound_claim VALUES(?,?,?)',(collision[0],chat.key,key))
        claimed=db.execute('SELECT 1 FROM outbound_claim WHERE chat=? AND rowkey=?',(chat.key,key)).fetchone()
        if claimed and row['role']=='user' and row.get('direction_verified') is not True:
            # Release only upon trustworthy incoming direction evidence. No ACK.
            continue
        result.append(message)
    return result,reason
