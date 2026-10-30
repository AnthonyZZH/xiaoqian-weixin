import {pathToFileURL} from 'node:url';
const root=process.env.XQ_NATIVE_PACKAGE_ROOT||'C:/xiaoqian/app/dsh/node_modules/@deepseek-ai/';
for(const name of ['dsh-schedule','dsh-storage','dsh-storage-domain','dsh-storage-json','dsh-api-session-controller','dsh-agent-default-model','dsh-attachment','dsh-attachment-local','dsh-client-file-upload','dsh-fs','dsh-api-remote-access','dsh-typert-loader','dsh-typert-protocol','dsh-typert-registry','dsh-workspace','dsh-session-query-sqlite','dsh-agent-preset-registry']){
  try{
    const m=await import(pathToFileURL(root+name+'/lib/index.js').href);
    const apply=m.default||m;
    console.log(JSON.stringify({name,exports:Object.keys(m).slice(0,30),inject:apply.inject||m.inject||null,configKeys:Object.keys(m.Config?.toJSON?.().refs||{}).slice(0,5)}));
  }catch(e){console.log(JSON.stringify({name,error:String(e).slice(0,250)}));}
}
