// Read-only host module boundary. Listing association does not change activation.
export function createWorldbookReader({getContext,loadModule=()=>import('/scripts/world-info.js')}={}){
 const byName=new Intl.Collator('zh-CN',{numeric:true,sensitivity:'variant'});
 const name=v=>typeof v==='string'&&v.trim()?v:null;
 async function associated(){const wi=await loadModule(),ctx=getContext(),group=ctx.groupId==null?null:ctx.groups?.find(g=>String(g.id)===String(ctx.groupId)),characters=group?(ctx.characters??[]).filter(c=>group.members?.includes(c.avatar)):[ctx.characters?.[ctx.characterId]].filter(Boolean);const charBooks=characters.flatMap(character=>{const file=character.avatar?.replace(/\.[^.]+$/,'');return [character.data?.extensions?.world,...(wi.world_info?.charLore??[]).filter(row=>row.name===file).flatMap(row=>row.extraBooks??[])];});return {wi,names:[...new Set([...(wi.selected_world_info??[]),ctx.chatMetadata?.[wi.METADATA_KEY??'world_info'],...charBooks].map(name).filter(Boolean))]};}
 const entries=(book,data)=>Object.entries(data?.entries??{}).map(([key,row])=>{const uid=row.uid??key;return {book,uid:String(uid),name:row.comment?.trim()||row.key?.join('、')||`条目 ${uid}`,content:typeof row.content==='string'?row.content:''};});
 return Object.freeze({
  async list(){const {wi,names}=await associated();if(typeof wi.loadWorldInfo!=='function')throw new Error('当前宿主不能读取世界书');return Promise.all(names.map(async book=>({book,entries:entries(book,await wi.loadWorldInfo(book)).sort((a,b)=>byName.compare(a.name,b.name))})));},
  async read(refs){const {wi,names}=await associated(),books=new Map();for(const book of new Set(refs.map(r=>r.book))){if(!names.includes(book))throw new Error(`世界书已失去关联：${book}`);books.set(book,entries(book,await wi.loadWorldInfo(book)));}return refs.map(ref=>{const entry=books.get(ref.book)?.find(row=>row.uid===ref.uid);if(!entry)throw new Error(`世界书条目已失效：${ref.book} / ${ref.uid}`);return entry;});}
 });
}
