// Compatibility source revision: 01e50d63.
export const DETAIL_QUERY_SURFACE_VERSION = 'detail-query-surface-v1';

// Retrieval-only normalization. Preserve compatibility numbers/symbols (notably
// temperatures and squared units); NFKC must not silently perform unit conversion.
function displayText(value) {
    return Array.from(value, char => {
        if (/[\p{N}\p{S}]/u.test(char) && !/[！-～]/u.test(char)) return char;
        return char.normalize('NFKC');
    }).join('').normalize('NFC').replace(/[\t \u00a0]+/gu, ' ').trim();
}

export function normalizeQuerySurfaceDisplay(value) {
    requireText(value);
    return displayText(value);
}

function requireText(value) {
    if (typeof value !== 'string') throw new TypeError('Detail surface inputs must be strings');
}

const NUMBER = /[+\-−]?\d+(?:\.\d+)?/gu;
const IDENTIFIER = /^([a-z]+)-?(\d+)$/u;
const UNIT = /^([+\-−]?\d+(?:\.\d+)?) *([\p{L}℃℉°%]+)$/u;
const BOUND = /^([\p{L}]+)(\d+)$/u;
const TRAILING_IDENTIFIER = /([a-z]+)-?(\d+)$/u;
const TRAILING_MEASUREMENT = /([+\-−]?\d+(?:\.\d+)?) *([\p{L}℃℉°%]+)$/u;

/** One model is one parent atom. Components are structural, never extra facts.
 * v1 expands one complete structured anchor, optionally bound to descriptive
 * text. Multi-number, sentence and other structures retain full-detail matching only.
 */
export function buildDetailQuerySurfaceModel(detail) {
    requireText(detail);
    const display = displayText(detail);
    if (!display) throw new TypeError('Detail must not be empty');
    const folded = display.toLowerCase();
    const identifier = IDENTIFIER.exec(folded);
    const unit = UNIT.exec(display);
    const bound = BOUND.exec(folded);
    let ruleFamily = 'plain-detail';
    let components = { full: folded };
    if (identifier) {
        ruleFamily = 'identifier';
        components = { letters: identifier[1], number: identifier[2], canonical: identifier[1] + identifier[2] };
    } else if (unit) {
        ruleFamily = /^[+\-−]/u.test(unit[1]) ? 'signed-unit' : 'measurement';
        components = { number: unit[1], unit: unit[2] };
    } else if (bound && Array.from(bound[1]).length >= 2) {
        ruleFamily = 'bound-text-number';
        components = { anchorKind: 'number', text: bound[1], number: bound[2] };
    } else {
        const trailingIdentifier = TRAILING_IDENTIFIER.exec(folded);
        const identifierText = trailingIdentifier ? folded.slice(0, trailingIdentifier.index).trim() : '';
        const identifierBoundary = Array.from(identifierText).at(-1) ?? '';
        const trailingMeasurement = TRAILING_MEASUREMENT.exec(display);
        const measurementText = trailingMeasurement ? display.slice(0, trailingMeasurement.index).trim().toLowerCase() : '';
        if (trailingIdentifier && Array.from(identifierText).length >= 2
            && identifierBoundary && !identityContinuation(identifierBoundary)) {
            ruleFamily = 'bound-text-number';
            components = { anchorKind: 'identifier', text: identifierText,
                letters: trailingIdentifier[1], number: trailingIdentifier[2],
                canonical: trailingIdentifier[1] + trailingIdentifier[2] };
        } else if (trailingMeasurement && Array.from(measurementText).length >= 2) {
            ruleFamily = 'bound-text-number';
            components = { anchorKind: 'measurement', text: measurementText,
                number: trailingMeasurement[1], unit: trailingMeasurement[2] };
        }
    }
    return Object.freeze({
        version: DETAIL_QUERY_SURFACE_VERSION, parentDetail: detail,
        display, normalized: folded, ruleFamily, components: Object.freeze(components),
    });
}

