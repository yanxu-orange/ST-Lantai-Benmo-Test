// Pure compatibility evidence: old fixed 01e50d63, adapted to TASK-016 boundaries.
import {collectStoryTimeRecallEvidence} from './story-time-evidence.js';
import { collectStructuredRecallCandidates } from './structured-candidates.js';
import { evaluateStructuredRecallCandidates } from './structured-relevance.js';

import { normalizeQuerySurfaceDisplay } from './detail-query-surface.js';

export const JOINT_QUALIFICATION_VERSION = 'joint-qualification-v1';

function timeSummaries(evaluations, fragments) {
    return fragments.map(fragment => {
        const local = evaluations.filter(e => e.target.fragmentId === fragment.id);
        const supports = local.filter(e => e.relation === 'support' && e.target.status === 'resolved' && e.domain.comparable);
        return { fragmentId: fragment.id, sourceKind: fragment.sourceKind, rawPosition: fragment.rawPosition,
            distanceFromCurrent: fragment.distanceFromCurrent, evaluations: local,
            relation: supports.length ? 'support' : 'neutral', scopes: [],
            supports, conflicts: [], diagnostics: [] };
    });
}

function structuredPaths(candidate) {
    if (!candidate) return [];
    const witnesses = new Map(candidate.evidence.parentFacts.flatMap(parent => parent.witnesses.map(w => [w.id, w])));
    const bundles = new Map(candidate.localBundles.map(bundle => [bundle.id, bundle]));
    return candidate.qualificationReasons.map(reason => {
        const source = reason.code === 'independent-parent' ? witnesses.get(reason.witnessId)
            : reason.code === 'local-complement' ? bundles.get(reason.bundleId) : null;
        if (!source) throw new TypeError('Structured qualification reason has no traceable locality');
        return { id: JSON.stringify(['structured', reason.code, reason.witnessId ?? reason.bundleId]),
            channel: 'structured', fragmentId: source.fragmentId, sourceKind: source.sourceKind,
            distanceFromCurrent: source.distanceFromCurrent, reason };
    });
}

// The time channel uses raw cleaned UTF-16 offsets while structured witnesses
// use normalized query offsets. Project boundaries, then verify the exact slice;
// never compare the two coordinate systems directly or search another occurrence.
function targetInWitnessCoordinates(target, fragment, witness) {
    if (target.coordinateSystem !== 'cleaned-fragment-utf16' || witness.coordinateSystem !== 'normalized-query-utf16') return null;
    const text = fragment.cleanedText;
    if (text.slice(...target.range) !== target.matchedText) return null;
    const display = normalizeQuerySurfaceDisplay(text);
    const fold = witness.normalizedQuery === display ? value => value : value => value.toLowerCase();
    if (fold(display) !== witness.normalizedQuery) return null;
    const boundary = index => fold(normalizeQuerySurfaceDisplay(`${text.slice(0, index)}\uE000`).slice(0, -1)).length;
    const range = target.range.map(boundary);
    if (witness.normalizedQuery.slice(...range) !== fold(normalizeQuerySurfaceDisplay(target.matchedText))) return null;
    return range;
}

function sharedFacts(candidate, evaluations, fragments) {
    if (!candidate) return [];
    const fragmentMap = new Map(fragments.map(f => [f.id, f]));
    const links = [];
    const roots = new Map();
    function root(key) {
        if (!roots.has(key)) roots.set(key, key);
        let next = key;
        while (roots.get(next) !== next) next = roots.get(next);
        return next;
    }
    for (const parent of candidate.evidence.parentFacts) {
        for (const witness of parent.witnesses) {
            for (const e of evaluations) {
                if (e.relation !== 'support' || e.target.status !== 'resolved' || !e.domain.comparable || e.target.fragmentId !== witness.fragmentId) continue;
                const range = targetInWitnessCoordinates(e.target, fragmentMap.get(witness.fragmentId), witness);
                // Conservatively require coverage of the WHOLE time token by an
                // actual component, not an accidental shared digit or substring.
                const component = range && witness.usedComponents.find(c => c.range[0] <= range[0] && c.range[1] >= range[1]);
                if (!component) continue;
                const parentNode = JSON.stringify(['parent', parent.id]);
                const timeNode = JSON.stringify(['time', e.target.calendarIdentity, e.target.value]);
                roots.set(root(timeNode), root(parentNode));
                links.push({ parentNode, parentFactId: parent.id, witnessId: witness.id, targetId: e.targetId,
                    fragmentId: witness.fragmentId, targetRange: [...e.target.range], normalizedTargetRange: range,
                    component: structuredClone(component), basis: 'matched-component-covers-time-target' });
            }
        }
    }
    const groups = new Map();
    for (const link of links) {
        const key = root(link.parentNode);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(link);
    }
    return [...groups.values()].map((evidence, index) => ({
        id: JSON.stringify([candidate.memoryId, 'shared-fact', index]), channels: ['structured', 'time'],
        parentFactIds: [...new Set(evidence.map(e => e.parentFactId))], witnessIds: [...new Set(evidence.map(e => e.witnessId))],
        targetIds: [...new Set(evidence.map(e => e.targetId))], fragmentIds: [...new Set(evidence.map(e => e.fragmentId))],
        evidence, consumedBenefits: 1, suppressionReasons: [],
    }));
}

