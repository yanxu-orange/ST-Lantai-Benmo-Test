const TAIL_SELECTORS = ['.lantai-latest-summary', '.lantai-workshop-results', '.lantai-round-record', '.lantai-world-briefing'];

// All displays share one floor-tail contract: host content, latest summary,
// then legacy workshop results, native records, custom workshop cards and world briefing. Only move our nodes, and do nothing once the ordered
// suffix is present so their MutationObservers cannot keep moving each other.
export function placeFloorBackgroundDisplay(parent, box) {
  if (box.parentNode !== parent) parent.append(box);
  const children = [...(parent.childNodes ?? parent.children)];
  const tails = TAIL_SELECTORS.flatMap(selector => {
    const group = children.filter(node => node.matches?.(selector));
    if (selector !== '.lantai-round-record') return group;
    const builtin = node => node.getAttribute?.('data-round-mode') === 'builtin';
    return [...group.filter(builtin), ...group.filter(node => !builtin(node))];
  });
  if (tails.every((node, index) => children[children.length - tails.length + index] === node)) return;
  for (const node of tails) {
    if ((parent.lastChild ?? parent.lastElementChild) !== node) parent.append(node);
  }
}
