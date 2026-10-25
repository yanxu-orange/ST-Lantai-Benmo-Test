// Opt-in, bounded presentation evidence. No text, user values, arbitrary action,
// class/dataset values, identities, URLs, errors or event/DOM objects enter rows.
const AREAS=new Set(['memory','time','benmo','workshop','settings','none','unknown']);
const PHASES=new Set(['requested','shown','ready','reload']);
const REASONS=new Set(['manual','timeout','panel-close','chat-change','document-hidden','dispose','frame-cap','event-cap','byte-cap','cost-limit','failed','unknown']);
const ROLES=['surface','header','title','close','icon','main','footer','decoration'];
const DISPLAY=new Set(['none','block','inline','inline-block','flex','inline-flex','grid','inline-grid','contents']);
const VISIBILITY=new Set(['visible','hidden','collapse']);
const ROUTES={home:'root',manage:'root',list:'list',detail:'detail',edit:'editor',settings:'settings','narrative-edit':'editor','narrative-settings':'settings','narrative-generate':'generate',schedules:'list',anniversaries:'list',holidays:'list','edit/schedule':'editor','edit/anniversary':'editor','edit/holiday':'editor',calendar:'settings',calibrate:'editor'};
const safe=fn=>{try{return fn();}catch{return undefined;}};
const number=(n,min=0,max=32768)=>typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max?Math.round(n*10)/10:null;
const limit=(n,cap)=>Number.isSafeInteger(n)&&n>0?Math.min(n,cap):cap;

function view(panel){
 const shadow=panel?.shadowRoot,content=shadow?.querySelector('#lt-host-content');
 if(!content)return {known:false,area:'none',route:'unknown',nodes:ROLES.map(()=>null)};
 const page=[...content.children].find(n=>n.classList?.contains('lt-host-page')&&!n.hidden);
 const root=page?.querySelector('.lantai')??null,header=root?.querySelector('header.lt-header')??null;
 const close=header?.querySelector('[data-action=close],[data-time-action=close],[data-settings-action=close],[data-api-action=close],[data-task-api-action=close]')??null;
 const has=name=>root?.classList.contains(name);
 const area=!root?'none':has('lt-time')?'time':has('benmo')?'benmo':has('lt-settings')||has('lt-api-settings')||has('lt-task-api-settings')?'settings':has('workshop')?'workshop':root.hasAttribute('data-memory-type')||has('lt-summary-workspace')||has('lt-recall')?'memory':'unknown';
 const raw=root?.getAttribute('data-time-route')??root?.getAttribute('data-benmo-route');
 const route=raw!==null&&raw!==undefined?(Object.hasOwn(ROUTES,raw)?ROUTES[raw]:'unknown'):(has('lt-memory-editor')?'editor':header?.classList.contains('lt-header--root')?'root':root?.querySelector('[role=dialog]')?'review':root?.querySelector('form')?'editor':'unknown');
 return {known:true,area,route,nodes:[root,header,header?.querySelector('h1')??null,close,close?.querySelector('img')??null,root?.querySelector('.lt-main')??null,root?.querySelector('.lt-footer')??null,content.querySelector('[data-host-decoration]')]};
}

