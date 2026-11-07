import {makeSettingsBackup,validateSettingsBackup,planSettingsRestore,applyChatSettingsRestore} from '../domain/settings-backup.js';
import {assertRoot} from '../domain/memory/model.js';
import {sameTarget} from '../domain/memory/repository.js';
import {isTheme} from './styles/theme.js';
const copy=structuredClone;
const labels={ai:'API 连接与任务分配',eventGeneration:'记忆生成',recall:'记忆召回',cumulativeGeneration:'古法总结',timeReminders:'时间提醒',workshop:'工坊栏目',scheduleTracking:'日程追踪',trackingPrompts:'物品与角色追踪',controls:'功能开关'};
const saveMethods={ai:'restoreAi',eventGeneration:'saveEventGeneration',recall:'saveRecall',cumulativeGeneration:'saveCumulativeGeneration',timeReminders:'saveTimeReminders',workshop:'saveWorkshop',scheduleTracking:'saveScheduleTracking',trackingPrompts:'saveTrackingPrompts',controls:'saveControls'};
const conflict=()=>new Error('设置或聊天已变化，请重新选择备份文件。');
const idle=()=>new Error('请先结束正在进行的任务或处理待审核内容，再恢复设置。');
const publicMessages=new Set(['设置备份格式无效，请选择兰台导出的设置文件。','无法读取设置备份，请选择兰台导出的 JSON 文件。','无法下载设置备份。','请先打开要备份设置的聊天。','请先打开要恢复设置的聊天。','请先重新读取外观设置。','外观恢复未完成，请重新读取外观设置。','存在同名但不同连接的 API 方案，请先调整方案名称后重新导入。','角色设置与当前角色名称存在冲突，请先调整角色配置后重新导入。','备份中的设置身份关联存在冲突。',conflict().message,idle().message]);
export function downloadSettingsBackup(doc,text,name){
 const win=doc?.defaultView??globalThis,BlobType=win.Blob??globalThis.Blob,urls=win.URL??globalThis.URL;
 if(!doc?.createElement||!BlobType||!urls?.createObjectURL)throw new Error('无法下载设置备份。');
 const url=urls.createObjectURL(new BlobType([text],{type:'application/json'}));let anchor;
 try{anchor=doc.createElement('a');anchor.href=url;anchor.download=name;doc.body.append(anchor);anchor.click();}finally{anchor?.remove();setTimeout(()=>urls.revokeObjectURL(url),0);}
 return true;
}
export function createSettingsBackupSession({settings,appearance,repository,getTarget=()=>repository?.captureTarget(),canRestore=()=>true,beginRestore=()=>()=>{},download,pluginVersion,now=()=>new Date().toISOString(),uuid}={}){
 let disposed=false,serial=0,pending=false,selection=null;
 let state={status:'ready',message:'',file:null,completed:[],missingCredentials:[]};const listeners=new Set();
 const inspect=()=>copy(state),publish=()=>{for(const fn of listeners)try{fn(inspect());}catch{}};
 const target=()=>{try{return getTarget()??null;}catch{return null;}};
 const contextMatches=value=>{const current=target();return value===null?current===null:sameTarget(value,current);};
 const busy=()=>!canRestore();
 const assertIdleRoot=root=>{if(root&&(root.summary?.pending||root.cumulative?.pending||root.narrative?.pendingRun))throw idle();};
 function clear(){selection=null;state={...state,file:null};}
 function fail(error,completed=[]){
  const unconfirmed=/UNCONFIRMED/.test(error?.code??'')||/未确认|尚未确认|未得到.*确认/.test(error?.message??'');
  state={...state,status:'error',completed, message:completed.length?`已恢复：${completed.join('、')}。${unconfirmed?'其余保存状态待确认，请重新读取后再导入。':'其余设置未完成，请重新选择备份文件后再试。'}`:unconfirmed?'保存状态待确认，请重新读取后再导入。':error?.code==='SETTINGS_CONFLICT'?conflict().message:publicMessages.has(error?.message)?error.message:'设置备份未完成，请重新读取设置后再试。'};
  // Do not retain a failed file's credentials or expose arbitrary host errors.
  clear();publish();return false;
 }
 async function exportFile({includeChat=false,includeCredentials=false}={}){
  if(disposed||pending)return false;pending=true;const ticket=++serial,owner=target();clear();state={...state,status:'exporting',message:'正在准备设置备份',completed:[],missingCredentials:[]};publish();
  try{
   const captured=await settings.captureBackup({includeCredentials});await appearance.ensure();const style=appearance.captureBackup();
   const root=includeChat?(owner?await repository.read(owner):(()=>{throw new Error('请先打开要备份设置的聊天。');})()):null;
   if(disposed||ticket!==serial||!contextMatches(owner)||settings.getEpoch()!==captured.epoch||!appearance.matchesBackup(style))throw conflict();
   const pack=makeSettingsBackup({settings:captured.settings,appearance:style,chatRoot:root,includeCredentials,pluginVersion,exportedAt:now()});
   await download(JSON.stringify(pack,null,2),`兰台设置备份-${pack.exportedAt.slice(0,10)}.json`);
   if(disposed||ticket!==serial)return false;state={...state,status:'ready',message:'已导出设置备份。'};publish();return true;
  }catch(error){return disposed||ticket!==serial?false:fail(error);}finally{if(ticket===serial)pending=false;if(!disposed)publish();}
 }
 async function readFile(file){
  if(disposed||pending)return false;pending=true;const ticket=++serial,owner=target();clear();state={...state,status:'reading',message:'正在读取设置备份',completed:[],missingCredentials:[]};publish();
  try{
   if(busy())throw idle();const captured=await settings.captureBackup({includeCredentials:true});await appearance.ensure();const style=appearance.captureBackup();
   let parsed;try{parsed=JSON.parse(await file.text());}catch{throw new Error('无法读取设置备份，请选择兰台导出的 JSON 文件。');}
   const pack=validateSettingsBackup(parsed),root=pack.chatSettings?(owner?await repository.read(owner):(()=>{throw new Error('请先打开要恢复设置的聊天。');})()):null;
   assertIdleRoot(root);
   if(disposed||ticket!==serial||!contextMatches(owner)||settings.getEpoch()!==captured.epoch||!appearance.matchesBackup(style))throw conflict();
   const plan=planSettingsRestore(pack,{settings:captured.settings,appearance:style,chatRoot:root,uuid});
   if(!isTheme(plan.appearance.theme))throw new Error('设置备份格式无效，请选择兰台导出的设置文件。');if(root)assertRoot(applyChatSettingsRestore(root,plan.chatSettings),owner);
   selection={ticket,owner,baseline:captured,style,root,plan};
   state={...state,status:'preview',message:'确认后恢复以下设置，已有聊天成果保留。',file:{name:String(file.name??'设置备份.json'),exportedAt:pack.exportedAt,pluginVersion:pack.pluginVersion,sections:[...Object.keys(pack.globalSettings).map(key=>labels[key]),'外观',...(pack.chatSettings?['当前聊天设置']:[])],includesCredentials:Object.hasOwn(pack,'credentials')},missingCredentials:plan.missingCredentials};publish();return true;
  }catch(error){return disposed||ticket!==serial?false:fail(error);}finally{if(ticket===serial)pending=false;if(!disposed)publish();}
 }
 async function restore(){
  if(disposed||pending||state.status!=='preview'||!selection)return false;pending=true;const chosen=selection,completed=[];let end=null,expectedEpoch=chosen.baseline.epoch;
  const valid=()=>!disposed&&serial===chosen.ticket&&contextMatches(chosen.owner)&&!busy();
  const check=()=>{if(!valid()||settings.getEpoch()!==expectedEpoch)throw conflict();};
  const saved=async result=>{const current=await settings.captureBackup();if(result.root.revision!==current.settings.revision)throw conflict();expectedEpoch=current.epoch;};
  try{
   if(busy())throw idle();check();if(!appearance.matchesBackup(chosen.style))throw conflict();if(chosen.root){assertIdleRoot(await repository.read(chosen.owner));if(JSON.stringify(await repository.read(chosen.owner))!==JSON.stringify(chosen.root))throw conflict();}
   end=beginRestore();if(typeof end!=='function')throw idle();state={...state,status:'restoring',message:'正在恢复设置',completed:[]};publish();
   for(const key of Object.keys(chosen.plan.globalSettings).filter(key=>key!=='controls')){
    check();const method=saveMethods[key],options={isCurrent:valid,expectedEpoch:chosen.baseline.epochs[key],requireConfirmation:true};
    const result=key==='ai'?await settings[method](chosen.plan.globalSettings[key],chosen.plan.credentials,options):await settings[method](chosen.plan.globalSettings[key],options);
    completed.push(labels[key]);await saved(result);
   }
   if(chosen.plan.chatSettings){check();await repository.restoreSettings(chosen.owner,chosen.root,chosen.plan.chatSettings,{isCurrent:valid});completed.push('当前聊天设置');}
   check();if(!appearance.matchesBackup(chosen.style))throw conflict();
   if(!await appearance.restoreBackup(chosen.plan.appearance,chosen.style,{isCurrent:valid}))throw Object.assign(new Error('外观恢复未完成，请重新读取外观设置。'),{code:appearance.inspect().confirmationRequired?'APPEARANCE_UNCONFIRMED':'APPEARANCE_CONFLICT'});completed.push('外观');
   if(chosen.plan.globalSettings.controls){check();const result=await settings.saveControls(chosen.plan.globalSettings.controls,{isCurrent:valid,expectedEpoch:chosen.baseline.epochs.controls,requireConfirmation:true});completed.push(labels.controls);await saved(result);}
   clear();state={...state,status:'ready',completed,message:'设置已恢复。',missingCredentials:chosen.plan.missingCredentials};publish();return true;
  }catch(error){return disposed?false:fail(error,completed);}finally{end?.();pending=false;if(!disposed)publish();}
 }
 return Object.freeze({inspect,exportFile,readFile,restore,cancel(){if(state.status==='restoring')return false;serial++;pending=false;clear();state={status:'ready',message:'',file:null,completed:[],missingCredentials:[]};publish();return true;},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},dispose(){disposed=true;serial++;selection=null;listeners.clear();}});
}

