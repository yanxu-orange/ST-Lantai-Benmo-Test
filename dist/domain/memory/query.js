// Read-only collection projection, shared by list and timeline.
import { activeEvents } from './model.js';
// List-only projection: keep storage order and timeline tie-breaking untouched.
export function orderMemoryList(events) {
  return events.map((event, index) => ({ event, index, first: event.sources.reduce((first, range) =>
    !first || range.start < first.start || range.start === first.start && range.end < first.end ? range : first, null) }))
    .sort((a, b) => {
      if (!a.first || !b.first) return a.first ? -1 : b.first ? 1 : a.index - b.index;
      return a.first.start - b.first.start || a.first.end - b.first.end || a.index - b.index;
    }).map(entry => entry.event);
}
export function filterMemories(events, { query = '', mode = 'all', words = 'all' } = {}) {
  const needle = query.trim().toLowerCase();
  return activeEvents(events).filter(event =>
    (!needle || event.title.toLowerCase().includes(needle) || event.body.toLowerCase().includes(needle)) &&
    (mode === 'all' || event.mode === mode) &&
    (words === 'all' || words === 'event' && !event.eventWords.length || words === 'detail' && !event.detailWords.length || words === 'none' && !event.eventWords.length && !event.detailWords.length));
}
