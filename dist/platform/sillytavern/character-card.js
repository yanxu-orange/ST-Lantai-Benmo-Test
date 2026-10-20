// Read only the uniquely selected card. Persona, world info and group members
// are separate sources and are never implicitly substituted.
export function captureSingleCharacterCard(context={}){
 if(context.groupId!==null&&context.groupId!==undefined&&context.groupId!=='')return null;
 const character=context.characters?.[context.characterId];if(!character)return null;
 return Object.fromEntries(['name','description','personality','scenario'].map(key=>[key,String(character.data?.[key]??character[key]??'')]));
}
