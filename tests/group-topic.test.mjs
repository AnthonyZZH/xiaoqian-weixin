import test from 'node:test';
import assert from 'node:assert/strict';
import {mentionsName,decideTopic,noteTopicReply,TOPIC_IDLE_MS} from '../tools/group-addressed-policy/group-topic-rules.mjs';

test('host-configured mention aliases are literal and have exact token boundaries',()=>{
 for(const gap of [' ','\u2005','\u00a0','\u3000',',','，','?','？']){
  assert.equal(mentionsName('@TestBot'+gap+'hello',['TestBot']),true);
 }
 assert.equal(mentionsName('请小千看这个'),true);
 assert.equal(mentionsName('@OtherBot hello',['TestBot']),false);
 assert.equal(mentionsName('@TestBotExtra hello',['TestBot']),false);
 assert.equal(mentionsName('x@TestBot hello',['TestBot']),false);
 assert.equal(mentionsName('@Bot.Name hello',['Bot.Name']),true);
 assert.equal(mentionsName('@BotXName hello',['Bot.Name']),false);
 assert.equal(mentionsName('@TestBot hello'),false);
});

test('one topic supports followups and punctuation without repeating the name',()=>{
 const s={},opts={mentionAliases:['TestBot']};
 const m=(id,text)=>({id,text,role:'user',sender:'SYNTHETIC MEMBER'});
 assert.equal(decideTopic(s,m('one','@TestBot 什么是量子轨道'),1000,opts).allow,true);
 noteTopicReply(s,'可以讨论量子轨道',1100);
 assert.equal(decideTopic(s,m('two','那具体呢'),1200,opts).allow,true);
 noteTopicReply(s,'继续解释轨道',1300);
 assert.equal(decideTopic(s,m('three','？？'),1400,opts).allow,true);
 assert.equal(decideTopic(s,m('stop','先别说话'),1500,opts).reason,'topic_stop');
 assert.equal(decideTopic(s,m('after','那具体呢'),1600,opts).allow,false);
});

test('self echo, unrelated conversation, topic change and expiration stay closed',()=>{
 const s={},m=(id,text,sender='SYNTHETIC MEMBER')=>({id,text,role:'user',sender});
 assert.equal(decideTopic(s,{...m('self','小千'),role:'assistant'},1000).allow,false);
 decideTopic(s,m('call','小千，量子轨道'),2000);noteTopicReply(s,'电子轨道',2100);
 assert.equal(decideTopic(s,m('other','今晚吃火锅','OTHER MEMBER'),2200).allow,false);
 assert.equal(decideTopic(s,m('shift','换个话题'),2300).allow,false);
 assert.equal(s.groupTopic,null);
 decideTopic(s,m('new','小千，量子轨道'),3000);
 assert.equal(decideTopic(s,m('late','量子轨道'),3000+TOPIC_IDLE_MS+1).allow,false);
});
