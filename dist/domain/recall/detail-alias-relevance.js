// Pure compatibility evidence: old fixed 01e50d63, adapted to TASK-016 boundaries.
import { collectDetailAliasCandidates, normalizeDetailAliasBindings } from './detail-alias-candidates.js';
import { combineStructuredAndTimeEvidence, evaluateOrdinaryRecallV2 } from './joint-qualification.js';
import { evaluateStructuredRecallCandidates } from './structured-relevance.js';

export const DETAIL_ALIAS_RELEVANCE_VERSION = 'detail-alias-relevance-v1';

function buildAliasLibraryStatistics(memories, relations) {
    const aliases = new Set(relations.flatMap(relation => relation.aliases.map(alias => alias.normalized)));
    const aliasesByMemory = new Map();
    for (const relation of relations) {
        const local = aliasesByMemory.get(relation.memoryId) ?? new Set();
        relation.aliases.forEach(alias => local.add(alias.normalized));
        aliasesByMemory.set(relation.memoryId, local);
    }
    for (const memory of memories) {
        if (memory?.mode !== 'trigger' || typeof memory.id !== 'string') continue;
        const local = aliasesByMemory.get(memory.id) ?? new Set();
        const values = [memory.title ?? '', ...(memory.keywords?.event ?? []),
            ...(memory.keywords?.detail ?? []), ...(memory.keywords?.primary ?? []),
            ...(memory.people ?? []), ...(memory.locations ?? []), ...(memory.keywords?.auxiliary ?? [])];
        for (const value of values) {
            const normalized = typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '';
            if (aliases.has(normalized)) local.add(normalized);
        }
        aliasesByMemory.set(memory.id, local);
    }
    const documentFrequency = new Map();
    for (const aliases of aliasesByMemory.values()) {
        for (const alias of aliases) {
            documentFrequency.set(alias, (documentFrequency.get(alias) ?? 0) + 1);
        }
    }
    return {
        version: 'detail-alias-statistics-v1',
        triggerCount: memories.filter(memory => memory?.mode === 'trigger').length,
        aliases: Object.fromEntries([...documentFrequency].map(([alias, frequency]) => [alias, {
            documentFrequency: frequency,
            meaningfulLength: Array.from(alias).length,
        }])),
    };
}

function compareAliasSupport(left, right) {
    if (!left) return right ? 1 : 0;
    if (!right) return -1;
    return left.distanceFromCurrent - right.distanceFromCurrent
        || left.aliasDocumentFrequency - right.aliasDocumentFrequency
        || right.aliasMeaningfulLength - left.aliasMeaningfulLength
        || left.discoveryOrder - right.discoveryOrder;
}

function baseRelevance(entry) {
    return Number.isFinite(entry.structuredRelevance) ? entry.structuredRelevance : 0;
}

function chooseProjectionCandidates(candidates) {
    const byParent = new Map();
    candidates.forEach((candidate, discoveryOrder) => {
        const key = JSON.stringify([candidate.memoryId, candidate.detailIndex]);
        const previous = byParent.get(key);
        const evaluated = { ...candidate, discoveryOrder, aliasDocumentFrequency: 0 };
        if (!previous || compareAliasSupport(evaluated, previous.evaluated) < 0) {
            byParent.set(key, { candidate, evaluated });
        }
    });
    const consumedAliasByMemory = new Set();
    const selected = [];
    for (const { candidate } of byParent.values()) {
        const key = JSON.stringify([candidate.memoryId, candidate.normalizedAlias]);
        if (consumedAliasByMemory.has(key)) continue;
        consumedAliasByMemory.add(key);
        selected.push(candidate);
    }
    return selected;
}

