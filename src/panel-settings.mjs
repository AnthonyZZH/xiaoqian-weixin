// Settings the owner can change from the control panel, and how they map onto the host patch file.
// Pure functions: the installer uses them to write the first configuration, the panel to rewrite it.
export const CUSTOM_PROVIDER='xq-custom';
export const SECRET_NAMES=['XQ_DEEPSEEK_API_KEY','XQ_CUSTOM_LLM_API_KEY','XQ_DRAW_API_KEY'];
export const DEFAULT_SETTINGS=Object.freeze({
 chat:{mode:'deepseek',model:'deepseek-flash',baseURL:'',contextWindow:128000},
 draw:{mode:'off',baseURL:'',model:'',size:'1024x1024'}});
const bad=message=>{throw Object.assign(new Error(message),{code:'SETTINGS_INVALID'});};
function url(value,what){
 let u;try{u=new URL(String(value||'').trim());}catch{bad(what+'的接口地址不是合法的网址');}
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password)bad(what+'的接口地址只能是 http(s) 地址，且不能带账号密码');
 return u.href.replace(/\/+$/,'');
}
const text=(value,what,max=120)=>{const s=String(value??'').trim();if(!s||s.length>max||/[\r\n]/.test(s))bad(what+'不能为空');return s;};

export function normalizeSettings(input={}){
 const chat=input.chat||{},draw=input.draw||{};
 if(!['deepseek','custom'].includes(chat.mode||'deepseek'))bad('聊天模型的类型不对');
 if(!['off','openai','sdwebui'].includes(draw.mode||'off'))bad('画图的类型不对');
 const out={chat:{...DEFAULT_SETTINGS.chat},draw:{...DEFAULT_SETTINGS.draw}};
 if(chat.mode==='custom'){
  const window=Number(chat.contextWindow??DEFAULT_SETTINGS.chat.contextWindow);
  if(!Number.isInteger(window)||window<4000||window>4000000)bad('上下文长度要在 4000 到 4000000 之间');
  out.chat={mode:'custom',model:text(chat.model,'模型名'),baseURL:url(chat.baseURL,'聊天模型'),contextWindow:window};
 }else out.chat={...DEFAULT_SETTINGS.chat,model:chat.model?text(chat.model,'模型名'):DEFAULT_SETTINGS.chat.model};
 if((draw.mode||'off')!=='off'){
  const size=String(draw.size||DEFAULT_SETTINGS.draw.size).trim();
  if(!/^\d{3,4}x\d{3,4}$/.test(size))bad('图片尺寸要写成 1024x1024 这样');
  out.draw={mode:draw.mode,baseURL:url(draw.baseURL,'画图'),model:draw.mode==='openai'?text(draw.model,'画图模型名'):String(draw.model||'').trim().slice(0,120),size};
 }
 return out;
}

/** Returns a new patch array with the model and drawing choices applied. The input is not modified. */
export function applySettings(patch,settings){
 const s=normalizeSettings(settings),out=structuredClone(patch).filter(e=>e.id!=='llm-pi-ai'&&e.id!=='agent-default-model');
 const bridge=out.flatMap(e=>e.insert||[]).find(e=>e.id==='xiaoqian-wechat-native');
 if(!bridge?.config)bad('配置文件里找不到小千的桥接项');
 const custom=s.chat.mode==='custom',provider=custom?CUSTOM_PROVIDER:'deepseek-official',config=bridge.config;
 // Any OpenAI-compatible endpoint (a hosted API or a model served on this machine) goes through the Harness's multi-provider adapter.
 if(custom)out.unshift({id:'llm-pi-ai',name:'@deepseek-ai/dsh-llm-pi-ai',config:{providers:{[CUSTOM_PROVIDER]:{displayName:'自定义模型',api:'openai-completions',
  baseURL:s.chat.baseURL,apiKeyEnv:'XQ_CUSTOM_LLM_API_KEY',models:[{id:s.chat.model,name:s.chat.model,contextWindow:s.chat.contextWindow}]}}}});
 out.unshift({id:'agent-default-model',name:'@deepseek-ai/dsh-agent-default-model',config:{provider,model:s.chat.model,reasoningEffort:'off'}});
 config.model={provider,model:s.chat.model};
 // Balance lookup and billing collection only understand the official DeepSeek account.
 config.balance={enabled:!custom};
 if(config.billingCollector)config.billingCollector={...config.billingCollector,enabled:!custom};
 if(s.draw.mode==='off')delete config.draw;
 else config.draw={enabled:true,kind:s.draw.mode,baseURL:s.draw.baseURL,model:s.draw.model,size:s.draw.size,apiKeyEnv:'XQ_DRAW_API_KEY'};
 return out;
}
