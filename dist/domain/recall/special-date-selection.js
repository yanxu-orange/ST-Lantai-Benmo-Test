// Legacy pool routing; user-confirmed relevance-first date selection (2026-10-06).
import { compareTimeValues } from './date-facts.js';

export const SPECIAL_DATE_SELECTION_VERSION = 'special-date-selection-v2';
export const RECALL_POOL_ROUTING_VERSION = 'recall-pool-routing-v1';

const TIER_RANK = Object.freeze({
    'named-origin': 0,
    'named-same-day': 1,
    'automatic-same-day': 2,
});

function normalizedLimit(value, label) {
    if (value === null || value === '' || value === undefined) return 0;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) throw new TypeError(`${label} must be a non-negative integer or blank`);
    return number;
}

function ordinaryLimit(value) {
    if (value === null || value === undefined) return Number.POSITIVE_INFINITY;
    return normalizedLimit(value, 'ordinaryLimit');
}

function structuredRelevanceMap(ordinaryResult) {
    return new Map((ordinaryResult?.evaluated ?? []).map(item => [item.memoryId,
        Number.isFinite(item.structuredRelevance) ? item.structuredRelevance : null]));
}

function targetAuthority(specialResult, fictionalCalendar) {
    const targets = specialResult?.targetResult?.targets;
    if (!Array.isArray(targets)) throw new TypeError('specialResult.targetResult.targets must be an array');
    const indexed = targets.map((target, authorityIndex) => ({ target, authorityIndex }));
    const named = indexed.filter(item => item.target?.kind === 'named');
    const automatic = indexed.filter(item => item.target?.kind === 'automatic');
    const compareNamed = (left, right) => {
        const leftIdentity = left.target.calendarIdentity ?? {};
        const rightIdentity = right.target.calendarIdentity ?? {};
        const calendarConflict = leftIdentity.calendarId && rightIdentity.calendarId
            && leftIdentity.calendarId !== rightIdentity.calendarId;
        const byDate = calendarConflict ? null
            : compareTimeValues(left.target.targetDate, right.target.targetDate, fictionalCalendar);
        return byDate === null || byDate === 0 ? left.authorityIndex - right.authorityIndex : byDate;
    };
    named.sort(compareNamed);
    automatic.sort((left, right) => left.authorityIndex - right.authorityIndex);
    const ordered = [...named, ...automatic];
    return new Map(ordered.map((item, rank) => [item.target.id, {
        rank, kind: item.target.kind, authorityIndex: item.authorityIndex,
    }]));
}

function recordComparator(left, right, evidenceFor = record => record.tierEvidence) {
    const leftEvidence = evidenceFor(left);
    const rightEvidence = evidenceFor(right);
    const leftYears = Math.min(...leftEvidence.map(item => item.yearsAgo));
    const rightYears = Math.min(...rightEvidence.map(item => item.yearsAgo));
    const byYears = leftYears - rightYears;
    const leftRelevance = Number.isFinite(left.structuredRelevance) ? left.structuredRelevance : 0;
    const rightRelevance = Number.isFinite(right.structuredRelevance) ? right.structuredRelevance : 0;
    const byRelevance = rightRelevance - leftRelevance;
    if (byRelevance) return byRelevance;
    if (byYears) return byYears;
    return left.libraryIndex - right.libraryIndex;
}

function normalizeSpecialCandidates(specialResult, ordinaryResult, authority) {
    if (!Array.isArray(specialResult?.candidates)) throw new TypeError('specialResult.candidates must be an array');
    const relevance = structuredRelevanceMap(ordinaryResult);
    const ids = new Set();
    const libraryIndexes = new Set();
    return specialResult.candidates.map(candidate => {
        if (!candidate || typeof candidate.memoryId !== 'string' || !['resident', 'trigger'].includes(candidate.mode)) {
            throw new TypeError('special candidate identity is invalid');
        }
        if (!Number.isInteger(candidate.libraryIndex) || candidate.libraryIndex < 0) throw new TypeError('special candidate libraryIndex is invalid');
        if (ids.has(candidate.memoryId) || libraryIndexes.has(candidate.libraryIndex)) throw new TypeError('special candidate snapshot is not unique');
        ids.add(candidate.memoryId);
        libraryIndexes.add(candidate.libraryIndex);
        if (!Array.isArray(candidate.evidence) || !candidate.evidence.length) throw new TypeError('special candidate evidence is missing');
        const evidence = structuredClone(candidate.evidence);
        const rank = Math.min(...evidence.map(item => TIER_RANK[item.kind] ?? Number.POSITIVE_INFINITY));
        if (!Number.isFinite(rank)) throw new TypeError('special candidate evidence kind is invalid');
        const highestTier = Object.keys(TIER_RANK).find(kind => TIER_RANK[kind] === rank);
        const tierEvidence = evidence.filter(item => item.kind === highestTier);
        for (const evidence of tierEvidence) {
            if (!authority.has(evidence.targetId) || !Number.isInteger(evidence.yearsAgo) || evidence.yearsAgo < 1) {
                throw new TypeError('special candidate evidence authority is invalid');
            }
        }
        return {
            memoryId: candidate.memoryId,
            mode: candidate.mode,
            libraryIndex: candidate.libraryIndex,
            highestTier,
            evidence,
            tierEvidence,
            structuredRelevance: relevance.get(candidate.memoryId) ?? null,
        };
    });
}

