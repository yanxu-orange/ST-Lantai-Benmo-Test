import {tokenizerV2} from './body-tokenizer.js';

// Frozen current-input/body-only trial: k1=1.2, b=.75, query terms deduplicated.
// All active trigger cards define corpus statistics BEFORE time eligibility.
// No cache: every index belongs to this invocation's captured library/settings.
export function rankBodyMemories(events, query, excludedTerms = []) {
  const names = events.flatMap(event => [...event.people, ...event.places,
    ...(event.locationAliases ?? []).flatMap(binding => binding.aliases)]);
  const tokenize = tokenizerV2(names, excludedTerms);
  const docs = events.map((event, libraryIndex) => {
    const tokens = tokenize(event.body), tf = new Map();
    for (const term of tokens) tf.set(term, (tf.get(term) ?? 0) + 1);
    return {id:event.id, libraryIndex, length:tokens.length, tf};
  });
  const df = new Map();
  for (const doc of docs) for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  const terms = [...new Set(tokenize(query))];
  return docs.map(doc => {
    const matchedTerms = terms.filter(term => doc.tf.has(term));
    let score = 0;
    for (const term of matchedTerms) {
      const frequency = doc.tf.get(term);
      const idf = Math.log(1 + (docs.length - df.get(term) + 0.5) / (df.get(term) + 0.5));
      score += idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * doc.length / (average || 1)));
    }
    return {id:doc.id, score, matchedTerms, libraryIndex:doc.libraryIndex};
  }).filter(candidate => Number.isFinite(candidate.score) && candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.libraryIndex - b.libraryIndex);
}

// Select B1 once. Duplicate/budget failures MUST NOT fall through to B2.
// Retrieval/counter failures affect only this optional supplement, never base.
export async function selectBodySupplement({events, query, excludedTerms, evaluated,
  selectedIds, maxTokens, renderCard, countTokens = null, rank = rankBodyMemories}) {
  const result = {status:'skipped', reason:'no-positive-candidate', candidate:null,
    tokens:null, estimated:false, maxTokens, scope:'additional-complete-card', soft:false,
    reminderApplied:false};
  if (maxTokens === 0) return {...result, reason:'budget-zero'};
  if (!query.trim()) return {...result, reason:'empty-query'};
  let candidate;
  try {
    const eligibility = new Map(evaluated.map(entry => [entry.memoryId, entry]));
    candidate = rank(events, query, excludedTerms).find(item => Number.isFinite(item.score) && item.score > 0
      && eligibility.has(item.id) && !eligibility.get(item.id).provenance?.explicitCurrentTimeConflict);
  } catch { return {...result, status:'failed', reason:'retrieval-failed'}; }
  if (!candidate) return result;
  const event = events.find(item => item.id === candidate.id);
  if (!event) return {...result, status:'failed', reason:'retrieval-failed'};
  result.candidate = {id:event.id, title:event.title, score:candidate.score, matchedTerms:candidate.matchedTerms};
  if (selectedIds.has(event.id)) return {...result, reason:'duplicate-selected'};
  try {
    const card = renderCard(event);
    const measured = countTokens ? await countTokens(card) : {tokens:Math.ceil(card.length / 2), estimated:true};
    const tokens = typeof measured === 'number' ? measured : measured?.tokens;
    if (!Number.isFinite(tokens) || tokens < 0) throw new Error('invalid-counter-result');
    result.tokens = tokens;
    result.estimated = typeof measured === 'object' && measured.estimated === true;
  } catch { return {...result, status:'failed', reason:'count-failed'}; }
  if (result.tokens > maxTokens) return {...result, reason:'budget-exceeded'};
  return {...result, status:'added', reason:'added'};
}
