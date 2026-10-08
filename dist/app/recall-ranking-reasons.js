const fields={people:'人物',location:'地点',locations:'地点',title:'标题',event:'事件词',detail:'细节词'};
const score=value=>{const shown=Number(value.toPrecision(4));return shown===value?String(shown):`约 ${shown}`;};
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
  if(facts.pool==='special'){const hit=item.dateEvidence?.special??[],words=[...new Set((item.reasons??[]).filter(x=>['keyword-match','alias-match'].includes(x.code)).map(x=>x.alias??x.term).filter(Boolean))].slice(0,3),dates=[...new Set(hit.map(x=>x.matchedLabel??(x.matchedDate?`${x.matchedDate.year}年${x.matchedDate.month}月${x.matchedDate.day}日`:'')).filter(Boolean))];return `时间记忆匹配：${hit.some(x=>x.kind==='named-origin')?'纪念日发生年份':hit.some(x=>x.kind==='named-same-day')?'纪念日对应的过去经历':'历史同日'}${dates.length?`（${dates.join('、')}）`:''}${words.length?`；同时命中关键词或简称：${words.join('、')}`:''}。本轮入选，不占普通名额。`;}
  if(facts.pool==='resident'){const hits=[...new Set((item.reasons??[]).filter(x=>['keyword-match','alias-match'].includes(x.code)).map(x=>x.alias??x.term).filter(Boolean))],dates=(item.dateEvidence?.ordinary??[]).filter(x=>x.relation==='support').map(x=>x.target.raw);return `常驻发送，不占触发记忆名额。${hits.length?`同时命中：${hits.slice(0,3).join('、')}。`:''}${dates.length?`日期匹配：${[...new Set(dates)].join('、')}。`:''}`;}
  const dates=item.dateEvidence?.ordinary??[],supports=dates.filter(x=>x.relation==='support');
  const currentDates=dates.filter(x=>x.target?.fragmentId==='current:0');
  const hasConflict=currentDates.some(x=>x.relation==='conflict')&&!currentDates.some(x=>x.relation==='support');
  if(hasConflict&&item.excludedReason)return '当前输入的明确日期与这条记忆冲突，本轮未选入。';
  if(item.excludedReason==='special-limit')return '符合日期纪念条件，但本轮日期纪念名额已用完或关闭；普通匹配依据不足。';
  const dateText=supports.length?`日期匹配：${[...new Set(supports.map(x=>x.target.raw))].join('、')}`:'';
  const structural=(facts.contributions??[]).some(x=>x.value>0)||(facts.combinations??[]).some(x=>x.value>0);
  const parts=[`本轮主要匹配依据：${dateText?[dateText,structural?contributions(facts,item.reasons):''].filter(Boolean).join('；'):contributions(facts,item.reasons)}。`];
  if(facts.rank===null){parts.push(`关联证据不足，未进入触发排名（关联分值 ${score(facts.score)}）。`);return parts.join(' ');}
  if(!item.excludedReason)parts.push('本轮入选。');
  else parts.push(item.excludedReason==='token-limit'?'前面的正文已达到 Token 上限，因此本条未入选。':'本轮记忆名额已用完，因此本条未入选。');
  parts.push(`（关联分值 ${score(facts.score)}，本轮第 ${facts.rank} 名${item.excludedReason==='count-limit'?`，最多 ${facts.maxCount} 条`:''}）`);
  return parts.join(' ');
}
