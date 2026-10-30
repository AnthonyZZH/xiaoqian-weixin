/** Animation-safe asset storage. Model calls use IDs; only trusted Host code imports paths. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ID = /^media_[a-f0-9]{24}$/;
const SCOPE = /^[A-Za-z0-9_.:-]{1,128}$/;
const EXT = new Set(['.png','.apng','.gif','.webp','.jpg','.jpeg']);
const STATUSES = new Set(['pending','approved','rejected']);
const SOURCES = new Set(['original','static_preview']);
const fail = code => { const e = new Error(code); e.code = code; throw e; };
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const scopeOf = scope => typeof scope === 'string' && SCOPE.test(scope) ? scope : fail('MEDIA_SCOPE_INVALID');
function descriptionOf(value) { if(typeof value !== 'string' || !value.trim() || value.length > 1000) fail('MEDIA_DESCRIPTION_INVALID'); return value.trim(); }

/** Reject every symlink/junction component, not just the leaf. */
function checkPath(value, {allowMissing=false}={}) {
  const absolute = path.resolve(value);
  let current = path.parse(absolute).root;
  for(const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current,part);
    let stat;
    try { stat = fs.lstatSync(current); } catch(e) { if(e.code === 'ENOENT' && allowMissing) continue; throw e; }
    if(stat.isSymbolicLink()) fail('MEDIA_SYMLINK_DENIED');
  }
  return absolute;
}
function inside(root,value) { const relative=path.relative(root,value); if(relative === '..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) fail('MEDIA_PATH_DENIED'); }
function dimensions(width,height) { if(!width || !height || width>16384 || height>16384 || width*height>100_000_000) fail('MEDIA_DIMENSIONS_INVALID'); return {width,height}; }
function subblocks(b, at) { while(at < b.length) { const size=b[at++]; if(size===0) return at; if(at+size>b.length) fail('MEDIA_FORMAT_INVALID'); at+=size; } fail('MEDIA_FORMAT_INVALID'); }
function gifInfo(b) {
  if(b.length<14) fail('MEDIA_FORMAT_INVALID');
  const size=dimensions(b.readUInt16LE(6),b.readUInt16LE(8));
  let at=13+((b[10]&128)?3*(2**((b[10]&7)+1)):0), frames=0, ended=false;
  while(at<b.length) {
    const tag=b[at++];
    if(tag===0x3b){ended=true;break;}
    if(tag===0x21){ if(at>=b.length) fail('MEDIA_FORMAT_INVALID'); at++; at=subblocks(b,at); }
    else if(tag===0x2c){
      if(at+9>b.length) fail('MEDIA_FORMAT_INVALID');
      dimensions(b.readUInt16LE(at+4),b.readUInt16LE(at+6));
      const packed=b[at+8]; at+=9+((packed&128)?3*(2**((packed&7)+1)):0);
      if(at>=b.length || b[at]<2 || b[at]>8) fail('MEDIA_FORMAT_INVALID');
      at=subblocks(b,at+1); if(++frames>1000) fail('MEDIA_TOO_MANY_FRAMES');
    } else fail('MEDIA_FORMAT_INVALID');
  }
  if(!ended || frames===0 || at!==b.length) fail('MEDIA_FORMAT_INVALID');
  return {format:'gif',frames,animated:frames>1,...size};
}
let crcTable;
function crc32(bytes){
  if(!crcTable) crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
  let c=0xffffffff;for(const x of bytes)c=crcTable[(c^x)&255]^(c>>>8);return (c^0xffffffff)>>>0;
}
function pngInfo(b){
  let at=8,size,frames=1,ended=false,hasData=false,animation=false;
  while(at+12<=b.length){
    const length=b.readUInt32BE(at),type=b.toString('ascii',at+4,at+8),end=at+12+length;
    if(length>0x7fffffff || end>b.length || crc32(b.subarray(at+4,at+8+length))!==b.readUInt32BE(at+8+length)) fail('MEDIA_FORMAT_INVALID');
    if(!size && type!=='IHDR') fail('MEDIA_FORMAT_INVALID');
    if(type==='IHDR'){if(size || length!==13)fail('MEDIA_FORMAT_INVALID');size=dimensions(b.readUInt32BE(at+8),b.readUInt32BE(at+12));}
    if(type==='acTL'){if(animation || length!==8)fail('MEDIA_FORMAT_INVALID');animation=true;frames=b.readUInt32BE(at+8);if(!frames || frames>1000)fail('MEDIA_TOO_MANY_FRAMES');}
    if(type==='IDAT')hasData=true;
    at=end;if(type==='IEND'){if(length!==0)fail('MEDIA_FORMAT_INVALID');ended=true;break;}
  }
  if(!ended || !hasData || at!==b.length)fail('MEDIA_FORMAT_INVALID');
  return {format:animation?'apng':'png',frames,animated:animation&&frames>1,...size};
}
function webpInfo(b){
  if(b.length<20 || b.readUInt32LE(4)+8!==b.length)fail('MEDIA_FORMAT_INVALID');
  let at=12,frames=0,animation=false,image=false;
  while(at+8<=b.length){const type=b.toString('ascii',at,at+4),length=b.readUInt32LE(at+4);at+=8;
    if(at+length>b.length)fail('MEDIA_FORMAT_INVALID');
    if(type==='ANIM')animation=true;if(type==='ANMF')frames++;if(type==='VP8 '||type==='VP8L')image=true;
    at+=length+(length&1);
  }
  if(at!==b.length || (!image&&!frames) || frames>1000)fail('MEDIA_FORMAT_INVALID');
  return {format:'webp',frames:frames||1,animated:animation&&frames>1};
}
function jpegInfo(b){
  if(b.length<4 || b[b.length-2]!==255 || b[b.length-1]!==217)fail('MEDIA_FORMAT_INVALID');
  let at=2,size;
  while(at+3<b.length){if(b[at++]!==255)fail('MEDIA_FORMAT_INVALID');while(b[at]===255)at++;const tag=b[at++];if(tag===0xda)break;
    if(tag===0xd8||tag===0xd9)continue;const length=b.readUInt16BE(at);if(length<2||at+length>b.length)fail('MEDIA_FORMAT_INVALID');
    if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(tag)){if(length<8)fail('MEDIA_FORMAT_INVALID');size=dimensions(b.readUInt16BE(at+5),b.readUInt16BE(at+3));}at+=length;
  }
  if(!size)fail('MEDIA_FORMAT_INVALID');return {format:'jpeg',frames:1,animated:false,...size};
}
export function inspectMedia(bytes){
  const b=Buffer.from(bytes);
  if(b.subarray(0,6).toString()==='GIF89a'||b.subarray(0,6).toString()==='GIF87a')return gifInfo(b);
  if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return pngInfo(b);
  if(b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')return webpInfo(b);
  if(b[0]===255&&b[1]===216)return jpegInfo(b);fail('MEDIA_FORMAT_UNSUPPORTED');
}
const extensionFor = format => ({gif:'.gif',png:'.png',apng:'.png',webp:'.webp',jpeg:'.jpg'})[format];
const compatible = (extension,format) => extensionFor(format)===extension || (format==='apng'&&extension==='.apng') || (format==='jpeg'&&extension==='.jpeg');
function publicRow(row){const {file,sha256,...rest}=row;return structuredClone(rest);}

export class MediaLibrary {
  constructor({root,maxBytes=16*1024*1024,maxItems=5000}={}){
    if(typeof root!=='string'||!path.isAbsolute(root))fail('MEDIA_ROOT_INVALID');
    this.root=checkPath(root,{allowMissing:true});this.assets=path.join(this.root,'assets');this.indexPath=path.join(this.root,'index.json');
    this.maxBytes=maxBytes;this.maxItems=maxItems;
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>128*1024*1024||!Number.isSafeInteger(maxItems)||maxItems<1)fail('MEDIA_LIMIT_INVALID');
    fs.mkdirSync(this.assets,{recursive:true});checkPath(this.assets);
    this.capabilities=Object.freeze({originalFileImport:true,originalBytePreservation:true,wechatOriginalAcquisition:false,wechatAnimatedPlaybackVerified:false,screenshotAcquisition:'static_preview'});
    if(fs.existsSync(this.indexPath)){
      checkPath(this.indexPath);let state;try{state=JSON.parse(fs.readFileSync(this.indexPath,'utf8'));}catch{fail('MEDIA_INDEX_INVALID');}
      if(state.version!==1||!Array.isArray(state.items)||state.items.length>maxItems)fail('MEDIA_INDEX_INVALID');
      const ids=new Set();for(const row of state.items){
        if(!row||!ID.test(row.id)||ids.has(row.id)||!SCOPE.test(row.scope)||!STATUSES.has(row.status)||!SOURCES.has(row.source)||!/^[a-f0-9]{64}$/.test(row.sha256)||row.file!==row.id+extensionFor(row.format))fail('MEDIA_INDEX_INVALID');
        descriptionOf(row.description);if(!Number.isSafeInteger(row.bytes)||row.bytes<1||row.bytes>maxBytes)fail('MEDIA_INDEX_INVALID');ids.add(row.id);
      }this.items=state.items;
    }else this.items=[];
  }
  _save(){
    checkPath(this.root);checkPath(this.assets);if(fs.existsSync(this.indexPath))checkPath(this.indexPath);
    const temporary=path.join(this.root,`.index-${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temporary,JSON.stringify({version:1,items:this.items},null,2),{flag:'wx',mode:0o600});
    fs.renameSync(temporary,this.indexPath);
  }
  _row(id,scope){scopeOf(scope);if(typeof id!=='string'||!ID.test(id))fail('MEDIA_ID_INVALID');const row=this.items.find(x=>x.id===id&&x.scope===scope);if(!row)fail('MEDIA_NOT_FOUND');return row;}
  _import(bytes,{description,scope,approved=false,source}){
    description=descriptionOf(description);scope=scopeOf(scope);if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>this.maxBytes)fail('MEDIA_SIZE_INVALID');
    const info=inspectMedia(bytes);if(source==='static_preview'&&(info.format!=='png'||info.animated))fail('MEDIA_PREVIEW_MUST_BE_STATIC_PNG');
    const digest=hash(bytes),existing=this.items.find(x=>x.scope===scope&&x.sha256===digest&&x.source===source);
    if(existing)return {...publicRow(existing),deduplicated:true};if(this.items.length>=this.maxItems)fail('MEDIA_LIBRARY_FULL');
    const id='media_'+crypto.randomBytes(12).toString('hex'),file=id+extensionFor(info.format),target=path.join(this.assets,file);inside(this.assets,target);checkPath(this.assets);
    fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});
    const row={id,file,sha256:digest,description,scope,status:approved?'approved':'pending',source,...info,bytes:bytes.length,createdAt:new Date().toISOString()};
    this.items.push(row);this._save();return {...publicRow(row),deduplicated:false};
  }
  /** Trusted Host import only: never expose sourcePath to model tools. */
  importOriginal(sourcePath,{description,scope,approved=false}={}){
    if(typeof sourcePath!=='string'||!path.isAbsolute(sourcePath))fail('MEDIA_SOURCE_PATH_INVALID');const source=checkPath(sourcePath),stat=fs.lstatSync(source);
    if(!stat.isFile()||stat.nlink>1)fail('MEDIA_SOURCE_FILE_INVALID');if(stat.size<1||stat.size>this.maxBytes)fail('MEDIA_SIZE_INVALID');
    const extension=path.extname(source).toLowerCase();if(!EXT.has(extension))fail('MEDIA_EXTENSION_UNSUPPORTED');
    const fd=fs.openSync(source,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));let bytes;
    try{const opened=fs.fstatSync(fd);if(!opened.isFile()||opened.size!==stat.size||opened.dev!==stat.dev||opened.ino!==stat.ino)fail('MEDIA_SOURCE_CHANGED');bytes=fs.readFileSync(fd);if(bytes.length!==stat.size)fail('MEDIA_SOURCE_CHANGED');}finally{fs.closeSync(fd);}
    if(!compatible(extension,inspectMedia(bytes).format))fail('MEDIA_EXTENSION_MISMATCH');
    return this._import(bytes,{description,scope,approved,source:'original'});
  }
  /** Screen crops can never be promoted to original animation. */
  importPreview(bytes,{description,scope}={}){return this._import(Buffer.from(bytes),{description,scope,approved:false,source:'static_preview'});}
  catalog({scope,query='',limit=60,includePending=false}={}){
    scope=scopeOf(scope);if(typeof query!=='string'||query.length>500||!Number.isInteger(limit)||limit<1||limit>200)fail('MEDIA_QUERY_INVALID');
    const terms=query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return this.items.filter(x=>x.scope===scope&&(x.status==='approved'||includePending&&x.status==='pending'))
      .map(row=>({row,score:terms.reduce((n,t)=>n+(row.description.toLocaleLowerCase().includes(t)?1:0),0)}))
      .filter(x=>!terms.length||x.score>0).sort((a,b)=>b.score-a.score||a.row.id.localeCompare(b.row.id)).slice(0,limit).map(x=>publicRow(x.row));
  }
  approve(id,{scope}={}){const row=this._row(id,scope);if(row.status==='rejected')fail('MEDIA_REJECTED');row.status='approved';this._save();return publicRow(row);}
  reject(id,{scope}={}){const row=this._row(id,scope);row.status='rejected';this._save();return publicRow(row);}
  editDescription(id,description,{scope}={}){const row=this._row(id,scope);row.description=descriptionOf(description);this._save();return publicRow(row);}
  resolveForSend(id,{scope,allowStaticPreview=false}={}){
    const row=this._row(id,scope);if(row.status!=='approved')fail('MEDIA_NOT_APPROVED');if(row.source==='static_preview'&&!allowStaticPreview)fail('MEDIA_STATIC_PREVIEW_ACK_REQUIRED');
    const target=path.join(this.assets,row.file);inside(this.assets,target);checkPath(target);const stat=fs.lstatSync(target);
    if(!stat.isFile()||stat.nlink>1||stat.size!==row.bytes)fail('MEDIA_ASSET_CHANGED');const bytes=fs.readFileSync(target);if(hash(bytes)!==row.sha256)fail('MEDIA_ASSET_CHANGED');
    const actual=inspectMedia(bytes);if(actual.format!==row.format||actual.animated!==row.animated)fail('MEDIA_ASSET_CHANGED');
    return {path:target,...publicRow(row),animationPlayback:'unverified'};
  }
}
