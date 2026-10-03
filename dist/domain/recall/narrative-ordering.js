// Pure compatibility evidence: old fixed 01e50d63, adapted to TASK-016 boundaries.
import { compareTimeValues, parseStoryTimePoint } from './narrative-time.js';

export const NARRATIVE_ORDERING_VERSION = 'narrative-ordering-v1';

function byLibrary(indexById) {
    return (left, right) => indexById.get(left) - indexById.get(right);
}

function normalizeNodes(nodes) {
    if (!Array.isArray(nodes)) throw new TypeError('nodes must be an array');
    const ids = new Set();
    const indexes = new Set();
    return nodes.map(node => {
        const memoryId = node?.memoryId;
        const libraryIndex = node?.libraryIndex;
        if (typeof memoryId !== 'string' || !memoryId || ids.has(memoryId)) throw new TypeError('node memoryId must be unique');
        if (!Number.isInteger(libraryIndex) || libraryIndex < 0 || indexes.has(libraryIndex)) {
            throw new TypeError('node libraryIndex must be a unique non-negative integer');
        }
        ids.add(memoryId);
        indexes.add(libraryIndex);
        return { memoryId, libraryIndex };
    });
}

function normalizeEdges(edges, kind, nodeIds, indexById) {
    if (!Array.isArray(edges)) throw new TypeError(`${kind}Edges must be an array`);
    const seen = new Set();
    return edges.map(edge => {
        const fromId = Array.isArray(edge) ? edge[0] : edge?.fromId;
        const toId = Array.isArray(edge) ? edge[1] : edge?.toId;
        if (!nodeIds.has(fromId) || !nodeIds.has(toId) || fromId === toId) throw new TypeError(`${kind} edge is invalid`);
        const key = `${fromId}\u0000${toId}`;
        if (seen.has(key)) throw new TypeError(`${kind} edges must be unique`);
        seen.add(key);
        return { ...(Array.isArray(edge) ? {} : edge), fromId, toId, kind };
    }).sort((left, right) => indexById.get(left.fromId) - indexById.get(right.fromId)
        || indexById.get(left.toId) - indexById.get(right.toId));
}

function stronglyConnectedComponents(ids, edges, indexById) {
    const adjacency = new Map(ids.map(id => [id, []]));
    for (const edge of edges) adjacency.get(edge.fromId).push(edge.toId);
    for (const values of adjacency.values()) values.sort(byLibrary(indexById));
    let nextIndex = 0;
    const indexes = new Map();
    const lowLinks = new Map();
    const stack = [];
    const onStack = new Set();
    const result = [];
    function visit(id) {
        indexes.set(id, nextIndex);
        lowLinks.set(id, nextIndex);
        nextIndex += 1;
        stack.push(id);
        onStack.add(id);
        for (const next of adjacency.get(id)) {
            if (!indexes.has(next)) {
                visit(next);
                lowLinks.set(id, Math.min(lowLinks.get(id), lowLinks.get(next)));
            } else if (onStack.has(next)) {
                lowLinks.set(id, Math.min(lowLinks.get(id), indexes.get(next)));
            }
        }
        if (lowLinks.get(id) !== indexes.get(id)) return;
        const component = [];
        while (stack.length) {
            const member = stack.pop();
            onStack.delete(member);
            component.push(member);
            if (member === id) break;
        }
        component.sort(byLibrary(indexById));
        result.push(component);
    }
    for (const id of [...ids].sort(byLibrary(indexById))) if (!indexes.has(id)) visit(id);
    return result.sort((left, right) => indexById.get(left[0]) - indexById.get(right[0]));
}

