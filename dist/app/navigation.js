const AREAS=[['memory','记忆'],['time','时间'],['benmo','本末'],['workshop','工坊'],['settings','设置']];
export function availableAreas(policy={memory:true,time:true,workshop:true,benmo:true,settings:true}){return AREAS.filter(([key])=>key==='settings'||policy[key]);}
export function mainNavigation({policy,current,attribute='data-action',actions={},attributes={}}={}){
 return `<nav class="ui-bottom-nav" aria-label="一级分区">${availableAreas(policy).map(([key,label])=>`<button type="button" class="ui-button ui-nav-item" ${attribute}="${actions[key]??key}" ${attributes[key]??''} ${key===current?'aria-current="page"':''}>${label}</button>`).join('')}</nav>`;
}

const BOOK_TITLES=Object.freeze({memory:'Memory',time:'Time',benmo:'Chronicles',workshop:'Scriptorium',settings:'Settings'});
export function rootTitle(area){
 const label=AREAS.find(([key])=>key===area)?.[1];
 if(!label)throw new TypeError('Unknown root area');
 return `<h1 class="ui-page-title"><span class="lt-title-native">${label}</span><span class="lt-book-title" aria-hidden="true">${BOOK_TITLES[area]}</span></h1>`;
}
