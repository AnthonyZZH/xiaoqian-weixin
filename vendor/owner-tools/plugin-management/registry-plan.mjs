// rc.4 PluginManager.registryPlan parity. No credential-bearing URLs leave this boundary.
const normalize=value=>{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw Error('REGISTRY_REQUIRES_PRIVATE_WEB_REVIEW');return u.href.replace(/\/*$/,'/')};
export function approvalRegistryPlan(requested,configured){
 if(!configured||!Array.isArray(configured.fallbackRegistries))throw Error('REGISTRY_PLAN_UNAVAILABLE_USE_WEB');
 const own=configured.resolved===null?null:normalize(configured.resolved),fallbacks=configured.fallbackRegistries.map(normalize);
 const publicOwn=own!==null&&(own==='https://registry.npmjs.org/'||fallbacks.includes(own));
 const known=[],keys=[],keyOf=v=>v===null?own:normalize(v);
 for(const v of [configured.registry,...configured.fallbackRegistries]){if(v===null&&!publicOwn)continue;const key=keyOf(v);if(keys.includes(key))continue;known.push(v===null?own:normalize(v));keys.push(key)}
 const first=normalize(requested),key=keyOf(first);
 if((key===own&&!publicOwn)||!keys.includes(key))return[first];
 return[first,...known.filter((_v,i)=>keys[i]!==key)];
}
