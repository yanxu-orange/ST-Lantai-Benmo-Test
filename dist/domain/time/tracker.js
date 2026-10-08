import {recognitionSettings} from './source.js';
import {createMessageDateParser} from './recognition.js';
import {replayDateMessages} from './replay.js';
import {resolveManualAnchor} from './anchor.js';
const copy=structuredClone;
const same=(a,b)=>a?.identity===b?.identity&&a?.role===b?.role&&a?.text===b?.text&&a?.content===b?.content&&a?.swipeId===b?.swipeId;
// One active-chat, disposable cache. It holds immutable text references rather
// than serialized copies, and never serves as persisted date authority.
export function createDateTracker(calendar,{settings={},chronology={eras:[]},manualAnchor=null}={}){
 const config=recognitionSettings(settings),anchor=copy(manualAnchor),parse=createMessageDateParser(calendar,{settings:config,chronology});
 let prior=null,entries=[],last=null,boundaryKey=null;
 return {
  clear(){prior=null;entries=[];last=null;boundaryKey=null;},
  reconcile(messages){
   if(!Array.isArray(messages))throw new TypeError('日期识别来源无效');
   const boundary=anchor?resolveManualAnchor(calendar,anchor,messages):{date:null,startIndex:0};
   if(!boundary)return {status:'needs-calibration',date:anchor?copy(anchor.date):null,parsedMessages:0};
   const key=JSON.stringify(boundary);if(boundaryKey!==key){prior=null;entries=[];last=null;boundaryKey=key;}
   let common=0;
   if(prior)while(common<Math.min(prior.length,messages.length)&&same(prior[common],messages[common]))common++;
   if(prior&&common===prior.length&&common===messages.length)return {...copy(last),status:'unchanged',parsedMessages:0};
   const cold=prior===null,start=Math.max(boundary.startIndex,common);
   const base=start===boundary.startIndex?boundary.date:entries[start-1]?.after??boundary.date;
   const result=replayDateMessages(calendar,messages,{parse,baseDate:base,startIndex:start,allowAssistantRollback:config.scope==='tags'});
   const kept=entries.slice(0,start);
   while(kept.length<start)kept.push({messageIndex:kept.length,before:null,after:null,matched:false});
   entries=[...kept,...result.entries];
   // Only source fields needed to detect edits/swipes/replacement are retained.
   prior=messages.map(message=>message?{identity:message.identity,role:message.role,text:message.text,content:message.content,swipeId:message.swipeId}:null);
   const lastMatch=entries.findLast(item=>item.matched);
   last={date:result.date,provenance:lastMatch?{source:messages[lastMatch.messageIndex]?.role,messageIndex:lastMatch.messageIndex}:boundary.date?{source:'manual',messageIndex:null}:null};
   return {...copy(last),status:'reconciled',parsedMessages:messages.length-start,historical:cold||start<Math.max(0,messages.length-config.lookback)};
  },
 };
}

// Explicit user-requested correction trusts recent eligible messages, including
// a newer date earlier than an old mistaken year. Background replay keeps its
// separate anti-rollback policy. Older history is consulted only for an anchor
// when the configured raw window cannot establish any date by itself.
export function recognizeRecentDate(calendar,messages,{settings={},chronology={eras:[]}}={}){
 if(!Array.isArray(messages))throw new TypeError('日期识别来源无效');
 const config=recognitionSettings(settings),parse=createMessageDateParser(calendar,{settings:config,chronology});
 const startIndex=Math.max(0,messages.length-config.lookback);
 if(!config.users&&!config.assistant)return {date:null,provenance:null,matchedCount:0,entries:[],historical:false,parsedMessages:0};
 const recent=replayDateMessages(calendar,messages,{parse,startIndex,allowAssistantRollback:true});
 if(recent.date!==null||startIndex===0)return {...recent,historical:false,parsedMessages:messages.length-startIndex};
 for(let i=startIndex-1;i>=0;i--){
  if(parse(messages[i],null)===null)continue;
  return {...replayDateMessages(calendar,messages,{parse,startIndex:i,allowAssistantRollback:true}),historical:true,parsedMessages:messages.length-i};
 }
 return {...recent,historical:true,parsedMessages:messages.length};
}
