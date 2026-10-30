import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {createRequire} from 'node:module';import {pathToFileURL,fileURLToPath} from 'node:url';
const fail=code=>Object.assign(Error(code),{code});
export const PINNED_PROVIDER_SHA='67f9cbc26ce0ea07009e0c36ee4a7cc058542cdf85b873549885922646cacd35';
export function buildOfficialBalanceShim({nativePackageRoot,outputDir,helperURL=new URL('./official-balance-capability.mjs',import.meta.url).href}={}){
 if(!path.isAbsolute(nativePackageRoot||'')||!path.isAbsolute(outputDir||''))throw fail('BALANCE_INSTALL_PATH_REQUIRED');
 const root=fs.realpathSync(nativePackageRoot),directory=path.join(root,'dsh-llm-deepseek-api-key'),meta=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
 if(meta.name!=='@deepseek-ai/dsh-llm-deepseek-api-key'||meta.version!=='0.2.1-rc.4')throw fail('BALANCE_PROVIDER_VERSION_UNSUPPORTED');
 const original=path.join(directory,'lib/index.js'),source=fs.readFileSync(original,'utf8'),hash=crypto.createHash('sha256').update(source).digest('hex');
 if(hash!==PINNED_PROVIDER_SHA)throw fail('BALANCE_PROVIDER_SOURCE_MISMATCH');
 const helper=new URL(helperURL);if(helper.protocol!=='file:'||!fs.statSync(fileURLToPath(helper)).isFile())throw fail('BALANCE_HELPER_PATH_INVALID');
 const require=createRequire(pathToFileURL(original)),imports=[];
 let generated=source.replace(/from \"(@deepseek-ai\/[^\"]+)\"/g,(_match,specifier)=>{const resolved=require.resolve(specifier);imports.push({specifier,resolved});return 'from '+JSON.stringify(pathToFileURL(resolved).href);});
 if(imports.length!==5)throw fail('BALANCE_IMPORT_CONTRACT_CHANGED');
 const needle='const presentApiKey = async (connection) => {';if(generated.split(needle).length!==2)throw fail('BALANCE_CLOSURE_CONTRACT_CHANGED');
 generated='import {attachOfficialBalance} from '+JSON.stringify(helper.href)+';\n'+generated.replace(needle,'attachOfficialBalance(ctx,{options,resolveApiKey});\n\t'+needle);
 const digest=crypto.createHash('sha256').update(generated).digest('hex');fs.mkdirSync(outputDir,{recursive:true});const target=path.join(outputDir,'provider-shim-'+digest.slice(0,24)+'.mjs');
 if(fs.existsSync(target)){if(crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')!==digest)throw fail('BALANCE_GENERATED_SHIM_TAMPERED');}
 else fs.writeFileSync(target,generated,{flag:'wx',mode:0o600});
 return {file:target,sha256:digest,version:meta.version,imports:imports.length,upstreamUnmodified:true};
}