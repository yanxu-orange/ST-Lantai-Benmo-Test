// A host-owned control: navigation never rebuilds it or opens another page.
export function mountUITransitionCaptureControl(shadow,{diagnostic,start=()=>diagnostic.start(),onSample=null,sampleMode=false}={}){
 const doc=shadow.ownerDocument,bar=doc.createElement('div');
 bar.setAttribute('data-interface-capture','');bar.setAttribute('role','group');bar.setAttribute('aria-label','界面诊断');
 const mark=doc.createElement('button'),clear=doc.createElement('button'),download=doc.createElement('button'),baseline=doc.createElement('button'),unclip=doc.createElement('button'),sample=doc.createElement('button'),gridOriginal=doc.createElement('button'),gridFixed=doc.createElement('button');
 for(const button of [mark,clear,download,baseline,unclip,sample,gridOriginal,gridFixed]){button.type='button';button.className='ui-button ui-button--secondary';}
 mark.setAttribute('data-interface-capture-mark','');clear.setAttribute('data-interface-capture-clear','');download.setAttribute('data-interface-capture-export','');
 baseline.setAttribute('data-interface-capture-clip-original','');unclip.setAttribute('data-interface-capture-clip-visible','');
 sample.setAttribute('data-interface-capture-sample','');sample.textContent='切区样本';
 gridOriginal.setAttribute('data-interface-capture-grid-original','');gridFixed.setAttribute('data-interface-capture-grid-fixed','');
 const gridStatus=doc.createElement('p');gridStatus.className='ui-field__support';gridStatus.setAttribute('data-interface-capture-grid-status','');
 baseline.textContent='原裁剪（0 px）';unclip.textContent='取消外层裁剪（0 px）';
 const timeline=doc.createElement('p');timeline.className='ui-field__support';timeline.setAttribute('data-interface-capture-timeline','');
 const sampleLabel=doc.createElement('p');sampleLabel.className='ui-field__support';sampleLabel.setAttribute('data-interface-capture-sample-label','');sampleLabel.textContent='切区样本：仅工坊／本末，关闭退出';sampleLabel.hidden=!sampleMode;
 clear.textContent='没闪';bar.append(mark,clear,download,baseline,unclip,sample,sampleLabel,gridOriginal,gridFixed,gridStatus,timeline);shadow.append(bar);
 let disposed=false,samplePending=false,sampleFailed=false;
 const numeric=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?String(value):'?';
 function updateTimeline(){
  if(disposed)return;
  const state=diagnostic.inspect(),session=typeof state.sessionId==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(state.sessionId)?state.sessionId:null;
  const lines=session?[`${session} | start e${numeric(state.startAnchor?.sequence)} @${numeric(state.startAnchor?.t)}ms`]:[];
  for(const navigation of (state.navigationHistory??[]).slice(-2)){
   const stages=(navigation.stages??[]).slice(-8).map(stage=>`${['requested','shown','ready','reload'].includes(stage.phase)?stage.phase:'unknown'} e${numeric(stage.sequence)}@${numeric(stage.t)}ms`);
   lines.push(`#${numeric(navigation.nav)} ${stages.join(' / ')}${navigation.omittedStages>0?` / omitted ${numeric(navigation.omittedStages)}`:''}`);
  }
  const text=lines.join('\n');if(timeline.textContent!==text)timeline.textContent=text;
  if(timeline.hidden!==!text)timeline.hidden=!text;
 }
 function updateGrid(){
  if(disposed)return;
  const state=diagnostic.inspect(),shown=sampleMode&&state.status==='recording';
  for(const [button,condition,label] of [[gridOriginal,'original','原计算'],[gridFixed,'fixed','固定计算']]){
   if(button.hidden!==!shown)button.hidden=!shown;
   const pressed=String(state.gridCondition===condition),text=`${pressed==='true'?'✓ ':''}${label}`;
   if(button.getAttribute('aria-pressed')!==pressed)button.setAttribute('aria-pressed',pressed);
   if(button.textContent!==text)button.textContent=text;
  }
  const disabled=state.gridReady!==true;if(gridFixed.disabled!==disabled)gridFixed.disabled=disabled;
  const text=sampleMode?(state.gridInvalid?'本次对照无效':state.gridCondition==='fixed'&&state.gridPending?.length>0?'待两页几何核对':shown&&!state.gridReady?'需先打开工坊和本末':''):'';
  if(gridStatus.textContent!==text)gridStatus.textContent=text;if(gridStatus.hidden!==!text)gridStatus.hidden=!text;
 }
 function update(){
  if(disposed)return;
  updateTimeline();updateGrid();
  const state=diagnostic.inspect(),recording=state.status==='recording';
  bar.hidden=!state.hasData&&!sampleMode;mark.disabled=false;clear.hidden=!recording;
  baseline.hidden=unclip.hidden=!recording||sampleMode;
  sample.hidden=sampleMode||typeof onSample!=='function'||!recording;sample.disabled=samplePending;sample.textContent=samplePending?'正在打开样本…':sampleFailed?'样本未打开，重试':'切区样本';
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
  event.stopPropagation();if(disposed||!sampleMode)return;
  const state=diagnostic.inspect();if(state.status!=='recording'||(value==='fixed'&&state.gridReady!==true))return;
  diagnostic.setGridCondition(value);updateGrid();
 }
 const clickGridOriginal=event=>setGrid(event,'original'),clickGridFixed=event=>setGrid(event,'fixed');
 async function clickSample(event){
  event.stopPropagation();if(disposed||sampleMode||samplePending||typeof onSample!=='function'||diagnostic.inspect().status!=='recording')return;
  samplePending=true;sampleFailed=false;update();
  try{sampleFailed=(await onSample())===false;}catch{sampleFailed=true;}
  finally{samplePending=false;if(!disposed)update();}
 }
 function clickDownload(event){event.stopPropagation();if(!diagnostic.download())download.textContent='导出失败，重试';else update();}
 mark.addEventListener('click',clickMark);clear.addEventListener('click',clickClear);download.addEventListener('click',clickDownload);baseline.addEventListener('click',clickBaseline);unclip.addEventListener('click',clickUnclip);sample.addEventListener('click',clickSample);gridOriginal.addEventListener('click',clickGridOriginal);gridFixed.addEventListener('click',clickGridFixed);
 const unsubscribe=diagnostic.subscribe(update),unsubscribeTimeline=diagnostic.subscribeTimeline?.(updateTimeline)??(()=>{}),unsubscribeGrid=diagnostic.subscribeGrid?.(updateGrid)??(()=>{});update();
 return {dispose(){if(disposed)return;disposed=true;unsubscribe();unsubscribeTimeline();unsubscribeGrid();mark.removeEventListener('click',clickMark);clear.removeEventListener('click',clickClear);download.removeEventListener('click',clickDownload);baseline.removeEventListener('click',clickBaseline);unclip.removeEventListener('click',clickUnclip);sample.removeEventListener('click',clickSample);gridOriginal.removeEventListener('click',clickGridOriginal);gridFixed.removeEventListener('click',clickGridFixed);bar.remove();}};
}
