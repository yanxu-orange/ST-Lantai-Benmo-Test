import { trackSettingsSave, waitForSettingsSaves, hasSettingsSaves } from './pending-settings-saves.js';
import {WORKSHOP_HIDE_RULE,WORKSHOP_STATUSBAR_RULE,WORKSHOP_STATUSBAR_LEGACY_RULE} from '../../domain/workshop/regex-rule.js';
export const HIDE_REGEX_MARKER='workshop-hide-regex-v1';
export const STATUS_REGEX_MARKER='workshop-statusbar-regex-v1';
const definitions=[
  {rule:WORKSHOP_HIDE_RULE,marker:HIDE_REGEX_MARKER,names:['时间与关键词记忆｜隐藏模块回收块','兰台本末｜隐藏工坊回收块'],patterns:['/<tkm_result\\b[^>]*>[\\s\\S]*?<\\/tkm_result>/g']},
  {rule:WORKSHOP_STATUSBAR_RULE,marker:STATUS_REGEX_MARKER,names:['砚序｜章节状态栏・杂志风・日夜持久化 v1'],patterns:[]},
];
function matches(rule,definition){
  return rule?.id===definition.rule.id||rule?.scriptName===definition.rule.scriptName||definition.names.includes(rule?.scriptName)
    ||rule?.markdownOnly===true&&rule?.promptOnly===false&&rule?.replaceString===definition.rule.replaceString
      &&[definition.rule.findRegex,...definition.patterns].includes(rule?.findRegex);
}
export const isWorkshopHideRule=rule=>matches(rule,definitions[0]);
export function createWorkshopRegexInstaller({settings,getContext,fetchImpl=globalThis.fetch,
  loadEngine=()=>import('/scripts/extensions/regex/engine.js'),loadHost=()=>import('/script.js'),readServerRules,saveHost,isCurrent=()=>true}={}){
  let pending=null;
  const check=()=>{if(!isCurrent())throw new Error('插件已停用，正则安装已停止');};
  async function readDisk(){
    if(readServerRules)return readServerRules();
    const context=getContext(),response=await fetchImpl('/api/settings/get',{method:'POST',headers:context.getRequestHeaders(),body:JSON.stringify({})});
    if(!response.ok)throw new Error('正则保存尚未确认');
    const body=await response.json(),data=typeof body.settings==='string'?JSON.parse(body.settings):body.settings;
    return data?.extension_settings?.regex;
  }
  async function saveMarker(snapshot,marker){check();const result=await settings.saveWorkshop({...snapshot.workshop,imports:[...snapshot.workshop.imports,marker]},{expectedEpoch:snapshot.epoch,isCurrent});check();if(result.status!=='committed')throw new Error('正则安装状态尚未保存确认');}
  async function ensure({settingsReady=false}={}){
    check();const outcomes=[];
    if(!settingsReady)await settings.read();
    check();const initial=settings.captureWorkshop();
    if(definitions.every(d=>initial.workshop.imports.includes(d.marker)))return {status:'already-handled'};
    const engine=await loadEngine();check();
    if(typeof engine.getScriptsByType!=='function'||typeof engine.saveScriptsByType!=='function'||engine.SCRIPT_TYPES?.GLOBAL===undefined)throw new Error('当前酒馆缺少正则安装接口');
    for(const definition of definitions){
      let snapshot=settings.captureWorkshop();
      if(snapshot.workshop.imports.includes(definition.marker))continue;
      const attempted=definition.marker+'-attempted',previousAttempt=snapshot.workshop.imports.includes(attempted);
      if(!previousAttempt)await saveMarker(snapshot,attempted);
      const hostSettings=getContext().extensionSettings;
      // Finish the earlier marker snapshot before installing host regex data.
      while(hasSettingsSaves(hostSettings)){await waitForSettingsSaves(hostSettings);check();}
      if(getContext().extensionSettings!==hostSettings)throw new Error('酒馆设置已变化，正则安装已停止');
      const rules=engine.getScriptsByType(engine.SCRIPT_TYPES.GLOBAL);
      if(!Array.isArray(rules))throw new Error('无法读取酒馆正则');
      const index=rules.findIndex(rule=>matches(rule,definition)),next=structuredClone(rules);
      if(index<0&&previousAttempt)throw new Error('这条正则曾安装中断或已被删除，已保留现状；可手动导入正则文件');
      if(index<0)next.push(structuredClone(definition.rule));
      else {
        if(definition.names.includes(next[index].scriptName))next[index].scriptName=definition.rule.scriptName;
        if(definition.marker===STATUS_REGEX_MARKER&&next[index].findRegex===WORKSHOP_STATUSBAR_LEGACY_RULE.findRegex&&next[index].replaceString===WORKSHOP_STATUSBAR_LEGACY_RULE.replaceString)next[index].replaceString=WORKSHOP_STATUSBAR_RULE.replaceString;
      }
      check();if(JSON.stringify(next)!==JSON.stringify(rules))await engine.saveScriptsByType(next,engine.SCRIPT_TYPES.GLOBAL);
      check();
      const save=saveHost??(await loadHost()).saveSettings;
      check();if(typeof save!=='function')throw new Error('无法确认正则保存');
      while(hasSettingsSaves(hostSettings)){await waitForSettingsSaves(hostSettings);check();}
      if(getContext().extensionSettings!==hostSettings)throw new Error('酒馆设置已变化，正则安装已停止');
      const saving=save();trackSettingsSave(hostSettings,saving);await saving;
      check();const disk=await readDisk();check();
      if(!Array.isArray(disk)||!disk.some(rule=>matches(rule,definition)))throw new Error('正则保存尚未确认');
      snapshot=settings.captureWorkshop();
      if(!snapshot.workshop.imports.includes(definition.marker))await saveMarker(snapshot,definition.marker);
      outcomes.push({name:definition.rule.scriptName,status:index<0?'installed':'kept-existing'});
    }
    return {status:'handled',outcomes};
  }
  return {ensure(options){if(!pending)pending=ensure(options).finally(()=>{pending=null;});return pending;}};
}
