import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
export const ISOLATED_ADAPTER_SHA='21fedb71f8d9aafea73b35ee13bc73737a8271d7ffa261697d4208e8563196cb';
export function buildIsolatedAdapter({nativePackageRoot,outputDir,billingCollector=false}){
 const original=path.join(nativePackageRoot,'dsh-llm-deepseek/lib/index.js'),source=fs.readFileSync(original,'utf8'),hash=crypto.createHash('sha256').update(source).digest('hex');
 const meta=JSON.parse(fs.readFileSync(path.join(nativePackageRoot,'dsh-llm-deepseek/package.json'),'utf8'));
 if(meta.version!=='0.2.1-rc.4'||hash!==ISOLATED_ADAPTER_SHA)throw Error('ISOLATED_ADAPTER_SOURCE_UNSUPPORTED');
 const require=createRequire(pathToFileURL(original));
 let code=source.replace(/from "([^"]+)"/g,(whole,spec)=>spec.startsWith('node:')?whole:'from '+JSON.stringify(pathToFileURL(require.resolve(spec)).href));
 const needle='const response = await fetch(`${messagesApiRoot(connection.baseURL)}/messages`, {';
 if(code.split(needle).length!==2)throw Error('ISOLATED_FINAL_FETCH_CONTRACT_CHANGED');
 const budgetURL=new URL('../vendor/isolated-owner/wire-budget.mjs',import.meta.url).href;
 const billingURL=new URL('./billing/collector.mjs',import.meta.url).href;
 const baseFetch=billingCollector?'(url,init)=>billingProviderFetch(fetch,{sessionId:options.sessionId,provider:options.provider,model:options.model},url,init)':'fetch';
 const billingImport=billingCollector?'import {billingProviderFetch} from '+JSON.stringify(billingURL)+';\n':'';
 code=billingImport+'import {taskWireBudget} from '+JSON.stringify(budgetURL)+';\n'+code.replace(needle,'const response = await taskWireBudget.fetch('+baseFetch+', {sessionId:options.sessionId}, `${messagesApiRoot(connection.baseURL)}/messages`, {');
 const digest=crypto.createHash('sha256').update(code).digest('hex'),file=path.join(outputDir,'isolated-deepseek-'+digest.slice(0,24)+'.mjs');
 fs.mkdirSync(outputDir,{recursive:true});if(fs.existsSync(file)){if(fs.readFileSync(file,'utf8')!==code)throw Error('ISOLATED_ADAPTER_TAMPERED');}else fs.writeFileSync(file,code,{flag:'wx',mode:0o600});
 return {file,sha256:digest,budgetURL};
}
