// Pure compatibility evidence: old fixed 01e50d63, adapted to TASK-016 boundaries.
import {
    buildDetailQuerySurfaceModel,
    matchDetailQuerySurface,
    normalizeQuerySurfaceDisplay,
} from './detail-query-surface.js';
import { detailAliasParentText, isEligibleDetailAliasParent } from './alias-parent.js';

export const DETAIL_ALIAS_CANDIDATES_VERSION = 'detail-alias-candidates-v1';

function diagnostic(code, bindingIndex, extra = {}) {
    return { code, bindingIndex, ...extra };
}

function parentFactId(memoryId, detailIndex, parentDetail) {
    return JSON.stringify([
        memoryId,
        `detail:${detailIndex}:${normalizeQuerySurfaceDisplay(parentDetail)}`,
    ]);
}

function normalizeAlias(value) {
    return normalizeQuerySurfaceDisplay(value).toLowerCase();
}

export function normalizeDetailAliasBindings({ memories = [], bindings = [] } = {}) {
    if (!Array.isArray(memories)) throw new TypeError('memories must be an array');
    if (!Array.isArray(bindings)) throw new TypeError('bindings must be an array');
    const diagnostics = [];
    const memoriesById = new Map();
    const ambiguousMemoryIds = new Set();
    for (const memory of memories) {
        if (!memory || typeof memory !== 'object' || typeof memory.id !== 'string') continue;
        if (memoriesById.has(memory.id)) ambiguousMemoryIds.add(memory.id);
        else memoriesById.set(memory.id, memory);
    }
    const accepted = [];

    bindings.forEach((binding, bindingIndex) => {
        if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
            diagnostics.push(diagnostic('binding-not-object', bindingIndex));
            return;
        }
        if (typeof binding.memoryId !== 'string' || !memoriesById.has(binding.memoryId)) {
            diagnostics.push(diagnostic('binding-memory-not-found', bindingIndex,
                { memoryId: typeof binding.memoryId === 'string' ? binding.memoryId : null }));
            return;
        }
        if (ambiguousMemoryIds.has(binding.memoryId)) {
            diagnostics.push(diagnostic('binding-memory-id-ambiguous', bindingIndex,
                { memoryId: binding.memoryId }));
            return;
        }
        const memory = memoriesById.get(binding.memoryId);
        const details = memory.keywords?.detail;
        if (!Number.isInteger(binding.detailIndex) || binding.detailIndex < 0
            || !Array.isArray(details) || binding.detailIndex >= details.length) {
            diagnostics.push(diagnostic('binding-detail-index-invalid', bindingIndex,
                { memoryId: binding.memoryId, detailIndex: binding.detailIndex ?? null }));
            return;
        }
        const storedParent = details[binding.detailIndex];
        if (typeof binding.parentDetail !== 'string' || binding.parentDetail !== storedParent) {
            diagnostics.push(diagnostic('binding-parent-detail-mismatch', bindingIndex, {
                memoryId: binding.memoryId,
                detailIndex: binding.detailIndex,
                parentDetail: typeof binding.parentDetail === 'string' ? binding.parentDetail : null,
            }));
            return;
        }
        if (typeof storedParent !== 'string' || !storedParent.trim()) {
            diagnostics.push(diagnostic('binding-parent-detail-invalid', bindingIndex,
                { memoryId: binding.memoryId, detailIndex: binding.detailIndex }));
            return;
        }
        const parentModel = buildDetailQuerySurfaceModel(storedParent);
        if (!isEligibleDetailAliasParent(storedParent)) {
            diagnostics.push(diagnostic('binding-parent-detail-ineligible', bindingIndex, {
                memoryId: binding.memoryId,
                detailIndex: binding.detailIndex,
                ruleFamily: parentModel.ruleFamily,
            }));
            return;
        }
        if (!Array.isArray(binding.aliases)) {
            diagnostics.push(diagnostic('binding-aliases-not-array', bindingIndex,
                { memoryId: binding.memoryId, detailIndex: binding.detailIndex }));
            return;
        }

        const aliases = [];
        const seen = new Set();
        binding.aliases.forEach((alias, aliasIndex) => {
            const base = { memoryId: binding.memoryId, detailIndex: binding.detailIndex, aliasIndex };
            if (typeof alias !== 'string') {
                diagnostics.push(diagnostic('alias-not-string', bindingIndex, base));
                return;
            }
            const normalized = normalizeAlias(alias);
            if (!normalized) {
                diagnostics.push(diagnostic('alias-empty', bindingIndex, base));
                return;
            }
            if (!/^[\p{Script=Han}0-9]+$/u.test(normalized)) {
                diagnostics.push(diagnostic('alias-not-continuous-han', bindingIndex, { ...base, alias }));
                return;
            }
            if (normalized === parentModel.normalized) {
                diagnostics.push(diagnostic('alias-equals-parent', bindingIndex, { ...base, alias }));
                return;
            }
            if (!detailAliasParentText(storedParent).text.includes(normalized)) {
                diagnostics.push(diagnostic('alias-not-contiguous-in-parent', bindingIndex, { ...base, alias }));
                return;
            }
            if (seen.has(normalized)) {
                diagnostics.push(diagnostic('alias-duplicate', bindingIndex, { ...base, alias }));
                return;
            }
            seen.add(normalized);
            aliases.push({ value: alias, normalized, aliasIndex,
                model: buildDetailQuerySurfaceModel(alias) });
        });
        if (!aliases.length) return;
        accepted.push({
            bindingIndex,
            memoryId: binding.memoryId,
            detailIndex: binding.detailIndex,
            parentDetail: storedParent,
            parentModel,
            aliases,
            parentFactId: parentFactId(binding.memoryId, binding.detailIndex, storedParent),
        });
    });
    const mergedByParent = new Map();
    for (const relation of accepted) {
        const key = JSON.stringify([relation.memoryId, relation.detailIndex]);
        const existing = mergedByParent.get(key);
        if (!existing) {
            mergedByParent.set(key, relation);
            continue;
        }
        const seen = new Set(existing.aliases.map(alias => alias.normalized));
        for (const alias of relation.aliases) {
            if (seen.has(alias.normalized)) {
                diagnostics.push(diagnostic('alias-duplicate', relation.bindingIndex, {
                    memoryId: relation.memoryId,
                    detailIndex: relation.detailIndex,
                    aliasIndex: alias.aliasIndex,
                    alias: alias.value,
                }));
                continue;
            }
            seen.add(alias.normalized);
            existing.aliases.push(alias);
        }
    }
    return { relations: [...mergedByParent.values()], diagnostics };
}

