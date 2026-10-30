export const name='xiaoqian-owner-native-services';export const inject=[];
export function apply(ctx){
 const slots={pluginManager:null,pluginMarket:null,loader:null};
 ctx.reflect.provide('ownerPluginServices',slots);
 for(const key of ['pluginManager','pluginMarket','loader'])ctx.inject([key],inner=>{
  const value=inner[key];slots[key]=value;inner.effect(()=>()=>{if(slots[key]===value)slots[key]=null;});
 });
}
export function discoverConfiguredMcp(slots){
 if(!slots.loader)return{status:'loader-unavailable',entries:[]};
 return{status:'ok',entries:[...slots.loader.entries()].filter(e=>e.options?.name==='@deepseek-ai/dsh-mcp-client').map(e=>({entryId:e.id,rowId:e.options.id,scope:'profile',configurationHidden:true}))};
}