// Compatibility source revision: 01e50d63.
import {
    buildRecallQueryFragments,
    collectMemoryStructuredWitnesses,
} from './structured-witness.js';

export const STRUCTURED_CANDIDATE_VERSION = 'structured-candidate-v1';

const FIELD_FAMILY = Object.freeze({
    event: 'event',
    detail: 'detail',
    title: 'title',
    primary: 'legacy-primary',
    auxiliary: 'legacy-auxiliary',
    people: 'people',
    locations: 'locations',
});

function unique(values) {
    return [...new Set(values)];
}

function familiesFor(fields) {
    return unique(fields.map(field => {
        const family = FIELD_FAMILY[field];
        if (!family) throw new TypeError(`Unsupported structured field: ${field}`);
        return family;
    }));
}

/**
 * Builds one bundle per fragment that contains evidence. Parent facts are unique
 * within a bundle while every field witness remains traceable. No cross-fragment
 * bundle is constructed here.
 */
export function buildMemoryLocalEvidenceBundles(memoryEvidence, fragments) {
    if (!memoryEvidence || typeof memoryEvidence !== 'object') throw new TypeError('memoryEvidence must be an object');
    if (typeof memoryEvidence.memoryId !== 'string') throw new TypeError('memoryEvidence.memoryId must be a string');
    if (!Array.isArray(memoryEvidence.parentFacts)) throw new TypeError('memoryEvidence.parentFacts must be an array');
    if (!Array.isArray(fragments)) throw new TypeError('fragments must be an array');

    memoryEvidence.parentFacts.forEach((parent, index) => {
        if (!parent || typeof parent !== 'object' || typeof parent.id !== 'string') {
            throw new TypeError(`memoryEvidence.parentFacts[${index}] is invalid`);
        }
        if (!Array.isArray(parent.sourceFields) || !Array.isArray(parent.witnesses)) {
            throw new TypeError(`memoryEvidence.parentFacts[${index}] is incomplete`);
        }
    });
    const parentsById = new Map(memoryEvidence.parentFacts.map(parent => [parent.id, parent]));
    if (parentsById.size !== memoryEvidence.parentFacts.length) throw new TypeError('Parent fact ids must be unique');

    return fragments.flatMap(fragment => {
        const parentEvidence = [];
        for (const parent of memoryEvidence.parentFacts) {
            const witnesses = parent.witnesses.filter(witness => witness.fragmentId === fragment.id);
            if (!witnesses.length) continue;
            parentEvidence.push({
                parentFactId: parent.id,
                sourceFields: [...parent.sourceFields],
                fieldFamilies: familiesFor(parent.sourceFields),
                witnessIds: witnesses.map(witness => witness.id),
            });
        }
        if (!parentEvidence.length) return [];
        return [{
            id: JSON.stringify([memoryEvidence.memoryId, fragment.id]),
            memoryId: memoryEvidence.memoryId,
            fragmentId: fragment.id,
            sourceKind: fragment.sourceKind,
            rawPosition: fragment.rawPosition,
            distanceFromCurrent: fragment.distanceFromCurrent,
            parentFactIds: parentEvidence.map(item => item.parentFactId),
            witnessIds: parentEvidence.flatMap(item => item.witnessIds),
            sourceFields: unique(parentEvidence.flatMap(item => item.sourceFields)),
            fieldFamilies: unique(parentEvidence.flatMap(item => item.fieldFamilies)),
            parentEvidence,
        }];
    });
}

/**
 * Discovers ordinary structured candidates in stable input/library order.
 * Any trigger memory with at least one parent-fact witness is retained. This
 * function deliberately makes no relevance, qualification or pool decision.
 */
export function collectStructuredRecallCandidates({ memories, currentInput, recentHistory = [] } = {}) {
    if (!Array.isArray(memories)) throw new TypeError('memories must be an array');
    const fragments = buildRecallQueryFragments({ currentInput, recentHistory });
    const memoryIds = new Set();
    const candidates = [];
    memories.forEach((memory, libraryIndex) => {
        if (!memory || typeof memory !== 'object') throw new TypeError(`memories[${libraryIndex}] must be an object`);
        if (typeof memory.id !== 'string') throw new TypeError(`memories[${libraryIndex}].id must be a string`);
        if (memoryIds.has(memory.id)) throw new TypeError(`Duplicate memory id: ${memory.id}`);
        memoryIds.add(memory.id);
        if (memory.mode !== 'trigger') return;
        const evidence = collectMemoryStructuredWitnesses(memory, fragments);
        if (!evidence.parentFacts.length) return;
        candidates.push({
            memoryId: memory.id,
            libraryIndex,
            evidence,
            localBundles: buildMemoryLocalEvidenceBundles(evidence, fragments),
        });
    });
    return {
        version: STRUCTURED_CANDIDATE_VERSION,
        fragments,
        candidates,
    };
}
