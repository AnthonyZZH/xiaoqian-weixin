import test from 'node:test';import assert from 'node:assert/strict';
import {taskInputIds,taskInputReceiptMatches} from '../vendor/isolated-owner/input-receipt.mjs';
const input={id:'task-input-synthetic',role:'user'},runtime={id:'runtime-synthetic',source:{kind:'runtime-context',form:'snapshot',sections:[{name:'approval:policy',text:'SYNTHETIC'}]}};
const receipt=inserted=>({type:'agent/inbox/spliced',data:{inserted}}),message=m=>({type:'user/message',data:m});
const session=events=>({seq:events.length,eventAt:i=>events[i],deriveMessages(){throw Error('EVENT_RECEIPTS_REQUIRED');}});
test('kernel snapshot remains context, not another task input',()=>{
 const events=[receipt([input]),message(input),message(runtime)];assert.deepEqual([...taskInputIds(events)],['task-input-synthetic']);assert.equal(taskInputReceiptMatches(session(events),input.id),true);
});
test('queued source forgery remains an extra input and is denied',()=>{
 const forged={...runtime,id:'forged-extra',role:'user'},events=[receipt([input,forged]),message(input),message(forged)];assert.equal(taskInputReceiptMatches(session(events),input.id),false);
});
test('exact loop clear notice is ignored only when it was never queued',()=>{
 const clear={id:'clear-synthetic',role:'user',source:{kind:'runtime-context'},content:[{type:'text',text:'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'}]};
 const events=[receipt([input]),message(input),message(clear)];assert.equal(taskInputReceiptMatches(session(events),input.id),true);
 assert.equal(taskInputReceiptMatches(session([receipt([input,clear]),message(input),message(clear)]),input.id),false);
});
