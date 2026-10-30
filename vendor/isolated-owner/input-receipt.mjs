// rc.4 projects runtime context as user/message, but never enqueues that snapshot.
// Actual input admission is recorded separately in agent/inbox/spliced. A caller
// cannot hide an extra queued input by giving it source.kind=runtime-context.
export function taskInputIds(events){
 const queued=new Set();for(const e of events)if(e.type==='agent/inbox/spliced')for(const m of e.data?.inserted||[])if(m.role==='user')queued.add(m.id);
 const ids=new Set(queued);
 for(const e of events){if(e.type!=='user/message')continue;const m=e.data||{},s=m.source||{};
  const snapshot=s.kind==='runtime-context'&&!queued.has(m.id)&&s.form==='snapshot'&&Array.isArray(s.sections)&&s.sections.length>0&&s.sections.every(v=>v&&typeof v.name==='string'&&typeof v.text==='string');
  const cleared=s.kind==='runtime-context'&&!queued.has(m.id)&&Object.keys(s).length===1&&m.content?.length===1&&m.content[0]?.type==='text'&&m.content[0]?.text==='Current runtime context: none. Earlier runtime-context snapshots no longer apply.';
  if(!snapshot&&!cleared)ids.add(m.id);
 }
 return ids;
}
export function taskInputReceiptMatches(session,messageId){
 if(!Number.isSafeInteger(session?.seq)||typeof session.eventAt!=='function')return session.deriveMessages().filter(m=>m.role==='user').every(m=>m.id===messageId);
 if(session.seq>20000)return false;
 const ids=taskInputIds(Array.from({length:session.seq},(_,i)=>session.eventAt(i)).filter(Boolean));return ids.has(messageId)&&[...ids].every(id=>id===messageId);
}
