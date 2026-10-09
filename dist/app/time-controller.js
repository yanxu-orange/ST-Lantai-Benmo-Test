import {recognizeRecentDate} from '../domain/time/tracker.js';
import {normalizeChronology,toUnifiedYear} from '../domain/time/chronology.js';
import {sameTarget} from '../domain/memory/repository.js';
import {createCalendar,normalizeCalendar} from '../domain/time/calendar.js';
import {storyDate} from '../domain/time/point.js';
import {createManualAnchor} from '../domain/time/anchor.js';
import {initialHolidayItems} from '../domain/time/catalog-items.js';
import {importYears} from '../domain/time/lunar.js';
import {assertTime} from '../domain/time/data.js';
import {defaultTimeReminders} from '../shared/settings/time-reminders.js';
import {createLatestSettingsWrite} from './latest-settings-write.js';
const copy=structuredClone,equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const names={schedule:'日程',anniversary:'纪念日',holiday:'节日'};
export function createTimeController({repository,settings,dateRuntime,captureSource,matchesSource,onMemory=()=>{},onSettings=()=>{},onWorkshop=()=>{},onBenmo=()=>{},onClose=()=>{},id=()=>globalThis.crypto.randomUUID()}={}){
 let disposed=false,ticket=0,target=null,baseline=null,config=null,writer=null,visible=true,navigation=0,refreshTicket=0,previewSerial=0,quickJob=null;
 const listeners=new Set(),stack=[];let pendingNavigation=null;
 let state={route:'home',status:'loading',time:null,reminders:null,draft:null,cursor:null,filter:'all',query:'',error:'',recognitionResult:false,saved:0,saving:false,scroll:{},opened:{},pendingCalendar:null,editorOriginal:null,editorTime:null,draftBaseline:null,confirm:null};
 const current=(t=target,n=ticket)=>{try{return !disposed&&n===ticket&&sameTarget(t,repository.captureTarget());}catch{return false;}};
 const notify=()=>{if(!disposed&&visible)for(const fn of listeners)try{fn(copy(state));}catch{}};
 const calendar=()=>{const definition=state.time?.calendars.find(item=>item.id===state.time.activeCalendarId);return definition?createCalendar(definition):null;};
 const resetWriter=()=>{writer?.dispose();writer=null;quickJob=null;};
 async function init(){
  if(disposed)return false;
  const nextTarget=repository.captureTarget();if(target&&sameTarget(target,nextTarget)&&baseline)return refresh();
  target=nextTarget;const request=++ticket;resetWriter();stack.length=0;state={...state,status:'loading',draft:null,pendingCalendar:null,error:'',recognitionResult:false,route:'home',cursor:null,saving:false};notify();
  try{const selection=await repository.captureTime(target);if(!current(nextTarget,request))return false;baseline=selection;config=settings.captureTimeReminders();state.time=copy(selection.time);state.reminders=copy(config.reminders);state.status='ready';setCursor();notify();return true;}
  catch(error){if(current(nextTarget,request)){state.status='failed';state.error=error.message;notify();}return false;}
 }
 async function refresh(){
  if(!current()||state.saving||writer?.inspect().saving)return false;
  const t=copy(target),n=ticket,refreshId=++refreshTicket;
  try{const selection=await repository.captureTime(t);if(!current(t,n)||refreshId!==refreshTicket||state.saving||writer?.inspect().saving)return false;resetWriter();baseline=selection;state.time=copy(selection.time);state.status='ready';state.error='';setCursor();notify();return true;}catch(error){if(current(t,n))fail(error);return false;}
 }
 const unsubscribeDate=dateRuntime.subscribe?.(()=>{if(visible&&!state.draft&&!state.saving&&!writer?.inspect().saving&&baseline)void refresh();});
 function setCursor(){const cal=calendar(),date=state.time?.currentDate;if(!cal){state.cursor=null;return;}const candidate=state.cursor?.calendarId===cal.definition.id?state.cursor:date?{...date,month:date.month??1,day:date.day??1}:{calendarId:cal.definition.id,year:1,month:1,day:1};try{state.cursor=cal.validate(candidate);}catch{state.cursor={calendarId:cal.definition.id,year:date?.year??1,month:1,day:1};}}
 function navigate(route,draft=null){navigation++;state.recognitionResult=false;stack.push({route:state.route,draft:copy(state.draft),filter:state.filter,query:state.query,cursor:copy(state.cursor),pendingCalendar:copy(state.pendingCalendar),editorOriginal:copy(state.editorOriginal),editorTime:copy(state.editorTime),draftBaseline:copy(state.draftBaseline)});state.route=route;if(['schedules','anniversaries','holidays'].includes(route)){state.filter='all';state.query='';}state.draft=copy(draft);state.draftBaseline=copy(draft);state.editorTime=copy(baseline?.time);state.editorOriginal=draft?.id?copy(state.time?.items.find(item=>item.id===draft.id)??null):null;state.error='';notify();}
 function back(force=false){if(!force&&requestDiscard(()=>back(true)))return;navigation++;const previous=stack.pop();if(previous)Object.assign(state,previous);else{state.route='home';state.draft=null;state.pendingCalendar=null;}setCursor();state.recognitionResult=false;state.error='';notify();}
 function requestDiscard(action){if(!state.saving&&state.draft&&!equal(state.draft,state.draftBaseline)){pendingNavigation=action;state.confirm='discard';notify();return true;}return false;}
 const fail=error=>{state.error=error?.message??'未能保存，请重试';notify();return false;};
 async function persist(change,{guard=()=>true}={}){
  const t=copy(target),n=ticket;if(!current(t,n))throw new Error('聊天已变化，请重新打开时间页');
  const selection=await repository.captureTime(t);if(!current(t,n))throw new Error('聊天已变化');
  const value=change(copy(selection.time));assertTime(value);
  const receipt=await repository.updateTime(t,selection,value,{isCurrent:()=>current(t,n)&&guard()});
  if(!current(t,n))throw new Error('聊天已变化');
  if(!['committed','unchanged'].includes(receipt.status))throw new Error('保存尚未确认，请重新读取后核对');
  baseline=receipt.selection;state.time=copy(receipt.root.time??selection.time);setCursor();return state.time;
 }
 async function explicit(action){if(state.saving||!current())return false;const t=copy(target),n=ticket,routeVersion=navigation;state.saving=true;state.error='';notify();try{if(quickJob&&await quickJob===false)throw new Error('先前的状态保存未完成，请重新读取后核对');if(!current(t,n))return false;await action({target:t,guard:()=>current(t,n)});if(!current(t,n))return false;state.saved++;if(navigation===routeVersion)back(true);return true;}catch(error){if(current(t,n))return fail(error);return false;}finally{if(current(t,n)){state.saving=false;notify();}}}
 function edit(path,value){if(!state.draft||state.saving||!current())return false;const parts=path.split('.');let node=state.draft;for(const key of parts.slice(0,-1)){if(!Object.hasOwn(node,key))return false;node=node[key];}node[parts.at(-1)]=value;state.recognitionResult=false;return true;}
 function open(route,force=false){
  if(!force&&!route.startsWith('reminders/')&&requestDiscard(()=>open(route,true)))return;
  if(state.saving||!current())return;
  if(!writer?.inspect().saving)resetWriter();
  if(['home','manage'].includes(route)){navigation++;stack.length=0;state.route=route;state.draft=null;state.pendingCalendar=null;state.error='';notify();return;}
  const cal=calendar();
  if(route==='calibrate'||route.startsWith('reminders/')){try{config=settings.captureTimeReminders();state.reminders=copy(config.reminders);}catch(error){fail(error);return;}}
  if(route==='calendar')navigate(route,{...(cal?copy(cal.definition):{id:id(),type:'modern',name:'现代历法'}),importStart:cal?.definition.importedYears?.[0]?.sourceYear??2025,importEnd:cal?.definition.importedYears?.at(-1)?.sourceYear??2026});
  else if(route==='calibrate'){
   if(!cal){open('calendar');return;}
   navigate(route,{date:copy(state.time.currentDate??{calendarId:cal.definition.id,year:null,month:null,day:null}),recognition:copy(state.time.recognition),chronology:copy(state.time.chronology),current:copy(state.reminders.current)});
  }else if(route.startsWith('reminders/'))navigate(route,copy(state.reminders[route.split('/')[1]]));
  else navigate(route);
 }
 function openItem(kind,itemId=null){if(!names[kind]||!calendar()||state.saving||!current())return;
  if(!writer?.inspect().saving)resetWriter();
  const original=state.time.items.find(item=>item.id===itemId),start=copy(state.cursor);
  navigate(`edit/${kind}`,original??{id:id(),kind,calendarId:start.calendarId,title:'',startDate:start,repeat:kind==='schedule'?'once':'yearly',durationDays:1,advanceDays:kind==='schedule'?3:null,enabled:true,remind:false,show:true,description:'',instruction:'',...(kind==='holiday'?{category:'自定义节日',dateRule:{type:'fixed',month:start.month,day:start.day,...(calendar().definition.type==='dynasty'?{monthId:calendar().months(start.year)[start.month-1].id}:{})},startDate:null}:{})});
 }
 async function save({confirmCalendar=false}={}){
  const route=state.route,editor=state.draft,draft=copy(state.draft);if(!draft)return false;
  if(route==='calendar'){
   try{
    const definition=copy(draft);delete definition.importStart;delete definition.importEnd;
    if(definition.type==='dynasty')definition.importedYears=importYears(draft.importStart,draft.importEnd,{includeTerms:definition.includeTerms===true});
    if(definition.type!=='dynasty')delete definition.importedYears;if(definition.type!=='custom')delete definition.months;
    normalizeCalendar(definition);
    const old=calendar()?.definition;
    if(equal(definition,old)){back(true);return true;}
    const structural=value=>{const result=copy(value);for(const key of ['id','name','showTerms','showHolidays'])delete result[key];return result;};
    if(old&&equal(structural(old),structural(definition)))return explicit(async()=>{await persist(time=>{if(!equal(time.calendars.find(item=>item.id===old.id),state.editorTime.calendars.find(item=>item.id===old.id)))throw new Error('历法配置已变化，请重新打开');return {...time,calendars:time.calendars.map(item=>item.id===old.id?definition:item)};});});
    // A changed calendar remains a draft until its date is calibrated.
    const retained=state.time.calendars.find(item=>equal(structural(item),structural(definition)));definition.id=retained?.id??(old?id():definition.id);
    state.pendingCalendar=definition;
    navigate('calibrate',{date:{calendarId:definition.id,year:null,month:null,day:null},recognition:copy(state.time.recognition),chronology:copy(state.time.chronology),current:copy(state.reminders.current)});return true;
   }catch(error){return fail(error);}
  }
  if(route.startsWith('edit/')){
   const original=state.editorOriginal??undefined;
   return explicit(async()=>{await persist(time=>{const found=time.items.find(item=>item.id===draft.id);if(!equal(found,original))throw new Error('此事项已变化，请重新打开');const item={...draft,title:draft.title.trim()};if(item.dateRule?.type==='fixed'&&calendar().definition.type==='dynasty'&&!item.dateRule.monthId){const month=calendar().months(state.cursor.year)[item.dateRule.month-1];if(!month)throw new Error('月份不存在');item.dateRule={...item.dateRule,monthId:month.id};}if(!item.title||item.title.length>160)throw new Error('名称须为1–160个字符');if(item.kind==='anniversary'&&item.startYear!=null&&item.startDate&&item.startYear>item.startDate.year)throw new Error('发生年份不能晚于所填日期');time.items=found?time.items.map(row=>row.id===item.id?item:row):[...time.items,item];return time;});});
  }
  if(route.startsWith('reminders/'))return explicit(async({guard})=>{const kind=route.split('/')[1],latest=settings.captureTimeReminders();if(!settings.matchesTimeReminders(config))throw new Error('提醒设置已变化，请重新打开');const receipt=await settings.saveTimeReminders({...latest.reminders,[kind]:draft},{expectedEpoch:latest.epoch,isCurrent:guard});if(receipt.status!=='committed')throw new Error('提醒设置保存尚未确认');config=settings.captureTimeReminders();state.reminders=copy(config.reminders);});
  if(route==='calibrate'&&state.pendingCalendar&&state.time.activeCalendarId&&!confirmCalendar){state.confirm='calendar';notify();return false;}
  if(route==='calibrate')return explicit(async({target:saveTarget,guard})=>{
   const definition=state.pendingCalendar??calendar().definition,cal=createCalendar(definition),date=storyDate(cal,Object.hasOwn(draft,'eraName')?{...draft.date,year:toUnifiedYear(draft.chronology,draft.eraName,draft.eraYear)}:draft.date),source=captureSource(saveTarget);
   const before=state.editorTime;
   await persist(time=>{
    if(!equal(time.calendars,before.calendars)||!equal(time.recognition,before.recognition)||!equal(time.chronology,before.chronology)||time.activeCalendarId!==before.activeCalendarId)throw new Error('日期配置已变化，请重新打开');
    if(!time.calendars.some(item=>item.id===definition.id)){time.calendars.push(definition);time.items.push(...initialHolidayItems(cal));}else time.calendars=time.calendars.map(item=>item.id===definition.id?definition:item);
    if(matchesSource&&!matchesSource(saveTarget,source))throw new Error('聊天消息已变化，请重新校准');
    time.activeCalendarId=definition.id;time.recognition=draft.recognition;time.chronology=draft.chronology;time.currentDate=date;time.manualAnchor=createManualAnchor(cal,date,source.messages);return time;
   },{guard:()=>guard()&&(!matchesSource||matchesSource(saveTarget,source))});
   if(!guard())throw new Error('聊天已变化');
   if(state.draft===editor)state.editorTime=copy(state.time);
   // If the separate global save fails, keep this editor and disclose the completed chat save.
   try{const latest=settings.captureTimeReminders();if(!settings.matchesTimeReminders(config))throw new Error('当前日期提醒配置已变化');const receipt=await settings.saveTimeReminders({...latest.reminders,current:draft.current},{expectedEpoch:latest.epoch,isCurrent:guard});if(receipt.status!=='committed')throw new Error('提醒设置保存尚未确认');config=settings.captureTimeReminders();state.reminders=copy(config.reminders);}
   catch(error){throw new Error(`故事日期已保存；全局提醒设置未确认：${error.message}`);}
   state.pendingCalendar=null;await dateRuntime.request();
   if(!guard())return;
   if(stack.at(-1)?.route==='calendar')stack.pop();
  });
  return false;
 }
 function toggleItem(itemId,field,calendarFlag=false){
  if(!(calendarFlag?['showHolidays','showTerms']:['enabled','remind','show']).includes(field)||!current()||state.saving)return Promise.resolve(false);
  if(!writer){
   const t=copy(target),n=ticket,flagsOf=time=>Object.fromEntries([...time.items.map(item=>[`item:${item.id}`,{enabled:item.enabled,remind:item.remind,show:item.show!==false}]),...time.calendars.map(item=>[`calendar:${item.id}`,{showHolidays:item.showHolidays!==false,showTerms:item.showTerms!==false}])]);
   let confirmed=flagsOf(state.time);
   writer=createLatestSettingsWrite({initial:confirmed,isCurrent:()=>current(t,n),persist:async flags=>{
    const changes=Object.keys(flags).filter(key=>!equal(flags[key],confirmed[key]));
    await persist(time=>{for(const key of changes){const collection=key.startsWith('calendar:')?time.calendars:time.items,id=key.slice(key.indexOf(':')+1),item=collection.find(row=>row.id===id);if(!item||!equal(flagsOf(time)[key],confirmed[key]))throw new Error('事项状态已变化，请重新打开');Object.assign(item,flags[key]);}return time;},{guard:()=>current(t,n)});
    confirmed=copy(flags);return flags;
   },onChange(snapshot){if(!current(t,n))return;for(const [prefix,items]of [['item',state.time.items],['calendar',state.time.calendars]])for(const item of items)if(snapshot.value[`${prefix}:${item.id}`])Object.assign(item,snapshot.value[`${prefix}:${item.id}`]);if(snapshot.error)state.time=copy(baseline.time);state.error=snapshot.error?.message??'';notify();}});
  }
  const key=`${calendarFlag?'calendar':'item'}:${itemId}`;quickJob=writer.change(flags=>{if(!flags[key])return;flags[key][field]=!flags[key][field];});return quickJob;
 }
 return {init,refresh,async recover(){const t=copy(target),n=ticket;if(!current(t,n)||state.saving)return false;try{await settings.read();if(!current(t,n))return false;config=settings.captureTimeReminders();state.reminders=copy(config.reminders);return refresh();}catch(error){return current(t,n)?fail(error):false;}},open,openItem,save,back,edit,toggleItem,confirm(){const kind=state.confirm;state.confirm=null;if(kind==='discard'){const next=pendingNavigation;pendingNavigation=null;next?.();}else if(kind==='calendar')return save({confirmCalendar:true});notify();},cancelConfirm(){state.confirm=null;pendingNavigation=null;notify();},toggleCalendar:field=>toggleItem(state.time.activeCalendarId,field,true),inspect:()=>copy(state),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},calendar,
  refreshDraft(){notify();},mutateDraft(change){if(state.draft&&!state.saving){change(state.draft);state.recognitionResult=false;notify();}},
  selectCalendar(calendarId){const found=state.time.calendars.find(item=>item.id===calendarId);if(found){state.draft={...copy(found),importStart:found.importedYears?.[0]?.sourceYear??2025,importEnd:found.importedYears?.at(-1)?.sourceYear??2026};notify();}},
  switchCalendarType(type){if(!['modern','custom','dynasty'].includes(type))return;const retained=state.time.calendars.findLast(item=>item.type===type);if(retained){this.selectCalendar(retained.id);return;}const previousId=state.draft.id;state.draft={id:previousId,type,name:type==='modern'?'现代历法':type==='dynasty'?'架空王朝历':'自定义历法',...(type==='custom'?{months:[{name:'一月',days:30}]}:{}),...(type==='dynasty'?{importStart:2025,importEnd:2026,includeTerms:false}:{})};notify();},
  async reidentify(){
   if(state.saving||!current()||state.route!=='calibrate'||!state.draft)return false;
   const t=copy(target),n=ticket,routeVersion=navigation,editor=state.draft,draft=copy(editor),preview=++previewSerial;
   const stillCurrent=()=>current(t,n)&&navigation===routeVersion&&state.draft===editor&&preview===previewSerial&&equal(state.draft,draft);
   try{
    const cal=state.pendingCalendar?createCalendar(state.pendingCalendar):calendar();if(!cal)throw new Error('请先选择历法');
    const chronology=normalizeChronology(draft.chronology);
    const source=await captureSource(t);
    if(!stillCurrent())return false;
    if(matchesSource&&!matchesSource(t,source))throw new Error('聊天消息已变化，请重新识别');
    const result=recognizeRecentDate(cal,source.messages,{settings:draft.recognition,chronology});
    if(result.date){state.draft.date=copy(result.date);delete state.draft.eraName;delete state.draft.eraYear;state.recognitionSource={floor:source.messages[result.provenance?.messageIndex]?.floor??result.provenance?.messageIndex,historical:result.historical===true};state.recognitionResult=true;state.error='';}
    else state.error='未识别到有效日期，已保留所填日期';
    notify();return !!result.date;
   }catch(error){return stillCurrent()?fail(error):false;}
  },
  remove(){if(state.draft?.catalogId)return Promise.resolve(fail(new Error('内置节日请恢复默认，不直接删除')));const draft=copy(state.draft),original=state.editorOriginal??undefined;return explicit(async()=>{await persist(time=>{if(!equal(time.items.find(item=>item.id===draft.id),original))throw new Error('事项已变化，请重新打开');return {...time,items:time.items.filter(item=>item.id!==draft.id)};});});},
  resetItem(){const original=state.editorOriginal;return explicit(async()=>{const replacement=initialHolidayItems(calendar()).find(item=>item.catalogId===original?.catalogId);if(!replacement)throw new Error('当前历法没有此默认条目');await persist(time=>{if(!equal(time.items.find(item=>item.id===original.id),original))throw new Error('事项已变化，请重新打开');return {...time,items:time.items.map(item=>item.id===original.id?replacement:item)};});});},
  jump(date){try{state.cursor=calendar().validate(date);notify();}catch{}},
  day(day){if(state.cursor){state.cursor={...state.cursor,day};notify();}},month(delta){const cal=calendar();if(!cal||!state.cursor)return;const next=cal.shiftMonths(state.cursor,delta);if(next){state.cursor=next;notify();}},today(){if(state.time.currentDate?.day!=null){state.cursor=copy(state.time.currentDate);notify();}},
  filter(value){state.filter=value;notify();},query(value){state.query=value;notify();},setScroll(route,value){state.scroll[route]=value;},setOpen(key,value){state.opened[key]=value;},
  memory(){if(!requestDiscard(onMemory))onMemory();},settings(){if(!requestDiscard(onSettings))onSettings();},close(){if(!requestDiscard(onClose))onClose();},suspend(){visible=false;},resume(){visible=true;notify();},
  workshop(){if(!requestDiscard(onWorkshop))onWorkshop();},
  benmo(){if(!requestDiscard(onBenmo))onBenmo();},
  dispose(){disposed=true;ticket++;resetWriter();unsubscribeDate?.();listeners.clear();}
 };
}