function before(text, index) { return Array.from(text.slice(Math.max(0, index - 2), index)).at(-1) ?? ''; }
function after(text, index) { return String.fromCodePoint(text.codePointAt(index) ?? 0); }
function identityContinuation(char) { return /[\p{N}\p{M}\p{Script=Latin}_+\-−./]/u.test(char); }
function numericTokens(text, withUnit = false) {
    return Array.from(text.matchAll(NUMBER), match => ({ value: match[0], start: match.index, end: match.index + match[0].length }))
        .filter(token => !identityContinuation(before(text, token.start))
            && !(withUnit ? /[\p{N}\p{M}_+\-−./]/u.test(after(text, token.end)) : identityContinuation(after(text, token.end))));
}
function occurrences(text, needle) {
    const found = [];
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
        found.push({ start: at, end: at + needle.length, value: needle });
    }
    return found;
}
function component(kind, occurrence, relation = 'exact') {
    return { kind, value: occurrence.value, range: [occurrence.start, occurrence.end], relation };
}

function identifierMatchClass(model, rawQuery, normalizedStart) {
    // Classify the matched occurrence, never a different occurrence elsewhere.
    // The sentinel retains whitespace at the end of a normalized prefix.
    for (const raw of rawQuery.matchAll(/[A-Za-z0-9Ａ-Ｚａ-ｚ０-９]+(?:[-－][A-Za-z0-9Ａ-Ｚａ-ｚ０-９]+)*/gu)) {
        const prefix = displayText(rawQuery.slice(0, raw.index) + '\u0001').slice(0, -1).toLowerCase();
        if (prefix.length !== normalizedStart) continue;
        if (raw[0] === model.parentDetail.trim()) return 'identifier-exact';
        return displayText(raw[0]) !== raw[0] ? 'identifier-nfkc-variant' : 'identifier-safe-variant';
    }
    return 'identifier-safe-variant';
}
function fullOccurrence(text, needle) {
    return occurrences(text, needle).find(hit => {
        const first = Array.from(needle)[0];
        const last = Array.from(needle).at(-1);
        return (!identityContinuation(first) || !identityContinuation(before(text, hit.start)))
            && (!identityContinuation(last) || !identityContinuation(after(text, hit.end)));
    });
}

// Query fragments are already local. Additionally, never bind components across
// an explicit clause/line boundary even if a caller accidentally supplies one.
function sameClause(text, a, b) {
    return !/[，,;；。！？!?\r\n]/u.test(text.slice(Math.min(a.end, b.end), Math.max(a.start, b.start)));
}

// Only maximal prefix/suffix overlap against each whole query letter run.
// No substring list is materialized; overlap length is counted in code points.
function boundaryOverlap(text, anchor) {
    const stored = Array.from(anchor);
    const results = [];
    for (const run of text.matchAll(/[\p{L}]+/gu)) {
        const chars = Array.from(run[0]);
        for (const side of ['prefix', 'suffix']) {
            let length = Math.min(chars.length, stored.length);
            while (length >= 2) {
                const edge = (side === 'prefix' ? stored.slice(0, length) : stored.slice(-length)).join('');
                if (run[0].includes(edge)) break;
                length--;
            }
            if (length < 2) continue;
            const value = (side === 'prefix' ? stored.slice(0, length) : stored.slice(-length)).join('');
            const start = run.index + run[0].indexOf(value);
            results.push({ value, start, end: start + value.length, side, runStart: run.index, runEnd: run.index + run[0].length });
        }
    }
    return results;
}

function compoundIdentifierAnchors(text) {
    const anchors = [];
    for (const token of text.matchAll(/[a-z0-9]+(?:[-_./][a-z0-9]+)*/gu)) {
        if (identityContinuation(before(text, token.index)) || identityContinuation(after(text, token.index + token[0].length))) continue;
        const parsed = IDENTIFIER.exec(token[0]);
        if (parsed) anchors.push({ value: token[0], start: token.index, end: token.index + token[0].length,
            letters: parsed[1], number: parsed[2] });
    }
    return anchors;
}

