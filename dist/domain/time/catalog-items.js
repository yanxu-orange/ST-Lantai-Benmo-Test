import {holidayCatalog} from './holiday-catalog.js';
import {ruleSupport,normalizeDateRule} from './date-rule.js';
const categories={'traditional-cn':'中国传统节日','solar-terms':'节气','modern-common':'现代常见节日','western-common':'西方常见节日'};
export function initialHolidayItems(calendar){
 const catalog=holidayCatalog(),modern=calendar.definition.type==='modern';
 return catalog.templates.filter(template=>{
  const pack=catalog.packs.find(item=>item.id===template.packId);
  return (modern?pack.modern:calendar.definition.type==='dynasty'&&(pack.fictional||template.packId==='solar-terms'))&&ruleSupport(calendar,template.rule).supported;
 }).map(template=>({id:`${calendar.definition.id}:catalog:${template.id}`,kind:'holiday',calendarId:calendar.definition.id,title:template.name,catalogId:template.id,packId:template.packId,category:categories[template.packId],dateRule:normalizeDateRule(template.rule),startDate:null,repeat:'yearly',durationDays:1,advanceDays:null,enabled:true,show:true,remind:false,description:template.fact,instruction:''}));
}
