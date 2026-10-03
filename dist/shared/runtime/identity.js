// Identity deliberately excludes message contents and display names.
export function readChatIdentity(context) {
  if (!context) return null;
  const chatId = typeof context.getCurrentChatId === 'function'
    ? context.getCurrentChatId()
    : context.chatId;
  if (chatId === null || chatId === undefined || chatId === '') return null;
  return {
    chatId: String(chatId),
    characterId: context.characterId == null ? null : String(context.characterId),
    groupId: context.groupId == null ? null : String(context.groupId),
  };
}

export function sameChatIdentity(left, right) {
  return Boolean(left && right
    && left.chatId === right.chatId
    && left.characterId === right.characterId
    && left.groupId === right.groupId);
}

export function createTargetGuard(getContext) {
  const identity = readChatIdentity(getContext());
  return {
    identity,
    isCurrent() {
      return sameChatIdentity(identity, readChatIdentity(getContext()));
    },
    async commitIfCurrent(work, commit) {
      const value = await work();
      if (!this.isCurrent()) return { status: 'stale' };
      await commit(value, getContext());
      return { status: 'committed' };
    },
  };
}
