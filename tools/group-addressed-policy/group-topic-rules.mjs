import crypto from 'node:crypto';
const hash=s=>crypto.createHash('sha256').update(String(s)).digest('hex');
const clean=s=>String(s??'').normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/gu,'');
export const TOPIC_IDLE_MS=8*60*1000;
const aliasMention=(text,alias)=>{
 const escaped=Array.from(clean(alias)).map(char=>'\\u{'+char.codePointAt(0).toString(16)+'}').join('');
 return new RegExp('(?:^|[^A-Za-z0-9_@])@'+escaped+'(?=$|[\\s\\u00a0\\u2005\\u3000,.:;!?\\uFF0C\\u3002\\uFF01\\uFF1F\\u3001\\uFF1A\\uFF1B\\(\\)\\[\\]\\uFF08\\uFF09])','u').test(clean(text));
};
export const mentionsName=(text,aliases=[])=>/\u5c0f\s*\u5343/u.test(clean(text))||aliases.some(alias=>aliasMention(text,alias));
const generic=new Set(['小千','这个','那个','什么','怎么','为何','为什么','帮我','帮忙','一下','可以','觉得','大家','你们','我们','不是','就是','然后','你好','谢谢','好的','知道','现在','这样','那个','的话','一个','一下','那具','体呢','具体','解释','为什','那你','你说','怎么','那再','再呢']);
function terms(text){const v=clean(text).replace(/@?小\s*千/gu,'').toLowerCase(),out=[];for(const word of v.match(/[a-z][a-z0-9_]{2,}|[\p{Script=Han}]{2,}/gu)||[]){if(/^[a-z]/.test(word))out.push(word);else for(let i=0;i<word.length-1;i++)out.push(word.slice(i,i+2));}return [...new Set(out.filter(w=>!generic.has(w)).map(hash))].slice(0,48);}
function control(text){const t=clean(text).trim();if(/^[>“"'「『]|^(?:转发|引用)[：:]/u.test(t))return null;
 if(/(?:^|[，,。])\s*(?:@?小千[，,\s]*)?(?:先|暂时)?(?:别说话|别接话|不要说了|别说了|安静|闭嘴|停一下|退出这个话题|结束这个话题|到此为止)(?:[了吧。！!\s]|$)/u.test(t)||/小千.{0,12}(?:先别说|别说了|别接话|退出话题)/u.test(t))return 'stop';
 if(/(?:^|[，,。])\s*(?:@?小千[，,\s]*)?(?:少说点|少说两句|少接话)(?:[。！!\s]|$)/u.test(t))return 'less';
 if(/^(?:@?小千[，,\s]*)?(?:恢复|继续聊|你可以说了)(?:[吧。！!\s]|$)/u.test(t))return 'resume';return null;}
function related(topic,text){const set=new Set(topic.terms);return terms(text).some(t=>set.has(t));}
function start(state,m,now){state.topicEpoch=(state.topicEpoch||0)+1;state.groupTopic={id:hash(m.id+'|'+state.topicEpoch),epoch:state.topicEpoch,startedAt:now,lastAt:now,lastBotAt:0,participants:m.sender?[hash(m.sender)]:[],terms:terms(m.text)};return state.groupTopic;}
export function decideTopic(state,m,now=Date.now(),{mentionAliases=[]}={}){
 if(m.role!=='user')return {allow:false,reason:'self_or_nonuser'};
 const ctl=control(m.text),old=state.groupTopic;
 if(ctl==='stop'||ctl==='less'){state.groupTopic=null;state.topicEpoch=(state.topicEpoch||0)+1;if(ctl==='less')state.topicLess=true;return {allow:false,invalidate:true,reason:'topic_'+ctl};}
 const shift=/(?:换个话题|换一个话题|另一个话题|不聊这个|聊点别的|说点别的|这个话题结束)/u.test(clean(m.text));
 const expired=old&&now-old.lastAt>TOPIC_IDLE_MS;
 if(shift||expired){state.groupTopic=null;state.topicEpoch=(state.topicEpoch||0)+1;}
 let topic=state.groupTopic;const direct=mentionsName(m.text,mentionAliases)||ctl==='resume';
 if(ctl==='resume')state.topicLess=false;
 if(direct){let invalidate=!!(shift||expired);if(!topic||(!related(topic,m.text)&&!(m.sender&&topic.participants.includes(hash(m.sender))&&/^\s*(?:那|这个|具体|继续|再|还有|为什么|怎么|你)/u.test(clean(m.text).replace(/@?小\s*千/gu,''))))){topic=start(state,m,now);invalidate=true;}
  topic.lastAt=now;topic.terms=[...new Set([...terms(m.text),...topic.terms])].slice(0,64);if(m.sender)topic.participants=[...new Set([hash(m.sender),...topic.participants])].slice(0,16);return {allow:true,invalidate,reason:'name_or_display_mention',topicId:topic.id};}
 if(!topic)return {allow:false,invalidate:!!(shift||expired),reason:shift?'topic_changed':expired?'topic_expired':'not_addressed'};
 const participant=m.sender&&topic.participants.includes(hash(m.sender));
 const adjacency=topic.lastWasBot===true&&now-topic.lastBotAt<=60000;
 const punctuationFollow=!!participant&&now-topic.lastAt<=120000&&/^[\s?？!！…。.]{1,12}$/u.test(clean(m.text));
 const follow=punctuationFollow||clean(m.text).length<=240&&(participant&&now-topic.lastAt<=120000||adjacency&&topic.lastBotAt>0)&&/^\s*(?:嗯|哦|噢|欸|诶|哈哈|笑|确实|原来|对|不对|是的|不是|那|所以|为什么|为啥|怎么|咋|第[一二三四五六七八九十0-9]|这个|那个|继续|再|还有|好|行|可以|具体|比如|举例|说说|你|能|但是|不过|等等)/u.test(clean(m.text));
 if(related(topic,m.text)||follow){topic.lastAt=now;topic.lastWasBot=false;topic.terms=[...new Set([...terms(m.text),...topic.terms])].slice(0,64);if(m.sender)topic.participants=[...new Set([hash(m.sender),...topic.participants])].slice(0,16);return {allow:true,reason:follow?'topic_followup':'topic_related',topicId:topic.id};}
 if(participant){topic.lastWasBot=false;return {allow:false,reason:'participant_unrelated_or_unclear'};}
 topic.lastWasBot=false;return {allow:false,reason:'unrelated_group_chat'};
}
export function noteTopicReply(state,text,now=Date.now()){const t=state.groupTopic;if(!t)return;t.lastAt=now;t.lastBotAt=now;t.lastWasBot=true;t.terms=[...new Set([...terms(text),...t.terms])].slice(0,64);}
export function seedTopic(state,m,text,now=Date.now()){const t=start(state,m,now);if(text)noteTopicReply(state,text,now);return t;}
