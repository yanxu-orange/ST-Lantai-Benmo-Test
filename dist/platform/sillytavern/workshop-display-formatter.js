import {WORKSHOP_REPLY_KEY} from './workshop-identities.js';

// Display-only adapter. No chat/result writes and no prompt-phase regex pass.
// The public Helper owns rule scope, disabled flags, placement and depth limits.
export function createWorkshopDisplayFormatter({getContext,getHelper=()=>globalThis.TavernHelper,loadLibrary=()=>import('/lib.js'),loadStyles=()=>import('/scripts/chats.js')}={}) {
  let libraryPromise,stylesPromise,serial=0;const identities=new WeakMap();
  const identity=value=>{if(!identities.has(value))identities.set(value,++serial);return identities.get(value);};
  const library=()=>libraryPromise??=(Promise.resolve().then(loadLibrary).catch(error=>{libraryPromise=null;throw error;}));
  const styleHelpers=()=>stylesPromise??=(Promise.resolve().then(loadStyles).catch(error=>{stylesPromise=null;throw error;}));
  // Only actual HTML or a fenced frontend qualifies when display rules leave
  // input unchanged. Plain text and model-only tags stay readable verbatim.
  const hasHtml=text=>/<(?:html|head|body|section|article|aside|header|footer|main|nav|details|summary|div|span|p|br|hr|h[1-6]|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|th|td|caption|blockquote|pre|code|b|strong|i|em|small|s|u|sub|sup|mark|a|img|figure|figcaption|button|label|input|select|option|textarea|fieldset|legend|form|center|font|svg|audio|video|source|style)\b[^>]*>/i.test(text)
    || /(?:^|\n)\s*```[^\n]*\n[\s\S]*?(?:html>|<head>|<body)/i.test(text);
  function removeCssComments(node){
    // The host parser represents comments in declarations without a value.
    // Older host decoders call value.includes when external media is blocked.
    // Use its own AST and remove comments, never parse CSS with string regexes.
    if(!node||typeof node!=='object')return;
    for(const key of ['rules','declarations','keyframes'])if(Array.isArray(node[key])){
      node[key]=node[key].filter(item=>item.type!=='comment');node[key].forEach(removeCssComments);
    }
    if(node.stylesheet)removeCssComments(node.stylesheet);
  }
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
        async format(raw,{scope}={}){
          try{
            const lib=await library();if(!isCurrent()||typeof lib.DOMPurify?.sanitize!=='function')return null;
            const regexed=helper.formatAsTavernRegexedString(raw,source,'display',{depth,character_name:name});
            // Blank display replacements also keep the original readable here.
            if(typeof regexed!=='string'||!regexed.trim()||(regexed===raw&&!hasHtml(raw))||!isCurrent())return null;
            const markdown=helper.builtin.renderMarkdown(regexed);
            if(typeof markdown!=='string'||!isCurrent())return null;
            // Encode AFTER Markdown: style text in fenced HTML is escaped and
            // must remain byte-for-byte code for the Helper to consume later.
            const needsStyles=/<style>[\s\S]+?<\/style>/i.test(markdown);
            const hostStyles=needsStyles?await styleHelpers():null;
            if(needsStyles&&(typeof hostStyles?.encodeStyleTags!=='function'||typeof hostStyles?.decodeStyleTags!=='function'
              ||typeof lib.css?.parse!=='function'||typeof lib.css?.stringify!=='function'
              ||!/^\[data-lantai-render-scope="[a-zA-Z0-9_-]+"\]$/.test(scope)))return null;
            if(!isCurrent())return null;
            const encoded=needsStyles?hostStyles.encodeStyleTags(markdown):markdown;
            // Same instance/hooks as host messageFormatting, no second regex or
            // Markdown pass. Raw style is forbidden; only encoded CSS survives.
            let html=lib.DOMPurify.sanitize(encoded,{RETURN_DOM:false,RETURN_DOM_FRAGMENT:false,RETURN_TRUSTED_TYPE:false,
              MESSAGE_SANITIZE:true,ADD_TAGS:needsStyles?['custom-style']:[],FORBID_TAGS:needsStyles?['style']:['style','custom-style'],KEEP_CONTENT:false});
            if(typeof html!=='string'||!html.trim())return null;
            const styles=[];
            if(needsStyles)html=html.replace(/<custom-style(?:\s[^>]*)?>([\s\S]*?)<\/custom-style>/gi,(_,encodedCss)=>{
              const ast=lib.css.parse(decodeURIComponent(encodedCss));removeCssComments(ast);
              const cleanCss=lib.css.stringify(ast);
              const decoded=hostStyles.decodeStyleTags(`<custom-style>${encodeURIComponent(cleanCss)}</custom-style>`,{prefix:`${scope} `});
              if(typeof decoded!=='string'||!decoded.startsWith('<style>')||!decoded.endsWith('</style>'))throw new Error('Host style decoding failed');
              // Never insert the returned style wrapper with innerHTML: CSS
              // strings/comments may contain </style>. The view uses textContent.
              styles.push(decoded.slice(7,-8));return '';
            });
            return html.trim()&&isCurrent()?{html,styles}:null;
          }catch{return null;}
        },
        // Compatibility probe, not a public arbitrary-container mount API.
        // The pinned Helper scanner wraps frontend pre nodes synchronously.
        // Missing/changed DOM contract fails closed to readable original text.
        captureTakeover(body){
          const candidates=[...(body.querySelectorAll?.('pre')??[])].filter(pre=>['html>','<head>','<body'].some(marker=>pre.textContent.includes(marker)));
          const taken=pre=>body.contains(pre)&&pre.parentNode?.classList?.contains('TH-render');
          const check=()=>candidates.every(taken);check.required=candidates.length>0;check.needsCleanup=()=>candidates.some(taken);return check;
        },
        async refresh(){if(!isCurrent())return false;await helper.refreshOneMessage(floor);return isCurrent();},
      };
    }catch{return null;}
  }
  return {capture};
}
