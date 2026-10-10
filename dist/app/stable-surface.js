// Retain unchanged top-level chrome while a page replaces loading or live data.
// This deliberately does not reconcile business content or cache any data.
export function replaceSurfaceMarkup(container, markup, previousMarkup) {
  const root = container.children?.[0];
  const opening = text => text?.match(/^<section\b[^>]*>/)?.[0];
  if (!root?.isEqualNode || !root.replaceChild || !previousMarkup || opening(markup) !== opening(previousMarkup)) {
    container.innerHTML = markup;
    return;
  }
  const staging = container.ownerDocument.createElement('div');
  staging.innerHTML = markup;
  const next = staging.children[0];
  if (!next || container.children.length !== 1) { container.innerHTML = markup; return; }
  const before = [...root.children], after = [...next.children];
  for (let index = 0; index < Math.max(before.length, after.length); index++) {
    const oldNode = before[index], newNode = after[index];
    if (!newNode) oldNode.remove();
    else if (!oldNode) root.append(newNode);
    else if (!oldNode.isEqualNode(newNode)) root.replaceChild(newNode, oldNode);
  }
}
