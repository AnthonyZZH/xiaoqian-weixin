import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
export const PINNED_DEEPSEEK_SHA='21fedb71f8d9aafea73b35ee13bc73737a8271d7ffa261697d4208e8563196cb';
export function buildBillingAdapter({nativePackageRoot,outputDir}){
 const original=path.join(nativePackageRoot,'dsh-llm-deepseek/lib/index.js'),source=fs.readFileSync(original,'utf8');
 const meta=JSON.parse(fs.readFileSync(path.join(nativePackageRoot,'dsh-llm-deepseek/package.json'),'utf8'));
 if(meta.version!=='0.2.1-rc.4'||crypto.createHash('sha256').update(source).digest('hex')!==PINNED_DEEPSEEK_SHA)throw Error('BILLING_ADAPTER_SOURCE_UNSUPPORTED');
 const require=createRequire(pathToFileURL(original));
 let code=source.replace(/from "([^"]+)"/g,(all,spec)=>spec.startsWith('node:')?all:'from '+JSON.stringify(pathToFileURL(require.resolve(spec)).href));
 const needle='const response = await fetch(`${messagesApiRoot(connection.baseURL)}/messages`, {';
 if(code.split(needle).length!==2)throw Error('BILLING_FINAL_FETCH_CONTRACT_CHANGED');
 const helper=new URL('./collector.mjs',import.meta.url).href;
 code='import {billingProviderFetch} from '+JSON.stringify(helper)+';\n'+code.replace(needle,'const response = await billingProviderFetch(fetch,{sessionId:options.sessionId,provider:options.provider,model:options.model}, `${messagesApiRoot(connection.baseURL)}/messages`, {');
 const digest=crypto.createHash('sha256').update(code).digest('hex'),file=path.join(outputDir,'billing-adapter-'+digest.slice(0,24)+'.mjs');
 fs.mkdirSync(outputDir,{recursive:true});if(fs.existsSync(file)){if(fs.readFileSync(file,'utf8')!==code)throw Error('BILLING_ADAPTER_TAMPERED');}else fs.writeFileSync(file,code,{flag:'wx',mode:0o600});
 return {file,sha256:digest};
}
