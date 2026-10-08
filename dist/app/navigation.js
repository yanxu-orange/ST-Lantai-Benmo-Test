const AREAS=[['memory','记忆'],['time','时间'],['workshop','工坊'],['settings','设置']];
export function availableAreas(policy={memory:true,time:true,workshop:true,settings:true}){return AREAS.filter(([key])=>key==='settings'||policy[key]);}
export function mainNavigation({policy,current,attribute='data-action',actions={},attributes={}}={}){
 return `<nav class="ui-bottom-nav" aria-label="一级分区">${availableAreas(policy).map(([key,label])=>`<button type="button" class="ui-button ui-nav-item" ${attribute}="${actions[key]??key}" ${attributes[key]??''} ${key===current?'aria-current="page"':''}>${label}</button>`).join('')}</nav>`;
}
