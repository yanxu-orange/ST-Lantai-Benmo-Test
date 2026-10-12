import {generationSourceOf,workshopSyncContent} from './model.js';
import {currentResult,resultText} from './results.js';
export function applicableModules(globalWorkshop, chatWorkshop, characterKey = null) {
  return [
    ...globalWorkshop.modules.filter(module => module.scope === 'global' || module.scope === 'character' && module.characterKey === characterKey),
    ...chatWorkshop.modules.filter(module => module.scope === 'chat'),
  ].filter(module => module.enabled);
}
export const WORKSHOP_SYNC_OPENINGS=Object.freeze({
 story:'续写时，如需调用相关信息或者设定，请参考此前记录的最新状态。完成本轮正文后，再根据本轮剧情更新这份记录。',
 background:'请根据本轮剧情更新此前记录。',
});
export function workshopTrackingInstructions(module,source=generationSourceOf(module)){
 if(module.lifecycle!=='sync')return module.content;
 return `【追踪要求】\n${WORKSHOP_SYNC_OPENINGS[source]}${workshopSyncContent(module)}`;
}
export function workshopPreviousRecord(text){return `【此前记录】\n这是本项追踪最近一次保存的记录：\n${text}`;}
export function workshopCaptureInstruction(module){return `将本模块要求生成的内容完整写在 <tkm_result module="${module.captureTag}"> 与 </tkm_result> 之间。保留要求中的内部标签。`;}
export function composeWorkshopPrompts(modules, results) {
  const seen = new Set();
  return modules.flatMap(module => {
    if (seen.has(module.id)) throw new Error('模块身份重复');
    seen.add(module.id);
    if(generationSourceOf(module)==='background') {
      if(module.lifecycle!=='sync')return [];
      const current=currentResult(results,module.id);
      return current?[{id:module.id,depth:module.depth,role:module.role,text:resultText(current)}]:[];
    }
    let text=module.content;
    if(module.lifecycle==='collect')text=[module.content,workshopCaptureInstruction(module)].filter(Boolean).join('\n\n');
    if(module.lifecycle==='sync') {
      const current = currentResult(results,module.id);
      text=[current?workshopPreviousRecord(resultText(current)):'',workshopTrackingInstructions(module,'story'),`【输出格式】\n${workshopCaptureInstruction(module)}`].filter(Boolean).join('\n\n');
    }
    return {id:module.id,depth:module.depth,role:module.role,text};
  });
}
