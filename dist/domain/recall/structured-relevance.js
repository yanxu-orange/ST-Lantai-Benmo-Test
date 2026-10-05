// Compatibility source revision: 01e50d63.
import { buildDetailQuerySurfaceModel } from './detail-query-surface.js';

const FAMILIES = Object.freeze({ title: 'title', event: 'event', detail: 'detail',
    primary: 'legacy-primary', auxiliary: 'legacy-auxiliary', people: 'people', locations: 'locations' });
const SOLO_ROLES = new Set(['detail', 'event', 'legacy-primary', 'title']);

function freezeTree(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freezeTree);
        Object.freeze(value);
    }
    return value;
}

// Trial values, NOT calibrated product constants. Structural exclusions above
// remain independent from these knobs. Override with a complete config snapshot.
export const STRUCTURED_RECALL_V2_CANDIDATE_CONFIG = freezeTree({
    version: 'structured-relevance-v1', status: 'candidate',
    roles: {
        detail: { base: 3, cap: 4.5, minimumLength: 2, standaloneMinimum: 1.5 },
        event: { base: 2, cap: 3, minimumLength: 2, standaloneMinimum: 1.3 },
        'legacy-primary': { base: 2, cap: 3, minimumLength: 2, standaloneMinimum: 1.3 },
        title: { base: 1.8, cap: 2.4, minimumLength: 4, standaloneMinimum: 1.2 },
        people: { base: 0.55, cap: 0.65, minimumLength: 2 },
        locations: { base: 0.7, cap: 0.85, minimumLength: 2 },
        'legacy-auxiliary': { base: 0.3, cap: 0.45, minimumLength: 2 },
    },
    matchReliability: {
        'full-detail': 1, 'safe-bound-text-part': 0.7, 'conditional-number-text-bundle': 0.65,
        'identifier-exact': 1, 'identifier-safe-variant': 1, 'identifier-nfkc-variant': 1,
        'measurement-exact': 1, 'signed-unit-exact': 1, 'full-literal': 1,
    },
    sourceDecayRate: 0.2,
    frequencyFloor: 0.2,
    repeatedPrevalenceLimit: 0.75,
    familyDiminishingRatio: 0.5,
    combination: { gain: 0.4, cap: 0.35, minimumLocalValue: 0.2,
        pairs: [['people', 'locations'], ['event', 'detail']] },
});

// This is an evidence-consumption key, not Storage equality or a new surface.
// Safe identifier variants share consumption, but signs, units, decimal digits,
// prefixes and distinct longer atoms remain separate. No substring deduplication.
function factKey(value) {
    const model = buildDetailQuerySurfaceModel(value);
    if (model.ruleFamily === 'identifier') return JSON.stringify(['identifier', model.components.canonical]);
    if (['measurement', 'signed-unit'].includes(model.ruleFamily)) {
        return JSON.stringify(['quantity', model.components.number, model.components.unit]);
    }
    return JSON.stringify(['literal', model.normalized]);
}

export function buildStructuredLibraryStatistics(memories) {
    if (!Array.isArray(memories)) throw new TypeError('memories must be an array');
    const byFamily = Object.fromEntries(Object.values(FAMILIES).map(role => [role, new Map()]));
    const facts = new Map();
    const ids = new Set();
    for (const memory of memories) {
        if (memory.mode !== 'trigger') continue;
        if (typeof memory.id !== 'string' || ids.has(memory.id)) throw new TypeError('Trigger memory ids must be unique strings');
        ids.add(memory.id);
        const seen = new Set();
        for (const [field, family] of Object.entries(FAMILIES)) {
            const values = field === 'title' ? [memory.title ?? '']
                : field === 'people' || field === 'locations' ? memory[field] ?? [] : memory.keywords?.[field] ?? [];
            if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw new TypeError('Statistics require structured string arrays');
            const keys = new Set(values.filter(value => value.trim()).map(factKey));
            for (const key of keys) {
                byFamily[family].set(key, (byFamily[family].get(key) ?? 0) + 1);
                seen.add(key);
            }
        }
        for (const key of seen) facts.set(key, (facts.get(key) ?? 0) + 1);
    }
    return freezeTree({ version: 'structured-statistics-v1', triggerCount: ids.size, triggerMemoryIds: [...ids],
        byFamily: Object.fromEntries(Object.entries(byFamily).map(([role, map]) => [role, Object.fromEntries(map)])),
        factDocumentFrequency: Object.fromEntries(facts) });
}

