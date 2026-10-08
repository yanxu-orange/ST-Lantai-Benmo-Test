// Pure compatibility evidence: old fixed 01e50d63, adapted to TASK-016 boundaries.
import {
    buildDetailQuerySurfaceModel,
    matchDetailQuerySurface,
    normalizeQuerySurfaceDisplay,
} from './detail-query-surface.js';

export const STRUCTURED_WITNESS_VERSION = 'structured-witness-v1';

const FIELD_SPECS = Object.freeze([
    ['title', memory => memory.title ? [memory.title] : []],
    ['event', memory => memory.keywords?.event ?? []],
    ['detail', memory => memory.keywords?.detail ?? []],
    ['primary', memory => memory.keywords?.primary ?? []],
    ['people', memory => memory.people ?? []],
    ['locations', memory => memory.locations ?? []],
    ['auxiliary', memory => memory.keywords?.auxiliary ?? []],
]);

function assertString(value, label) {
    if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
}

function assertStructuredList(value, label) {
    if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
    value.forEach((item, index) => assertString(item, `${label}[${index}]`));
    return value;
}

export function buildRecallQueryFragments({ currentInput, recentHistory = [] } = {}) {
    assertString(currentInput, 'currentInput');
    if (!Array.isArray(recentHistory)) throw new TypeError('recentHistory must be an array');
    const fragments = [{
        id: 'current:0', sourceKind: 'current', rawPosition: null, distanceFromCurrent: 0,
        originalText: currentInput, cleanedText: currentInput,
    }];
    const ids = new Set(['current:0']);
    const historyDistances = new Set();
    for (const [index, item] of recentHistory.entries()) {
        if (!item || typeof item !== 'object') throw new TypeError(`recentHistory[${index}] must be an object`);
        if (!Number.isInteger(item.rawPosition) || item.rawPosition < 0) throw new TypeError(`recentHistory[${index}].rawPosition must be a non-negative integer`);
        if (!Number.isInteger(item.distanceFromCurrent) || item.distanceFromCurrent < 1) throw new TypeError(`recentHistory[${index}].distanceFromCurrent must be a positive integer`);
        assertString(item.originalText, `recentHistory[${index}].originalText`);
        assertString(item.cleanedText, `recentHistory[${index}].cleanedText`);
        const id = `history:${item.rawPosition}`;
        if (ids.has(id)) throw new TypeError(`Duplicate query fragment id: ${id}`);
        if (historyDistances.has(item.distanceFromCurrent)) throw new TypeError(`Duplicate history distance: ${item.distanceFromCurrent}`);
        ids.add(id);
        historyDistances.add(item.distanceFromCurrent);
        fragments.push({
            id, sourceKind: 'history', rawPosition: item.rawPosition,
            distanceFromCurrent: item.distanceFromCurrent,
            originalText: item.originalText, cleanedText: item.cleanedText,
        });
    }
    return Object.freeze(fragments.map(fragment => Object.freeze(fragment)));
}

function canonicalFactKey(value) {
    return normalizeQuerySurfaceDisplay(value);
}

function characterBefore(text, index) {
    return Array.from(text.slice(Math.max(0, index - 2), index)).at(-1) ?? '';
}

function characterAfter(text, index) {
    return String.fromCodePoint(text.codePointAt(index) ?? 0);
}

function continuesIdentity(char) {
    return /[\p{N}\p{M}\p{Script=Latin}_]/u.test(char);
}

function matchLiteralSurface(storedValue, queryText) {
    const stored = canonicalFactKey(storedValue).toLowerCase();
    const query = normalizeQuerySurfaceDisplay(queryText).toLowerCase();
    if (!stored) return null;
    for (let start = query.indexOf(stored); start !== -1; start = query.indexOf(stored, start + stored.length)) {
        const end = start + stored.length;
        const first = Array.from(stored)[0];
        const last = Array.from(stored).at(-1);
        if (continuesIdentity(first) && continuesIdentity(characterBefore(query, start))) continue;
        if (continuesIdentity(last) && continuesIdentity(characterAfter(query, end))) continue;
        return {
            matchClass: 'full-literal', ruleFamily: 'literal', normalizedQuery: query,
            coordinateSystem: 'normalized-query-utf16',
            usedComponents: [{ kind: 'full-value', value: stored, range: [start, end], relation: 'exact' }],
        };
    }
    return null;
}

