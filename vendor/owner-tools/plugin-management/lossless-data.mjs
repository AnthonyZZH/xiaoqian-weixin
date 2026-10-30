// Explicit native DTO projection. Optional undefined properties are omitted;
// incompatible values in retained fields fail with their path, never become [].
export function optionalJson(value, location='$', seen=new Set()){
 if(value===null||typeof value==='string'||typeof value==='boolean')return value;
 if(typeof value==='number'){if(Number.isFinite(value)&&!Object.is(value,-0))return value;throw Error('NON_JSON_NUMBER:'+location);}
 if(!value||typeof value!=='object')throw Error('NON_JSON_TYPE:'+location+':'+typeof value);
 if(seen.has(value))throw Error('CYCLIC_DATA:'+location);
 if(!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('NON_JSON_PROTOTYPE:'+location);
 if(Object.getOwnPropertySymbols(value).length)throw Error('SYMBOL_DATA:'+location);
 seen.add(value);
 try{
  if(Array.isArray(value))return Array.from({length:value.length},(_,i)=>{if(!Object.hasOwn(value,i)||value[i]===undefined)throw Error('ARRAY_ITEM_MISSING:'+location+'['+i+']');return optionalJson(value[i],location+'['+i+']',seen)});
  const result={};
  for(const [key,d]of Object.entries(Object.getOwnPropertyDescriptors(value))){if(!d.enumerable)continue;if(!Object.hasOwn(d,'value'))throw Error('ACCESSOR_DATA:'+location+'.'+key);if(d.value!==undefined)Object.defineProperty(result,key,{value:optionalJson(d.value,location+'.'+key,seen),enumerable:true,writable:true,configurable:true});}
  return result;
 }finally{seen.delete(value);}
}
function row(record,keys,required,location){
 if(!record||typeof record!=='object'||Array.isArray(record)||![Object.prototype,null].includes(Object.getPrototypeOf(record)))throw Error('ROW_INVALID:'+location);
 const result={};for(const key of keys){const d=Object.getOwnPropertyDescriptor(record,key);if(!d)continue;if(!Object.hasOwn(d,'value'))throw Error('ACCESSOR_DATA:'+location+'.'+key);if(d.value!==undefined)result[key]=optionalJson(d.value,location+'.'+key);}
 for(const key of required)if(typeof result[key]!=='string'||!result[key])throw Error('REQUIRED_FIELD:'+location+'.'+key);
 return result;
}
export function bundleDto(record,location='$bundle'){
 return row(record,['name','version','official','availability','enabled','installed','optional','removable','readOnlyReason','description','installTarget','error','rows','overrides'],['name'],location);
}
export function pluginDto(record,location='$plugin'){
 return row(record,['entryId','moduleName','patchId','parentId','status','state','fiberPhase','disabled','enabled','readOnlyReason'],['entryId','moduleName'],location);
}
export function pluginListDto(bundles,plugins){
 if(!Array.isArray(bundles)||!Array.isArray(plugins))throw Error('LIST_NOT_ARRAY');
 const result={bundles:bundles.map((b,i)=>bundleDto(b,'$.bundles['+i+']')),plugins:plugins.map((p,i)=>pluginDto(p,'$.plugins['+i+']'))};
 result.counts={listedBundles:result.bundles.length,profileInstalled:result.bundles.filter(b=>b.installed===true).length,availableBundles:result.bundles.filter(b=>b.availability==='profile'||b.availability==='installation').length,pluginEntries:result.plugins.length};
 return result;
}