function validateConfig(config) {
    if (config?.status !== 'candidate' || config.version !== STRUCTURED_RECALL_V2_CANDIDATE_CONFIG.version) {
        throw new TypeError('Expected a versioned candidate configuration');
    }
    function numbers(actual, template) {
        for (const [key, value] of Object.entries(template)) {
            if (typeof value === 'number' && (!Number.isFinite(actual?.[key]) || actual[key] < 0)) throw new TypeError(`Invalid candidate parameter: ${key}`);
            if (value && typeof value === 'object' && !Array.isArray(value)) numbers(actual?.[key], value);
        }
    }
    numbers(config, STRUCTURED_RECALL_V2_CANDIDATE_CONFIG);
    if (config.frequencyFloor > 1 || config.repeatedPrevalenceLimit > 1 || config.familyDiminishingRatio > 1) throw new TypeError('Candidate ratios must be bounded by one');
    if (Object.values(config.matchReliability).some(value => value > 1)
        || config.matchReliability['full-detail'] < config.matchReliability['safe-bound-text-part']
        || config.matchReliability['full-detail'] < config.matchReliability['conditional-number-text-bundle']) throw new TypeError('Invalid match reliability ordering');
    if (JSON.stringify(config.combination.pairs) !== JSON.stringify(STRUCTURED_RECALL_V2_CANDIDATE_CONFIG.combination.pairs)) {
        throw new TypeError('Combination pair policy is not a numeric calibration parameter');
    }
}

function meaningfulLength(value) { return Array.from(value.match(/[\p{L}\p{N}]/gu) ?? []).length; }
function hasTypedDetailIdentity(witness) {
    if (witness.field !== 'detail') return false;
    const model = buildDetailQuerySurfaceModel(witness.storedValue);
    const supported = {
        identifier: new Set(['identifier-exact', 'identifier-safe-variant', 'identifier-nfkc-variant']),
        measurement: new Set(['measurement-exact']),
        'signed-unit': new Set(['signed-unit-exact']),
    };
    return supported[model.ruleFamily]?.has(witness.matchClass) ?? false;
}
function byValue(a, b) { return b.value - a.value || a.witness.distanceFromCurrent - b.witness.distanceFromCurrent || a.order - b.order; }

function witnessValue(witness, key, stats, config, order) {
    const role = FAMILIES[witness.field];
    const policy = config.roles[role];
    const matchReliability = config.matchReliability[witness.matchClass];
    if (!policy || !Number.isFinite(matchReliability)) throw new TypeError('Unsupported witness role or match class');
    const documentFrequency = stats.factDocumentFrequency[key];
    if (!documentFrequency) throw new TypeError('Witness fact missing from library statistics');
    const prevalence = documentFrequency / stats.triggerCount;
    // Leave-one-document repetition lowers small-library false-rarity effects;
    // a singleton gets no rarity bonus. Lexical/role gates remain necessary.
    const repetition = (documentFrequency - 1) / stats.triggerCount;
    const frequencyAdjustment = Math.max(config.frequencyFloor, 1 - repetition);
    const sourceReliability = 1 / (1 + config.sourceDecayRate * witness.distanceFromCurrent);
    const length = meaningfulLength(witness.storedValue);
    const typedDetailIdentity = hasTypedDetailIdentity(witness);
    const specificityAdjustment = Math.min(1, length / Math.max(1, policy.minimumLength));
    return { witness, order, role, documentFrequency, prevalence,
        fieldDocumentFrequency: stats.byFamily[role][key] ?? 0,
        baseFieldRole: policy.base, matchReliability, sourceReliability, frequencyAdjustment,
        meaningfulLength: length, typedDetailIdentity, specificityAdjustment,
        discriminative: (length >= policy.minimumLength || typedDetailIdentity)
            && !(documentFrequency > 1 && prevalence >= config.repeatedPrevalenceLimit),
        value: policy.base * matchReliability * sourceReliability * frequencyAdjustment * specificityAdjustment };
}

function independentSurfaces(a, b) {
    // Distinct stored facts can still be the SAME queried surface. Require each
    // witness to expose some additional matched text before rewarding a pair.
    const av = a.witness.usedComponents.map(item => item.value).join('');
    const bv = b.witness.usedComponents.map(item => item.value).join('');
    return av !== bv && !(av.includes(bv) || bv.includes(av));
}