function addAliasWitnesses(base, memories, selected) {
    const candidates = structuredClone(base.structuredResult.candidates);
    const byMemory = new Map(candidates.map(candidate => [candidate.memoryId, candidate]));
    const libraryIndex = new Map(memories.map((memory, index) => [memory.id, index]));
    for (const alias of selected) {
        let candidate = byMemory.get(alias.memoryId);
        if (!candidate) {
            candidate = { memoryId: alias.memoryId, libraryIndex: libraryIndex.get(alias.memoryId),
                evidence: { version: 'structured-witness-v1', memoryId: alias.memoryId,
                    parentFacts: [], fragmentEvidence: base.structuredResult.fragments.map(fragment => ({
                        fragmentId: fragment.id, parentFactIds: [], witnessIds: [],
                    })) }, localBundles: [] };
            candidates.push(candidate);
            byMemory.set(alias.memoryId, candidate);
        }
        let parent = candidate.evidence.parentFacts.find(item => item.id === alias.parentFactId);
        if (!parent) {
            parent = { id: alias.parentFactId, memoryId: alias.memoryId, parentKind: 'detail-atom',
                canonicalKey: alias.parentDetail.normalize('NFKC').trim(), sourceFields: ['detail'],
                storedOccurrences: [{ field: 'detail', fieldIndex: alias.detailIndex, storedValue: alias.parentDetail }],
                witnesses: [] };
            candidate.evidence.parentFacts.push(parent);
        }
        const witness = { id: alias.id, memoryId: alias.memoryId, parentFactId: alias.parentFactId,
            fragmentId: alias.fragmentId, sourceKind: alias.sourceKind, rawPosition: alias.rawPosition,
            distanceFromCurrent: alias.distanceFromCurrent, field: 'detail', fieldIndex: alias.detailIndex,
            storedValue: alias.matchedAlias, matchClass: 'full-detail', ruleFamily: 'explicit-detail-alias',
            normalizedQuery: alias.normalizedQuery, coordinateSystem: alias.coordinateSystem,
            usedComponents: alias.usedComponents.map(component => ({ ...component, range: [...component.range] })) };
        parent.witnesses.push(witness);
        const fragmentEvidence = candidate.evidence.fragmentEvidence.find(item => item.fragmentId === alias.fragmentId);
        if (!fragmentEvidence) throw new TypeError('Alias candidate fragment is missing from structured snapshot');
        if (!fragmentEvidence.parentFactIds.includes(parent.id)) fragmentEvidence.parentFactIds.push(parent.id);
        fragmentEvidence.witnessIds.push(witness.id);
        let bundle = candidate.localBundles.find(item => item.fragmentId === alias.fragmentId);
        if (!bundle) {
            bundle = { id: JSON.stringify([alias.memoryId, alias.fragmentId]), memoryId: alias.memoryId,
                fragmentId: alias.fragmentId, sourceKind: alias.sourceKind, rawPosition: alias.rawPosition,
                distanceFromCurrent: alias.distanceFromCurrent, parentFactIds: [], witnessIds: [],
                sourceFields: [], fieldFamilies: [], parentEvidence: [] };
            candidate.localBundles.push(bundle);
        }
        if (!bundle.parentFactIds.includes(parent.id)) bundle.parentFactIds.push(parent.id);
        bundle.witnessIds.push(witness.id);
        if (!bundle.sourceFields.includes('detail')) bundle.sourceFields.push('detail');
        if (!bundle.fieldFamilies.includes('detail')) bundle.fieldFamilies.push('detail');
        let localParent = bundle.parentEvidence.find(item => item.parentFactId === parent.id);
        if (!localParent) {
            localParent = { parentFactId: parent.id, sourceFields: ['detail'], fieldFamilies: ['detail'], witnessIds: [] };
            bundle.parentEvidence.push(localParent);
        }
        localParent.witnessIds.push(witness.id);
    }
    candidates.sort((left, right) => left.libraryIndex - right.libraryIndex);
    return { ...base.structuredResult, candidates };
}

function withAliasStatistics(statistics, aliasStatistics) {
    const next = structuredClone(statistics);
    for (const [alias, item] of Object.entries(aliasStatistics.aliases)) {
        const key = JSON.stringify(['literal', alias]);
        next.factDocumentFrequency[key] = item.documentFrequency;
        next.byFamily.detail[key] = item.documentFrequency;
    }
    return next;
}

/**
 * Adds each actually matched explicit alias as a coordinate-bound witness of
 * its parent detail atom, then evaluates the unchanged ordinary-recall rules.
 */
