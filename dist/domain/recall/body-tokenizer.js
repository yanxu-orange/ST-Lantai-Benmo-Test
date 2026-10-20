// Controlled tokenizer correction, not a quality-tuned ranker.
// Explicit grammatical particles/pronouns only; no stopwords learned from heldout.
const stop=new Set(['的','了','是','在','和','与','我','你','他','她','它','这','那']);
export function tokenizerV2(names=[],excluded=[]){
 const norm=x=>x.toLowerCase(),denied=new Set(excluded.map(norm));
 const protectedNames=[...new Set(names.map(norm))].filter(x=>x&&!denied.has(x)).sort((a,b)=>b.length-a.length||a.localeCompare(b));
 const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
 return raw=>{
  const text=norm(raw),segments=[...segmenter.segment(text)],boundaries=new Set(segments.flatMap(s=>[s.index,s.index+s.segment.length]));
  const ordinary=t=>[...segmenter.segment(t)].filter(s=>s.isWordLike).map(s=>s.segment).filter(s=>!stop.has(s)&&!denied.has(s));
  const out=[];let start=0,i=0;
  while(i<text.length){
   // Keep exact numeric-unit atoms distinct: 38℃, 38°C and 38 remain separate.
   const unit=text.slice(i).match(/^\d+(?:\.\d+)?(?:℃|°c|°f|kg|km|cm|mm|ml|公斤|千米|厘米|毫米|毫升|岁|元)(?![a-z0-9])/u)?.[0];
   const name=protectedNames.find(n=>text.startsWith(n,i)
     && ([...n].length!==1||(boundaries.has(i)&&boundaries.has(i+n.length)))
     && (!/[a-z0-9]/i.test(n[0])||i===0||!/[a-z0-9]/i.test(text[i-1]))
     && (!/[a-z0-9]/i.test(n.at(-1))||!/[a-z0-9]/i.test(text[i+n.length]??'')));
   const atom=unit??name;
   if(atom){out.push(...ordinary(text.slice(start,i)));if(!denied.has(atom))out.push(atom);i+=atom.length;start=i;}else i++;
  }
  out.push(...ordinary(text.slice(start)));return out;
 };
}
