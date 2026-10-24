// Keep presentation chrome mounted while its owner renders fresh business content.
// Limited to a complete Lantai section and its header; no field reconciliation,
// data cache, or ownership of a view's lifecycle.
function attributes(node, next) {
  for (const attr of [...node.attributes]) if (!next.hasAttribute(attr.name)) node.removeAttribute(attr.name);
  for (const attr of [...next.attributes]) if (node.getAttribute(attr.name) !== attr.value) node.setAttribute(attr.name, attr.value);
}
function header(node, next) {
  if (node.isEqualNode(next)) return;
  attributes(node, next); // Clear temporary inert when a dialog closes, too.
  const before = [...node.children], after = [...next.children];
  for (let index = 0; index < Math.max(before.length, after.length); index++) {
    const oldChild = before[index], newChild = after[index];
    if (!newChild) oldChild.remove();
    else if (!oldChild) node.append(newChild);
    else if (oldChild.isEqualNode(newChild)) continue;
    else if (oldChild.classList.contains('lt-root-top') && newChild.classList.contains('lt-root-top')) header(oldChild, newChild);
    else node.replaceChild(newChild, oldChild);
  }
}
function replace(container, markup, retainEqualContent) {
  const root = container.children?.[0];
  // Minimal test DOMs and body-only cumulative mounts keep their replacement path.
  // Arbitrary fragments must never be interpreted as complete page chrome.
  if (!root?.attributes || !root.isEqualNode || !root.replaceChild || container.children.length !== 1 || !root.matches?.('section.lantai')) {
    container.innerHTML = markup;
    return;
  }
  const staging = container.ownerDocument.createElement('div');
  staging.innerHTML = markup;
  const next = staging.children[0];
  if (staging.children.length !== 1 || !next?.matches?.('section.lantai')) { container.innerHTML = markup; return; }
  attributes(root, next);
  const before = [...root.children], after = [...next.children];
  for (let index = 0; index < Math.max(before.length, after.length); index++) {
    const oldNode = before[index], newNode = after[index];
    if (!newNode) oldNode.remove();
    else if (!oldNode) root.append(newNode);
    else if (oldNode.matches('header.lt-header') && newNode.matches('header.lt-header')) header(oldNode, newNode);
    else if (!retainEqualContent || !oldNode.isEqualNode(newNode)) root.replaceChild(newNode, oldNode);
  }
}
// Existing time/Benmo/workshop owners also retain equal top-level content. Their
// explicit state/draft patching and full-render reconciliation remain responsible.
export function replaceSurfaceMarkup(container, markup, previousMarkup) {
  if (!previousMarkup) { container.innerHTML = markup; return; }
  replace(container, markup, true);
}
// Full-render owners still replace main/footer as before; only unchanged chrome
// survives data refreshes. This avoids retaining stale live field values.
export function replacePageMarkup(container, markup) { replace(container, markup, false); }