function compoundMeasurementAnchors(text, storedUnit) {
    const anchors = [];
    for (const token of numericTokens(text, true)) {
        const gap = /^ */u.exec(text.slice(token.end))[0].length;
        const start = token.end + gap;
        const exactUnit = text.startsWith(storedUnit, start);
        const unit = exactUnit ? storedUnit : Array.from(text.slice(start))[0];
        if (!unit || !/[\p{L}℃℉°%]/u.test(unit)) continue;
        const end = start + unit.length;
        if (/[\p{N}\p{M}°℃℉/%²³]/u.test(after(text, end))) continue;
        anchors.push({ value: text.slice(token.start, end), start: token.start, end,
            number: token.value, unit });
    }
    return anchors;
}

function anchorTouchesRun(text, anchor, overlap) {
    if (anchor.start < overlap.runEnd && anchor.end > overlap.runStart) return true;
    if (anchor.end <= overlap.runStart) return /^ *$/u.test(text.slice(anchor.end, overlap.runStart));
    return /^ *$/u.test(text.slice(overlap.runEnd, anchor.start));
}

/** Single evidence object; no score, qualification, pool or memory-level witness.
 * Ranges are UTF-16 offsets into normalizedQuery, NOT offsets into raw input.
 * Consumers retain parentDetail alongside memory/field identity; canonical text
 * is never a storage identity. A successful result consumes no facts itself.
 */
