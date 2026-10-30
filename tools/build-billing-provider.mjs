import path from 'node:path';import {buildOfficialBalanceShim} from '../src/balance-shim-builder.mjs';
const [nativePackageRoot,outputDir]=process.argv.slice(2);
if(!path.isAbsolute(nativePackageRoot||'')||!path.isAbsolute(outputDir||''))throw Error('Usage: node tools/build-billing-provider.mjs ABSOLUTE_NATIVE_NAMESPACE ABSOLUTE_PRIVATE_SHIM_OUTPUT');
const result=buildOfficialBalanceShim({nativePackageRoot,outputDir,billingCollector:true});
console.log(JSON.stringify({file:result.file,sha256:result.sha256,version:result.version,upstreamUnmodified:result.upstreamUnmodified}));
