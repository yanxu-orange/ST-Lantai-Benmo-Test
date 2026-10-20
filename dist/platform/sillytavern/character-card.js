// Read only the uniquely selected card. Persona, world info and group members
// are separate sources and are never implicitly substituted.
export function captureSingleCharacterCard(context={}){
 if(context.groupId!==null&&context.groupId!==undefined&&context.groupId!=='')return null;
 const character=context.characters?.[context.characterId];if(!character)return null;
 const fields=Object.fromEntries(['name','description','personality','scenario'].map(key=>[key,String(character.data?.[key]??character[key]??'')]));
 return Object.values(fields).some(value=>value.trim())?fields:null;
}

// Current public persona only. name1 is presentation, never an identity key.
export function captureCurrentUserPersona(context={}){
 const description=context.powerUserSettings?.persona_description;
 if(typeof description!=='string'||!description.trim())return null;
 return {name:typeof context.name1==='string'?context.name1:'',description};
}
