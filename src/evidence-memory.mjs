import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {atomicJson,scopedDirectory,trustedChats} from './features.mjs';
import {observedUserTurn,deliveredAssistantTurn,validateFactCandidate,classifyFact,selectDailyCards,
  planDailyMaintenance,commitDailyMaintenance,maintenanceDay} from './memory-core.mjs';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
/** Exact-message evidence and small daily recall, separate from the flat legacy facts. */
export class EvidenceMemory {
  constructor({root,chats,clock=Date.now}){
    this.root=scopedDirectory(root);this.chats=trustedChats(chats);this.clock=clock;
  }
  chat(id){const c=this.chats.get(id);if(!c)throw new Error('EVIDENCE_CHAT_UNKNOWN');return c;}
  scope(id){const c=this.chat(id);return c.owner?'owner:private':
    `wechat:${c.mode==='group'?'g':'p'}:${hash(c.mode+'\0'+c.id)}`;}
  file(id){const c=this.chat(id);return path.join(scopedDirectory(this.root,c.owner?'owner':c.mode,hash(c.mode+'\0'+c.id)),'evidence.json');}
  load(id){const file=this.file(id);let state={version:1,turns:[],cards:[],archive:[]};
    if(fs.existsSync(file)){
      if(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>32*1024*1024)throw new Error('EVIDENCE_STATE_INVALID');
      state=JSON.parse(fs.readFileSync(file,'utf8'));
    }
    if(state.version!==1||!Array.isArray(state.turns)||!Array.isArray(state.cards)||!Array.isArray(state.archive))throw new Error('EVIDENCE_STATE_INVALID');
    return state;}
  observe(id,message){
    if(!message?.text?.trim())return false;
    const c=this.chat(id),state=this.load(id),scope=this.scope(id);
    if(state.turns.some(row=>row.id===message.id))return false;
    const actor=c.owner?'owner':'unverified-chat-member';
    const turn=observedUserTurn({id:message.id,scope,actor,text:message.text.slice(0,1000),at:this.clock()});
    state.turns.push(turn);state.turns=state.turns.slice(-300);
    atomicJson(this.file(id),state);return true;
  }
  observeAssistantEcho(id,message){
    // An input-cleared send receipt is not evidence of delivery. A later stable
    // outbound WeChat UI echo is recorded as a local observation only.
    if(!message?.text?.trim())return false;
    const state=this.load(id),scope=this.scope(id);
    const turn=deliveredAssistantTurn({scope,receipt:{status:'delivered',
      platformMessageId:message.id,text:message.text.slice(0,1000)},at:this.clock()});
    if(state.turns.some(row=>row.id===turn.id))return false;
    state.turns.push({...turn,evidenceKind:'wechat-ui-echo'});
    state.turns=state.turns.slice(-300);atomicJson(this.file(id),state);return true;
  }
  confirmOwnerFact(id,{key,content,kind='preference',evidence,importance=0.5,durability='developing',trustedOwnerRequest=false}){
    const chat=this.chat(id);if(!chat.owner)throw new Error('EVIDENCE_OWNER_REQUIRED');
    const state=this.load(id),scope=this.scope(id);
    if(state.cards.length>=100)throw new Error('EVIDENCE_CAPACITY');
    const candidate={scope,actor:'owner',key,content,kind,evidence,importance,durability};
    const checked=validateFactCandidate(candidate,state.turns);
    const {tier,basis}=classifyFact(checked,{trustedOwnerRequest});
    const now=this.clock(),card={id:crypto.randomUUID(),scope,actor:'owner',key,content,kind,
      evidence,importance,tier,basis,confirmed:true,status:'active',visibility:'scope',
      lastEvidenceAt:Math.max(...checked.evidenceTurns.map(row=>row.at)),
      daily:{clarity:'vivid',day:maintenanceDay(now),evidenceAt:now,recallCount:0}};
    state.cards.push(card);atomicJson(this.file(id),state);return card;
  }
  search(id,query=''){
    const state=this.load(id);return selectDailyCards(state.cards,{scope:this.scope(id),query})
      .map(({card,text})=>({id:card.id,text,evidence:card.evidence,tier:card.tier}));
  }
  maintain(id){
    const state=this.load(id),next=structuredClone(state);let changes=0;
    for(const card of state.cards){
      const plan=planDailyMaintenance(card,this.clock());
      if(!plan)continue;
      commitDailyMaintenance(plan,{transaction:fn=>fn({
        appendFullArchive:version=>next.archive.push(version),
        updateDaily:daily=>{const row=next.cards.find(x=>x.id===daily.cardId);row.daily={...daily};delete row.daily.cardId;}
      })});changes++;
    }
    if(changes)atomicJson(this.file(id),next);return changes;
  }
}
