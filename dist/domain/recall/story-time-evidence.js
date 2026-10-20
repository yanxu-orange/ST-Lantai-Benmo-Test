// Adapted from verified legacy 81f9865; calendar arithmetic uses the current TIME domain.
import {
    parseStoryTimeValue, parseNumeral, compareTimeValues, timePrecisionRank,
    formatStoryTimeValue, shiftStoryYears, shiftStoryDays,
} from './date-facts.js';
import { buildRecallQueryFragments } from './structured-witness.js';

export const STORY_TIME_EVIDENCE_VERSION = 'story-time-evidence-v1';
const NON_FACTUAL = /如果|假如|假设|倘若|要是|梦里|梦中|梦见|计划|打算|预计|预定|将于/;
const NUMERAL = '[\\d零〇元一二两三四五六七八九十]+';
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Shape adapters only. Domain remains the sole calendar parser/validator.
function parseRaw(raw, fictionalCalendar) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    return parseStoryTimeValue(text, { fictionalCalendar });
}

function pointValue(point, fictionalCalendar) {
    if (!point || (point.status && point.status !== 'parsed')) return null;
    if (point.value) return structuredClone(point.value);
    return parseRaw(point.raw, fictionalCalendar);
}

function project(value, precision) {
    const rank = timePrecisionRank({ precision });
    return { ...value, precision, month: rank >= 2 ? value.month : null,
        day: rank >= 3 ? value.day : null, hour: null, minute: null, shichen: null,
        isLeapMonth: rank >= 2 ? Boolean(value.isLeapMonth) : false };
}

function calendarIdentity(value, explicitId = null) {
    return { calendar: value?.calendar ?? null, era: value?.era ?? null, calendarId: explicitId ?? value?.calendarId ?? value?.calendar ?? null };
}

// Lexical spans are not dates. Preserve original UTF-16 coordinates for diagnostics.
function nonDateSpans(text) {
    const clock = /(?<!\d)\d{1,2}[:：]\d{2}(?:[:：]\d{2})?(?:\s*[-—–~～至到]\s*\d{1,2}[:：]\d{2}(?:[:：]\d{2})?)?(?!\d)/gu;
    const duration = /(?<![\d.])\d+(?:\.\d+)?\s*[-—–~～至到]\s*\d+(?:\.\d+)?\s*(?:毫秒|秒钟|秒|分钟|分|小时|钟头|天|周|个月|年)(?![月日号])/gu;
    const decimalDuration = /(?<![\d.])\d+\.\d+\s*(?:毫秒|秒钟|秒|分钟|分|小时|钟头|天|周|个月)(?![月日号])/gu;
    return [clock, duration, decimalDuration].flatMap((regex, i) => [...text.matchAll(regex)].map(m => ({start:m.index,end:m.index+m[0].length,raw:m[0],reason:i===2?'decimal-duration':i?'duration-range':'clock-token'})));
}