function stableTopologicalComponents(components, edges, indexById) {
    const componentById = new Map();
    components.forEach((component, componentIndex) => component.forEach(id => componentById.set(id, componentIndex)));
    const adjacency = new Map(components.map((_, index) => [index, new Set()]));
    const indegree = new Map(components.map((_, index) => [index, 0]));
    for (const edge of edges) {
        const from = componentById.get(edge.fromId);
        const to = componentById.get(edge.toId);
        if (from === to || adjacency.get(from).has(to)) continue;
        adjacency.get(from).add(to);
        indegree.set(to, indegree.get(to) + 1);
    }
    const componentLibraryIndex = index => Math.min(...components[index].map(id => indexById.get(id)));
    const available = components.map((_, index) => index).filter(index => indegree.get(index) === 0);
    const ordered = [];
    while (available.length) {
        available.sort((left, right) => componentLibraryIndex(left) - componentLibraryIndex(right));
        const current = available.shift();
        ordered.push(current);
        for (const next of adjacency.get(current)) {
            indegree.set(next, indegree.get(next) - 1);
            if (indegree.get(next) === 0) available.push(next);
        }
    }
    if (ordered.length !== components.length) throw new Error('narrative ordering graph remained cyclic after conflict resolution');
    return ordered.flatMap(index => components[index]);
}

/**
 * Resolves already-built narrative constraints. Strong SCCs are collapsed and
 * emitted in library order; ordinal edges inside any combined cyclic SCC are
 * suppressed as a set, independent of edge insertion order.
 */
export function resolveNarrativeOrderGraph({ nodes, strongEdges = [], ordinalEdges = [] } = {}) {
    const normalizedNodes = normalizeNodes(nodes);
    const ids = normalizedNodes.map(node => node.memoryId);
    const nodeIds = new Set(ids);
    const indexById = new Map(normalizedNodes.map(node => [node.memoryId, node.libraryIndex]));
    const strong = normalizeEdges(strongEdges, 'story-time', nodeIds, indexById);
    const ordinal = normalizeEdges(ordinalEdges, 'event-ordinal', nodeIds, indexById);
    const strongComponents = stronglyConnectedComponents(ids, strong, indexById);
    const componentById = new Map();
    strongComponents.forEach((component, index) => component.forEach(id => componentById.set(id, index)));
    const strongCycleComponents = strongComponents.filter(component => component.length > 1);
    const strongCycleIndexes = new Set(strongCycleComponents.map(component => componentById.get(component[0])));
    const suppressedOrdinal = ordinal.filter(edge => {
        const component = componentById.get(edge.fromId);
        return component === componentById.get(edge.toId) && strongCycleIndexes.has(component);
    });
    const ordinalAfterStrongFallback = ordinal.filter(edge => !suppressedOrdinal.includes(edge));
    const componentNodes = strongComponents.map((component, index) => ({
        memoryId: String(index), libraryIndex: Math.min(...component.map(id => indexById.get(id))),
    }));
    const componentIndexById = new Map(strongComponents.flatMap((component, index) => component.map(id => [id, index])));
    const translatedStrong = strong.filter(edge => componentIndexById.get(edge.fromId) !== componentIndexById.get(edge.toId))
        .map(edge => ({ fromId: String(componentIndexById.get(edge.fromId)), toId: String(componentIndexById.get(edge.toId)) }));
    const translatedOrdinal = ordinalAfterStrongFallback
        .filter(edge => componentIndexById.get(edge.fromId) !== componentIndexById.get(edge.toId))
        .map(edge => ({ fromId: String(componentIndexById.get(edge.fromId)), toId: String(componentIndexById.get(edge.toId)), source: edge }));
    const componentIndexMap = new Map(componentNodes.map(node => [node.memoryId, node.libraryIndex]));
    const combinedComponents = stronglyConnectedComponents(
        componentNodes.map(node => node.memoryId),
        [...translatedStrong, ...translatedOrdinal],
        componentIndexMap,
    );
    const ordinalConflictSets = combinedComponents.filter(component => component.length > 1).map(component => new Set(component));
    for (const edge of ordinalAfterStrongFallback) {
        const from = String(componentIndexById.get(edge.fromId));
        const to = String(componentIndexById.get(edge.toId));
        if (ordinalConflictSets.some(component => component.has(from) && component.has(to))) suppressedOrdinal.push(edge);
    }
    const suppressedKeys = new Set(suppressedOrdinal.map(edge => `${edge.fromId}\u0000${edge.toId}`));
    const retainedOrdinal = ordinal.filter(edge => !suppressedKeys.has(`${edge.fromId}\u0000${edge.toId}`));
    const schedulableStrong = strong.filter(edge => componentIndexById.get(edge.fromId) !== componentIndexById.get(edge.toId));
    const orderedIds = stableTopologicalComponents(strongComponents, [...schedulableStrong, ...retainedOrdinal], indexById);
    const diagnostics = [
        ...strongCycleComponents.map(component => ({
            code: 'strong-time-cycle', affectedIds: [...component], action: 'stable-library-order-fallback',
        })),
        ...ordinalConflictSets.map(component => ({
            code: 'ordinal-conflict-component',
            affectedIds: [...component].flatMap(id => strongComponents[Number(id)]).sort(byLibrary(indexById)),
            action: 'suppress-internal-ordinal-edges',
        })),
    ];
    return {
        version: NARRATIVE_ORDERING_VERSION,
        orderedIds,
        strongEdges: strong,
        retainedOrdinalEdges: retainedOrdinal,
        suppressedOrdinalEdges: suppressedOrdinal.sort((left, right) => indexById.get(left.fromId) - indexById.get(right.fromId)
            || indexById.get(left.toId) - indexById.get(right.toId)),
        diagnostics,
        orderMeaning: 'post-budget-narrative-order-with-stable-library-fallback',
    };
}

