const statusPrompt=`<状态栏>\n在<content>正文之前生成本轮状态栏，每一轮新正文都需更新。\n\n状态栏包含：\n章节号与符合本轮剧情的章节标题；\n本轮故事发生的起止时间；\n本轮故事涉及的全部完整地点；\n本轮天气。\n\n格式：\n<scene>\n{{第X章}} · {{符合本轮剧情的章节标题，不超过8个字}}\n{{YYYY年MM月DD日 星期X HH:MM-HH:MM}}\n{{本轮全部完整地点}}\n{{天气}}\n</scene>\n\n每轮新正文，章节号在上一章基础上+1。\n</状态栏>`;
const previous={collect:'每回合在正文之后写一则轻松的小剧场，主题是旅途中的小意外。保持人物性格，不改变正文已发生的事实。',sync:'根据本轮正文更新随身物品清单。记录物品名称、数量、持有人和本轮变化；没有依据的变化不要添加。每次输出完整的当前清单。'};
const previousV2={
 prompt:'提示词注入示例：可以在这里填写希望 AI 遵守的写作规则，例如状态栏、小剧场或人物表现要求。启用后，正文中的要求会随对话发送。请按自己的需要修改。\n\n示例规则：\n描写人物时，通过具体的语言、动作和选择表现性格。不要替用户控制的角色作出重要决定。',
 collect:'内容收集示例：要求 AI 每回合写一则小剧场，生成后可以在“查看结果”中翻看收集记录。请按自己的需要修改主题。\n\n示例要求：\n'+previous.collect,
 sync:'长期追踪示例：收集本回合的物品清单，并在下一回合发送给 AI，便于持续更新。请按自己的需要修改追踪项目。\n\n示例要求：\n'+previous.sync,
};
const examples={
 prompt:'提示词注入：\n将此处填写的内容发送给 AI，用来补充要求或规则。\neg：状态栏生成要求，写作要求。\n\n使用方法：新建条目，填写内容，选择作用范围和注入位置，保存并开启。',
 collect:'内容收集：\n让 AI 按此处填写的要求生成内容，并收集到工坊，方便集中查看。\neg：小剧场，剧情记录。\n\n使用方法：新建条目，填写内容，选择作用范围和注入位置，保存并开启。生成后，点击“查看结果”阅读、编辑或删除记录。',
 sync:'长期追踪：\n收集 AI 按此处要求生成的信息，并在下一回合发送给 AI，供其继续参考和更新。\neg：物品变化，角色认知。\n\n使用方法：新建条目，填写追踪内容与更新要求，选择作用范围和注入位置，保存并开启。生成后，点击“查看结果”查看或修改记录。',
};
export function createWorkshopExamples() {
 const base={scope:'global',role:'system',depth:0,enabled:false};
 return [
  {...base,id:'lantai-example-prompt',name:'时间状态栏',content:statusPrompt,lifecycle:'prompt',captureTag:null,example:false},
  ...['prompt','collect','sync'].map((lifecycle,index)=>({...base,id:lifecycle==='prompt'?'lantai-example-injection':`lantai-example-${lifecycle}`,name:['提示词注入功能介绍','内容收集功能介绍','长期追踪功能介绍'][index],content:examples[lifecycle],lifecycle,captureTag:index?`g${index}`:null,example:true})),
 ];
}
// Only untouched defaults are revised. User text, switches, scopes and result identities survive.
export function reviseWorkshopExamples(modules) {
 const next=structuredClone(modules), defaults=createWorkshopExamples();
 for(const row of next){
  if(row.example!==true)continue;
  if(row.id==='lantai-example-prompt'){
   row.example=false;
   if(row.name==='剧情状态栏')row.name='时间状态栏';
  }else if(['lantai-example-injection','lantai-example-collect','lantai-example-sync'].includes(row.id)){
   const replacement=defaults.find(item=>item.id===row.id);
   const oldNames={prompt:['提示词注入示例'],collect:['小剧场收藏夹','小剧场收藏示例'],sync:['物品追踪','物品追踪示例']};
   if(oldNames[row.lifecycle]?.includes(row.name))row.name=replacement.name;
   if(row.content===previous[row.lifecycle]||row.content===previousV2[row.lifecycle])row.content=replacement.content;
  }
 }
 return next;
}
