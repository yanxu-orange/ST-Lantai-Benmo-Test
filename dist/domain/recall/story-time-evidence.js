// Adapted from verified legacy 81f9865; calendar arithmetic uses the current TIME domain.
import {
    parseStoryTimeValue, parseNumeral, compareTimeValues, timePrecisionRank,
    formatStoryTimeValue, shiftStoryYears, shiftStoryDays,
} from './date-facts.js';
import { buildRecallQueryFragments } from './structured-witness.js';

export const STORY_TIME_EVIDENCE_VERSION = 'story-time-evidence-v1';
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

// Date evidence contributes candidates only. Purpose, quotation and narration
// do not change date parsing, and a different date never vetoes another route.
function dateContextForMatch(match) {
    return { timeRole: 'date-mention', contextReason: 'date-candidate',
        contextExcerpt: match.raw, scopeRange: [match.start, match.end],
        canSupport: true, canConflict: false, canVetoFragment: false };
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
        { kind: 'relative-day', regex: /昨天|前天|明天|今天|今日/gu },
        { kind: 'month-day', regex: /(?<![\d年])\d{1,2}月\s*\d{1,2}[日号]/gu },
    ];
    const targets = [];
    for (const fragment of fragments) {
        const nonDates = nonDateSpans(fragment.cleanedText);
        // Sentence ranges preserve cleaned-fragment UTF-16 offsets; decimal
        // points survive, and narration/purpose do not alter date eligibility.
        for (const sentence of fragment.cleanedText.matchAll(/[^。！？!?；;\r\n]+/g)) {
            const matches = patterns.flatMap(({ kind, regex, expectedCalendar }, priority) => [...sentence[0].matchAll(regex)]
                .map(match => ({ kind, priority, expectedCalendar, raw: match[0], start: sentence.index + match.index, end: sentence.index + match.index + match[0].length })));
            matches.sort((a, b) => a.start - b.start || b.end - a.end || a.priority - b.priority);
            let occupiedEnd = -1;
            for (const match of matches) {
                if (match.start < occupiedEnd) continue;
                occupiedEnd = match.end;
                const nonDate = nonDates.find(span => match.start < span.end && match.end > span.start);
                const context = dateContextForMatch(match);
                let value = null;
                let anchor = null;
                if (nonDate) { /* Keep an unresolved diagnostic, never parse a date substring. */ }
                else if (match.kind === 'absolute') {
                    const suffix=fragment.cleanedText.slice(match.end);
                    value = /^[./]\d/u.test(suffix)?null:parseRaw(match.raw, fictionalCalendar);
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
                    } else if (current && match.kind === 'relative-year') {
                        const amount = match.raw === '去年' ? 1 : match.raw === '前年' ? 2 : parseNumeral(match.raw.slice(0, -2));
                        if (Number.isSafeInteger(amount) && amount > 0) value = shiftStoryYears(project(current, 'year'), -amount, fictionalCalendar);
                    } else if (current && match.kind === 'relative-day' && timePrecisionRank(current) >= 3) {
                        value = shiftStoryDays(project(current, 'day'), { 昨天: -1, 前天: -2, 明天: 1, 今天: 0, 今日: 0 }[match.raw], fictionalCalendar);
                    } else if (current && match.kind === 'month-day') {
                        value = parseRaw(`${formatStoryTimeValue(project(current, 'year'))}${match.raw.replace(/号$/, '日')}`, fictionalCalendar);
                    }
                }
                // Approximation belongs to the token, regardless of absolute or
                // relative form; it must not manufacture an exact anchored date.
                if (/(?:约|大概)\s*$/u.test(fragment.cleanedText.slice(0,match.start))
                    || /^\s*(?:左右|前后)/u.test(fragment.cleanedText.slice(match.end))) value = null;
                targets.push({ id: `${fragment.id}:time:${match.start}-${match.end}`, fragmentId: fragment.id,
                    sourceKind: fragment.sourceKind, rawPosition: fragment.rawPosition, distanceFromCurrent: fragment.distanceFromCurrent,
                    raw: match.raw, matchedText: match.raw, range: [match.start, match.end], coordinateSystem: 'cleaned-fragment-utf16',
                    ...context, lexicalExclusion: nonDate ?? null, kind: match.kind, status: value ? 'resolved' : 'unresolved', value,
                    precision: value?.precision ?? null, calendarIdentity: calendarIdentity(value, anchor?.calendarId), anchor });
            }
        }
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
        return { ...result, relation: 'neutral', reason: single ? 'different-date-not-excluded' : 'outside-date-range-not-excluded' };
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