function fieldValues(memory, field, getter) {
    const values = getter(memory);
    if (field === 'title') {
        values.forEach((item, index) => assertString(item, `memory.title[${index}]`));
        return values;
    }
    return assertStructuredList(values, `memory.${field}`);
}

function collectOccurrenceWitnesses(memoryId, occurrence, fragments) {
    const model = occurrence.field === 'detail' ? buildDetailQuerySurfaceModel(occurrence.storedValue) : null;
    const witnesses = [];
    for (const [fragmentIndex, fragment] of fragments.entries()) {
        if (!fragment.cleanedText) continue;
        const surface = model
            ? matchDetailQuerySurface(model, fragment.cleanedText)
            : matchLiteralSurface(occurrence.storedValue, fragment.cleanedText);
        if (!surface?.matched && occurrence.field === 'detail') continue;
        if (!surface) continue;
        witnesses.push({
            id: JSON.stringify([memoryId, occurrence.field, occurrence.fieldIndex, fragment.id]),
            memoryId, parentFactId: null, fragmentId: fragment.id,
            sourceKind: fragment.sourceKind, rawPosition: fragment.rawPosition,
            distanceFromCurrent: fragment.distanceFromCurrent,
            field: occurrence.field, fieldIndex: occurrence.fieldIndex,
            storedValue: occurrence.storedValue,
            matchClass: surface.matchClass, ruleFamily: surface.ruleFamily,
            normalizedQuery: surface.normalizedQuery,
            coordinateSystem: surface.coordinateSystem,
            usedComponents: surface.usedComponents.map(component => ({
                ...component, range: [...component.range],
            })),
            _fragmentIndex: fragmentIndex,
        });
    }
    return witnesses;
}

/**
 * Collects lossless local witnesses and groups them into retrieval parent facts.
 * Distinct detail array entries remain distinct atoms. Literal fields with the
 * same conservative canonical key join one unambiguous detail atom when present.
 */
