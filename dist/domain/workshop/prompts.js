import {generationSourceOf} from './model.js';
import {currentResult,resultText} from './results.js';
export function applicableModules(globalWorkshop, chatWorkshop, characterKey = null) {
  return [
    ...globalWorkshop.modules.filter(module => module.scope === 'global' || module.scope === 'character' && module.characterKey === characterKey),
    ...chatWorkshop.modules.filter(module => module.scope === 'chat'),
  ].filter(module => module.enabled);
}
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
    const parts = [module.content.trim()];
    if(module.lifecycle !== 'prompt') {
      parts.push(`将本模块要求生成的内容完整写在 <tkm_result module="${module.captureTag}"> 与 </tkm_result> 之间。保留要求中的内部标签。`);
    }
    if(module.lifecycle === 'sync') {
      const current = currentResult(results,module.id);
      if(current) parts.push(`此前记录：\n${resultText(current)}`);
    }
    return {id:module.id,depth:module.depth,role:module.role,text:parts.filter(Boolean).join('\n\n')};
  });
}
