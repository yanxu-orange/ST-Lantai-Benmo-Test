export function detailAliasParentText(value){return {text:String(value??'').trim().normalize('NFKC').toLowerCase(),explicitlyWrapped:false};}
export function isEligibleDetailAliasParent(value){return /[\p{Script=Han}0-9]/u.test(detailAliasParentText(value).text);}