export function matchDetailQuerySurface(model, queryFragment) {
    requireText(queryFragment);
    if (model?.version !== DETAIL_QUERY_SURFACE_VERSION) throw new TypeError('Unsupported detail surface model version');
    const display = displayText(queryFragment);
    const text = model.ruleFamily === 'measurement' || model.ruleFamily === 'signed-unit' ? display : display.toLowerCase();
    const result = (matched, matchClass, usedComponents = []) => ({
        matched, version: model.version, ruleFamily: model.ruleFamily,
        parentDetail: model.parentDetail, matchClass,
        reason: matched ? null : matchClass, normalizedQuery: text,
        coordinateSystem: 'normalized-query-utf16', usedComponents,
    });
    const c = model.components;
    if (model.ruleFamily === 'identifier') {
        let reason = 'identifier-boundary-conflict';
        // Maximal connector-bearing tokens stop sub-identifiers leaking out.
        for (const token of text.matchAll(/[a-z0-9]+(?:[-_./][a-z0-9]+)*/gu)) {
            if (identityContinuation(before(text, token.index)) || identityContinuation(after(text, token.index + token[0].length))) continue;
            const parsed = IDENTIFIER.exec(token[0]);
            if (!parsed) continue;
            if (parsed[1] === c.letters && parsed[2] === c.number) {
                const hit = { value: token[0], start: token.index, end: token.index + token[0].length };
                const matchClass = identifierMatchClass(model, queryFragment, token.index);
                return result(true, matchClass, [component('identifier', hit, 'letters-number-identity')]);
            }
            if (parsed[1] !== c.letters && parsed[2] === c.number) reason = 'identifier-prefix-conflict';
            else if (parsed[1] === c.letters && parsed[2].replace(/^0+/u, '') === c.number.replace(/^0+/u, '')) reason = 'identifier-leading-zero-conflict';
        }
        return result(false, reason);
    }
    if (model.ruleFamily === 'measurement' || model.ruleFamily === 'signed-unit') {
        const tokens = numericTokens(text, true);
        for (const token of tokens) {
            if (token.value !== c.number) continue;
            const gap = /^ */u.exec(text.slice(token.end))[0].length;
            const start = token.end + gap;
            if (!text.startsWith(c.unit, start)) continue;
            const end = start + c.unit.length;
            // Latin units require a whole token; Han units allow surrounding prose.
            if (/[\p{Script=Latin}]/u.test(c.unit.at(-1)) && /[\p{Script=Latin}\p{N}\p{M}]/u.test(after(text, end))) continue;
            if (/[\p{N}\p{M}°℃℉/%²³]/u.test(after(text, end))) continue;
            return result(true, `${model.ruleFamily}-exact`, [component('number', token), component('unit', { value: c.unit, start, end })]);
        }
        if (tokens.some(token => token.value === c.number)) return result(false, 'unit-identity-conflict');
        if (model.ruleFamily === 'signed-unit' && tokens.some(token => token.value.replace(/^[+\-−]/u, '') === c.number.replace(/^[+\-−]/u, ''))) {
            return result(false, 'signed-unit-sign-conflict');
        }
        if (tokens.some(token => token.value.replace('.', '') === c.number.replace('.', ''))) return result(false, 'measurement-scale-conflict');
        return result(false, 'numeric-identity-conflict');
    }
    const full = fullOccurrence(text, model.normalized);
    if (full) return result(true, 'full-detail', [component('full-detail', full)]);
    if (model.ruleFamily !== 'bound-text-number') return result(false, 'full-detail-absent');

    if (c.anchorKind === 'identifier' || c.anchorKind === 'measurement') {
        const anchors = c.anchorKind === 'identifier'
            ? compoundIdentifierAnchors(text) : compoundMeasurementAnchors(text, c.unit);
        const anchor = anchors.find(item => c.anchorKind === 'identifier'
            ? item.letters === c.letters && item.number === c.number
            : item.number === c.number && item.unit === c.unit);
        if (!anchor) return result(false, 'structured-anchor-conflict');
        const localOverlaps = boundaryOverlap(text, c.text).filter(hit => sameClause(text, anchor, hit));
        const overlap = localOverlaps.find(hit => !anchors.some(other => other !== anchor && anchorTouchesRun(text, other, hit)));
        if (!overlap && c.anchorKind === 'identifier') {
            if (localOverlaps.length) return result(false, 'structured-anchor-conflict');
            return result(true, 'identifier-safe-variant', [component('identifier', anchor, 'letters-number-identity')]);
        }
        if (!overlap) return result(false, 'generic-bare-substring');
        return result(true, 'conditional-number-text-bundle', [
            component('structured-anchor', anchor, c.anchorKind === 'identifier' ? 'identifier-identity' : 'quantity-identity'),
            component('bound-text', overlap, overlap.side),
        ]);
    }

    const numbers = numericTokens(text);
    for (const hit of occurrences(text, c.text)) {
        // An attached different value must not fall back to the text-only route.
        if (identityContinuation(before(text, hit.start)) || identityContinuation(after(text, hit.end))) continue;
        if (numbers.some(number => sameClause(text, hit, number))) continue;
        return result(true, 'safe-bound-text-part', [component('bound-text', hit)]);
    }
    const overlaps = boundaryOverlap(text, c.text);
    for (const number of numbers.filter(token => token.value === c.number)) {
        const overlap = overlaps.find(hit => sameClause(text, number, hit)
            && !numbers.some(other => other.value !== c.number
                && ((other.start >= hit.runEnd && /^ *$/u.test(text.slice(hit.runEnd, other.start)))
                    || (other.end <= hit.runStart && /^ *$/u.test(text.slice(other.end, hit.runStart))))));
        if (overlap) return result(true, 'conditional-number-text-bundle', [component('number', number), component('bound-text', overlap, overlap.side)]);
    }
    if (numbers.some(token => token.value === c.number)) return result(false, 'numeric-identity-conflict');
    if (numbers.some(token => token.value.includes(c.number))) return result(false, 'numeric-boundary-conflict');
    if (numbers.some(token => c.number.includes(token.value))) return result(false, 'numeric-fragment');
    return result(false, 'generic-bare-substring');
}