export function evaluateOrdinaryRecallWithAliases({
    memories,
    currentInput,
    recentHistory = [],
    bindings = [],
    currentStoryTime = null,
    fictionalCalendar = {},
    structuredConfig,
} = {}) {
    if (!Array.isArray(bindings)) throw new TypeError('bindings must be an array');
    const base = evaluateOrdinaryRecallV2({
        memories,
        currentInput,
        recentHistory,
        currentStoryTime,
        fictionalCalendar,
        structuredConfig,
    });
    if (!bindings.length) return base;

    const triggerMemories = memories.filter(memory => memory?.mode === 'trigger');
    const normalized = normalizeDetailAliasBindings({ memories: triggerMemories, bindings });
    const aliasResult = collectDetailAliasCandidates({
        memories: triggerMemories,
        fragments: base.structuredResult.fragments,
        bindings,
    });
    const statistics = buildAliasLibraryStatistics(triggerMemories, normalized.relations);
    const selectedProjection = chooseProjectionCandidates(aliasResult.candidates);
    const candidateResult = addAliasWitnesses(base, memories, selectedProjection);
    const structuredResult = evaluateStructuredRecallCandidates(candidateResult, {
        memories, config: base.structuredResult.config,
        statistics: withAliasStatistics(base.structuredResult.statistics, statistics),
    });
    const authoritative = combineStructuredAndTimeEvidence({
        memories, structuredResult, timeResult: base.timeResult,
    });
    const nonTriggerIds = new Set(memories
        .filter(memory => memory && typeof memory.id === 'string' && memory.mode !== 'trigger')
        .map(memory => memory.id));
    const diagnostics = aliasResult.diagnostics.map(item =>
        item.code === 'binding-memory-not-found' && nonTriggerIds.has(item.memoryId)
            ? { ...item, code: 'binding-memory-not-trigger' }
            : item);
    const baseByMemory = new Map(authoritative.evaluated.map(entry => [entry.memoryId, entry]));
    const bestByMemory = new Map();
    const selectedSet = new Set(selectedProjection);

    const candidates = aliasResult.candidates.map((candidate, discoveryOrder) => {
        const ordinary = baseByMemory.get(candidate.memoryId);
        if (!ordinary) throw new TypeError('Alias candidate has no ordinary-recall evaluation');
        const projectedId = candidate.parentFactId;
        const projectedParent = ordinary.structuredEvidence?.evidence.parentFacts
            .find(parent => parent.id === projectedId) ?? null;
        const fragmentTime = ordinary.timeByFragment.find(summary => summary.fragmentId === candidate.fragmentId);
        const suppressionReasons = [];
        if (ordinary.provenance.explicitCurrentTimeConflict) {
            suppressionReasons.push('explicit-current-time-conflict');
        } else if (fragmentTime?.relation === 'conflict') {
            suppressionReasons.push('same-fragment-time-conflict');
        }
        if (!selectedSet.has(candidate)) suppressionReasons.push('better-alias-support-already-consumed');
        const aliasContribution = ordinary.structuredEvidence?.parentContributions
            .find(parent => parent.parentFactId === projectedId) ?? null;
        const aliasConsumed = (aliasContribution?.consumedValue ?? 0) > 0;
        const aliasQualified = aliasConsumed && ordinary.structuredQualificationReasons
            .some(reason => reason.parentFactId === projectedId
                || ordinary.structuredEvidence?.localBundles.some(bundle => bundle.id === reason.bundleId
                    && bundle.parentFactIds.includes(projectedId)));
        if (!projectedParent || !aliasContribution) suppressionReasons.push('alias-query-surface-not-consumed');
        else if (!aliasConsumed) suppressionReasons.push('alias-did-not-qualify');
        if (!ordinary.ordinaryQualified) suppressionReasons.push('ordinary-memory-not-qualified');

        const evaluated = {
            ...candidate,
            discoveryOrder,
            projectedParentFactId: projectedId,
            aliasDocumentFrequency: aliasContribution?.documentFrequency ?? null,
            aliasMeaningfulLength: aliasContribution?.meaningfulLength ?? candidate.aliasMeaningfulLength,
            qualificationEligible: aliasQualified && !suppressionReasons.some(reason => reason.includes('time-conflict')),
            rankingEligible: suppressionReasons.length === 0,
            suppressionReasons,
        };
        if (evaluated.rankingEligible) {
            const previous = bestByMemory.get(candidate.memoryId);
            if (!previous || compareAliasSupport(evaluated, previous) < 0) {
                bestByMemory.set(candidate.memoryId, evaluated);
            }
        }
        return evaluated;
    });

    for (const candidate of candidates) {
        if (candidate.rankingEligible && bestByMemory.get(candidate.memoryId) !== candidate) {
            candidate.rankingEligible = false;
            candidate.suppressionReasons.push('better-alias-support-already-consumed');
        }
    }

    const evaluated = authoritative.evaluated.map(ordinary => ({
        memoryId: ordinary.memoryId,
        libraryIndex: ordinary.libraryIndex,
        ordinaryQualified: ordinary.ordinaryQualified,
        baseStructuredRelevance: base.evaluated.find(item => item.memoryId === ordinary.memoryId)?.structuredRelevance ?? null,
        structuredRelevance: ordinary.structuredRelevance,
        bestAliasSupport: bestByMemory.get(ordinary.memoryId) ?? null,
    }));
    const rankedReference = evaluated.filter(entry => entry.ordinaryQualified).sort((left, right) =>
        baseRelevance(baseByMemory.get(right.memoryId)) - baseRelevance(baseByMemory.get(left.memoryId))
        || left.libraryIndex - right.libraryIndex);

    return {
        version: DETAIL_ALIAS_RELEVANCE_VERSION,
        status: 'active-query-surface',
        base: authoritative,
        aliasResult: {
            version: aliasResult.version,
            statistics,
            diagnostics,
            candidates,
            evaluated,
            rankedReference,
        },
    };
}
