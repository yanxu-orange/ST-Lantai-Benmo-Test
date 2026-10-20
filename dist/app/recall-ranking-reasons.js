const fields={people:'人物',location:'地点',locations:'地点',title:'标题',event:'事件词',detail:'细节词'};
const position=row=>row.sourceKind==='current'?'当前输入':Number.isFinite(row.distanceFromCurrent)?`最近第 ${row.distanceFromCurrent} 楼`:'语境';
function groupedWords(rows){
  const used=new Set(),chosen=[];
  for(const row of [...rows].sort((a,b)=>b.value-a.value)){
    const key=JSON.stringify([row.position,row.word]);if(used.has(key))continue;used.add(key);chosen.push(row);if(chosen.length===3)break;
  }
  const groups=new Map();for(const row of chosen){if(!groups.has(row.position))groups.set(row.position,[]);groups.get(row.position).push(row.text);}
  return [...groups].sort(([a],[b])=>a==='当前输入'?-1:b==='当前输入'?1:Number(a.match(/\d+/)?.[0]??0)-Number(b.match(/\d+/)?.[0]??0)).map(([place,words])=>`${place}：${words.join('、')}`).join('；');
}
function contributions(facts,reasons=[]){
  return groupedWords((facts.contributions??[]).filter(item=>item.value>0).map(item=>{
    const alias=reasons.find(reason=>reason.code==='alias-match'&&reason.alias===item.term&&reason.sourceKind===item.sourceKind&&reason.distanceFromCurrent===item.distanceFromCurrent&&reason.rankingEligible);
    const term=alias?`${fields[item.field]??'词'}“${alias.term}”的简称“${alias.alias}”`:item.matchedAlias?`${fields[item.field]??'词'}“${item.term}”的别名“${item.matchedAlias}”`:`${fields[item.field]??'词'}“${item.term}”`;
    return {position:position(item),word:item.matchedAlias??item.term,value:item.value,text:term};
  }))||'没有足够的关联线索';
}
export function recallRankingReason(item){
  const facts=item.ranking;if(!facts)return '';
  if(facts.method){
    const why={'count-limit':'普通记忆名额已用完。','token-limit':'前面的完整正文已达到 Token 软上限。','candidate-limit':'未进入各路去重补位后的候选名额。','date-conflict':'当前整段明确日期查询与记忆日期相斥。','channel-disabled':'关键词、BM25和向量通道已关闭；本轮没有日期支持。','channel-unavailable':'向量通道未就绪或请求失败，其他可用通道证据不足。','insufficient-evidence':'已启用通道未产生足够的候选依据。','special-limit':'时间名额已用完或关闭，未由普通池选入。'}[item.excludedReason];
    const evidence=item.routeEvidence??{},details=[];
    if(evidence.keyword&&(evidence.keyword.contributions??[]).some(row=>row.value>0))details.push(`关键词：${contributions(evidence.keyword,item.reasons)}。`);
    const body=(evidence.bm25?.contributions??[]).flatMap(row=>(row.termContributions??[]).map(term=>({word:term.term,text:`“${term.term}”`,value:term.score*row.weight,position:position(row)})));
    if(body.length)details.push(`BM25：${groupedWords(body)}。`);
    const dates=evidence.date?.supports??[];if(dates.length)details.push(`指定日期：${groupedWords(dates.map(row=>({position:position(row.target),word:row.target.raw,text:`“${row.target.raw}”`,value:1})))}。`);
    if(Number.isSafeInteger(evidence.vector?.rank))details.push(`向量：检索第 ${evidence.vector.rank} 名。`);
    if(Number.isSafeInteger(evidence.rerank?.rank)&&evidence.rerank.rank!==facts.rank)details.push(`重排：第 ${evidence.rerank.rank} 名。`);
    const result=why?why.replace(/[。]$/,'')+'，未入选。':'已入选。';
    details.push(facts.rank===null?result:`本轮第 ${facts.rank} 名，${result}`);
    return details.join('\n');
  }
  if(facts.pool==='special'){const hit=item.dateEvidence?.special??[],words=[...new Set((item.reasons??[]).filter(x=>['keyword-match','alias-match'].includes(x.code)).map(x=>x.alias??x.term).filter(Boolean))].slice(0,3),dates=[...new Set(hit.map(x=>x.matchedLabel??(x.matchedDate?`${x.matchedDate.year}年${x.matchedDate.month}月${x.matchedDate.day}日`:'')).filter(Boolean))];return `时间记忆匹配：${hit.some(x=>x.kind==='named-origin')?'纪念日发生年份':hit.some(x=>x.kind==='named-same-day')?'纪念日对应的过去经历':'历史同日'}${dates.length?`（${dates.join('、')}）`:''}${words.length?`；同时命中关键词或简称：${words.join('、')}`:''}。本轮入选，不占普通名额。`;}
  if(facts.pool==='resident'){const hits=[...new Set((item.reasons??[]).filter(x=>['keyword-match','alias-match'].includes(x.code)).map(x=>x.alias??x.term).filter(Boolean))],dates=(item.dateEvidence?.ordinary??[]).filter(x=>x.relation==='support').map(x=>x.target.raw);return `常驻发送，不占触发记忆名额。${hits.length?`同时命中：${hits.slice(0,3).join('、')}。`:''}${dates.length?`日期匹配：${[...new Set(dates)].join('、')}。`:''}`;}
  const dates=item.dateEvidence?.ordinary??[],supports=dates.filter(x=>x.relation==='support');
  const currentDates=dates.filter(x=>x.target?.fragmentId==='current:0');
  const hasConflict=currentDates.some(x=>x.relation==='conflict')&&!currentDates.some(x=>x.relation==='support');
  if(hasConflict&&item.excludedReason)return '当前输入的明确日期与这条记忆冲突，本轮未选入。';
  if(item.excludedReason==='special-limit')return '符合日期纪念条件，但本轮日期纪念名额已用完或关闭；普通匹配依据不足。';
  const dateText=supports.length?`日期匹配：${groupedWords(supports.map(row=>({position:position(row.target),word:row.target.raw,text:`“${row.target.raw}”`,value:1})))}`:'';
  const structural=(facts.contributions??[]).some(x=>x.value>0)||(facts.combinations??[]).some(x=>x.value>0);
  const parts=[`本轮主要匹配依据：${dateText?[dateText,structural?contributions(facts,item.reasons):''].filter(Boolean).join('；'):contributions(facts,item.reasons)}。`];
  if(facts.rank===null){parts.push('关联证据不足，未进入触发排名。');return parts.join('\n');}
  const why=!item.excludedReason?'已入选。':item.excludedReason==='token-limit'?'前面的正文已达到 Token 上限，未入选。':`记忆名额已用完（最多 ${facts.maxCount} 条），未入选。`;
  parts.push(`本轮第 ${facts.rank} 名，${why}`);
  return parts.join('\n');
}
