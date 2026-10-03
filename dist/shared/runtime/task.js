import { createTargetGuard } from './identity.js';

let nextTaskId = 0;
export function createGuardedTask(getContext) {
  const guard = createTargetGuard(getContext);
  const taskId = ++nextTaskId;
  let cancelled = false;
  return {
    taskId,
    identity: guard.identity,
    cancel() { cancelled = true; },
    async run(work, commit) {
      const result = await work();
      if (cancelled || !guard.isCurrent()) return { taskId, status: 'stale' };
      await commit(result, getContext());
      return { taskId, status: 'succeeded' };
    },
  };
}
