/** Per-chat reviewed catalog hosted beside the durable Python UI client. */
export class MediaBridge {
  constructor(driver){this.driver=driver;}
  async request(operation,scope,rest={}){
    const result=await this.driver.call(operation,{targetId:scope,...rest});
    if(result.status!=='ok')throw new Error(result.code||'MEDIA_UNAVAILABLE');
    return result;
  }
  async catalog({scope,query='',includePending=false,limit=20}){
    return (await this.request('media_catalog',scope,{query,includePending,limit})).records;
  }
  async approve(id,{scope}){
    return (await this.request('media_review',scope,{action:'approve',mediaId:id})).record;
  }
  async reject(id,{scope}){
    return (await this.request('media_review',scope,{action:'reject',mediaId:id})).record;
  }
  async editDescription(id,description,{scope}){
    return (await this.request('media_review',scope,{action:'describe',mediaId:id,description})).record;
  }
  async importOriginal(scope,file,metadata={}){
    return (await this.request('media_import_file',scope,{path:file,...metadata})).record;
  }
  async importStaticCapture(scope,base64,description=''){
    return (await this.request('media_import_static',scope,{base64,description})).record;
  }
  async previewForVision(scope,id){
    const result=await this.request('media_preview',scope,{mediaId:id});
    return {base64:result.base64,label:result.label};
  }
  async resolveForSend(id,{scope}){
    return (await this.request('media_resolve',scope,{mediaId:id})).media;
  }
}
