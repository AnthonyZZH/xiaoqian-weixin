// What the control panel may see and do. Everything here acts for the person holding the panel token:
// status, pause/resume, task cancel/retry, model and drawing settings, restart. Secrets are write-only.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {applySettings,normalizeSettings,DEFAULT_SETTINGS,SECRET_NAMES} from './panel-settings.mjs';
import {probeDraw} from './draw-api.mjs';

const fail=(code,message)=>{throw Object.assign(new Error(message||code),{code});};
const readJson=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^﻿/,''));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
function writeJson(file,value){const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(temp,file);}
const tail=(file,lines)=>{try{return fs.readFileSync(file,'utf8').trimEnd().split('\n').slice(-lines);}catch{return [];}};

/** options: {settingsFile, patchFile, restartScript, secretsFile, secretsWritable} — all optional; without the first
 *  two the panel can still pause/resume and manage tasks, but cannot change settings.
 *  Keys are read-only by default: they are set on the machine itself (system environment variables, like the
 *  DeepSeek key) and the panel only shows whether each one is present. Only with secretsWritable may the panel
 *  store keys (in secretsFile), which means typing them over whatever connection the panel is reached through. */
export function createPanelControl({getCore,engine,stateDir,options={},env=process.env,spawnImpl=spawn,fetchImpl=fetch}){
 const canConfigure=!!(options.settingsFile&&options.patchFile),keysWritable=options.secretsWritable===true&&!!options.secretsFile;
 const settings=()=>normalizeSettings(readJson(options.settingsFile,DEFAULT_SETTINGS));
 const savedSecrets=()=>options.secretsFile?readJson(options.secretsFile,{}):{};
 const secretState=()=>{const saved=savedSecrets();return Object.fromEntries(SECRET_NAMES.map(n=>[n,!!(saved[n]||env[n])]));};
 const typed=body=>Object.fromEntries(SECRET_NAMES.map(n=>[n,typeof body.secrets?.[n]==='string'?body.secrets[n].trim():'']).filter(([,v])=>v));
 function status(){
  const core=getCore(),lastRead=tail(path.join(stateDir,'driver','read-outcomes-node.jsonl'),12).map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(r=>r?.phase==='terminal').at(-1);
  const model=core?.model||{};
  return {at:new Date().toISOString(),startedAt:new Date(Date.now()-process.uptime()*1000).toISOString(),paused:core?core.store.data.paused===true:null,
   model:{provider:model.provider,model:model.model},drawing:typeof core?.capabilities?.draw==='function',
   lastRead:lastRead?{at:lastRead.at,outcome:lastRead.outcome,code:lastRead.code}:null,
   errors:tail(path.join(stateDir,'loop-errors.log'),5).map(l=>l.slice(0,240)),
   can:{configure:canConfigure,restart:!!options.restartScript,setKeys:keysWritable}};
 }
 function restart(){
  if(!options.restartScript)fail('RESTART_UNAVAILABLE','这个部署没有配置重启脚本');
  // The script re-launches itself outside this process tree, restarts the host, and restores the previous
  // configuration if the host does not come back.
  // Not `detached`: on Windows a detached, hidden PowerShell exits without running the script. The script only
  // creates a one-off scheduled task and returns, and that task is what outlives this process.
  const child=spawnImpl('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',options.restartScript],{stdio:'ignore',windowsHide:true});
  child.on?.('error',()=>{});
  child.unref?.();
  return {restarting:true};
 }
 const actions={
  'bridge/pause':()=>{getCore().pause();return {paused:true};},
  'bridge/resume':()=>{getCore().resume();return {paused:false};},
  'task/cancel':({id})=>engine.cancel(Number(id)),
  'task/retry':({id,stepId})=>engine.retry(Number(id),stepId||null).task,
  'host/restart':restart,
  'settings/save':body=>{
   if(!canConfigure)fail('SETTINGS_UNAVAILABLE','这个部署没有开放在面板里改设置');
   const next=normalizeSettings(body.settings),patch=applySettings(readJson(options.patchFile,null),next);
   const secrets=savedSecrets(),incoming=typed(body);
   if(Object.keys(incoming).length&&!keysWritable)fail('SECRETS_READ_ONLY','密钥只能在小千所在的电脑上设置，面板里不能输入');
   for(const [name,value] of Object.entries(incoming)){if(value.length>400||/\s/.test(value))fail('SECRET_INVALID','密钥格式不对');secrets[name]=value;}
   if(next.chat.mode==='deepseek'&&!secrets.XQ_DEEPSEEK_API_KEY&&!env.XQ_DEEPSEEK_API_KEY)fail('SECRET_MISSING','还没有 DeepSeek 密钥');
   if(Object.keys(incoming).length)writeJson(options.secretsFile,secrets);
   // The restart script falls back to these copies if the host does not come back.
   fs.copyFileSync(options.patchFile,options.patchFile+'.prev');
   if(fs.existsSync(options.settingsFile))fs.copyFileSync(options.settingsFile,options.settingsFile+'.prev');else fs.rmSync(options.settingsFile+'.prev',{force:true});
   writeJson(options.patchFile,patch);writeJson(options.settingsFile,next);
   return {saved:true,settings:next,secrets:secretState(),...(body.restart===false?{}:restart())};
  },
  // Reachability only: asks the endpoint for its model list. It never sends a prompt and costs nothing.
  'settings/test':async body=>{
   const s=normalizeSettings(body.settings),saved=savedSecrets(),incoming=keysWritable?typed(body):{},key=n=>incoming[n]||saved[n]||env[n];
   const probe=async(url,secret)=>{try{const r=await fetchImpl(url,{headers:secret?{authorization:'Bearer '+secret}:{},signal:AbortSignal.timeout(15000)});return {ok:r.ok,status:r.status};}catch(e){return {ok:false,error:String(e?.cause?.code||e?.name||'UNREACHABLE')};}};
   const out={};
   if(body.target!=='draw')out.chat=s.chat.mode==='custom'?await probe(s.chat.baseURL+'/models',key('XQ_CUSTOM_LLM_API_KEY')):await probe('https://api.deepseek.com/models',key('XQ_DEEPSEEK_API_KEY'));
   if(body.target!=='chat'&&s.draw.mode!=='off')out.draw=await probeDraw({kind:s.draw.mode,baseURL:s.draw.baseURL,apiKeyEnv:'K'},{fetchImpl,env:{K:key('XQ_DRAW_API_KEY')}}).catch(e=>({ok:false,error:String(e?.cause?.code||e?.name||'UNREACHABLE')}));
   return out;
  }};
 return {status,settings:()=>canConfigure?{settings:settings(),secrets:secretState()}:null,
  async act(name,body){const fn=actions[name];if(!fn)fail('ACTION_UNKNOWN');return fn(body&&typeof body==='object'?body:{});}};
}
