const fields={people:'人物',location:'地点',locations:'地点',title:'标题',event:'事件词',detail:'细节词'};
const score=value=>{const shown=Number(value.toPrecision(4));return shown===value?String(shown):`约 ${shown}`;};
export const RECALL_RANKING_RULES=Object.freeze([
  '触发记忆先看是否有足够匹配，再按本轮关联分值排序。人物、地点、事件和细节的匹配方式共同影响分值，不是命中词越多就一定排在前面。',
  '历史楼层越远，影响越小；多条触发记忆共有的词、同类重复线索会减弱区分作用。同分沿原有记忆顺序，不代表哪条更重要，也不按简称更近或更长优先。',
  '常驻记忆不占触发名额。条数与正文 Token 上限在排序后应用，Token 边界保留最后一条完整正文；入选后的叙事排列不改变竞争排名。',
]);
function contributions(facts,reasons=[]){
  const parents=facts.contributions.filter(item=>item.value>0).map(item=>{
    const discounts=[];
    if(item.sourceKind!=='current'&&item.distanceFromCurrent>0&&item.sourceReliability<1)discounts.push('历史语境关联减弱');
    if(item.frequencyAdjustment<1)discounts.push('多条记忆共有，区分作用减弱');
    if(item.specificityAdjustment<1)discounts.push('短词区分作用减弱');
    if(item.matchReliability<1)discounts.push('部分匹配作用减弱');
    if(item.saturationFactor<1||item.suppressionReasons.includes('family-saturation'))discounts.push('同类重复作用减弱');
    const alias=reasons.find(reason=>reason.code==='alias-match'&&reason.alias===item.term&&reason.sourceKind===item.sourceKind&&reason.distanceFromCurrent===item.distanceFromCurrent&&reason.rankingEligible);
    const term=alias?`${fields[item.field]??'词'}“${alias.term}”的简称“${alias.alias}”`:`${fields[item.field]??'词'}“${item.term}”`;
    return {value:item.value,text:`${item.sourceKind==='current'?'当前输入':`最近第 ${item.distanceFromCurrent} 楼`}的${term}（${score(item.value)} 分${discounts.length?`，${discounts.join('、')}`:''}）`};
  });
  for(const combination of facts.combinations)parents.push({value:combination.value,text:`${combination.roles.map(role=>fields[role]??role).join('与')}在同段语境共同出现（${score(combination.value)} 分）`});
  parents.sort((left,right)=>right.value-left.value);
  return parents.length?parents.slice(0,3).map(item=>item.text).join('、')+(parents.length>3?'等':''):'没有足够的关联线索';
}
export function recallRankingReason(item){
  const facts=item.ranking;if(!facts)return '';
  if(facts.pool==='resident')return '常驻发送，不占触发记忆名额。';
  const parts=[`本轮主要匹配依据：${contributions(facts,item.reasons)}。`];
  if(facts.rank===null){parts.push(`关联证据不足，未进入触发排名（关联分值 ${score(facts.score)}）。`);return parts.join(' ');}
  if(!item.excludedReason)parts.push('本轮入选。');
  else parts.push(item.excludedReason==='token-limit'?'前面的正文已达到 Token 上限，因此本条未入选。':'本轮记忆名额已用完，因此本条未入选。');
  parts.push(`（关联分值 ${score(facts.score)}，本轮第 ${facts.rank} 名${item.excludedReason==='count-limit'?`，最多 ${facts.maxCount} 条`:''}）`);
  return parts.join(' ');
}
