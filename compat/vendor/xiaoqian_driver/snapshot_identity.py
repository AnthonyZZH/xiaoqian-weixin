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
            if all(current[i]==old[j]['token'] for i,j in pairs):
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
            if 0<=j<len(old):items.append({**old[j],'raw':rows[i]['key']})
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
    return materialize_alignment(db,chat,aligned,Message,digest,known),reason



def page_digest(rows):
    return hashlib.sha256(json.dumps(rows,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()

def recovery_initialize(db):
    db.executescript("""CREATE TABLE IF NOT EXISTS identity_anchor_pages(chat TEXT,digest TEXT,items TEXT,PRIMARY KEY(chat,digest));
    CREATE TABLE IF NOT EXISTS identity_observation(chat TEXT PRIMARY KEY,items TEXT,epoch TEXT,viewport TEXT,sequence INTEGER);
    CREATE TABLE IF NOT EXISTS identity_recovery_status(chat TEXT PRIMARY KEY,reason TEXT,polls INTEGER,page_digest TEXT,budget INTEGER);""")

def archive(db,chat,items):
    if not items:return
    raw=json.dumps(items,separators=(',',':'));key=hashlib.sha256(raw.encode()).hexdigest()
    db.execute('INSERT OR REPLACE INTO identity_anchor_pages VALUES(?,?,?)',(chat.key,key,raw))
    db.execute('DELETE FROM identity_anchor_pages WHERE chat=? AND rowid NOT IN (SELECT rowid FROM identity_anchor_pages WHERE chat=? ORDER BY rowid DESC LIMIT 32)',(chat.key,chat.key))

def known_page(db,chat,rows):
    matches={}
    for (raw,) in db.execute('SELECT items FROM identity_anchor_pages WHERE chat=?',(chat.key,)):
        items=json.loads(raw)
        for start in range(len(items)-len(rows)+1):
            chunk=items[start:start+len(rows)]
            if all(token(row)==item['token'] for row,item in zip(rows,chunk)):
                keys=tuple(item['key'] for item in chunk);matches[keys]=chunk
    if len(matches)==1:return next(iter(matches.values()))
    return None

def note_recovery(db,chat,rows,reason):
    db.execute('INSERT INTO identity_recovery_status VALUES(?,?,1,?,6) ON CONFLICT(chat) DO UPDATE SET reason=excluded.reason,polls=polls+1,page_digest=excluded.page_digest',
        (chat.key,reason,page_digest(rows)))

def bounded_history(db,chat,pages):
    """Read-only historical evidence search: never dispatches or moves high water.

    Host may collect at most six overlapping history pages. Returns only an
    already-known anchor; does not declare unknown rows to be new messages.
    """
    if len(pages)>6:raise ValueError('history_page_budget_exceeded')
    status=db.execute('SELECT budget FROM identity_recovery_status WHERE chat=?',(chat.key,)).fetchone()
    remaining=status[0] if status else 6
    if len(pages)>remaining:raise ValueError('history_page_budget_exhausted')
    if status:db.execute('UPDATE identity_recovery_status SET budget=budget-? WHERE chat=?',(len(pages),chat.key))
    else:db.execute('INSERT INTO identity_recovery_status VALUES(?,?,0,?,?)',(chat.key,'history_evidence_search','',remaining-len(pages)))
    for index,rows in enumerate(pages):
        found=known_page(db,chat,rows)
        if found:return {'found':True,'page':index,'known_keys':[x['key'] for x in found]}
    return {'found':False,'action':'certified_live_edge_observation_required','budget_exhausted':len(pages)==remaining}

_original_reconcile=reconcile
def reconcile(db,chat,rows):
    # Persist known anchors before attempting to align another viewport.
    saved=db.execute('SELECT items FROM snapshot_identity WHERE chat=?',(chat.key,)).fetchone()
    if saved:archive(db,chat,json.loads(saved[0]))
    found=known_page(db,chat,rows) if rows else None
    if found:
        # An archived history page is old identity only. Do not move live horizon.
        return [(r,i['key']) for r,i in zip(rows,found) if not i.get('shadow')],None
    observing=db.execute('SELECT 1 FROM identity_observation WHERE chat=?',(chat.key,)).fetchone()
    if rows and observing:
        reason='live_edge_receipt_required';note_recovery(db,chat,rows,reason);return [],reason
    result,reason=_original_reconcile(db,chat,rows)
    if reason:note_recovery(db,chat,rows,reason)
    elif rows:
        page=db.execute('SELECT items FROM snapshot_identity WHERE chat=?',(chat.key,)).fetchone()
        if page:archive(db,chat,json.loads(page[0]))
    return result,reason

def recover_live_edge(db,chat,rows,receipt,verify):
    """Host-only. verify must validate an unforgeable controller receipt.

    This does not execute UI. A bare JSON flag at_live_edge is never accepted.
    First unknown page is shadow observation, NOT baseline acceptance or ACK.
    Every advancing page needs its own current viewport/epoch-bound receipt.
    """
    if not callable(verify):raise ValueError('controller_verifier_required')
    canonical=db.execute('SELECT items FROM snapshot_identity WHERE chat=?',(chat.key,)).fetchone()
    if canonical:archive(db,chat,json.loads(canonical[0]))
    proof=verify(receipt)
    if not isinstance(proof,dict) or proof.get('chat_key')!=chat.key or proof.get('page_digest')!=page_digest(rows) or proof.get('at_live_edge') is not True:
        raise ValueError('invalid_live_edge_receipt')
    epoch,viewport,sequence=proof.get('controller_epoch'),proof.get('viewport_generation'),proof.get('sequence')
    if not isinstance(epoch,str) or not epoch or not isinstance(viewport,str) or not viewport or type(sequence) is not int or sequence<0:
        raise ValueError('invalid_controller_continuity')
    saved=db.execute('SELECT items,epoch,viewport,sequence FROM identity_observation WHERE chat=?',(chat.key,)).fetchone()
    if saved and epoch==saved[1] and viewport==saved[2] and sequence<=saved[3]:raise ValueError('controller_receipt_replayed')
    old=json.loads(saved[0]) if saved and epoch==saved[1] and viewport==saved[2] else None
    items=None;status='shadow_observation_started'
    if old and rows:
        candidates=[]
        # Include prepend/contained-history interpretations, not only suffix-prefix.
        for offset in range(-len(rows)+1,len(old)):
            pairs=[(i,offset+i) for i in range(len(rows)) if 0<=offset+i<len(old)]
            if all(token(rows[i])==old[j]['token'] for i,j in pairs):
                aliases=sum(rows[i]['key']==old[j].get('raw') for i,j in pairs)
                candidates.append(((len(pairs),aliases),offset))
        if candidates:
            score=max(score for score,_ in candidates)
            offsets=[offset for itemscore,offset in candidates if itemscore==score]
            if len(offsets)!=1:
                status='ambiguous_observation_reseeded'
            else:
                offset=offsets[0];items=[]
                for i,row in enumerate(rows):
                    j=offset+i
                    if 0<=j<len(old):items.append({**old[j],'raw':row['key']})
                    elif j<0:items.append({'token':token(row),'key':'shadow:'+uuid.uuid4().hex,'raw':row['key'],'shadow':True})
                    else:items.append({'token':token(row),'key':'ordered:'+uuid.uuid4().hex,'raw':row['key'],'shadow':False})
                status='certified_live_edge_advanced'
    if items is None:
        found=known_page(db,chat,rows) if rows else None
        items=[{**i,'raw':r['key']} for r,i in zip(rows,found)] if found else [{'token':token(r),'key':'shadow:'+uuid.uuid4().hex,'raw':r['key'],'shadow':True} for r in rows]
    db.execute('INSERT OR REPLACE INTO identity_observation VALUES(?,?,?,?,?)',(chat.key,json.dumps(items),epoch,viewport,sequence))
    # Keep canonical baseline/ACKs intact. Archive observations separately;
    # shadows are excluded from inbox even when later used as sequence anchors.
    archive(db,chat,items);note_recovery(db,chat,rows,status)
    return [(row,item['key']) for row,item in zip(rows,items) if not item.get('shadow')],status

def recovery_messages(db,chat,rows,Message,digest,receipt,verify):
    previous=db.execute('SELECT items FROM identity_observation WHERE chat=?',(chat.key,)).fetchone()
    known={r['key'] for r in json.loads(previous[0])} if previous else set()
    canonical=db.execute('SELECT items FROM snapshot_identity WHERE chat=?',(chat.key,)).fetchone()
    if canonical:known.update(r['key'] for r in json.loads(canonical[0]))
    aligned,reason=recover_live_edge(db,chat,rows,receipt,verify)
    return materialize_alignment(db,chat,aligned,Message,digest,known),reason


def materialize_alignment(db,chat,aligned,Message,digest,known):
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
    return result
