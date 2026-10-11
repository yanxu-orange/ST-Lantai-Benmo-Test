import {WORKSHOP_REPLY_KEY} from './workshop-identities.js';

// Display-only adapter. No chat/result writes and no prompt-phase regex pass.
// The public Helper owns rule scope, disabled flags, placement and depth limits.
export function createWorkshopDisplayFormatter({getContext,getHelper=()=>globalThis.TavernHelper,loadLibrary=()=>import('/lib.js')}={}) {
  let libraryPromise,serial=0;const identities=new WeakMap();
  const identity=value=>{if(!identities.has(value))identities.set(value,++serial);return identities.get(value);};
  const library=()=>libraryPromise??=(Promise.resolve().then(loadLibrary).catch(error=>{libraryPromise=null;throw error;}));
  function capture(floor){
    try{
      const context=getContext?.(),helper=getHelper(),chat=context?.chat,message=chat?.[floor];
      const chatIdentity=()=>{const ctx=getContext?.();return JSON.stringify([ctx?.getCurrentChatId?.()??ctx?.chatId,ctx?.characterId,ctx?.groupId]);};
      const chatToken=chatIdentity();
      const ownsChat=()=>{try{return getContext?.()?.chat===chat&&chatIdentity()===chatToken;}catch{return false;}};
      // ST's refreshOneMessage -> messageFormatting can mutate chat[0].mes.
      // Reject before invoking either formatting or refresh, not by writing back.
      if(!Number.isSafeInteger(floor)||floor<=0||!message||message.is_system
        ||typeof helper?.formatAsTavernRegexedString!=='function'||typeof helper?.builtin?.renderMarkdown!=='function'
        ||typeof helper?.refreshOneMessage!=='function'||typeof helper?.getTavernRegexes!=='function')return null;
      const text=message.mes,swipe=message.swipe_id,name=message.name,user=message.is_user,reply=message.extra?.[WORKSHOP_REPLY_KEY];
      const source=user?'user_input':message.extra?.type==='narrator'?'slash_command':'ai_output';
      const depth=chat.slice(floor+1).filter(row=>!row.is_system).length;
      // This is an invalidation fingerprint, NOT our own rule-selection engine.
      // The Helper's legacy no-argument getter omits preset rules, so use types.
      const rules=()=>JSON.stringify([
        ...['global','preset','character'].map(type=>helper.getTavernRegexes({type})),
        getContext()?.extensionSettings?.disabledExtensions,
        getContext()?.extensionSettings?.character_allowed_regex,
        getContext()?.extensionSettings?.preset_allowed_regex,
      ]);
      const ruleKey=rules(),key=JSON.stringify([identity(helper),identity(chat),identity(message),text,swipe,reply,source,name,depth,ruleKey]);
      const isCurrent=()=>{
        try{return ownsChat()&&chat[floor]===message&&message.mes===text&&message.swipe_id===swipe
          &&message.extra?.[WORKSHOP_REPLY_KEY]===reply&&message.name===name&&message.is_user===user&&!message.is_system&&getHelper()===helper
          &&(user?'user_input':message.extra?.type==='narrator'?'slash_command':'ai_output')===source
          &&chat.slice(floor+1).filter(row=>!row.is_system).length===depth&&rules()===ruleKey;}catch{return false;}
      };
      return {key,helper,isCurrent,ownsChat,
        async format(raw){
          try{
            const lib=await library();if(!isCurrent()||typeof lib.DOMPurify?.sanitize!=='function')return null;
            const regexed=helper.formatAsTavernRegexedString(raw,source,'display',{depth,character_name:name});
            // Blank display replacements also keep the original readable here.
            if(typeof regexed!=='string'||!regexed.trim()||regexed===raw||!isCurrent())return null;
            const markdown=helper.builtin.renderMarkdown(regexed);
            if(typeof markdown!=='string'||!isCurrent())return null;
            // Same DOMPurify instance and MESSAGE_SANITIZE hooks as ST's
            // messageFormatting. Hooks are installed before initExtensions.
            // Calling sanitize directly avoids its floor-0 writes, auto-fix
            // and all repeat regex/Markdown passes. Outer CSS is unsupported;
            // escaped fenced HTML (including its style text) stays intact.
            const html=lib.DOMPurify.sanitize(markdown,{RETURN_DOM:false,RETURN_DOM_FRAGMENT:false,RETURN_TRUSTED_TYPE:false,
              MESSAGE_SANITIZE:true,FORBID_TAGS:['style','custom-style'],KEEP_CONTENT:false});
            return typeof html==='string'&&html.trim()&&isCurrent()?html:null;
          }catch{return null;}
        },
        // Compatibility probe, not a public arbitrary-container mount API.
        // The pinned Helper scanner wraps frontend pre nodes synchronously.
        // Missing/changed DOM contract fails closed to readable original text.
        captureTakeover(body){
          const candidates=[...(body.querySelectorAll?.('pre')??[])].filter(pre=>['html>','<head>','<body'].some(marker=>pre.textContent.includes(marker)));
          const taken=pre=>body.contains(pre)&&pre.parentNode?.classList?.contains('TH-render');
          const check=()=>candidates.every(taken);check.needsCleanup=()=>candidates.some(taken);return check;
        },
        async refresh(){if(!isCurrent())return false;await helper.refreshOneMessage(floor);return isCurrent();},
      };
    }catch{return null;}
  }
  return {capture};
}
