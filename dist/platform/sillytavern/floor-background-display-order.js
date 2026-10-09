const TAIL_SELECTORS = ['.lantai-latest-summary', '.lantai-workshop-results'];

// Both displays share one floor-tail contract: host content, latest summary,
// then workshop results. Only move our nodes, and do nothing once the ordered
// suffix is present so their MutationObservers cannot keep moving each other.
export function placeFloorBackgroundDisplay(parent, box) {
  if (box.parentNode !== parent) parent.append(box);
  const children = [...(parent.childNodes ?? parent.children)];
  const tails = TAIL_SELECTORS.map(selector => children.find(node => node.matches?.(selector))).filter(Boolean);
  if (tails.every((node, index) => children[children.length - tails.length + index] === node)) return;
  for (const node of tails) {
    if ((parent.lastChild ?? parent.lastElementChild) !== node) parent.append(node);
  }
}