function pointValue(point, fictionalCalendar) {
    if (!point || point.status !== 'parsed') return null;
    if (point.value && typeof point.value === 'object') return point.value;
    if (typeof point.raw !== 'string' || !point.raw.trim()) return null;
    return parseStoryTimePoint(point.raw, { fictionalCalendar }).value;
}

function pointRelation(left, right, fictionalCalendar) {
    if (!left || !right) return null;
    const yearLeft = { ...left, month: null, day: null, hour: null, minute: null };
    const yearRight = { ...right, month: null, day: null, hour: null, minute: null };
    const year = compareTimeValues(yearLeft, yearRight, fictionalCalendar);
    if (year === null || year !== 0) return year;
    if (left.month === null || right.month === null) return null;
    const month = compareTimeValues({ ...left, day: null, hour: null, minute: null },
        { ...right, day: null, hour: null, minute: null }, fictionalCalendar);
    if (month === null || month !== 0) return month;
    if (left.day === null || right.day === null) return null;
    const day = compareTimeValues({ ...left, hour: null, minute: null },
        { ...right, hour: null, minute: null }, fictionalCalendar);
    if (day === null || day !== 0) return day;
    if (left.hour === null || right.hour === null) return left.hour === null && right.hour === null ? 0 : null;
    const hour = compareTimeValues({ ...left, minute: null }, { ...right, minute: null }, fictionalCalendar);
    if (hour === null || hour !== 0) return hour;
    if (left.minute === null || right.minute === null) return left.minute === null && right.minute === null ? 0 : null;
    return compareTimeValues(left, right, fictionalCalendar);
}

function memoryInterval(memory, fictionalCalendar) {
    const start = pointValue(memory?.time?.start, fictionalCalendar);
    const end = pointValue(memory?.time?.end, fictionalCalendar);
    const explicitCalendarId = typeof memory?.time?.calendarId === 'string' && memory.time.calendarId
        ? memory.time.calendarId
        : (start?.calendarId ?? end?.calendarId ?? null);
    const inferredCalendarId = start?.calendar === 'gregorian'
        ? 'gregorian'
        : (start?.calendar === 'era' ? `era:${fictionalCalendar?.id ?? 'active'}` : null);
    const calendarId = explicitCalendarId ?? inferredCalendarId;
    const endpointCalendarConflict = start && end && start.calendar !== end.calendar;
    if (!start || !end) return { start, end, calendarId, invalid: false };
    return { start, end, calendarId,
        invalid: endpointCalendarConflict || pointRelation(start, end, fictionalCalendar) > 0 };
}

