// Read-only collection projection, shared by list and timeline.
import { activeEvents } from './model.js';
export function filterMemories(events, { query = '', mode = 'all', words = 'all' } = {}) {
  const needle = query.trim().toLowerCase();
  return activeEvents(events).filter(event =>
    (!needle || event.title.toLowerCase().includes(needle) || event.body.toLowerCase().includes(needle)) &&
    (mode === 'all' || event.mode === mode) &&
    (words === 'all' || words === 'event' && !event.eventWords.length || words === 'detail' && !event.detailWords.length || words === 'none' && !event.eventWords.length && !event.detailWords.length));
}
