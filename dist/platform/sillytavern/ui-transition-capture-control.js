// A host-owned control: navigation never rebuilds it or opens another page.
export function mountUITransitionCaptureControl(shadow,{diagnostic,start=()=>diagnostic.start(),onSample=null,onSimpleSample=null,onHeldSample=null,onVisibilitySample=null,onFilteredSample=null,onNoScrollSample=null,onInnerScrollSample=null,onNormalInnerSample=null,onUnfilteredInnerSample=null,onUnfilteredNoScrollSample=null,onNormalNoScrollSample=null,onOriginalNoScrollSample=null,onHiddenMainSample=null,sampleMode=false,sampleContent='original',sampleWarmMode='normal',sampleObserverMode='normal',sampleMainScrollMode='normal',gridEnabled=false}={}){
 const doc=shadow.ownerDocument,bar=doc.createElement('div');
 bar.setAttribute('data-interface-capture','');bar.setAttribute('role','group');bar.setAttribute('aria-label','界面诊断');
 const mark=doc.createElement('button'),clear=doc.createElement('button'),download=doc.createElement('button'),baseline=doc.createElement('button'),unclip=doc.createElement('button'),sample=doc.createElement('button'),simpleSample=doc.createElement('button'),heldSample=doc.createElement('button'),visibilitySample=doc.createElement('button'),filteredSample=doc.createElement('button'),noScrollSample=doc.createElement('button'),innerScrollSample=doc.createElement('button'),normalInnerSample=doc.createElement('button'),unfilteredInnerSample=doc.createElement('button'),unfilteredNoScrollSample=doc.createElement('button'),normalNoScrollSample=doc.createElement('button'),originalNoScrollSample=doc.createElement('button'),hiddenMainSample=doc.createElement('button'),gridOriginal=doc.createElement('button'),gridFixed=doc.createElement('button');
 for(const button of [mark,clear,download,baseline,unclip,sample,simpleSample,heldSample,visibilitySample,filteredSample,noScrollSample,innerScrollSample,normalInnerSample,unfilteredInnerSample,unfilteredNoScrollSample,normalNoScrollSample,originalNoScrollSample,hiddenMainSample,gridOriginal,gridFixed]){button.type='button';button.className='ui-button ui-button--secondary';}
 mark.setAttribute('data-interface-capture-mark','');clear.setAttribute('data-interface-capture-clear','');download.setAttribute('data-interface-capture-export','');
 baseline.setAttribute('data-interface-capture-clip-original','');unclip.setAttribute('data-interface-capture-clip-visible','');
 sample.setAttribute('data-interface-capture-sample','');sample.textContent='原正文样本';simpleSample.setAttribute('data-interface-capture-simple-sample','');simpleSample.textContent='简化正文样本';heldSample.setAttribute('data-interface-capture-held-sample','');heldSample.textContent='简化正文（跳过复核）';visibilitySample.setAttribute('data-interface-capture-visibility-sample','');visibilitySample.textContent='简化正文（仅显隐）';filteredSample.setAttribute('data-interface-capture-filtered-sample','');filteredSample.textContent='仅显隐（过滤重复通知）';noScrollSample.setAttribute('data-interface-capture-no-scroll-sample','');noScrollSample.textContent='仅显隐（正文不滚动）';innerScrollSample.setAttribute('data-interface-capture-inner-scroll-sample','');innerScrollSample.textContent='仅显隐（内部滚动）';normalInnerSample.setAttribute('data-interface-capture-normal-inner-sample','');normalInnerSample.textContent='正常切区（内部滚动）';unfilteredInnerSample.setAttribute('data-interface-capture-unfiltered-inner-sample','');unfilteredInnerSample.textContent='内部滚动（不过滤通知）';unfilteredNoScrollSample.setAttribute('data-interface-capture-unfiltered-no-scroll-sample','');unfilteredNoScrollSample.textContent='正文不滚动（不过滤通知）';normalNoScrollSample.setAttribute('data-interface-capture-normal-no-scroll-sample','');normalNoScrollSample.textContent='正常切区（正文不滚动）';originalNoScrollSample.setAttribute('data-interface-capture-original-no-scroll-sample','');originalNoScrollSample.textContent='原正文（正常切区，不滚动）';hiddenMainSample.setAttribute('data-interface-capture-hidden-main-sample','');hiddenMainSample.textContent='原正文（hidden 对照）';
 gridOriginal.setAttribute('data-interface-capture-grid-original','');gridFixed.setAttribute('data-interface-capture-grid-fixed','');
 const gridStatus=doc.createElement('p');gridStatus.className='ui-field__support';gridStatus.setAttribute('data-interface-capture-grid-status','');
 baseline.textContent='原裁剪（0 px）';unclip.textContent='取消外层裁剪（0 px）';
 const timeline=doc.createElement('p');timeline.className='ui-field__support';timeline.setAttribute('data-interface-capture-timeline','');
 const readout=doc.createElement('div');readout.setAttribute('data-interface-capture-readout','');
 const observerStatus=doc.createElement('p');observerStatus.setAttribute('data-interface-capture-observer','');
 const mainScrollStatus=doc.createElement('p');mainScrollStatus.setAttribute('data-interface-capture-main-scroll','');
 const innerScrollStatus=doc.createElement('p');innerScrollStatus.setAttribute('data-interface-capture-inner-scroll','');
 const mainScrollDetails=doc.createElement('p');mainScrollDetails.setAttribute('data-interface-capture-main-scroll-details','');
 const sampleLabel=doc.createElement('p');sampleLabel.className='ui-field__support';sampleLabel.setAttribute('data-interface-capture-sample-label','');sampleLabel.textContent=`切区样本：${sampleContent==='simplified'?'简化正文':'原正文'}${sampleWarmMode==='skip-warm-revalidation'?'，跳过切回复核':sampleWarmMode==='visibility-only'?'，仅显隐切换':sampleWarmMode==='normal'&&sampleMainScrollMode==='inner'?'，正常切区（内部滚动）':sampleWarmMode==='normal'&&sampleMainScrollMode==='clip'?'，正常切区（正文不滚动）':sampleWarmMode==='normal'&&sampleMainScrollMode==='hidden'?'，正常切区（hidden 对照）':''}${sampleWarmMode==='visibility-only'&&sampleObserverMode==='owned-hidden-filter'?'，过滤重复通知':sampleWarmMode==='visibility-only'&&sampleObserverMode==='normal'&&sampleMainScrollMode==='inner'?'，内部滚动（不过滤通知）':sampleWarmMode==='visibility-only'&&sampleObserverMode==='normal'&&sampleMainScrollMode==='clip'?'，正文不滚动（不过滤通知）':''}，仅工坊／本末，关闭退出`;sampleLabel.hidden=!sampleMode;
 readout.append(sampleLabel,observerStatus,mainScrollStatus,mainScrollDetails,innerScrollStatus,timeline);
 clear.textContent='没闪';bar.append(mark,clear,download,baseline,unclip,sample,simpleSample,heldSample,visibilitySample,filteredSample,noScrollSample,innerScrollSample,normalInnerSample,unfilteredInnerSample,unfilteredNoScrollSample,normalNoScrollSample,originalNoScrollSample,hiddenMainSample,readout,gridOriginal,gridFixed,gridStatus);shadow.append(bar);
 let disposed=false,samplePending=null,sampleFailed=null;
 const numeric=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?String(value):'?';
 function updateMainScroll(){
  if(disposed)return;
  const state=diagnostic.inspect(),enabled=sampleMode&&((sampleWarmMode==='visibility-only'&&((sampleObserverMode==='owned-hidden-filter'&&['clip','inner'].includes(sampleMainScrollMode))||(sampleObserverMode==='normal'&&['clip','inner'].includes(sampleMainScrollMode))))||(sampleWarmMode==='normal'&&['clip','inner'].includes(sampleMainScrollMode)));
  const hiddenMode=sampleMode&&sampleContent==='original'&&sampleWarmMode==='normal'&&sampleMainScrollMode==='hidden';
  const invalidPages=Object.values(state.mainScrollVerification?.pages??{}).filter(page=>page?.status==='invalid');
  const overflowOnly=invalidPages.length>0&&invalidPages.every(page=>page.reason===(hiddenMode?'overflow-not-hidden':'overflow-not-clip'));
  const statuses=hiddenMode?{pending:'hidden 待确认',applied:'hidden 已生效',invalid:overflowOnly?'hidden 未生效':'本轮无效'}:{pending:'待确认',applied:'已关闭',invalid:overflowOnly?'未生效':'本轮无效'};
  const text=(enabled||hiddenMode)&&Object.hasOwn(statuses,state.mainScrollStatus)?`${hiddenMode?'正文溢出':'正文滚动'}：${statuses[state.mainScrollStatus]}`:'';
  if(mainScrollStatus.textContent!==text)mainScrollStatus.textContent=text;if(mainScrollStatus.hidden!==!text)mainScrollStatus.hidden=!text;
  const reasons={'overflow-not-hidden':'溢出值不符','overflow-not-clip':'未关闭滚动','empty-layout':'尺寸为空','outside-surface':'越界','overlapping-layout':'重叠'};
  const details=(enabled||hiddenMode)?['workshop','benmo'].flatMap(area=>{const page=state.mainScrollVerification?.pages?.[area];return page?.status==='invalid'?[`${area==='workshop'?'工坊':'本末'}：${Object.hasOwn(reasons,page.reason)?reasons[page.reason]:'无效'} #${Number.isSafeInteger(page.nav)&&page.nav>=0?page.nav:'?'}`]:[];}).join('／'):'';
  if(mainScrollDetails.textContent!==details)mainScrollDetails.textContent=details;if(mainScrollDetails.hidden!==!details)mainScrollDetails.hidden=!details;
 }
 function updateInnerScroll(){
  if(disposed)return;
  const state=diagnostic.inspect(),enabled=sampleMode&&sampleMainScrollMode==='inner'&&(sampleWarmMode==='normal'||(sampleWarmMode==='visibility-only'&&['normal','owned-hidden-filter'].includes(sampleObserverMode)));
  const statuses={pending:'待确认',ready:'已具备条件',scrolled:'已观察到滚动',invalid:'未具备条件'},status=state.innerScrollVerification?.status;
  const text=enabled&&Object.hasOwn(statuses,status)?`内部滚动：${statuses[status]}`:'';
  if(innerScrollStatus.textContent!==text)innerScrollStatus.textContent=text;if(innerScrollStatus.hidden!==!text)innerScrollStatus.hidden=!text;
 }
 function updateObserver(){
  if(disposed)return;
  const state=diagnostic.inspect(),counts=state.observerDelivery;
  const shown=sampleMode&&sampleWarmMode==='visibility-only'&&['normal','owned-hidden-filter'].includes(state.sampleObserverMode)&&counts!==null&&typeof counts==='object';
  const text=shown?`外观通知：已跳过 ${numeric(counts.skippedBatches)} 批／仍同步 ${numeric(counts.deliveredBatches)} 批`:'';
  if(observerStatus.textContent!==text)observerStatus.textContent=text;
  if(observerStatus.hidden!==!shown)observerStatus.hidden=!shown;
 }
 function updateTimeline(){
  if(disposed)return;
  const state=diagnostic.inspect(),session=typeof state.sessionId==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(state.sessionId)?state.sessionId:null;
  const lines=session?[`${session} | start e${numeric(state.startAnchor?.sequence)} @${numeric(state.startAnchor?.t)}ms`]:[];
  for(const navigation of (state.navigationHistory??[]).slice(-2)){
   const stages=(navigation.stages??[]).slice(-8).map(stage=>`${['requested','shown','ready','reload','held'].includes(stage.phase)?stage.phase:'unknown'} e${numeric(stage.sequence)}@${numeric(stage.t)}ms`);
   lines.push(`#${numeric(navigation.nav)} ${stages.join(' / ')}${navigation.omittedStages>0?` / omitted ${numeric(navigation.omittedStages)}`:''}`);
  }
  const text=lines.join('\n');if(timeline.textContent!==text)timeline.textContent=text;
  if(timeline.hidden!==!text)timeline.hidden=!text;
 }
 function updateGrid(){
  if(disposed)return;
  const state=diagnostic.inspect(),shown=sampleMode&&gridEnabled&&state.status==='recording';
  for(const [button,condition,label] of [[gridOriginal,'original','原计算'],[gridFixed,'fixed','固定计算']]){
   if(button.hidden!==!shown)button.hidden=!shown;
   const pressed=String(state.gridCondition===condition),text=`${pressed==='true'?'✓ ':''}${label}`;
   if(button.getAttribute('aria-pressed')!==pressed)button.setAttribute('aria-pressed',pressed);
   if(button.textContent!==text)button.textContent=text;
  }
  const disabled=state.gridReady!==true;if(gridFixed.disabled!==disabled)gridFixed.disabled=disabled;
  const text=sampleMode&&gridEnabled?(state.gridInvalid?'本次对照无效':state.gridCondition==='fixed'&&state.gridPending?.length>0?'待两页几何核对':shown&&!state.gridReady?'需先打开工坊和本末':''):'';
  if(gridStatus.textContent!==text)gridStatus.textContent=text;if(gridStatus.hidden!==!text)gridStatus.hidden=!text;
 }
 function update(){
  if(disposed)return;
  updateTimeline();updateGrid();updateObserver();updateMainScroll();updateInnerScroll();
  const state=diagnostic.inspect(),recording=state.status==='recording';
  if(sampleMode){const text=`切区样本：${sampleContent==='simplified'?'简化正文':'原正文'}${sampleWarmMode==='skip-warm-revalidation'?'，跳过切回复核':sampleWarmMode==='visibility-only'?'，仅显隐切换':sampleWarmMode==='normal'&&sampleMainScrollMode==='inner'?'，正常切区（内部滚动）':sampleWarmMode==='normal'&&sampleMainScrollMode==='clip'?'，正常切区（正文不滚动）':sampleWarmMode==='normal'&&sampleMainScrollMode==='hidden'?'，正常切区（hidden 对照）':''}${sampleWarmMode==='visibility-only'&&sampleObserverMode==='owned-hidden-filter'?'，过滤重复通知':sampleWarmMode==='visibility-only'&&sampleObserverMode==='normal'&&sampleMainScrollMode==='inner'?'，内部滚动（不过滤通知）':sampleWarmMode==='visibility-only'&&sampleObserverMode==='normal'&&sampleMainScrollMode==='clip'?'，正文不滚动（不过滤通知）':''}${state.reason==='failed'?'，读取失败，本次记录无效':'，仅工坊／本末，关闭退出'}`;if(sampleLabel.textContent!==text)sampleLabel.textContent=text;}
  bar.hidden=!state.hasData&&!sampleMode;mark.disabled=false;clear.hidden=!recording;
  baseline.hidden=unclip.hidden=!recording||sampleMode;
  for(const [button,callback,kind,label] of [[sample,onSample,'original','原正文样本'],[simpleSample,onSimpleSample,'simplified','简化正文样本'],[heldSample,onHeldSample,'held','简化正文（跳过复核）'],[visibilitySample,onVisibilitySample,'visibility','简化正文（仅显隐）'],[filteredSample,onFilteredSample,'filtered','仅显隐（过滤重复通知）'],[noScrollSample,onNoScrollSample,'no-scroll','仅显隐（正文不滚动）'],[innerScrollSample,onInnerScrollSample,'inner-scroll','仅显隐（内部滚动）'],[normalInnerSample,onNormalInnerSample,'normal-inner','正常切区（内部滚动）'],[unfilteredInnerSample,onUnfilteredInnerSample,'unfiltered-inner','内部滚动（不过滤通知）'],[unfilteredNoScrollSample,onUnfilteredNoScrollSample,'unfiltered-no-scroll','正文不滚动（不过滤通知）'],[normalNoScrollSample,onNormalNoScrollSample,'normal-no-scroll','正常切区（正文不滚动）'],[originalNoScrollSample,onOriginalNoScrollSample,'original-no-scroll','原正文（正常切区，不滚动）'],[hiddenMainSample,onHiddenMainSample,'hidden-main','原正文（hidden 对照）']]){
   button.hidden=sampleMode||typeof callback!=='function'||!recording;button.disabled=samplePending!==null;button.textContent=samplePending===kind?'正在打开样本…':sampleFailed===kind?'样本未打开，重试':label;
  }
  baseline.setAttribute('aria-pressed',String(state.clipCondition==='original'));unclip.setAttribute('aria-pressed',String(state.clipCondition==='visible'));
  baseline.textContent=`${state.clipCondition==='original'?'✓ ':''}原裁剪（0 px）`;unclip.textContent=`${state.clipCondition==='visible'?'✓ ':''}取消外层裁剪（0 px）`;
  mark.textContent=recording?'闪了':'重新记录';
  download.hidden=!state.hasData;
  const count=Number.isSafeInteger(state.observationCount)&&state.observationCount>0?`（${state.observationCount}）`:'';
  download.textContent=recording?`停止并导出${count}`:state.reason==='capture-cap'?'记录已满，请导出':`导出记录${count}`;
 }
 function clickMark(event){
  event.stopPropagation();
  if(diagnostic.inspect().status==='recording')diagnostic.mark('flicker');else start();
  update();
 }
 function clickClear(event){event.stopPropagation();if(diagnostic.inspect().status==='recording')diagnostic.mark('no-flicker');update();}
 function setClip(event,value){event.stopPropagation();if(!sampleMode&&diagnostic.inspect().status==='recording')diagnostic.setClipCondition(value);update();}
 const clickBaseline=event=>setClip(event,'original'),clickUnclip=event=>setClip(event,'visible');
 function setGrid(event,value){
  event.stopPropagation();if(disposed||!sampleMode||!gridEnabled)return;
  const state=diagnostic.inspect();if(state.status!=='recording'||(value==='fixed'&&state.gridReady!==true))return;
  diagnostic.setGridCondition(value);updateGrid();
 }
 const clickGridOriginal=event=>setGrid(event,'original'),clickGridFixed=event=>setGrid(event,'fixed');
 async function launchSample(event,callback,kind){
  event.stopPropagation();if(disposed||sampleMode||samplePending!==null||typeof callback!=='function'||diagnostic.inspect().status!=='recording')return;
  samplePending=kind;sampleFailed=null;update();
  try{if((await callback())===false)sampleFailed=kind;}catch{sampleFailed=kind;}
  finally{samplePending=null;if(!disposed)update();}
 }
 const clickSample=event=>launchSample(event,onSample,'original'),clickSimpleSample=event=>launchSample(event,onSimpleSample,'simplified'),clickHeldSample=event=>launchSample(event,onHeldSample,'held'),clickVisibilitySample=event=>launchSample(event,onVisibilitySample,'visibility'),clickFilteredSample=event=>launchSample(event,onFilteredSample,'filtered'),clickNoScrollSample=event=>launchSample(event,onNoScrollSample,'no-scroll'),clickInnerScrollSample=event=>launchSample(event,onInnerScrollSample,'inner-scroll'),clickNormalInnerSample=event=>launchSample(event,onNormalInnerSample,'normal-inner'),clickUnfilteredInnerSample=event=>launchSample(event,onUnfilteredInnerSample,'unfiltered-inner'),clickUnfilteredNoScrollSample=event=>launchSample(event,onUnfilteredNoScrollSample,'unfiltered-no-scroll'),clickNormalNoScrollSample=event=>launchSample(event,onNormalNoScrollSample,'normal-no-scroll'),clickOriginalNoScrollSample=event=>launchSample(event,onOriginalNoScrollSample,'original-no-scroll'),clickHiddenMainSample=event=>launchSample(event,onHiddenMainSample,'hidden-main');
 function clickDownload(event){event.stopPropagation();if(!diagnostic.download())download.textContent='导出失败，重试';else update();}
 mark.addEventListener('click',clickMark);clear.addEventListener('click',clickClear);download.addEventListener('click',clickDownload);baseline.addEventListener('click',clickBaseline);unclip.addEventListener('click',clickUnclip);sample.addEventListener('click',clickSample);simpleSample.addEventListener('click',clickSimpleSample);heldSample.addEventListener('click',clickHeldSample);visibilitySample.addEventListener('click',clickVisibilitySample);filteredSample.addEventListener('click',clickFilteredSample);noScrollSample.addEventListener('click',clickNoScrollSample);innerScrollSample.addEventListener('click',clickInnerScrollSample);normalInnerSample.addEventListener('click',clickNormalInnerSample);unfilteredInnerSample.addEventListener('click',clickUnfilteredInnerSample);unfilteredNoScrollSample.addEventListener('click',clickUnfilteredNoScrollSample);normalNoScrollSample.addEventListener('click',clickNormalNoScrollSample);originalNoScrollSample.addEventListener('click',clickOriginalNoScrollSample);hiddenMainSample.addEventListener('click',clickHiddenMainSample);gridOriginal.addEventListener('click',clickGridOriginal);gridFixed.addEventListener('click',clickGridFixed);
 const unsubscribe=diagnostic.subscribe(update),unsubscribeTimeline=diagnostic.subscribeTimeline?.(updateTimeline)??(()=>{}),unsubscribeGrid=diagnostic.subscribeGrid?.(updateGrid)??(()=>{}),unsubscribeObserver=diagnostic.subscribeObserver?.(updateObserver)??(()=>{}),unsubscribeMainScroll=diagnostic.subscribeMainScroll?.(updateMainScroll)??(()=>{}),unsubscribeInnerScroll=diagnostic.subscribeInnerScroll?.(updateInnerScroll)??(()=>{});update();
 return {dispose(){if(disposed)return;disposed=true;unsubscribe();unsubscribeTimeline();unsubscribeGrid();unsubscribeObserver();unsubscribeMainScroll();unsubscribeInnerScroll();mark.removeEventListener('click',clickMark);clear.removeEventListener('click',clickClear);download.removeEventListener('click',clickDownload);baseline.removeEventListener('click',clickBaseline);unclip.removeEventListener('click',clickUnclip);sample.removeEventListener('click',clickSample);simpleSample.removeEventListener('click',clickSimpleSample);heldSample.removeEventListener('click',clickHeldSample);visibilitySample.removeEventListener('click',clickVisibilitySample);filteredSample.removeEventListener('click',clickFilteredSample);noScrollSample.removeEventListener('click',clickNoScrollSample);innerScrollSample.removeEventListener('click',clickInnerScrollSample);normalInnerSample.removeEventListener('click',clickNormalInnerSample);unfilteredInnerSample.removeEventListener('click',clickUnfilteredInnerSample);unfilteredNoScrollSample.removeEventListener('click',clickUnfilteredNoScrollSample);normalNoScrollSample.removeEventListener('click',clickNormalNoScrollSample);originalNoScrollSample.removeEventListener('click',clickOriginalNoScrollSample);hiddenMainSample.removeEventListener('click',clickHiddenMainSample);gridOriginal.removeEventListener('click',clickGridOriginal);gridFixed.removeEventListener('click',clickGridFixed);bar.remove();}};
}