// A date is an event-time constraint only when the input actually requests that
// date's events. A scene clock or an unclassified mention is not a validity interval.
const REQUEST_START = /^\s*(?:(?:请|麻烦|帮我|给我|请问|能否|能|可以|可否|我想)\s*)?(?:查找|查询|寻找|检索|搜索|找出|翻出|调出|回忆|回想|回顾|复述|记得|回到|穿越到|找)/u;
function clauses(text) {
    return [...text.matchAll(/[^。！？!?；;，,\r\n]+/gu)].map(match => ({ range: [match.index, match.index + match[0].length], text: match[0] }));
}
function timeContext(text, match, nonDates) {
    const parts = clauses(text);
    const index = parts.findIndex(part => part.range[0] <= match.start && match.end <= part.range[1]);
    const clause = parts[index];
    const left = text.slice(clause.range[0], match.start);
    const right = text.slice(match.end, clause.range[1]);
    const queryLeft = left.replace(/[“”‘’「」『』"']/gu, '').slice(-64);
    const queryRight = right.replace(/[“”‘’「」『』"']/gu, '').slice(0, 64);
    const request = REQUEST_START.exec(queryLeft);
    const directQuery = request && queryLeft.slice(request[0].length).trim() === '';
    const explicitScene = /(?:现在是|今天是|当前(?:日期|时间)?[：:]?|(?:剧情)?(?:日期|时间)\s*[：:])\s*$/u.test(queryLeft);
    const memoryNoun = /记忆|往事|经历|经过|事件|记录|那次|当日|那天/u;
    const scopedMemoryQuery = Boolean(request) && memoryNoun.test(queryRight)
        && !/(?:然后|接着|再去|参观)[^。！？!?；;]*$/u.test(queryLeft);
    const trailing = /(?:回顾|回忆|回想|复述|查找|查询|检索|搜索|列出|展示|给我端上来)(?:一下|一遍)?\s*(?:吗|么|好吗)?\s*$/u.exec(queryRight);
    const objectText = trailing ? queryRight.slice(0, trailing.index) : '';
    const requestPrefix = /^\s*(?:(?:请|麻烦)\s*)?(?:(?:把|将)(?:写着|标着|注明|记着)?|给我|帮我)?\s*$/u.test(queryLeft);
    const trailingQuery = requestPrefix && trailing && memoryNoun.test(objectText)
        && !/说|回忆|回想|想起|打算|准备|正在|已经/u.test(objectText);
    const nominalDateQuery = /^\s*的(?:记忆|往事|经历|经过|事件|记录)\s*$/u.test(queryRight);
    const qualifiedDate = !queryLeft.trim() && (nominalDateQuery
        || /^\s*(?:(?:那天|当天|当日).{0,12})?(?:发生了?什么|发生过什么|有哪些)/u.test(queryRight));
    const remainder = text.slice(clause.range[0], match.start) + text.slice(match.end, clause.range[1]);
    const clocksRemoved = nonDates.filter(span => span.reason === 'clock-token' && span.start >= clause.range[0] && span.end <= clause.range[1])
        .reduce((value, span) => value.replace(span.raw, ''), remainder);
    const dateOnly = parts.length === 1 && /^[\s“”‘’「」『』"'、和与及或:：]*$/u.test(clocksRemoved);
    let scopeEnd = clause.range[1];
    const next = parts[index + 1];
    const referentialQuery = next && next.text.length <= 64 && REQUEST_START.test(next.text)
        && (/那天|当日|当天|这天|那次|这两|两天|这两个日期/u.test(next.text)
            || memoryNoun.test(queryRight));
    if (referentialQuery) scopeEnd = next.range[1];
    const explicit = directQuery || scopedMemoryQuery || trailingQuery || referentialQuery || (!explicitScene && (qualifiedDate || dateOnly));
    const background = /(?:建于|始建于|建成于|创建于|创立于|成立于|始于|源于|起源于|可追溯到)\s*$/u.test(left)
        || (/由[^，,。！？!?；;\r\n]{1,30}于\s*$/u.test(left)
            && /^\s*(?:建造|建成|创建|创立|成立|落成|修建)/u.test(right))
        || /^\s*(?:建造|建成|创建|创立|成立|落成|修建)的/u.test(right);
    return { timeRole: background && !explicit ? 'historical-reference' : explicit ? 'recall-target' : explicitScene ? 'scene-date' : 'date-mention',
        contextReason: background && !explicit ? 'explicit-historical-description' : explicit ? 'explicit-date-query'
            : explicitScene ? 'scene-clock-not-event-time' : 'unclassified-date',
        contextExcerpt: left + match.raw + right, scopeRange: [clause.range[0], scopeEnd],
        canSupport: true, canConflict: Boolean(explicit), canVetoFragment: false };
}

function authorizeFragmentVeto(fragment, targets) {
    const parts = clauses(fragment.cleanedText);
    // A bounded two-event comparison is also a date lookup, not a comparison of
    // typography or date formatting. Require two parsed dates in the same clause.
    for (const part of parts) {
        const group = targets.filter(target => target.fragmentId === fragment.id && target.status === 'resolved'
            && target.range[0] >= part.range[0] && target.range[1] <= part.range[1]);
        if (group.length >= 2 && /比较|对照|核对/u.test(part.text)
            && /(?:两次|各次)[\p{L}]{1,16}|(?:两天|两日|两个日期).{0,8}(?:事件|经历|经过|往事|记录|发生)/u.test(part.text)
            && !/格式|字形|字体|字号|写法|排版|颜色/u.test(part.text)) {
            for (const target of group) Object.assign(target, { timeRole: 'recall-target', contextReason: 'explicit-date-comparison', canConflict: true });
        }
    }
    const local = targets.filter(target => target.fragmentId === fragment.id && target.canConflict);
    if (!local.length) return;
    const covered = part => local.some(target => target.scopeRange[0] <= part.range[0] && target.scopeRange[1] >= part.range[1]);
    // A short leading topic heading may introduce a following lookup. Action or
    // scene text is never silently swallowed into that heading's date constraint.
    const topic = (part, index) => index === 0 && parts.length > 1 && covered(parts[1])
        && /^[\p{L}\p{N}\s]{1,12}$/u.test(part.text.trim())
        && !/今天|现在|当前|此刻|这次|然后|继续|正在|已经|想|要|去|拿|领|取|带|把|让|帮|请|放|等|做|看|说|走|写|吃|开/u.test(part.text);
    const exclusive = parts.every((part, index) => covered(part) || topic(part, index));
    for (const target of local) target.canVetoFragment = exclusive;
}

export function extractStoryTimeTargetsFromFragments({ fragments, currentStoryTime = null, fictionalCalendar = {} }) {
    const current = pointValue(currentStoryTime, fictionalCalendar);
    const eraNames = (fictionalCalendar.chronology?.eras ?? []).map(era => era.name).filter(name => typeof name === 'string' && name);
    // Locate complete tokens, then ask Domain to parse them. No date arithmetic
    // or validity rules are duplicated here. Unconfigured eras require a token boundary.
    const era = eraNames.length ? `(?:${eraNames.sort((a, b) => b.length - a.length).map(escapeRegex).join('|')})`
        : '(?<![\\p{L}\\p{N}])[^\\s\\d，,。：:;；!?！？<>]{1,12}?';
    // Known calendar names may contain 年. Match them exactly before the generic
    // token, whose year boundary still prevents swallowing a later narrative date.
    const definition = fictionalCalendar.definition;
    const configuredMonths = definition?.type === 'custom' ? definition.months ?? []
        : definition?.type === 'dynasty' ? (definition.importedYears ?? []).flatMap(year => year.months ?? []) : [];
    const monthNames = [...new Set(configuredMonths.map(month => typeof month.name === 'string' ? month.name.trim() : '').filter(Boolean))]
        .sort((a, b) => b.length - a.length).map(escapeRegex);
    const genericMonth = '(?:闰)?(?:(?![年日号])[\\p{Script=Han}\\d.]){1,12}月';
    const month = monthNames.length ? `(?:${monthNames.join('|')}|${genericMonth})` : genericMonth;
    const relativeYear = `(?:去年|前年|(?<![\\p{N}零〇元一二两三四五六七八九十])${NUMERAL}年前)`;
    const patterns = [
        { kind: 'relative-date', regex: new RegExp(`${relativeYear}\\s*(?:的\\s*)?(?:今日|今天|同日|${month}(?:\\s*(?:初|廿)?[\\d.零〇元一二两三四五六七八九十]+[日号]?)?)`, 'gu') },
        { kind: 'absolute', expectedCalendar: 'era', regex: new RegExp(`${era}\\s*${eraNames.length ? NUMERAL : '(?:\\d{1,2}|[零〇元一二两三四五六七八九十]+)'}年(?!前)(?:\\s*${month}(?:\\s*(?:初|廿)?${NUMERAL}[日号]?)?)?`, 'gu') },
        { kind: 'absolute', regex: new RegExp(`(?<![\\p{Script=Latin}\\p{N}_./+\\-])(?:公元\\s*)?\\d{1,4}\\s*(?:年(?!前)(?:\\s*${month}(?:\\s*(?:初|廿)?[\\d.零〇元一二两三四五六七八九十]+[日号]?)?)?|[-/.]\\d+(?:[-/.]\\d+)?)(?!\\d)`, 'gu') },
        { kind: 'absolute', regex: /(?<!\S)\d{3,4}(?!\S)/gu },
        { kind: 'relative-year', regex: new RegExp(`去年|前年|(?<![\\p{N}零〇元一二两三四五六七八九十])${NUMERAL}年前`, 'gu') },
        { kind: 'relative-day', regex: /昨天|前天|明天/gu },
        { kind: 'month-day', regex: /(?<![\d年])\d{1,2}月\s*\d{1,2}[日号]/gu },
    ];
    const targets = [];
    for (const fragment of fragments) {
        const nonDates = nonDateSpans(fragment.cleanedText);
        // Sentence ranges preserve cleaned-fragment UTF-16 offsets. Commas do
        // not terminate a hypothetical condition's scope; decimal points survive.
        for (const sentence of fragment.cleanedText.matchAll(/[^。！？!?；;\r\n]+/g)) {
            if (NON_FACTUAL.test(sentence[0])) continue;
            const matches = patterns.flatMap(({ kind, regex, expectedCalendar }, priority) => [...sentence[0].matchAll(regex)]
                .map(match => ({ kind, priority, expectedCalendar, raw: match[0], start: sentence.index + match.index, end: sentence.index + match.index + match[0].length })));
            matches.sort((a, b) => a.start - b.start || b.end - a.end || a.priority - b.priority);
            let occupiedEnd = -1;
            for (const match of matches) {
                if (match.start < occupiedEnd) continue;
                occupiedEnd = match.end;
                const nonDate = nonDates.find(span => match.start < span.end && match.end > span.start);
                const context = timeContext(fragment.cleanedText, match, nonDates);
                let value = null;
                let anchor = null;
                if (nonDate) { /* Keep an unresolved diagnostic, never parse a date substring. */ }
                else if (match.kind === 'absolute') {
                    const prefix=fragment.cleanedText.slice(0,match.start),suffix=fragment.cleanedText.slice(match.end);
                    const approximate=/(?:约|大概)\s*$/u.test(prefix)||/^\s*(?:左右|前后)/u.test(suffix);
                    value = approximate||/^[./]\d/u.test(suffix)?null:parseRaw(match.raw, fictionalCalendar);
                    if (match.expectedCalendar && !value?.sourceEra && !/^公元\s*/u.test(match.raw)) value = null;
                }
                else {
                    anchor = current ? { value: structuredClone(current), raw: currentStoryTime.raw ?? '', calendarId: currentStoryTime.calendarId ?? current.calendar } : null;
                    if (current && match.kind === 'relative-date') {
                        const parts = /^(去年|前年|.+?年前)\s*(?:的\s*)?(.+)$/u.exec(match.raw);
                        const amount = parts[1] === '去年' ? 1 : parts[1] === '前年' ? 2 : parseNumeral(parts[1].slice(0, -2));
                        const year = Number.isSafeInteger(amount) && amount > 0 ? shiftStoryYears(project(current, 'year'), -amount, fictionalCalendar) : null;
                        if (year) {
                            if (['今日','今天','同日'].includes(parts[2])) {
                                if (timePrecisionRank(current) >= 3) {
                                    value = shiftStoryYears(project(current, 'day'), -amount, fictionalCalendar);
                                    if (value && (value.day !== current.day)) value = null;
                                }
                            } else value = parseRaw(`${formatStoryTimeValue(year)}${parts[2].replace(/号$/, '日')}`, fictionalCalendar);
                        }
                        if (/(?:约|大概)\s*$/u.test(fragment.cleanedText.slice(0,match.start)) || /^\s*(?:左右|前后)/u.test(fragment.cleanedText.slice(match.end))) value = null;
                    } else if (current && match.kind === 'relative-year') {
                        const amount = match.raw === '去年' ? 1 : match.raw === '前年' ? 2 : parseNumeral(match.raw.slice(0, -2));
                        if (Number.isSafeInteger(amount) && amount > 0) value = shiftStoryYears(project(current, 'year'), -amount, fictionalCalendar);
                    } else if (current && match.kind === 'relative-day' && timePrecisionRank(current) >= 3) {
                        value = shiftStoryDays(project(current, 'day'), { 昨天: -1, 前天: -2, 明天: 1 }[match.raw], fictionalCalendar);
                    } else if (current && match.kind === 'month-day') {
                        value = parseRaw(`${formatStoryTimeValue(project(current, 'year'))}${match.raw.replace(/号$/, '日')}`, fictionalCalendar);
                    }
                }
                targets.push({ id: `${fragment.id}:time:${match.start}-${match.end}`, fragmentId: fragment.id,
                    sourceKind: fragment.sourceKind, rawPosition: fragment.rawPosition, distanceFromCurrent: fragment.distanceFromCurrent,
                    raw: match.raw, matchedText: match.raw, range: [match.start, match.end], coordinateSystem: 'cleaned-fragment-utf16',
                    ...context, lexicalExclusion: nonDate ?? null, kind: match.kind, status: value ? 'resolved' : 'unresolved', value,
                    precision: value?.precision ?? null, calendarIdentity: calendarIdentity(value, anchor?.calendarId), anchor });
            }
        }
        authorizeFragmentVeto(fragment, targets);
    }
    return targets;
}

export function evaluateMemoryStoryTimeEvidence(memory, targets, { fictionalCalendar = {} } = {}) {
    const knownStart = pointValue(memory.time?.start, fictionalCalendar);
    const knownEnd = pointValue(memory.time?.end, fictionalCalendar);
    const start = knownStart ?? knownEnd, end = knownEnd ?? knownStart;
    const evaluations = targets.map(target => {
        const result = { memoryId: memory.id, targetId: target.id, target: structuredClone(target),
            memoryTime: { start: structuredClone(memory.time?.start ?? null), end: structuredClone(memory.time?.end ?? null) },
            comparison: { start: structuredClone(start), end: structuredClone(end), target: structuredClone(target.value) },
            domain: { memory: calendarIdentity(start, memory.time?.calendarId), target: target.calendarIdentity, comparable: false },
            precisionRelation: 'unknown', relation: 'neutral', reason: 'memory-time-unparsed' };
        if (!target.value || target.status !== 'resolved') return { ...result, reason: 'unresolved-target' };
        if (!start || !end || !knownStart&&memory.time?.start?.raw?.trim() || !knownEnd&&memory.time?.end?.raw?.trim()) return result;
        const explicitMemoryId = memory.time?.calendarId;
        const targetId = target.calendarIdentity.calendarId;
        const incompatible = (explicitMemoryId && targetId && explicitMemoryId !== targetId)
            || compareTimeValues(start, target.value, fictionalCalendar) === null
            || compareTimeValues(end, target.value, fictionalCalendar) === null;
        if (incompatible) return { ...result, precisionRelation: 'incomparable', reason: 'incomparable-calendar' };
        result.domain.comparable = true;
        const targetRank = timePrecisionRank(target.value);
        const memoryRank = Math.min(timePrecisionRank(start), timePrecisionRank(end));
        if (!targetRank || !memoryRank || targetRank > 3) return { ...result, reason: 'unsupported-precision' };
        if (memoryRank < targetRank) return { ...result, precisionRelation: 'memory-coarser-than-target', reason: 'insufficient-memory-precision' };
        result.precisionRelation = memoryRank > targetRank ? 'target-coarser-than-memory' : 'exact';
        // Project ALL three values to the query's requested precision. Null
        // components are symmetric here, never invented missing month/day facts.
        const a = project(start, target.value.precision);
        const b = project(end, target.value.precision);
        const t = project(target.value, target.value.precision);
        result.comparison.projected = { start: a, end: b, target: t };
        // Check definite reversal at the finest precision both endpoints possess.
        const commonPrecision = memoryRank >= 3 ? 'day' : memoryRank === 2 ? 'month' : 'year';
        if (compareTimeValues(project(start, commonPrecision), project(end, commonPrecision), fictionalCalendar) > 0) {
            return { ...result, reason: 'invalid-memory-range' };
        }
        const after = compareTimeValues(t, a, fictionalCalendar);
        const before = compareTimeValues(t, b, fictionalCalendar);
        const single = compareTimeValues(a, b, fictionalCalendar) === 0;
        if (after >= 0 && before <= 0) return { ...result, relation: 'support',
            reason: result.precisionRelation === 'target-coarser-than-memory' ? 'coarse-target-contains-memory'
                : single ? 'exact-support' : 'target-within-memory-range' };
        if (target.canConflict === false) return { ...result, relation: 'neutral', reason: target.timeRole === 'historical-reference'
            ? 'historical-reference-not-conflict' : 'non-query-date-not-conflict' };
        return { ...result, relation: 'conflict', reason: single ? 'exact-date-conflict' : 'disjoint-range-conflict' };
    });
    return { memoryId: memory.id, evaluations, diagnostics: targets.length ? [] : [{ relation: 'neutral', reason: 'no-time-target' }] };
}

export function collectStoryTimeRecallEvidence({ memories, currentInput, recentHistory = [], currentStoryTime = null, fictionalCalendar = {} }) {
    if (!Array.isArray(memories)) throw new TypeError('memories must be an array');
    const fragments = buildRecallQueryFragments({ currentInput, recentHistory });
    const targets = extractStoryTimeTargetsFromFragments({ fragments, currentStoryTime, fictionalCalendar });
    const evaluated = [];
    for (const [libraryIndex, memory] of memories.entries()) {
        if (memory.mode !== 'trigger') continue;
        evaluated.push({ libraryIndex, ...evaluateMemoryStoryTimeEvidence(memory, targets, { fictionalCalendar }) });
    }
    return { version: STORY_TIME_EVIDENCE_VERSION, enabled:true, fragments, targets, evaluated,
        supportedCandidates: evaluated.filter(item => item.evaluations.some(e => e.relation === 'support')),
        conflictedCandidates: evaluated.filter(item => item.evaluations.some(e => e.relation === 'conflict')) };
}