export function evaluateStructuredCandidate(candidate, statistics, config = STRUCTURED_RECALL_V2_CANDIDATE_CONFIG) {
    validateConfig(config);
    if (!statistics.triggerMemoryIds.includes(candidate.memoryId)) throw new TypeError('Candidate is not a trigger in these statistics');
    const consumptionGroups = new Map();
    let order = 0;
    for (const parent of candidate.evidence.parentFacts) {
        for (const witness of parent.witnesses) {
            // Keep parent IDs intact; retrieval-equivalent stored occurrences
            // are linked only for consumption. Every original witness survives.
            const key = factKey(witness.storedValue);
            const groupKey = parent.id;
            let group = consumptionGroups.get(groupKey);
            if (!group) {
                group = { parentFactId: parent.id, sourceFields: parent.sourceFields, choices: [], key };
                consumptionGroups.set(groupKey, group);
            }
            group.choices.push(witnessValue(witness, key, statistics, config, order++));
        }
    }
    const parentContributions = [...consumptionGroups.values()].map(group => {
        group.choices.sort(byValue);
        const selected = group.choices[0];
        return { ...group, fieldFamilies: [...new Set(group.sourceFields.map(field => FAMILIES[field]))],
            selectedWitness: selected.witness, ...selected, value: selected.value,
            consumedValue: 0, suppressionReasons: [] };
    });
    const consumedKeys = new Set();
    const roleRanks = new Map();
    const roleTotals = new Map();
    const sortedParents = [...parentContributions].sort(byValue);
    for (const parent of sortedParents) {
        if (consumedKeys.has(parent.key)) {
            parent.suppressionReasons.push('retrieval-equivalent-parent-already-consumed');
            continue;
        }
        consumedKeys.add(parent.key);
        const rank = roleRanks.get(parent.role) ?? 0;
        const previous = roleTotals.get(parent.role) ?? 0;
        parent.saturationFactor = config.familyDiminishingRatio ** rank;
        parent.consumedValue = Math.min(parent.value * parent.saturationFactor, Math.max(0, config.roles[parent.role].cap - previous));
        roleRanks.set(parent.role, rank + 1);
        roleTotals.set(parent.role, previous + parent.consumedValue);
        if (parent.consumedValue < parent.value) parent.suppressionReasons.push('family-saturation');
    }

    const qualificationReasons = [];
    const suppressionReasons = [];
    for (const parent of parentContributions) {
        const solo = parent.choices.find(choice => SOLO_ROLES.has(choice.role) && choice.discriminative
            && choice.value >= config.roles[choice.role].standaloneMinimum);
        if (solo) qualificationReasons.push({ code: 'independent-parent', parentFactId: parent.parentFactId, witnessId: solo.witness.id, role: solo.role });
        else suppressionReasons.push({ code: 'no-independent-parent-qualification', parentFactId: parent.parentFactId,
            detail: parent.discriminative ? 'role-or-contribution-insufficient' : 'length-or-prevalence-insufficient' });
    }

    const bundleContributions = candidate.localBundles.map(bundle => {
        // Source fields on parent/bundle are descriptive unions across messages;
        // only these exact local witnesses may supply a role for combination.
        const local = parentContributions.flatMap(parent => parent.choices
            .filter(choice => choice.witness.fragmentId === bundle.fragmentId && bundle.witnessIds.includes(choice.witness.id))
            .map(choice => ({ ...choice, key: parent.key, parentFactId: parent.parentFactId })));
        let best = null;
        for (const [leftRole, rightRole] of config.combination.pairs) {
            for (const left of local.filter(item => item.role === leftRole)) {
                for (const right of local.filter(item => item.role === rightRole)) {
                    if (left.parentFactId === right.parentFactId || left.key === right.key || !independentSurfaces(left, right)) continue;
                    if (!left.discriminative && !right.discriminative) continue;
                    if (left.meaningfulLength < config.roles[left.role].minimumLength || right.meaningfulLength < config.roles[right.role].minimumLength) continue;
                    if (Math.min(left.value, right.value) < config.combination.minimumLocalValue) continue;
                    const value = Math.min(config.combination.cap, config.combination.gain * Math.min(left.value, right.value));
                    if (!best || value > best.value) best = { value, witnessIds: [left.witness.id, right.witness.id],
                        parentFactIds: [left.parentFactId, right.parentFactId], roles: [leftRole, rightRole] };
                }
            }
        }
        if (best) qualificationReasons.push({ code: 'local-complement', bundleId: bundle.id, ...best });
        return { bundleId: bundle.id, fragmentId: bundle.fragmentId, distanceFromCurrent: bundle.distanceFromCurrent,
            ...(best ?? { value: 0, witnessIds: [], parentFactIds: [], roles: [] }), consumedValue: 0,
            suppressionReasons: best ? [] : ['no-discriminative-local-complement'] };
    });
    // At most one best local combination reward, never one reward per repeated
    // message. Parent base values above are still consumed exactly once.
    const bestBundle = bundleContributions.reduce((best, next) => !best || next.value > best.value ? next : best, null);
    if (bestBundle) bestBundle.consumedValue = bestBundle.value;
    for (const bundle of bundleContributions) {
        if (bundle !== bestBundle && bundle.value > 0) bundle.suppressionReasons.push('single-combination-cap');
    }
    const relevance = parentContributions.reduce((sum, item) => sum + item.consumedValue, 0) + (bestBundle?.consumedValue ?? 0);
    return { ...candidate, calibration: { version: config.version, status: config.status },
        parentContributions, bundleContributions, relevance, qualified: qualificationReasons.length > 0,
        qualificationReasons, suppressionReasons };
}

export function evaluateStructuredRecallCandidates(candidateResult, {
    memories, config = STRUCTURED_RECALL_V2_CANDIDATE_CONFIG, statistics = null,
} = {}) {
    validateConfig(config);
    const libraryStatistics = statistics ?? buildStructuredLibraryStatistics(memories);
    const candidates = candidateResult.candidates.map(candidate => evaluateStructuredCandidate(candidate, libraryStatistics, config));
    const ranked = [...candidates].sort((a, b) => b.relevance - a.relevance || a.libraryIndex - b.libraryIndex);
    return { version: config.version, status: 'candidate', config, statistics: libraryStatistics, fragments: candidateResult.fragments,
        candidates, ranked, qualifiedIds: ranked.filter(item => item.qualified).map(item => item.memoryId),
        notQualifiedIds: ranked.filter(item => !item.qualified).map(item => item.memoryId) };
}