function bestAliasMatch(relation, fragment) {
    const matches = relation.aliases.flatMap(alias => {
        const surface = matchDetailQuerySurface(alias.model, fragment.cleanedText);
        if (!surface.matched) return [];
        const range = surface.usedComponents[0]?.range ?? [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
        return [{ alias, surface, range }];
    });
    matches.sort((a, b) => Array.from(b.alias.normalized).length - Array.from(a.alias.normalized).length
        || a.range[0] - b.range[0]
        || a.alias.aliasIndex - b.alias.aliasIndex);
    return matches[0] ?? null;
}

/**
 * Discovers evidence from explicit, snapshot-local detail aliases.
 * Results are deliberately not production witnesses and never qualify a memory.
 */
export function collectDetailAliasCandidates({ memories = [], fragments = [], bindings = [] } = {}) {
    if (!Array.isArray(memories)) throw new TypeError('memories must be an array');
    if (!Array.isArray(fragments)) throw new TypeError('fragments must be an array');
    if (!Array.isArray(bindings)) throw new TypeError('bindings must be an array');
    if (!bindings.length) return { version: DETAIL_ALIAS_CANDIDATES_VERSION, candidates: [], diagnostics: [] };

    const { relations, diagnostics } = normalizeDetailAliasBindings({ memories, bindings });
    const candidates = [];

    const completeRelations = new Set();
    for (const relation of relations) {
        if (!fragments.some(fragment => fragment?.cleanedText
            && matchDetailQuerySurface(relation.parentModel, fragment.cleanedText).matched)) continue;
        completeRelations.add(relation);
    }

    for (const fragment of fragments) {
        if (!fragment || typeof fragment !== 'object' || typeof fragment.cleanedText !== 'string'
            || !fragment.cleanedText) continue;
        const completeParents = relations.filter(relation =>
            matchDetailQuerySurface(relation.parentModel, fragment.cleanedText).matched);

        for (const relation of relations) {
            if (completeRelations.has(relation) || completeParents.includes(relation)) continue;
            const best = bestAliasMatch(relation, fragment);
            if (!best) continue;
            const conflictingParent = completeParents.find(other =>
                other.parentModel.normalized !== relation.parentModel.normalized
                && other.aliases.some(alias => alias.normalized === best.alias.normalized));
            if (conflictingParent) {
                diagnostics.push(diagnostic('alias-suppressed-by-other-complete-parent', relation.bindingIndex, {
                    memoryId: relation.memoryId,
                    detailIndex: relation.detailIndex,
                    fragmentId: fragment.id ?? null,
                    alias: best.alias.value,
                    conflictingMemoryId: conflictingParent.memoryId,
                    conflictingDetailIndex: conflictingParent.detailIndex,
                }));
                continue;
            }

            const usedComponents = best.surface.usedComponents.map(component => ({
                ...component,
                kind: 'explicit-alias',
                range: [...component.range],
            }));
            candidates.push({
                id: JSON.stringify([relation.memoryId, 'detail-alias', relation.detailIndex,
                    fragment.id ?? null, best.alias.normalized]),
                memoryId: relation.memoryId,
                parentFactId: relation.parentFactId,
                field: 'detail',
                detailIndex: relation.detailIndex,
                parentDetail: relation.parentDetail,
                matchedAlias: best.alias.value,
                normalizedAlias: best.alias.normalized,
                aliasMeaningfulLength: Array.from(best.alias.normalized).length,
                fragmentId: fragment.id ?? null,
                sourceKind: fragment.sourceKind ?? null,
                rawPosition: fragment.rawPosition ?? null,
                distanceFromCurrent: fragment.distanceFromCurrent ?? null,
                matchClass: 'explicit-detail-alias',
                ruleFamily: 'explicit-detail-alias',
                normalizedQuery: best.surface.normalizedQuery,
                coordinateSystem: best.surface.coordinateSystem,
                usedComponents,
                qualified: false,
            });
        }
    }

    return { version: DETAIL_ALIAS_CANDIDATES_VERSION, candidates, diagnostics };
}