/**
 * Establishes one K-independent canonical order. K only takes a prefix. This
 * layer consumes 23B-8 evidence and optional 23B-7 raw structured relevance;
 * it never re-evaluates keywords, dates, or ordinary qualification.
 */
export function selectSpecialDateCandidates({
    specialResult, ordinaryResult = null, limit = null, fictionalCalendar = {},
} = {}) {
    const authority = targetAuthority(specialResult, fictionalCalendar);
    const records = normalizeSpecialCandidates(specialResult, ordinaryResult, authority);
    const residents = records.filter(record => record.mode === 'resident').sort((a, b) => a.libraryIndex - b.libraryIndex);
    const triggers = records.filter(record => record.mode === 'trigger');
    const origins = triggers.filter(record => record.highestTier === 'named-origin');
    const named = triggers.filter(record => record.highestTier === 'named-same-day');
    const automatic = triggers.filter(record => record.highestTier === 'automatic-same-day');
    const originOrder = [...origins].sort(recordComparator);
    const namedOrder = [...named].sort(recordComparator);
    const automaticOrder = [...automatic].sort(recordComparator);
    const canonical = [...originOrder, ...namedOrder, ...automaticOrder];
    const quota = normalizedLimit(limit, 'limit');
    const selected = canonical.slice(0, quota);
    const selectedIds = new Set(selected.map(item => item.memoryId));
    return {
        version: SPECIAL_DATE_SELECTION_VERSION,
        limit: quota,
        memorySelectionEnabled: quota > 0,
        canonical,
        canonicalIds: canonical.map(item => item.memoryId),
        selected,
        selectedIds: selected.map(item => item.memoryId),
        notSelected: canonical.filter(item => !selectedIds.has(item.memoryId)),
        residentEvidence: residents,
        diagnostics: [
            ...residents.map(item => ({ memoryId: item.memoryId, code: 'resident-special-excluded-before-k' })),
            ...canonical.filter(item => !selectedIds.has(item.memoryId))
                .map(item => ({ memoryId: item.memoryId, code: quota ? 'special-k-limited' : 'special-selection-disabled' })),
        ],
    };
}

function ordinaryReason(item) {
    return item.qualificationPaths.map(path => path.reason?.code ?? path.channel).join('；');
}

/**
 * Routes already-evaluated channel results into resident, K, and count-based N
 * membership. Token budgeting and narrative injection ordering remain outside.
 */