export function combineStructuredAndTimeEvidence({ memories, structuredResult, timeResult }) {
    // Prevent accidentally joining evidence produced for different query snapshots.
    if (JSON.stringify(structuredResult.fragments) !== JSON.stringify(timeResult.fragments)) throw new TypeError('Channel query fragments differ');
    const structured = new Map(structuredResult.candidates.map(c => [c.memoryId, c]));
    const times = new Map(timeResult.evaluated.map(e => [e.memoryId, e]));
    const currentThemeIds = new Set(structuredResult.candidates
        .filter(candidate => candidate.evidence.parentFacts
            .some(parent => parent.witnesses.some(witness => witness.fragmentId === 'current:0')))
        .map(candidate => candidate.memoryId));
    const hasExplicitCurrentTheme = currentThemeIds.size > 0;
    const evaluated = memories.flatMap((memory, libraryIndex) => {
        if (memory.mode !== 'trigger') return [];
        const keyword = structured.get(memory.id) ?? null;
        const time = times.get(memory.id);
        if (!time || time.libraryIndex !== libraryIndex || (keyword && keyword.libraryIndex !== libraryIndex)) throw new TypeError('Channel library snapshot differs');
        const timeByFragment = timeSummaries(time.evaluations, timeResult.fragments);
        const qualificationPaths = structuredPaths(keyword);
        const suppressedPaths = [];
        for (const summary of timeByFragment) {
            for (const e of summary.supports) {
                const localWitnessIds = keyword?.evidence.parentFacts.flatMap(p => p.witnesses)
                    .filter(w => w.fragmentId === summary.fragmentId).map(w => w.id) ?? [];
                const path = { id: JSON.stringify(['time', e.targetId]), channel: 'time', fragmentId: summary.fragmentId,
                    sourceKind: summary.sourceKind, distanceFromCurrent: summary.distanceFromCurrent,
                    reason: { code: 'time-support', targetId: e.targetId, evidenceReason: e.reason, precision: e.target.precision },
                    localStructuredDisambiguation: localWitnessIds.length ? { code: 'local-structured-disambiguation', witnessIds: localWitnessIds } : null };
                qualificationPaths.push(path);
            }
        }
        const ordinaryQualified = qualificationPaths.length > 0;
        return [{ memoryId: memory.id, libraryIndex, structuredEvidence: keyword, timeEvidence: time,
            structuredCandidate: Boolean(keyword), structuredQualified: keyword?.qualified ?? false,
            structuredRelevance: keyword?.relevance ?? null,
            structuredQualificationReasons: keyword?.qualificationReasons ?? [], structuredSuppressionReasons: keyword?.suppressionReasons ?? [],
            timeEvaluations: time.evaluations, timeByFragment, ordinaryQualified, excluded: !ordinaryQualified,
            qualificationPaths, suppressedPaths,
            exclusionReasons: ordinaryQualified ? [] : ['no-active-qualification-path'],
            sharedFactGroups: sharedFacts(keyword, time.evaluations, timeResult.fragments),
            provenance: { structuredCandidate: Boolean(keyword), structuredQualified: keyword?.qualified ?? false,
                timeEvaluated: timeResult.enabled===true, timeSupport: timeByFragment.some(t => t.supports.length > 0),
                timeConflict: timeByFragment.some(t => t.conflicts.length > 0), timeNeutral: timeByFragment.some(t => t.relation === 'neutral'),
                explicitCurrentTimeConflict: false, explicitCurrentStructuredTheme: hasExplicitCurrentTheme,
                ordinaryQualified, excluded: !ordinaryQualified } }];
    });
    return { version: JOINT_QUALIFICATION_VERSION, structuredResult, timeResult, evaluated,
        qualifiedIds: evaluated.filter(e => e.ordinaryQualified).map(e => e.memoryId), excludedIds: evaluated.filter(e => e.excluded).map(e => e.memoryId) };
}

export function evaluateOrdinaryRecallV2({ memories, currentInput, recentHistory = [], currentStoryTime = null, fictionalCalendar = {}, structuredConfig }) {
    const candidates = collectStructuredRecallCandidates({ memories, currentInput, recentHistory });
    const structuredResult = evaluateStructuredRecallCandidates(candidates, { memories, config: structuredConfig });
    const timeResult = collectStoryTimeRecallEvidence({memories,currentInput,recentHistory,currentStoryTime,fictionalCalendar});
    return combineStructuredAndTimeEvidence({ memories, structuredResult, timeResult });
}