export function createUITransitionDiagnostic({document:doc,getPanel,now=()=>doc.defaultView?.performance?.now?.()??globalThis.performance.now(),wall=()=>Date.now(),
 requestFrame=fn=>doc.defaultView?.requestAnimationFrame?.(fn),cancelFrame=id=>doc.defaultView?.cancelAnimationFrame?.(id),
 setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id),
 MutationObserver:MO=doc.defaultView?.MutationObserver,ResizeObserver:RO=doc.defaultView?.ResizeObserver,
 getStyle=node=>doc.defaultView?.getComputedStyle?.(node),limits={}}={}){
 const caps={duration:limit(limits.duration,30000),frames:limit(limits.frames,2000),events:limit(limits.events,256),bytes:Math.max(4096,limit(limits.bytes,1048576))};
 let active=false,disposed=false,epoch=0,status='idle',reason=null,mode='phase-style-and-attributes',anchor=null,startAt=null,endedAt=null;
 let frames=[],events=[],bytes=0,sequence=0,nav=0,frameId=null,timerId=null,mutation=null,resize=null,targets=[],ids=null,geometry=null,styles=null,nodeSerial=0;
 let dirty=true,known=false,area='none',route='unknown',lastFrame=null,mutations=0,slowFrames=0,slowStyles=0,styleChecks=0,lastStyleKey='',releaseDownload=null,frameAvailable=null,geometryAvailable=null,mutationAvailable=null;
 const subscribers=new Set();
 const inspect=()=>({status,reason,mode,hasData:anchor!==null});
 const publish=()=>{for(const listener of subscribers)safe(()=>listener(inspect()));};
 const time=()=>number(now()-startAt,0,120000);
 function cleanup(){
  if(frameId!==null)safe(()=>cancelFrame(frameId));if(timerId!==null)safe(()=>clearTimer(timerId));frameId=timerId=null;
  safe(()=>mutation?.disconnect());safe(()=>resize?.disconnect());mutation=resize=null;
  safe(()=>doc.removeEventListener('visibilitychange',visibility));targets=[];ids=geometry=styles=null;dirty=true;
 }
 function stop(value='manual'){
  if(!active)return false;
  endedAt=safe(time)??null;active=false;epoch++;reason=REASONS.has(value)?value:'unknown';status='stopped';cleanup();publish();return true;
 }
 function append(kind,row){
  if(!active)return null;
  const list=kind==='frame'?frames:events,cap=kind==='frame'?caps.frames:caps.events;
  if(list.length>=cap){stop(kind==='frame'?'frame-cap':'event-cap');return null;}
  const size=JSON.stringify(row).length+25; // Includes conservative reserve for post-serialization numeric cost.
  if(bytes+size>caps.bytes-2048){stop('byte-cap');return null;}
  list.push(row);bytes+=size;return row.sequence;
 }
 function nodeId(node){if(!node)return null;if(!ids.has(node))ids.set(node,++nodeSerial);return ids.get(node);}
 function refresh(){
  const next=view(getPanel());known=next.known;area=next.area;route=next.route;
  const changed=next.nodes.length!==targets.length||next.nodes.some((n,i)=>n!==targets[i]);targets=next.nodes;dirty=false;
  if(changed&&resize){resize.disconnect();for(const node of new Set(targets.filter(Boolean)))resize.observe(node);}
 }
 function state(node,index){
  if(!node)return [ROLES[index],null,known?false:null,null,null,null,null,null,null,null,null,null];
  let hidden=false,inert=false,ancestor=node,depth=0;
  while(ancestor&&depth++<32){hidden=hidden||ancestor.hidden===true;inert=inert||ancestor.inert===true;ancestor=ancestor.parentNode??ancestor.host??null;}
  return [ROLES[index],nodeId(node),true,typeof node.isConnected==='boolean'?node.isConnected:null,typeof node.hidden==='boolean'?node.hidden:null,typeof node.inert==='boolean'?node.inert:null,hidden,inert,
   index===4&&typeof node.complete==='boolean'?node.complete:null,index===4?number(node.naturalWidth):null,styles.get(node)??null,geometry.get(node)??null];
 }
 function sampleNodes(){return ROLES.map((_,i)=>state(targets[i],i));}
 function downgrade(){if(mode==='attributes-only')return;mode='attributes-only';publish();}
 function sampleStyle(){
  const key=`${nav}:${nodeId(targets[0])}`;
  if(mode==='attributes-only'||key===lastStyleKey||styleChecks>=64)return;
  lastStyleKey=key;styleChecks++;
  const started=now(),samples=[];
  for(const index of [0,1,5,6]){
   const node=targets[index],css=node?safe(()=>getStyle(node)):null;
   const display=css?DISPLAY.has(css.display)?css.display:'other':null,visibility=css?VISIBILITY.has(css.visibility)?css.visibility:'other':null;
   const opacity=css?number(Number(css.opacity),0,1):null;
   samples.push([ROLES[index],nodeId(node),display,visibility,opacity]);
  }
  const row={sequence:++sequence,t:time(),kind:'style',nav,mode:'bounded-phase-style',cost:null,nodes:samples};
  const ref=append('event',row);const cost=row.cost=number(now()-started,0,120000);
  if(!active)return;if(ref!==null)for(const index of [0,1,5,6])if(targets[index])styles.set(targets[index],ref);
  slowStyles=cost!==null&&cost>6?slowStyles+1:0;if(slowStyles>=3)downgrade();
 }
 function stage(phase,target='unknown'){
  if(!active||!PHASES.has(phase))return false;
  try{
   refresh();if(phase==='requested')nav++;
   append('event',{sequence:++sequence,t:time(),kind:'phase',nav,phase,target:AREAS.has(target)?target:'unknown',area,route,nodes:sampleNodes()});
   if(active&&(phase==='shown'||phase==='ready'))sampleStyle();return active;
  }catch{stop('failed');return false;}
 }
 function tick(token){
  frameId=null;if(!active||token!==epoch)return;
  try{
   const started=now(),t=time();if(t===null){stop('failed');return;}if(t>=caps.duration){stop('timeout');return;}
   if(dirty)refresh();const nodes=sampleNodes();
   const row={sequence:++sequence,t,nav,area,route,mode:'attributes',dt:lastFrame===null?null:number(t-lastFrame,0,120000),cost:null,mutations:number(mutations,0,65535),nodes};
   append('frame',row);const cost=row.cost=number(now()-started,0,120000);
   if(!active)return;
   lastFrame=t;mutations=0;
   slowFrames=cost!==null&&cost>3?slowFrames+1:0;
   if(slowFrames>=3){if(mode==='attributes-only')stop('cost-limit');else{downgrade();slowFrames=0;}}
   if(active){frameId=requestFrame(()=>tick(token));frameAvailable=frameId!==undefined&&frameId!==null;}
  }catch{stop('failed');}
 }
 function visibility(){if(active&&doc.visibilityState==='hidden')stop('document-hidden');}
 function start(){
  if(disposed||active||doc.visibilityState==='hidden')return false;
  cleanup();safe(()=>releaseDownload?.());releaseDownload=null;
  frames=[];events=[];bytes=sequence=nav=nodeSerial=mutations=styleChecks=slowFrames=slowStyles=0;lastFrame=null;lastStyleKey='';anchor=startAt=endedAt=reason=null;frameAvailable=geometryAvailable=mutationAvailable=null;mode='phase-style-and-attributes';
  try{
   startAt=now();anchor=number(wall(),0,9007199254740991);if(!Number.isFinite(startAt)||anchor===null)throw new Error();
   ids=new WeakMap();geometry=new WeakMap();styles=new WeakMap();active=true;status='recording';const token=++epoch;
   geometryAvailable=typeof RO==='function';if(RO)resize=new RO(entries=>{if(!active||token!==epoch)return;try{for(const entry of entries){if(!targets.includes(entry.target))continue;const ref=append('event',{sequence:++sequence,t:time(),kind:'geometry',source:'resize-observer-content',node:nodeId(entry.target),width:number(entry.contentRect?.width),height:number(entry.contentRect?.height)});if(!active)return;if(ref!==null)geometry.set(entry.target,ref);}}catch{stop('failed');}});
   refresh();const shadow=getPanel()?.shadowRoot;if(!shadow)throw new Error();
   mutationAvailable=typeof MO==='function';if(MO){mutation=new MO(records=>{if(active&&token===epoch){dirty=true;mutations=Math.min(65535,mutations+records.length);}});mutation.observe(shadow,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','inert','class']});}
   doc.addEventListener('visibilitychange',visibility);timerId=setTimer(()=>{if(active&&token===epoch)stop('timeout');},caps.duration);
   append('event',{sequence:++sequence,t:time(),kind:'start',area,route});frameId=requestFrame(()=>tick(token));frameAvailable=frameId!==undefined&&frameId!==null;publish();return true;
  }catch{if(active)stop('failed');else{cleanup();status='stopped';reason='failed';publish();}return false;}
 }
 function snapshot(){
  return JSON.parse(JSON.stringify({schema:'lantai-ui-transition-v1',storage:'memory-only-cleared-on-refresh',status,stopReason:reason,startedUnixMs:anchor,startedPerformanceMs:number(startAt,0,9007199254740991),endedRelativeMs:endedAt,
   limits:{durationMs:caps.duration,frames:caps.frames,events:caps.events,bytes:caps.bytes},mode,
   nodeColumns:['role','id','present','connected','ownHidden','ownInert','treeHidden','treeInert','imageComplete','imageNaturalWidth','styleEvent','geometryEvent'],
   sampling:{frameCallbackAvailable:frameAvailable,geometryObserverAvailable:geometryAvailable,mutationObserverAvailable:mutationAvailable,targetFreshness:mutationAvailable===false?'host-phase-refresh-only-internal-replacements-may-be-stale':'host-phase-or-observed-mutation-refresh',costScope:'row-collection-and-serialization-excludes-observer-callbacks',frames:'attributes-no-style-or-rect',styles:'up-to-four-nodes-per-phase-checkpoint-max64',geometry:'asynchronous-content-size',missing:'null-is-unknown; references-point-to-timestamped-events',screenPixelsObserved:false},frames,events}));
 }
 function download(urlApi=doc.defaultView?.URL??globalThis.URL,BlobType=doc.defaultView?.Blob??globalThis.Blob){
  if(anchor===null)return false;
  return safe(()=>{
   if(active)stop('manual');safe(()=>releaseDownload?.());releaseDownload=null;
   const url=urlApi.createObjectURL(new BlobType([JSON.stringify(snapshot())],{type:'application/json'})),anchorNode=doc.createElement('a');
   releaseDownload=()=>urlApi.revokeObjectURL(url);
   try{anchorNode.href=url;anchorNode.download='lantai-ui-transition-diagnostic.json';anchorNode.hidden=true;doc.body.append(anchorNode);anchorNode.click();}finally{anchorNode.remove();}return true;
  })===true;
 }
 return Object.freeze({start,stop,stage,inspect,snapshot,download,subscribe(fn){subscribers.add(fn);return()=>subscribers.delete(fn);},dispose(){if(disposed)return;stop('dispose');cleanup();safe(()=>releaseDownload?.());releaseDownload=null;disposed=true;subscribers.clear();}});
}
