import {assessMainScroll} from './transition-sample-main-scroll.js';
import {createTransitionGridProbe} from './transition-grid-probe.js';
// Opt-in, bounded presentation evidence. No text, user values, arbitrary action,
// class/dataset values, identities, URLs, errors or event/DOM objects enter rows.
const AREAS=new Set(['memory','time','benmo','workshop','settings','none','unknown']);
const PHASES=new Set(['requested','shown','ready','held','reload']);
const REASONS=new Set(['manual','timeout','panel-close','chat-change','document-hidden','dispose','frame-cap','event-cap','byte-cap','cost-limit','failed','captured','capture-cap','unknown']);
const ROLES=['surface','header','title','close','icon','main','footer','decoration'];
const DISPLAY=new Set(['none','block','inline','inline-block','flex','inline-flex','grid','inline-grid','contents']);
const OVERFLOW=new Set(['visible','hidden','clip','scroll','auto','overlay']);
const VISIBILITY=new Set(['visible','hidden','collapse']);
const ROUTES={home:'root',manage:'root',list:'list',detail:'detail',edit:'editor',settings:'settings','narrative-edit':'editor','narrative-settings':'settings','narrative-generate':'generate',schedules:'list',anniversaries:'list',holidays:'list','edit/schedule':'editor','edit/anniversary':'editor','edit/holiday':'editor',calendar:'settings',calibrate:'editor'};
const safe=fn=>{try{return fn();}catch{return undefined;}};
const number=(n,min=0,max=32768)=>typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max?Math.round(n*10)/10:null;
let sessionSerial=0;
function newSessionId(){
 const bytes=new Uint8Array(4);
 if(globalThis.crypto?.getRandomValues)globalThis.crypto.getRandomValues(bytes);else for(let i=0;i<bytes.length;i++)bytes[i]=Math.floor(Math.random()*256);
 return 'S'+[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('')+'-'+(++sessionSerial).toString(36);
}
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
 getStyle=node=>doc.defaultView?.getComputedStyle?.(node),limits={},sampleMode=false,sampleContent='original',sampleWarmMode='normal',sampleObserverMode='normal',sampleMainScrollMode='normal',gridEnabled=false}={}){
 const contentCondition=sampleMode?(sampleContent==='simplified'?'simplified':'original'):null;
 const warmCondition=contentCondition==='simplified'&&['skip-warm-revalidation','visibility-only'].includes(sampleWarmMode)?sampleWarmMode:'normal';
 const observerCondition=sampleMode&&warmCondition==='visibility-only'?(sampleObserverMode==='owned-hidden-filter'?'owned-hidden-filter':'normal'):null;
 const mainScrollCondition=observerCondition==='owned-hidden-filter'?(['clip','inner'].includes(sampleMainScrollMode)?sampleMainScrollMode:'normal'):null;
 const freshMainScroll=()=>({workshop:{status:'pending',reason:null,nav:null},benmo:{status:'pending',reason:null,nav:null}});
 let mainScrollPages=freshMainScroll(),innerScrollPages=freshMainScroll();
 let innerScrollNodes=new Map();
 const innerScrollProof=()=>({status:mainScrollCondition!=='inner'?'inactive':Object.values(innerScrollPages).some(p=>p.status==='invalid')?'invalid':Object.values(innerScrollPages).every(p=>['ready','scrolled'].includes(p.status))?(Object.values(innerScrollPages).some(p=>p.status==='scrolled')?'scrolled':'ready'):'pending',pages:clone(innerScrollPages)});
 const mainScrollProof=()=>({status:!['clip','inner'].includes(mainScrollCondition)?'inactive':Object.values(mainScrollPages).some(p=>p.status==='invalid')?'invalid':Object.values(mainScrollPages).every(p=>p.status==='applied')?'applied':'pending',pages:clone(mainScrollPages)});
 const freshObserverCounts=()=>({skippedBatches:0,skippedRecords:0,deliveredBatches:0,deliveredRecords:0});
 let observerCounts=freshObserverCounts();
 const gridActive=sampleMode&&gridEnabled===true;
 const caps={duration:limit(limits.duration,30000),frames:limit(limits.frames,2000),events:limit(limits.events,256),bytes:Math.max(sampleMode?32768:4096,limit(limits.bytes,1048576))};
 let active=false,disposed=false,epoch=0,status='idle',reason=null,mode='phase-style-and-attributes',anchor=null,startAt=null,endedAt=null;
 let frames=[],events=[],bytes=0,sequence=0,nav=0,frameId=null,timerId=null,mutation=null,resize=null,targets=[],ids=null,geometry=null,styles=null,nodeSerial=0;
 let dirty=true,known=false,area='none',route='unknown',lastFrame=null,mutations=0,slowFrames=0,slowStyles=0,lastStyleKey='',releaseDownload=null,frameAvailable=null,geometryAvailable=null,mutationAvailable=null;
 let sessionId=null,startAnchor=null,navigationHistory=[];
 let observations=[],archiveBytes=0,lastMarkedNav=0,evicted=null,styleTimes=[];
 const archiveCaps={bytes:Math.max(4096,limit(limits.captureBytes,8388608)),observations:limit(limits.observations,32)};
 let clipCondition=null,clipStyle=null,clipContent=null,previousClip=null;
 let sizeCondition=null,conditionEpoch=0,conditionStyle=null,conditionContent=null,previousCondition=null,layoutFrame=null,layoutTimes=[];
 const pending=new Map();
 const clone=value=>JSON.parse(JSON.stringify(value));
 const archiveSize=value=>JSON.stringify(value).length*2+64;
 const rowSizes=new WeakMap(),eventIndex=new Map(),references=new Map();
 const subscribers=new Set(),timelineSubscribers=new Set(),gridSubscribers=new Set(),observerSubscribers=new Set(),mainScrollSubscribers=new Set(),innerScrollSubscribers=new Set();
 let savedGrid=null,gridMode='original',gridInvalid=false,gridVerified=false;
 const gridProbe=createTransitionGridProbe({getStyle,onChange(detail){const state=gridProbe.inspect();gridMode=state.mode;gridInvalid=state.invalid;gridVerified=state.mode==='fixed'&&!state.invalid&&state.pending.length===0;if(!active)return;append('event',{sequence:++sequence,t:time(),kind:'grid-probe',nav,detail});for(const listener of gridSubscribers)safe(()=>listener(inspect()));}});
 const inspectGrid=()=>!active&&savedGrid?savedGrid:gridProbe.inspect();
 const inspect=()=>({innerScrollVerification:innerScrollProof(),sampleMainScrollMode:mainScrollCondition,mainScrollVerification:mainScrollProof(),mainScrollStatus:mainScrollProof().status,sampleObserverMode:observerCondition,observerDelivery:observerCondition===null?null:{...observerCounts},sessionId,startAnchor:startAnchor?{...startAnchor}:null,navigationHistory:clone(navigationHistory),status,reason,mode,hasData:anchor!==null,capturePending:pending.size>0,captured:observations.some(item=>item.complete),observationCount:observations.length,pendingCount:pending.size,clipCondition,sizeCondition,conditionEpoch,gridCondition:inspectGrid().mode,gridReady:inspectGrid().ready,gridInvalid:inspectGrid().invalid,gridPending:[...inspectGrid().pending]});
 const publishMainScroll=()=>{for(const listener of mainScrollSubscribers)safe(()=>listener(inspect()));};
 function confirmInnerScroll(row,node,sameSurface){
  if(mainScrollCondition!=='inner'||!Object.hasOwn(innerScrollPages,area))return null;
  const old=innerScrollPages[area],previous=innerScrollNodes.get(area);
  let status='pending',reason='unknown-geometry';
  if(!sameSurface)reason='surface-changed';
  else if(row.overflow?.x&&row.overflow?.y&&row.rect&&[row.rect.width,row.rect.height,row.clientHeight,row.clientWidth,row.scrollHeight,row.scrollWidth,row.scrollTop].every(Number.isFinite)){
   if(row.overflow.x!=='auto'||row.overflow.y!=='auto'){status='invalid';reason='overflow-not-auto';}
   else if(row.rect.width<=0||row.rect.height<=0||row.clientHeight<=0||row.clientWidth<=0||row.scrollHeight<=row.clientHeight){status='invalid';reason='no-scroll-range';}
   else{status='ready';reason=null;if(previous?.node===node&&Number.isFinite(previous.top)&&Number.isFinite(row.scrollTop)&&Math.abs(previous.top-row.scrollTop)>1e-7||previous?.scrolled&&previous?.node===node)status='scrolled';}
  }
  innerScrollPages[area]={status,reason,nav,scrollTop:row.scrollTop};if(sameSurface)innerScrollNodes.set(area,{node,top:row.scrollTop,scrolled:status==='scrolled'});
  for(const listener of innerScrollSubscribers)safe(()=>listener(inspect()));return innerScrollProof();
 }
 function confirmMainScroll(layout,sameSurface){
  if(!['clip','inner'].includes(mainScrollCondition)||!Object.hasOwn(mainScrollPages,area))return null;
  if(mainScrollPages[area].status!=='invalid')mainScrollPages[area]={...(sameSurface?assessMainScroll(layout):{status:'pending',reason:'surface-changed'}),nav};
  publishMainScroll();return mainScrollProof();
 }
 const publishTimeline=()=>{for(const listener of timelineSubscribers)safe(()=>listener(inspect()));};
 const publish=()=>{for(const listener of subscribers)safe(()=>listener(inspect()));};
 const time=()=>number(now()-startAt,0,Number.MAX_SAFE_INTEGER);
 function resetClipCondition(){
  safe(()=>clipStyle?.remove());clipStyle=null;
  if(clipContent)safe(()=>{if(previousClip===null)clipContent.removeAttribute('data-lt-clip-probe');else clipContent.setAttribute('data-lt-clip-probe',previousClip);});
  clipContent=null;previousClip=null;clipCondition=null;
 }
 function resetSizeCondition(){
  resetClipCondition();
  if(layoutFrame!==null)safe(()=>cancelFrame(layoutFrame));layoutFrame=null;
  safe(()=>conditionStyle?.remove());conditionStyle=null;
  if(conditionContent)safe(()=>{if(previousCondition===null)conditionContent.removeAttribute('data-lt-size-probe');else conditionContent.setAttribute('data-lt-size-probe',previousCondition);});
  conditionContent=null;previousCondition=null;sizeCondition=null;
 }
 function cleanup(){
  innerScrollNodes.clear();
  if(gridProbe.inspect().pages.length||gridProbe.inspect().invalid)savedGrid=gridProbe.inspect();gridProbe.reset();
  resetSizeCondition();
  if(frameId!==null)safe(()=>cancelFrame(frameId));if(timerId!==null)safe(()=>clearTimer(timerId));frameId=timerId=null;
  for(const timer of pending.values())safe(()=>clearTimer(timer));pending.clear();
  safe(()=>mutation?.disconnect());safe(()=>resize?.disconnect());mutation=resize=null;
  safe(()=>doc.removeEventListener('visibilitychange',visibility));targets=[];ids=geometry=styles=null;dirty=true;
 }
 function stop(value='manual'){
  if(!active)return false;
  value=REASONS.has(value)?value:'unknown';
  endedAt=safe(time)??null;for(const item of observations)if(item.finishedRelativeMs===null){item.finishedRelativeMs=endedAt;item.complete=value!=='capture-cap'&&endedAt!==null&&endedAt>=item.markedRelativeMs+2000;item.stopReason=value;}active=false;epoch++;reason=REASONS.has(value)?value:'unknown';status='stopped';cleanup();publish();return true;
 }
 // Capacity applies to the retained window, not to the session lifetime.
 // An expired referenced sample becomes explicitly unknown, never a dangling ID.
 function countReferences(row,delta){
  for(const node of row.nodes??[])if(node.length===12)for(const column of [10,11])if(node[column]!==null){const ref=node[column],count=(references.get(ref)??0)+delta;if(count>0)references.set(ref,count);else references.delete(ref);}
 }
 function drop(kind,index,cause){
  const list=kind==='frame'?frames:events,row=list.splice(index,1)[0];
  bytes-=rowSizes.get(row)??0;countReferences(row,-1);evicted[cause][kind]++;
  if(kind==='event'){
   eventIndex.delete(row.sequence);
   if(row.kind==='style'||row.kind==='geometry'){
    for(const retained of [...frames,...events])for(const node of retained.nodes??[]){
     if(node.length!==12)continue;
     for(const column of [10,11])if(node[column]===row.sequence){node[column]=null;evicted.referencesExpired++;}
    }
   }
   references.delete(row.sequence);
  }
 }
 function trim(t){
  const cutoff=Math.max(0,t-caps.duration);
  while(frames.length&&frames[0].t<cutoff)drop('frame',0,'age');
  // Keep older style/size samples when retained rows still refer to them.
  for(let i=events.length-1;i>=0;i--)if(events[i].t<cutoff&&!['style','geometry'].includes(events[i].kind))drop('event',i,'age');
  for(let i=events.length-1;i>=0;i--)if(events[i].t<cutoff&&!references.has(events[i].sequence))drop('event',i,'age');
  while(frames.length>caps.frames)drop('frame',0,'capacity');
  while(events.length>caps.events)drop('event',0,'capacity');
  while(bytes>caps.bytes-(sampleMode?16384:3072)&&(frames.length||events.length)){
   if(!events.length||(frames.length&&frames[0].sequence<events[0].sequence))drop('frame',0,'capacity');else drop('event',0,'capacity');
  }
 }
 function append(kind,row){
  if(!active)return null;
  row.conditionEpoch=conditionEpoch;row.shrinkCssPx=sizeCondition;row.clipMode=clipCondition;row.sampleContent=contentCondition;row.sampleWarmMode=sampleMode?warmCondition:null;row.sampleObserverMode=observerCondition;row.sampleMainScrollMode=mainScrollCondition;row.gridMode=gridActive?gridMode:null;row.gridInvalid=gridActive?gridInvalid:null;row.gridVerified=gridActive?gridVerified:null;
  const list=kind==='frame'?frames:events;
  const size=JSON.stringify(row).length+32;
  list.push(row);rowSizes.set(row,size);bytes+=size;countReferences(row,1);
  if(kind==='event')eventIndex.set(row.sequence,row);
  archiveRow(kind,row);
  trim(row.t);
  return kind==='event'&&eventIndex.has(row.sequence)?row.sequence:null;
 }
 // Each observation owns an immutable pre-window and independently collects its
 // post-window. Rolling eviction therefore cannot erase a labeled observation.
 function archiveRow(kind,row){
  const recipients=observations.filter(item=>item.finishedRelativeMs===null&&row.t<=item.markedRelativeMs+2000);
  if(!recipients.length)return;
  const size=archiveSize(row);
  if(archiveBytes+size*recipients.length>archiveCaps.bytes){stop('capture-cap');return;}
  for(const item of recipients)item[kind==='frame'?'frames':'events'].push(clone(row));
  archiveBytes+=size*recipients.length;
 }
 function finalizeCost(kind,row){
  for(const item of observations){const saved=item[kind==='frame'?'frames':'events'].at(-1);if(saved?.sequence===row.sequence)saved.cost=row.cost;}
 }
 function mark(label='flicker'){
  if(!active||!['flicker','no-flicker'].includes(label))return false;
  try{
   const t=time();if(t===null)return false;trim(t);refresh();
   // The interval is evidence, not a claim that the last transition caused it.
   const candidates=events.filter(row=>row.kind==='phase'&&row.phase==='requested'&&row.nav>lastMarkedNav);
   const expectedCount=nav-lastMarkedNav;
   const association=expectedCount===1&&candidates.length===1?'single-observed-transition':expectedCount>1?'multiple-transitions':'unknown';
   const item={sessionId,conditionAtMark:{epoch:conditionEpoch,shrinkCssPx:sizeCondition,clipMode:clipCondition,sampleContent:contentCondition,sampleWarmMode:sampleMode?warmCondition:null,sampleObserverMode:observerCondition,sampleMainScrollMode:mainScrollCondition,gridMode:gridActive?gridProbe.inspect().mode:null,gridInvalid:gridActive?gridInvalid:null,gridVerified:gridActive?gridVerified:null},ordinal:observations.length+1,label,markedRelativeMs:t,requestedBeforeMs:caps.duration,requestedAfterMs:2000,finishedRelativeMs:null,complete:false,stopReason:null,
    transition:{association,fromNavExclusive:lastMarkedNav,toNavInclusive:nav,expectedCount,candidates:candidates.map(row=>({nav:row.nav,t:row.t,target:row.target})),missingRequests:Math.max(0,expectedCount-candidates.length)},
    coverage:{earliestFrameRelativeMs:frames[0]?.t??null,latestPreFrameRelativeMs:frames.at(-1)?.t??null,evicted:clone(evicted)},frames:clone(frames),events:clone(events)};
   const size=archiveSize(item);
   if(observations.length>=archiveCaps.observations||archiveBytes+size>archiveCaps.bytes){stop('capture-cap');return false;}
   observations.push(item);archiveBytes+=size;lastMarkedNav=nav;
   append('event',{sequence:++sequence,t,kind:'user-mark',ordinal:item.ordinal,label,area,route,nav});
   if(!active)return true;
   const token=epoch;
   const timer=setTimer(()=>{
    if(!active||token!==epoch||item.finishedRelativeMs!==null)return;
    item.finishedRelativeMs=time();item.complete=item.finishedRelativeMs>=item.markedRelativeMs+2000;
    safe(()=>clearTimer(pending.get(item.ordinal)));pending.delete(item.ordinal);publish();
   },2000);
   pending.set(item.ordinal,timer);publish();return true;
  }catch{stop('failed');return false;}
 }
 // Deliberately event-driven: two rAF turns after a condition or phase change.
 // No layout reads enter the ordinary per-frame attribute sampler.
 const precise=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e7?value:null;
 function layoutNode(role,node){
  const bounds=node?safe(()=>node.getBoundingClientRect?.()):null;
  const css=node&&['surface','main','inner','decoration','page'].includes(role)?safe(()=>getStyle(node)):null;
  const overflow=css?{x:OVERFLOW.has(css.overflowX)?css.overflowX:null,y:OVERFLOW.has(css.overflowY)?css.overflowY:null}:null;
  return {role,overflow,rect:bounds?Object.fromEntries(['x','y','top','right','bottom','left','width','height'].map(key=>[key,precise(bounds[key])])):null,
   clientWidth:precise(node?.clientWidth),clientHeight:precise(node?.clientHeight),scrollWidth:precise(node?.scrollWidth),scrollHeight:precise(node?.scrollHeight),scrollTop:precise(node?.scrollTop)};
 }
 function scheduleLayout(ready=false,verifyGrid=false){
  if(!active||sizeCondition===null&&sampleMode!==true)return;
  if(layoutFrame!==null)safe(()=>cancelFrame(layoutFrame));
  const token=epoch,condition=conditionEpoch,scheduledNav=nav,scheduledSurface=targets[0];
  layoutFrame=requestFrame(()=>{
   if(!active||token!==epoch||condition!==conditionEpoch||nav!==scheduledNav)return;
   layoutFrame=requestFrame(()=>{
    if(!active||token!==epoch||condition!==conditionEpoch||nav!==scheduledNav)return;layoutFrame=null;
    try{
     const t=time();layoutTimes=layoutTimes.filter(value=>value>=t-caps.duration);if(layoutTimes.length>=64)return;layoutTimes.push(t);
     refresh();const panel=getPanel(),content=panel?.shadowRoot?.querySelector('#lt-host-content'),win=doc.defaultView,viewport=win?.visualViewport;
     const layout=[layoutNode('host',panel),layoutNode('content',content),layoutNode('surface',targets[0]),layoutNode('header',targets[1]),layoutNode('main',targets[5]),layoutNode('footer',targets[6]),layoutNode('decoration',targets[7]),layoutNode('page',targets[0]?.parentNode)];
     const innerNode=mainScrollCondition==='inner'?targets[5]?.querySelector('[data-transition-simple-main]'):null;
     const innerLayout=mainScrollCondition==='inner'?layoutNode('inner',innerNode):null;if(innerLayout)layout.push(innerLayout);
     const innerScrollVerification=innerLayout?confirmInnerScroll(innerLayout,innerNode,targets[0]===scheduledSurface):null;
     const viewportData={innerWidth:precise(win?.innerWidth),innerHeight:precise(win?.innerHeight),devicePixelRatio:precise(win?.devicePixelRatio),width:precise(viewport?.width),height:precise(viewport?.height),offsetLeft:precise(viewport?.offsetLeft),offsetTop:precise(viewport?.offsetTop),scale:precise(viewport?.scale)};
     if(gridActive&&targets[0]===scheduledSurface&&(ready||verifyGrid))gridProbe.observe(area,targets[0],layout,{ready,viewport:viewportData});
     const mainScrollVerification=confirmMainScroll(layout,targets[0]===scheduledSurface);
     const expected=clipCondition==='visible'?'visible':null,observed=layout[2].overflow;
     append('event',{sequence:++sequence,t,kind:'layout',nav,shrinkCssPx:sizeCondition,settling:'two-animation-frames-not-paint-proof',
      viewport:viewportData,mainScrollVerification,innerScrollVerification,
      clipVerification:{rule:clipCondition==='visible'?'force-visible':clipCondition==='original'?'no-override':'inactive',expectedSurfaceOverflow:expected,surfaceMatches:expected&&observed?.x&&observed?.y?observed.x===expected&&observed.y===expected:null},layout});
    }catch{stop('failed');}
   });
  });
 }
 function setGridCondition(value){
  if(!active||!gridActive||!['original','fixed'].includes(value))return false;
  if(value===gridProbe.inspect().mode)return true;
  if(value==='fixed'&&(!gridProbe.inspect().ready||gridProbe.inspect().invalid))return false;
  conditionEpoch++;const changed=gridProbe.setMode(value);
  if(changed.mode!==value)return false;
  append('event',{sequence:++sequence,t:time(),kind:'grid-condition',nav});scheduleLayout(false,true);return true;
 }
 function setSizeCondition(value){
  if(!active||!(value===0||value===1))return false;
  if(value===sizeCondition&&clipCondition===null)return true;
  resetClipCondition();
  try{
   if(!conditionStyle){
    const shadow=getPanel()?.shadowRoot,content=shadow?.querySelector('#lt-host-content');if(!content)return false;
    conditionContent=content;previousCondition=content.getAttribute('data-lt-size-probe');
    conditionStyle=doc.createElement('style');
    conditionStyle.textContent='#lt-host-content[data-lt-size-probe="0"] { align-self:start; height:calc(100% - 0px); } #lt-host-content[data-lt-size-probe="1"] { align-self:start; height:calc(100% - 1px); }';
    shadow.append(conditionStyle);
   }
   sizeCondition=value;conditionEpoch++;conditionContent.setAttribute('data-lt-size-probe',String(value));
   append('event',{sequence:++sequence,t:time(),kind:'size-condition',shrinkCssPx:value,nav});
   scheduleLayout();publish();return true;
  }catch{stop('failed');return false;}
 }
 function setClipCondition(value){
  if(!active||!['original','visible'].includes(value))return false;
  if(value===clipCondition&&sizeCondition===0)return true;
  try{
   if(sizeCondition!==0&&!setSizeCondition(0))return false;
   if(!active)return false;
   if(!clipStyle){
    const shadow=getPanel()?.shadowRoot,content=shadow?.querySelector('#lt-host-content');if(!content)return false;
    clipContent=content;previousClip=content.getAttribute('data-lt-clip-probe');clipStyle=doc.createElement('style');
    clipStyle.textContent=['', ' > .time-mount', ' > .wk-mount', ' > .benmo-mount'].map(mount=>`#lt-host-content[data-lt-clip-probe="visible"] > .lt-host-page${mount} > .lantai`).join(', ')+' { overflow:visible !important; }';
    shadow.append(clipStyle);
   }
   clipCondition=value;conditionEpoch++;clipContent.setAttribute('data-lt-clip-probe',value);
   append('event',{sequence:++sequence,t:time(),kind:'clip-condition',nav});scheduleLayout();publish();return true;
  }catch{stop('failed');return false;}
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
   index===4&&typeof node.complete==='boolean'?node.complete:null,index===4?number(node.naturalWidth):null,eventIndex.has(styles.get(node))?styles.get(node):null,eventIndex.has(geometry.get(node))?geometry.get(node):null];
 }
 function sampleNodes(){return ROLES.map((_,i)=>state(targets[i],i));}
 function downgrade(){if(mode==='attributes-only')return;mode='attributes-only';publish();}
 function sampleStyle(){
  const key=`${nav}:${nodeId(targets[0])}`;
  styleTimes=styleTimes.filter(t=>t>=time()-caps.duration);
  if(mode==='attributes-only'||key===lastStyleKey||styleTimes.length>=64)return;
  lastStyleKey=key;styleTimes.push(time());
  const started=now(),samples=[];
  for(const index of [0,1,5,6]){
   const node=targets[index],css=node?safe(()=>getStyle(node)):null;
   const display=css?DISPLAY.has(css.display)?css.display:'other':null,visibility=css?VISIBILITY.has(css.visibility)?css.visibility:'other':null;
   const opacity=css?number(Number(css.opacity),0,1):null;
   samples.push([ROLES[index],nodeId(node),display,visibility,opacity]);
  }
  const row={sequence:++sequence,t:time(),kind:'style',nav,mode:'bounded-phase-style',cost:null,nodes:samples};
  const ref=append('event',row);const cost=row.cost=number(now()-started,0,120000);finalizeCost('event',row);
  if(!active)return;if(ref!==null)for(const index of [0,1,5,6])if(targets[index])styles.set(targets[index],ref);
  slowStyles=cost!==null&&cost>6?slowStyles+1:0;if(slowStyles>=3)downgrade();
 }
 function observerBatch(outcome,count){
  if(!active||observerCondition===null||!['skipped','delivered'].includes(outcome)||!Number.isSafeInteger(count)||count<1)return false;
  observerCounts[outcome+'Batches']++;observerCounts[outcome+'Records']+=count;
  append('event',{sequence:++sequence,t:time(),kind:'appearance-observer',nav,outcome,records:count});for(const listener of observerSubscribers)safe(()=>listener(inspect()));return true;
 }
 function stage(phase,target='unknown'){
  if(!active||!PHASES.has(phase))return false;
  try{
   refresh();if(phase==='requested'){nav++;if(mainScrollCondition==='inner'&&Object.hasOwn(innerScrollPages,target)){innerScrollPages[target]={status:'pending',reason:null,nav};for(const listener of innerScrollSubscribers)safe(()=>listener(inspect()));}if(['clip','inner'].includes(mainScrollCondition)&&Object.hasOwn(mainScrollPages,target)&&mainScrollPages[target].status!=='invalid'){mainScrollPages[target]={status:'pending',reason:null,nav};publishMainScroll();}}
   const event={sequence:++sequence,t:time(),kind:'phase',nav,phase,target:AREAS.has(target)?target:'unknown',area,route,nodes:sampleNodes()};
   append('event',event);
   let entry=navigationHistory.find(item=>item.nav===nav);
   if(!entry){entry={nav,stages:[],omittedStages:0};navigationHistory.push(entry);if(navigationHistory.length>2)navigationHistory.shift();}
   entry.stages.push({phase,sequence:event.sequence,t:event.t});if(entry.stages.length>8){entry.stages.shift();entry.omittedStages++;}
   if(active&&(phase==='shown'||phase==='ready'||phase==='held')){sampleStyle();scheduleLayout(phase==='ready');}publishTimeline();return active;
  }catch{stop('failed');return false;}
 }
 function tick(token){
  frameId=null;if(!active||token!==epoch)return;
  try{
   const started=now(),t=time();if(t===null){stop('failed');return;}
   if(dirty)refresh();const nodes=sampleNodes();
   const row={sequence:++sequence,t,nav,area,route,mode:'attributes',dt:lastFrame===null?null:number(t-lastFrame,0,Number.MAX_SAFE_INTEGER),cost:null,mutations:number(mutations,0,65535),nodes};
   append('frame',row);const cost=row.cost=number(now()-started,0,120000);finalizeCost('frame',row);
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
  cleanup();savedGrid=null;safe(()=>releaseDownload?.());releaseDownload=null;
  observerCounts=freshObserverCounts();mainScrollPages=freshMainScroll();innerScrollPages=freshMainScroll();innerScrollNodes=new Map();frames=[];events=[];eventIndex.clear();references.clear();observations=[];archiveBytes=0;lastMarkedNav=0;sessionId=null;startAnchor=null;navigationHistory=[];conditionEpoch=0;layoutTimes=[];evicted={age:{frame:0,event:0},capacity:{frame:0,event:0},referencesExpired:0};styleTimes=[];bytes=sequence=nav=nodeSerial=mutations=slowFrames=slowStyles=0;lastFrame=null;lastStyleKey='';anchor=startAt=endedAt=reason=null;frameAvailable=geometryAvailable=mutationAvailable=null;mode='phase-style-and-attributes';
  try{
   startAt=now();anchor=number(wall(),0,9007199254740991);if(!Number.isFinite(startAt)||anchor===null)throw new Error();
   sessionId=newSessionId();
   ids=new WeakMap();geometry=new WeakMap();styles=new WeakMap();active=true;status='recording';const token=++epoch;
   geometryAvailable=typeof RO==='function';if(RO)resize=new RO(entries=>{if(!active||token!==epoch)return;try{for(const entry of entries){if(!targets.includes(entry.target))continue;const ref=append('event',{sequence:++sequence,t:time(),kind:'geometry',source:'resize-observer-content',node:nodeId(entry.target),width:number(entry.contentRect?.width),height:number(entry.contentRect?.height)});if(!active)return;if(ref!==null)geometry.set(entry.target,ref);}}catch{stop('failed');}});
   refresh();const shadow=getPanel()?.shadowRoot;if(!shadow)throw new Error();
   mutationAvailable=typeof MO==='function';if(MO){mutation=new MO(records=>{if(active&&token===epoch){dirty=true;mutations=Math.min(65535,mutations+records.length);}});mutation.observe(shadow.querySelector('#lt-host-content')??shadow,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','inert','class']});}
   doc.addEventListener('visibilitychange',visibility);
   const startEvent={sequence:++sequence,t:time(),kind:'start',area,route};startAnchor={sequence:startEvent.sequence,t:startEvent.t};append('event',startEvent);frameId=requestFrame(()=>tick(token));frameAvailable=frameId!==undefined&&frameId!==null;publish();return true;
  }catch{if(active)stop('failed');else{cleanup();status='stopped';reason='failed';publish();}return false;}
 }
 function snapshot(){
  if(active)trim(time());
  const rows=[...frames,...events.filter(row=>row.kind!=='style'&&row.kind!=='geometry')];
  const earliest=rows.length?Math.min(...rows.map(row=>row.t)):null;
  return JSON.parse(JSON.stringify({schema:'lantai-ui-transition-v14',innerScrollVerification:innerScrollProof(),sampleMainScrollMode:mainScrollCondition,mainScrollVerification:mainScrollProof(),sampleContent:contentCondition,sampleWarmMode:sampleMode?warmCondition:null,sampleObserverMode:observerCondition,observerDelivery:observerCondition===null?null:{...observerCounts},gridExperiment:gridActive?(active?gridProbe.inspect():savedGrid):null,sample:sampleMode===true?'fixed-switch-v1':null,videoAlignment:{sessionId,startAnchor,navigationHistory,meaning:'event-times-not-paint-times; same-frame-stages-not-visually-separable',maxNavigations:2,maxStagesPerNavigation:8},storage:'memory-only-cleared-on-refresh',status,stopReason:reason,startedUnixMs:anchor,startedPerformanceMs:number(startAt,0,9007199254740991),endedRelativeMs:endedAt,
   limits:{windowMs:caps.duration,frames:caps.frames,events:caps.events,bytes:caps.bytes,captureBytes:archiveCaps.bytes,observations:archiveCaps.observations},mode,observations,sizeExperiment:{target:'lt-host-content',anchor:'top',allowedShrinkCssPx:[0,1],currentShrinkCssPx:sizeCondition,conditionEpoch},clipExperiment:{target:'direct-business-surface-only',currentMode:clipCondition,shrinkCssPx:0},
   captureStorage:{estimatedBytes:archiveBytes,policy:'immutable-labeled-windows-stop-on-capacity',order:'observation-ordinal; rows-by-sequence',postWindowMs:2000},
   retention:{earliestRelativeMs:earliest,latestFrameRelativeMs:frames.at(-1)?.t??null,evicted,policy:'rolling-window-with-capacity-eviction; older-referenced-events-may-be-retained'},
   nodeColumns:['role','id','present','connected','ownHidden','ownInert','treeHidden','treeInert','imageComplete','imageNaturalWidth','styleEvent','geometryEvent'],
   sampling:{frameCallbackAvailable:frameAvailable,geometryObserverAvailable:geometryAvailable,mutationObserverAvailable:mutationAvailable,targetFreshness:mutationAvailable===false?'host-phase-refresh-only-internal-replacements-may-be-stale':'host-phase-or-observed-mutation-refresh',costScope:'row-collection-and-serialization-excludes-observer-callbacks',frames:'attributes-no-style-or-rect',styles:'up-to-four-nodes-per-phase-checkpoint-max64-per-window',geometry:'asynchronous-content-size',missing:'null-is-unknown; references-point-to-retained-timestamped-events; capacity-expired-references-are-cleared-and-counted',layout:'sample-or-size-experiment-two-raf-after-change-or-shown-ready-max64-per-window-unrounded-numbers',screenPixelsObserved:false},frames,events}));
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
 return Object.freeze({start,stop,mark,setGridCondition,setSizeCondition,setClipCondition,stage,observerBatch,inspect,snapshot,download,subscribeInnerScroll(fn){innerScrollSubscribers.add(fn);return()=>innerScrollSubscribers.delete(fn);},subscribeMainScroll(fn){mainScrollSubscribers.add(fn);return()=>mainScrollSubscribers.delete(fn);},subscribeObserver(fn){observerSubscribers.add(fn);return()=>observerSubscribers.delete(fn);},subscribeGrid(fn){gridSubscribers.add(fn);return()=>gridSubscribers.delete(fn);},subscribeTimeline(fn){timelineSubscribers.add(fn);return()=>timelineSubscribers.delete(fn);},subscribe(fn){subscribers.add(fn);return()=>subscribers.delete(fn);},dispose(){if(disposed)return;stop('dispose');cleanup();safe(()=>releaseDownload?.());releaseDownload=null;disposed=true;subscribers.clear();timelineSubscribers.clear();gridSubscribers.clear();observerSubscribers.clear();mainScrollSubscribers.clear();innerScrollSubscribers.clear();innerScrollNodes.clear();}});
}