export function routeRecallPoolsV2({
    memories, ordinaryResult, specialResult, specialLimit = null,
    ordinaryLimit: ordinaryQuota = null, fictionalCalendar = {}, ordinaryRankedReference = null,
} = {}) {
    if (!Array.isArray(memories)) throw new TypeError('memories must be an array');
    if (!Array.isArray(ordinaryResult?.evaluated)) throw new TypeError('ordinaryResult.evaluated must be an array');
    const ids = new Set();
    const memoryById = new Map();
    memories.forEach((memory, libraryIndex) => {
        if (!memory || typeof memory.id !== 'string' || ids.has(memory.id)) throw new TypeError('memory snapshot ids must be unique strings');
        if (!['resident', 'trigger'].includes(memory.mode)) throw new TypeError('memory mode is invalid');
        ids.add(memory.id);
        memoryById.set(memory.id, { memory, libraryIndex });
    });
    const evaluatedById = new Map();
    for (const item of ordinaryResult.evaluated) {
        const snapshot = memoryById.get(item.memoryId);
        if (!snapshot || snapshot.memory.mode !== 'trigger' || snapshot.libraryIndex !== item.libraryIndex
            || evaluatedById.has(item.memoryId)) throw new TypeError('ordinary result library snapshot differs');
        evaluatedById.set(item.memoryId, item);
    }
    for (const memory of memories) {
        if (memory.mode === 'trigger' && !evaluatedById.has(memory.id)) throw new TypeError('ordinary result is incomplete');
    }
    const special = selectSpecialDateCandidates({
        specialResult, ordinaryResult, limit: specialLimit, fictionalCalendar,
    });
    for (const record of [...special.canonical, ...special.residentEvidence]) {
        const snapshot = memoryById.get(record.memoryId);
        if (!snapshot || snapshot.libraryIndex !== record.libraryIndex || snapshot.memory.mode !== record.mode) {
            throw new TypeError('special result library snapshot differs');
        }
    }
    const selectedSpecialIds = new Set(special.selectedIds);
    const aliasRank = new Map();
    if (ordinaryRankedReference !== null) {
        if (!Array.isArray(ordinaryRankedReference)) throw new TypeError('ordinaryRankedReference must be an array');
        ordinaryRankedReference.forEach((item, index) => {
            if (!item || typeof item.memoryId !== 'string' || aliasRank.has(item.memoryId)
                || !evaluatedById.get(item.memoryId)?.ordinaryQualified) {
                throw new TypeError('ordinary alias ranking snapshot differs');
            }
            aliasRank.set(item.memoryId, index);
        });
    }
    const ordinaryCanonical = ordinaryResult.evaluated
        .filter(item => item.ordinaryQualified && !selectedSpecialIds.has(item.memoryId))
        .sort((left, right) => (right.structuredRelevance ?? 0) - (left.structuredRelevance ?? 0)
            || (aliasRank.has(left.memoryId) && aliasRank.has(right.memoryId)
                ? aliasRank.get(left.memoryId) - aliasRank.get(right.memoryId)
                : 0)
            || left.libraryIndex - right.libraryIndex)
        .map(item => ({
            ...item,
            memory: memoryById.get(item.memoryId).memory,
            reason: ordinaryReason(item),
        }));
    const n = ordinaryLimit(ordinaryQuota);
    const selectedOrdinary = ordinaryCanonical.slice(0, n);
    const selectedOrdinaryIds = new Set(selectedOrdinary.map(item => item.memoryId));
    const residents = memories.map((memory, libraryIndex) => ({ memory, libraryIndex }))
        .filter(item => item.memory.mode === 'resident')
        .map(item => {
            const specialEvidence = special.residentEvidence.find(record => record.memoryId === item.memory.id) ?? null;
            return { ...item, memoryId: item.memory.id, specialEvidence };
        });
    const selectedSpecial = special.selected.map(item => ({ ...item, memory: memoryById.get(item.memoryId).memory,
        reason: `纪念日：${item.highestTier}` }));
    const provenanceById = Object.create(null);
    const diagnostics = [...special.diagnostics];
    for (const { memory } of residents) provenanceById[memory.id] = ['resident'];
    for (const record of specialResult.candidates) {
        const sources = provenanceById[record.memoryId] ?? [];
        for (const kind of record.evidence.map(item => item.kind)) if (!sources.includes(kind)) sources.push(kind);
        provenanceById[record.memoryId] = sources;
    }
    for (const item of ordinaryResult.evaluated.filter(item => item.ordinaryQualified)) {
        const sources = provenanceById[item.memoryId] ?? [];
        if (!sources.includes('ordinary-qualified')) sources.push('ordinary-qualified');
        provenanceById[item.memoryId] = sources;
        if (selectedSpecialIds.has(item.memoryId)) diagnostics.push({ memoryId: item.memoryId, code: 'ordinary-slot-released-by-special-k' });
        else if (!selectedOrdinaryIds.has(item.memoryId)) diagnostics.push({ memoryId: item.memoryId, code: 'ordinary-n-limited' });
    }
    const uniqueMembershipIds = [
        ...residents.map(item => item.memoryId),
        ...selectedSpecial.map(item => item.memoryId),
        ...selectedOrdinary.map(item => item.memoryId),
    ];
    if (new Set(uniqueMembershipIds).size !== uniqueMembershipIds.length) throw new TypeError('pool routing produced duplicate memory ids');
    return {
        version: RECALL_POOL_ROUTING_VERSION,
        special,
        resident: { selected: residents, selectedIds: residents.map(item => item.memoryId) },
        specialPool: { selected: selectedSpecial, selectedIds: selectedSpecial.map(item => item.memoryId),
            notSelected: special.notSelected },
        ordinary: { canonical: ordinaryCanonical, canonicalIds: ordinaryCanonical.map(item => item.memoryId),
            selected: selectedOrdinary, selectedIds: selectedOrdinary.map(item => item.memoryId),
            notSelected: ordinaryCanonical.filter(item => !selectedOrdinaryIds.has(item.memoryId)) },
        uniqueMembershipIds,
        provenanceById,
        diagnostics,
        reminders: structuredClone(specialResult.occurrences ?? []),
        orderMeaning: 'pool-membership-assembly-only-not-narrative-injection-order',
    };
}

