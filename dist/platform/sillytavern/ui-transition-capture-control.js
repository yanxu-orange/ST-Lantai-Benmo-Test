// A host-owned control: navigation never rebuilds it or opens another page.
export function mountUITransitionCaptureControl(shadow,{diagnostic,start=()=>diagnostic.start()}={}){
 const doc=shadow.ownerDocument,bar=doc.createElement('div');
 bar.setAttribute('data-interface-capture','');bar.setAttribute('role','group');bar.setAttribute('aria-label','界面诊断');
 const mark=doc.createElement('button'),clear=doc.createElement('button'),download=doc.createElement('button'),baseline=doc.createElement('button'),unclip=doc.createElement('button');
 for(const button of [mark,clear,download,baseline,unclip]){button.type='button';button.className='ui-button ui-button--secondary';}
 mark.setAttribute('data-interface-capture-mark','');clear.setAttribute('data-interface-capture-clear','');download.setAttribute('data-interface-capture-export','');
 baseline.setAttribute('data-interface-capture-clip-original','');unclip.setAttribute('data-interface-capture-clip-visible','');
 baseline.textContent='原裁剪（0 px）';unclip.textContent='取消外层裁剪（0 px）';
 clear.textContent='没闪';bar.append(mark,clear,download,baseline,unclip);shadow.append(bar);
 let disposed=false;
 function update(){
  if(disposed)return;
  const state=diagnostic.inspect(),recording=state.status==='recording';
  bar.hidden=!state.hasData;mark.disabled=false;clear.hidden=!recording;
  baseline.hidden=unclip.hidden=!recording;
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
 function setClip(event,value){event.stopPropagation();if(diagnostic.inspect().status==='recording')diagnostic.setClipCondition(value);update();}
 const clickBaseline=event=>setClip(event,'original'),clickUnclip=event=>setClip(event,'visible');
 function clickDownload(event){event.stopPropagation();if(!diagnostic.download())download.textContent='导出失败，重试';else update();}
 mark.addEventListener('click',clickMark);clear.addEventListener('click',clickClear);download.addEventListener('click',clickDownload);baseline.addEventListener('click',clickBaseline);unclip.addEventListener('click',clickUnclip);
 const unsubscribe=diagnostic.subscribe(update);update();
 return {dispose(){if(disposed)return;disposed=true;unsubscribe();mark.removeEventListener('click',clickMark);clear.removeEventListener('click',clickClear);download.removeEventListener('click',clickDownload);baseline.removeEventListener('click',clickBaseline);unclip.removeEventListener('click',clickUnclip);bar.remove();}};
}