function sameSummaryBatch(left, right) {
    const leftId = left?.source?.batchId;
    const rightId = right?.source?.batchId;
    return typeof leftId === 'string' && leftId.trim().length > 0 && leftId === rightId;
}

function validEventOrdinal(memory) {
    const value = memory?.source?.eventOrdinal;
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Reorders a fixed final selection without changing any item or pool data. */
export function orderMemoriesForNarrative({ items, fictionalCalendar = {} } = {}) {
    if (!Array.isArray(items)) throw new TypeError('items must be an array');
    const normalized = items.map(item => ({
        item,
        memory: item?.memory,
        memoryId: item?.memoryId ?? item?.memory?.id,
        libraryIndex: item?.libraryIndex,
    }));
    if (normalized.some(item => !item.memory || item.memoryId !== item.memory.id)) throw new TypeError('each item must carry its matching memory');
    const intervals = new Map(normalized.map(item => [item.memoryId, memoryInterval(item.memory, fictionalCalendar)]));
    const strongEdges = [];
    const ordinalEdges = [];
    const diagnostics = normalized.filter(item => intervals.get(item.memoryId).invalid).map(item => ({
        code: 'invalid-story-time-range', affectedIds: [item.memoryId], action: 'exclude-time-constraints',
    }));
    for (let leftIndex = 0; leftIndex < normalized.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < normalized.length; rightIndex += 1) {
            const left = normalized[leftIndex];
            const right = normalized[rightIndex];
            const leftInterval = intervals.get(left.memoryId);
            const rightInterval = intervals.get(right.memoryId);
            const calendarConflict = leftInterval.calendarId && rightInterval.calendarId
                && leftInterval.calendarId !== rightInterval.calendarId;
            const comparable = !leftInterval.invalid && !rightInterval.invalid && !calendarConflict;
            const leftBefore = comparable
                && pointRelation(leftInterval.end, rightInterval.start, fictionalCalendar) < 0;
            const rightBefore = comparable
                && pointRelation(rightInterval.end, leftInterval.start, fictionalCalendar) < 0;
            if (leftBefore || rightBefore) {
                const before = leftBefore ? left : right;
                const after = leftBefore ? right : left;
                strongEdges.push({ fromId: before.memoryId, toId: after.memoryId, reason: 'strict-non-overlapping-story-time' });
                continue;
            }
            const leftOrdinal = validEventOrdinal(left.memory);
            const rightOrdinal = validEventOrdinal(right.memory);
            if (!comparable || !sameSummaryBatch(left.memory, right.memory)
                || leftOrdinal === null || rightOrdinal === null || leftOrdinal === rightOrdinal) continue;
            const before = leftOrdinal < rightOrdinal ? left : right;
            const after = leftOrdinal < rightOrdinal ? right : left;
            ordinalEdges.push({ fromId: before.memoryId, toId: after.memoryId, reason: 'same-summary-batch-event-ordinal' });
        }
    }
    const graph = resolveNarrativeOrderGraph({
        nodes: normalized.map(({ memoryId, libraryIndex }) => ({ memoryId, libraryIndex })),
        strongEdges,
        ordinalEdges,
    });
    const itemById = new Map(normalized.map(item => [item.memoryId, item.item]));
    const orderedItems = graph.orderedIds.map(id => itemById.get(id));
    return {
        ...graph,
        orderedItems,
        orderedMemories: orderedItems.map(item => item.memory),
        diagnostics: [...diagnostics, ...graph.diagnostics],
    };
}
