import { emptyRoot, inheritMemoryRoot, assertRoot } from '../../domain/memory/model.js';
import { sameTarget } from '../../domain/memory/repository.js';
export function createFakeAdapter({ persistence, key = 'lantai-task009-fiction-only', seed = {}, wait = async () => {}, clock = () => crypto.randomUUID() } = {}) {
  let roots;
  const stored = persistence?.getItem(key);
  try { roots = stored ? JSON.parse(stored) : structuredClone(seed); } catch { throw new Error('虚构数据损坏，未覆盖存储'); }
  let chatId = null, epoch = 0, failNext = false;
  const current = () => roots[chatId];
  const captureTarget = () => chatId && current() ? { chatId, rootId: current().rootId, epoch } : null;
  const check = target => { if (!sameTarget(target,captureTarget())) throw new Error('聊天目标已变化'); };
  const persist = next => { persistence?.setItem(key,JSON.stringify(next)); roots = structuredClone(next); };
  return {
    captureTarget,
    peekConfirmed(target) { check(target); return assertRoot(current(), target); },
    switchChat(id) { if (!id || typeof id !== 'string') throw new Error('聊天身份无效'); epoch++; chatId = id; if (!roots[id]) persist({ ...roots, [id]: emptyRoot(clock()) }); return captureTarget(); },
    async read(target) { check(target); await wait('read'); check(target); return assertRoot(current(),target); },
    async commit(target, next, expectedRevision, { guard = () => true } = {}) {
      check(target); await wait('commit'); check(target);
      assertRoot(next,target);
      if (current().revision !== expectedRevision || next.revision !== expectedRevision + 1) throw new Error('保存冲突，请重新读取');
      if (failNext) { failNext = false; throw new Error('模拟保存失败，草稿已保留'); }
      if (guard(structuredClone(current())) !== true) throw new Error('任务已取消或来源已失效');
      check(target);
      // Persist first: storage failure leaves the old authority intact; no rollback writes to another chat.
      persist({ ...roots, [target.chatId]: structuredClone(next) }); check(target); return structuredClone(current());
    },
    failNextSave() { failNext = true; },
    branch(parentId, childId, floor) {
      if (!roots[parentId] || roots[childId] || !childId || childId === parentId) throw new Error('无法确认独立分支');
      const parent = assertRoot(roots[parentId], {rootId: roots[parentId].rootId});
      const child = inheritMemoryRoot(parent,clock(),floor);
      persist({ ...roots, [childId]: child }); return structuredClone(child);
    },
    snapshot: () => structuredClone(roots)
  };
}