export function collectMemoryStructuredWitnesses(memory, fragments) {
    if (!memory || typeof memory !== 'object') throw new TypeError('memory must be an object');
    assertString(memory.id, 'memory.id');
    if (!Array.isArray(fragments)) throw new TypeError('fragments must be an array');
    const fragmentIds = new Set();
    const historyDistances = new Set();
    fragments.forEach((fragment, index) => {
        if (!fragment || typeof fragment !== 'object') throw new TypeError(`fragments[${index}] must be an object`);
        assertString(fragment.id, `fragments[${index}].id`);
        assertString(fragment.originalText, `fragments[${index}].originalText`);
        assertString(fragment.cleanedText, `fragments[${index}].cleanedText`);
        if (!['current', 'history'].includes(fragment.sourceKind)) throw new TypeError(`fragments[${index}].sourceKind is invalid`);
        if (!Number.isInteger(fragment.distanceFromCurrent) || fragment.distanceFromCurrent < 0) throw new TypeError(`fragments[${index}].distanceFromCurrent is invalid`);
        if (fragment.sourceKind === 'current') {
            if (fragment.id !== 'current:0' || fragment.rawPosition !== null || fragment.distanceFromCurrent !== 0) {
                throw new TypeError(`fragments[${index}] has an invalid current identity`);
            }
        } else {
            if (!Number.isInteger(fragment.rawPosition) || fragment.rawPosition < 0
                || fragment.id !== `history:${fragment.rawPosition}` || fragment.distanceFromCurrent < 1) {
                throw new TypeError(`fragments[${index}] has an invalid history identity`);
            }
            if (historyDistances.has(fragment.distanceFromCurrent)) throw new TypeError(`Duplicate history distance: ${fragment.distanceFromCurrent}`);
            historyDistances.add(fragment.distanceFromCurrent);
        }
        if (fragmentIds.has(fragment.id)) throw new TypeError(`Duplicate query fragment id: ${fragment.id}`);
        fragmentIds.add(fragment.id);
    });

    const matchedOccurrences = [];
    FIELD_SPECS.forEach(([field, getter], fieldRank) => {
        fieldValues(memory, field, getter).forEach((storedValue, fieldIndex) => {
            if (!storedValue.trim()) return;
            const occurrence = {
                field, fieldIndex, fieldRank, storedValue,
                canonicalKey: canonicalFactKey(storedValue),
            };
            const witnesses = collectOccurrenceWitnesses(memory.id, occurrence, fragments);
            if (witnesses.length) matchedOccurrences.push({ ...occurrence, witnesses });
        });
    });

    const groups = [];
    const detailGroupsByCanonical = new Map();
    for (const occurrence of matchedOccurrences.filter(item => item.field === 'detail')) {
        const group = {
            groupKey: `detail:${occurrence.fieldIndex}:${occurrence.canonicalKey}`,
            canonicalKey: occurrence.canonicalKey, parentKind: 'detail-atom', occurrences: [occurrence],
        };
        groups.push(group);
        const same = detailGroupsByCanonical.get(occurrence.canonicalKey) ?? [];
        same.push(group);
        detailGroupsByCanonical.set(occurrence.canonicalKey, same);
    }
    const literalGroups = new Map();
    for (const occurrence of matchedOccurrences.filter(item => item.field !== 'detail')) {
        const detailGroups = detailGroupsByCanonical.get(occurrence.canonicalKey) ?? [];
        if (detailGroups.length === 1) {
            detailGroups[0].occurrences.push(occurrence);
            continue;
        }
        let group = literalGroups.get(occurrence.canonicalKey);
        if (!group) {
            group = {
                groupKey: `literal:${occurrence.canonicalKey}`,
                canonicalKey: occurrence.canonicalKey, parentKind: 'literal-fact', occurrences: [],
            };
            literalGroups.set(occurrence.canonicalKey, group);
            groups.push(group);
        }
        group.occurrences.push(occurrence);
    }

    const parentFacts = groups.map(group => {
        group.occurrences.sort((a, b) => a.fieldRank - b.fieldRank || a.fieldIndex - b.fieldIndex);
        const id = JSON.stringify([memory.id, group.groupKey]);
        const witnesses = group.occurrences.flatMap(occurrence => occurrence.witnesses)
            .sort((a, b) => a._fragmentIndex - b._fragmentIndex
                || FIELD_SPECS.findIndex(([field]) => field === a.field) - FIELD_SPECS.findIndex(([field]) => field === b.field)
                || a.fieldIndex - b.fieldIndex)
            .map(witness => {
                const { _fragmentIndex, ...publicWitness } = witness;
                return { ...publicWitness, parentFactId: id };
            });
        return {
            id, memoryId: memory.id, parentKind: group.parentKind,
            canonicalKey: group.canonicalKey,
            sourceFields: [...new Set(group.occurrences.map(item => item.field))],
            storedOccurrences: group.occurrences.map(item => ({
                field: item.field, fieldIndex: item.fieldIndex, storedValue: item.storedValue,
            })),
            witnesses,
        };
    }).sort((a, b) => {
        const firstA = a.storedOccurrences[0];
        const firstB = b.storedOccurrences[0];
        return FIELD_SPECS.findIndex(([field]) => field === firstA.field)
            - FIELD_SPECS.findIndex(([field]) => field === firstB.field)
            || firstA.fieldIndex - firstB.fieldIndex;
    });

    const fragmentEvidence = fragments.map(fragment => {
        const witnesses = parentFacts.flatMap(parent => parent.witnesses)
            .filter(witness => witness.fragmentId === fragment.id);
        return {
            fragmentId: fragment.id,
            parentFactIds: [...new Set(witnesses.map(witness => witness.parentFactId))],
            witnessIds: witnesses.map(witness => witness.id),
        };
    });
    return {
        version: STRUCTURED_WITNESS_VERSION,
        memoryId: memory.id,
        parentFacts,
        fragmentEvidence,
    };
}
