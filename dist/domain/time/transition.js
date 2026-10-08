import {maskMarkup} from './text.js';
// Explicit narrative advances. Plans/durations such as "还有两天" are not advances.
const DIGITS = {零:0,〇:0,元:1,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
export function parseNumeral(value) {
  const text = String(value ?? '').trim();
  if (text.includes('元') && text !== '元') return null;
  if (/^\d+$/.test(text)) { const n=Number(text);return Number.isSafeInteger(n)?n:null; }
  if (text && [...text].every(char=>Object.hasOwn(DIGITS,char))) {
    const n=Number([...text].map(char=>DIGITS[char]).join(''));return Number.isSafeInteger(n)?n:null;
  }
  const tens=text.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  return tens ? (tens[1]?DIGITS[tens[1]]:1)*10+(tens[2]?DIGITS[tens[2]]:0) : null;
}
const NUMBER='[\\d零〇一二两三四五六七八九十]+';
const UNIT='(天|日|周|星期|月|年)';
const END='(?=$|\\s|[，,。！？!?；;])';
const patterns=[
  new RegExp(`^(${NUMBER})\\s*(?:个)?${UNIT}\\s*(?:以后|之后|后)${END}`),
  new RegExp(`^(?:(?:时间|剧情|故事)\\s*)?(?:又\\s*)?(?:过了|经过了?)\\s*(${NUMBER})\\s*(?:个)?${UNIT}${END}`),
  new RegExp(`^(?:时间|剧情|故事)\\s*(?:已经\\s*)?过去了\\s*(${NUMBER})\\s*(?:个)?${UNIT}${END}`),
  new RegExp(`^(${NUMBER})\\s*(?:个)?${UNIT}\\s*过去了${END}`),
];
export function parseAdvancePrefix(text) {
  if (typeof text !== 'string') throw new TypeError('推进文本无效');
  const next=text.match(new RegExp(`^(?:次日|翌日|第二天)${END}`));
  if(next)return {kind:'shiftDays',amount:1,length:next[0].length};
  for(const pattern of patterns){
    const match=text.match(pattern);if(!match)continue;
    if (/^[零〇一二两三四五六七八九]{2,}$/.test(match[1])) return null;
    const amount=parseNumeral(match[1]);if(amount===null||amount<=0)return null;
    const unit=match[2],factor=['周','星期'].includes(unit)?7:1;
    if(!Number.isSafeInteger(amount*factor))return null;
    return {kind:unit==='月'?'shiftMonths':unit==='年'?'shiftYears':'shiftDays',amount:amount*factor,length:match[0].length};
  }
  return null;
}
// Replace HTML structure without changing UTF-16 offsets in the source.
export function advanceCandidates(text, offset=0) {
  if(typeof text!=='string'||!Number.isSafeInteger(offset)||offset<0)throw new TypeError('推进来源无效');
  const plain=maskMarkup(text), result=[];
  for(const match of plain.matchAll(/[^\r\n。！？!?]+/g)){
    const leading=match[0].length-match[0].trimStart().length;
    const operation=parseAdvancePrefix(match[0].trimStart());
    if(!operation)continue;
    const start=offset+match.index+leading;
    result.push({kind:operation.kind,amount:operation.amount,start,end:start+operation.length});
  }
  return result;
}
