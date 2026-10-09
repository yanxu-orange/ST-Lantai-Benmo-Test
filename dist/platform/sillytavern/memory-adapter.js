import {emptyNarrative} from '../../domain/narrative/data.js';
import {emptyTracking} from '../../domain/tracking/data.js';
import {emptyLatest} from '../../domain/latest/data.js';
import {locateDeletedMessages} from '../../domain/summary/source-deletion.js';
import {emptySummary} from '../../domain/summary/data.js';
import {emptyCumulative} from '../../domain/cumulative/data.js';
import {emptyWorkshop} from '../../domain/workshop/model.js';
import {assertWorkshopProof} from './workshop-identities.js';
import { getSillyTavernContext } from './context.js';
import { emptyRoot, assertRoot, inheritMemoryRoot } from '../../domain/memory/model.js';
import { sameTarget } from '../../domain/memory/repository.js';

export const MEMORY_KEY = 'lantai_benmo_memory';
const copy = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const identity = binding => JSON.stringify([binding.kind, binding.owner, binding.name]);
const sameBinding = (a, b) => !!a && !!b && identity(a) === identity(b);
const stale = () => new Error('聊天目标已变化，请返回列表重新进入');
const unconfirmed = () => Object.assign(new Error('保存结果尚未确认，可能已经写入或聊天目标已变化；请恢复连接后重新读取'), { code: 'COMMIT_UNCONFIRMED' });

// Ordinary chat configuration uses the host's normal background save. Only
// known configuration fields are excluded here: results, memory and unknown
// extensions remain protected even when a write also changes configuration.
function protectedContent(root) {
  const { revision, controls, time, workshop, summary, cumulative, latest, tracking, narrative, ...content } = root;
  const { revision: workshopRevision, modules, imports, captureCounters, ...results } = workshop ?? emptyWorkshop();
  const { revision: summaryRevision, preferences: summaryPreferences, ...summaryMemory } = summary ?? emptySummary();
  const { revision: cumulativeRevision, preferences: cumulativePreferences, ...cumulativeMemory } = cumulative ?? emptyCumulative();
  const {revision:latestRevision,preferences:latestPreferences,...latestMemory}=latest??emptyLatest();
  const {revision:trackingRevision,preferences:trackingPreferences,...trackingMemory}=tracking??emptyTracking();
  const {revision:narrativeRevision,preferences:narrativePreferences,...narrativeMemory}=narrative??emptyNarrative();
  return { ...content, narrative:narrativeMemory, workshop: results, summary: summaryMemory, cumulative: cumulativeMemory, latest:latestMemory,tracking:trackingMemory };
}
// 1.18/1.19 saveMetadata swallows transport failures. Memory-result commits
// still require a server readback of this exact chat.
export function createSillyTavernMemoryAdapter({ getContext = getSillyTavernContext, fetch: request = globalThis.fetch, uuid = () => crypto.randomUUID() } = {}) {
  let epoch = 0, observed = null, prepared = null, disposed = false, preparing = null;
  const listeners = new Set(), subscriptions = [];
  const renames = new Map();
  const branchPoints = new Map();
  const uncertain = new Map();
  const configurationSaves = new Set();
  let activeSnapshot = null;
  let sourceEpoch=0,sourceSerial=0;
  const messageIds=new WeakMap(),sourceVersions=new Map();
  const deletionListeners=new Set(),visibilityObservers=new Set();
  let deletionBaseline=null,deletionSerial=0,regenerationRemoval=null;
  function messageIdentity(message,floor){
    if(!messageIds.has(message))messageIds.set(message,`message-${++sourceSerial}`);
    return messageIds.get(message);
  }
  function sourceChanged(payload){
    const floor=typeof payload==='number'?payload:payload?.messageId??payload?.mesId??payload?.index;
    if(Number.isSafeInteger(floor)&&floor>=0)sourceVersions.set(floor,(sourceVersions.get(floor)??0)+1);
    else sourceEpoch++;
    snapshotMessages();refreshDeletionBaseline();
  }
  function binding(context = getContext()) {
    const name = context?.getCurrentChatId?.() ?? context?.chatId;
    if (typeof name !== 'string' || !name || !context?.chatMetadata || !Array.isArray(context.chat)) throw new Error('请先打开角色或群组聊天');
    if (context.groupId != null && context.groupId !== '') {
      const group = context.groups?.find(item => String(item.id) === String(context.groupId));
      if (!group || group.chat_id !== name) throw new Error('群组聊天身份无法确认');
      return { kind: 'group', owner: String(context.groupId), name, ...hostIdentity(context) };
    }
    const avatar = context.characters?.[context.characterId]?.avatar;
    if (typeof avatar !== 'string' || !avatar || context.characters[context.characterId].chat !== name) throw new Error('角色聊天身份无法确认');
    return { kind: 'character', owner: avatar, name, ...hostIdentity(context) };
  }
  function hostIdentity(context) {
    return { integrity: typeof context.chatMetadata.integrity === 'string' ? context.chatMetadata.integrity : null,
      lineageParent: typeof context.chatMetadata.main_chat === 'string' ? context.chatMetadata.main_chat : null };
  }
  function snapshotMessages() {
    try {
      const context = getContext(), current = binding(context);
      // These are read-only message references, not a cached metadata authority.
      // The official branch code appends extra.branches before clearChat clears
      // the original array. Retaining the message objects preserves that signal.
      activeSnapshot = { binding: current, rootId: context.chatMetadata[MEMORY_KEY]?.rootId,
        messages: context.chat.map((message, floor) => ({ message, floor })) };
    } catch { activeSnapshot = null; }
  }
  function refreshDeletionBaseline(force=false) {
    try {
      const current=binding(),messages=getContext().chat;
      // Render/save callbacks can happen after splice but before MESSAGE_DELETED.
      // Never erase the pre-delete evidence in that gap.
      if(!force&&deletionBaseline&&sameBinding(current,deletionBaseline.binding)&&messages.length<deletionBaseline.objects.length)return;
      deletionBaseline={binding:current,objects:[...messages],sourceEpoch};
    } catch {deletionBaseline=null;}
  }
  function deletedMessages() {
    const previous=deletionBaseline;
    sourceEpoch++;sourceVersions.clear();
    let evidence=null,target=null,error=null;
    try {
      const current=binding(),objects=getContext().chat;
      if(previous&&sameBinding(previous.binding,current)&&objects.length<previous.objects.length){
        const difference=locateDeletedMessages(previous.objects,objects);
        const regeneratedTail=difference?.removedFloors.length===1&&difference.removedFloors[0]===previous.objects.length-1&&previous.objects.at(-1)===regenerationRemoval;
        if(regeneratedTail){regenerationRemoval=null;}
        else if(!difference)error='来源删除位置无法可靠确认，记忆已保留';
        else {
          try{target=captureTarget();}catch{const raw=getContext().chatMetadata[MEMORY_KEY];if(!raw)throw stale();assertRoot(raw,{rootId:raw.rootId});const observedBinding=observe();if(!sameBinding(raw.binding,observedBinding))throw stale();target=targetFor(raw,observedBinding);}
          evidence={...difference,before:{epoch:previous.sourceEpoch,messages:chatSourceMessages(false,previous.objects)},after:{epoch:sourceEpoch,messages:chatSourceMessages()}};}
      }
    } catch { /* An unprepared or changed chat has no authority to mutate. */ }
    snapshotMessages();refreshDeletionBaseline(true);
    if(evidence||error)for(const listener of deletionListeners)listener({id:++deletionSerial,target,deletion:evidence,error});
  }
  function captureBranchPoint() {
    try {
      const current = binding(), raw = getContext().chatMetadata[MEMORY_KEY];
      if (!activeSnapshot || !raw || !sameBinding(raw.binding, activeSnapshot.binding) || raw.rootId !== activeSnapshot.rootId
        || current.kind !== activeSnapshot.binding.kind || current.owner !== activeSnapshot.binding.owner
        || getContext().chatMetadata.main_chat !== activeSnapshot.binding.name || sameBinding(current, activeSnapshot.binding)) return;
      const points = activeSnapshot.messages.filter(({ message }) => Array.isArray(message.extra?.branches) && message.extra.branches.includes(current.name));
      if (points.length === 1) branchPoints.set(identity(current), { parent: activeSnapshot.binding.name, rootId: raw.rootId, floor: points[0].floor });
    } catch { /* Missing identity is handled when the page is opened. */ }
  }
  function capabilities() {
    const context = getContext(), source = context?.eventSource;
    if (!context || typeof context.saveMetadata !== 'function' || typeof context.getRequestHeaders !== 'function' || typeof request !== 'function'
      || typeof source?.on !== 'function' || typeof (source.removeListener ?? source.off) !== 'function'
      || !context.eventTypes?.CHAT_CHANGED || !context.eventTypes?.CHAT_RENAMED) throw new Error('当前酒馆缺少聊天保存或生命周期能力');
    return context;
  }
  function observe() {
    if (disposed) throw new Error('兰台已关闭');
    const current = binding(), id = identity(current);
    if (observed !== id) { observed = id; epoch++; prepared = null; }
    return current;
  }
  function targetFor(root, current) { return { chatId: identity(current), rootId: root.rootId, epoch }; }
  function check(target) {
    const current = observe();
    if (!prepared || !sameTarget(target, targetFor(prepared, current))) throw stale();
    return current;
  }
  async function serverChat(current) {
    const context = capabilities();
    const group = current.kind === 'group';
    const response = await request(group ? '/api/chats/group/get' : '/api/chats/get', {
      method: 'POST', cache: 'no-store', headers: context.getRequestHeaders(),
      body: JSON.stringify(group ? { id: current.name } : { avatar_url: current.owner, file_name: current.name }),
    });
    if (!response.ok) throw new Error('无法确认聊天已保存，请检查连接后重试');
    const rows = await response.json();
    if (!Array.isArray(rows) || !rows[0]?.chat_metadata) throw new Error('无法读回聊天文件，请检查连接后重试');
    return rows;
  }
  function uncertaintyFor(current) {
    const direct = uncertain.get(identity(current));
    if (direct) return direct;
    return [...uncertain.values()].find(record => {
      if (record.binding.kind !== current.kind || record.binding.owner !== current.owner) return false;
      const knownRename = renames.get(identity(current))?.includes(record.binding.name);
      const stableRename = !!record.binding.integrity && record.binding.integrity === current.integrity
        && record.binding.lineageParent === current.lineageParent && record.binding.lineageParent !== record.binding.name;
      return knownRename || stableRename;
    });
  }
  function requireConfirmed(current) {
    if (uncertaintyFor(current)) throw unconfirmed();
  }
  async function waitForWrite(current, ticket = epoch) {
    // A known local transaction is still working, not an unknown save outcome.
    // Never expose its staged metadata, and wait through readback/proof too.
    for (;;) {
      const record = uncertaintyFor(current);
      if (!record?.inFlight) return;
      if (record.epoch !== ticket) throw unconfirmed();
      const committed = await record.completion;
      if (ticket !== epoch || !sameBinding(observe(), current)) throw stale();
      if (!committed) throw unconfirmed();
    }
  }
  async function reconcile(current = observe(), joinWrites = false) {
    if (joinWrites) while (uncertaintyFor(current)?.inFlight) await waitForWrite(current);
    const record = uncertaintyFor(current);
    if (!record) return;
    if (record.inFlight) throw unconfirmed();
    const ticket = epoch, id = identity(current);
    try {
      const rows = await serverChat(current);
      if (ticket !== epoch || identity(observe()) !== id) throw stale();
      // Another reconciliation may have already adopted authority and begun a
      // new write. Never apply an older read over that write or clear its marker.
      if (uncertain.get(record.key) !== record) {
        if (uncertaintyFor(current)) throw unconfirmed();
        return;
      }
      const disk = copy(rows[0].chat_metadata[MEMORY_KEY]);
      const isPrevious = equal(disk, record.previous);
      if (disk === undefined) {
        if (!isPrevious) throw new Error('保存归属无法确认');
      } else {
        assertRoot(disk, { rootId: disk.rootId });
        if (!sameBinding(disk.binding, current) && !(isPrevious || sameBinding(disk.binding, record.binding))) throw new Error('保存归属无法确认');
        if (disk.rootId !== record.next.rootId && !(isPrevious && disk.rootId === record.previous?.rootId)) throw new Error('保存根身份已变化');
      }
      const fresh = getContext();
      if (disk === undefined) delete fresh.chatMetadata[MEMORY_KEY];
      else fresh.chatMetadata[MEMORY_KEY] = copy(disk);
      prepared = disk === undefined ? copy(record.previousAuthority) : sameBinding(disk.binding, current) ? copy(disk) : null;
      uncertain.delete(record.key);
      snapshotMessages();
    } catch { throw unconfirmed(); }
  }
  function persistConfiguration(target, next, guard) {
    const current = check(target), context = capabilities();
    requireConfirmed(current);
    const had = Object.hasOwn(context.chatMetadata, MEMORY_KEY);
    const previous = copy(context.chatMetadata[MEMORY_KEY]);
    if (guard(copy(previous ?? prepared)) !== true) throw new Error('任务已取消或来源已失效');
    check(target);
    context.chatMetadata[MEMORY_KEY] = copy(next);
    try {
      // Invoke while the checked chat is still current; never defer invocation
      // to a promise continuation that could run after a chat switch.
      const save = context.saveMetadata;
      const pending = { chatId: target.chatId, promise: Promise.resolve(save()).catch(() => {}) };
      configurationSaves.add(pending);
      void pending.promise.then(() => configurationSaves.delete(pending));
    } catch (error) {
      // Only a synchronous failure is observable in this lightweight path.
      // Late failure cannot roll back a newer edit or a newly opened chat.
      try {
        check(target);
        const fresh = getContext();
        if (equal(fresh.chatMetadata[MEMORY_KEY], next)) {
          if (had) fresh.chatMetadata[MEMORY_KEY] = previous;
          else delete fresh.chatMetadata[MEMORY_KEY];
        }
      } catch { /* Never restore into another loaded chat. */ }
      throw error;
    }
    check(target);
    prepared = copy(next);
    snapshotMessages();
    return copy(next);
  }
  async function persist(target, next, guard = () => true, workshopProof) {
    // A delayed older configuration snapshot must not land after a confirmed
    // memory result. Only protected writes wait for these host saves.
    const pending = [...configurationSaves].filter(save => save.chatId === target.chatId);
    if (pending.length) {
      check(target);
      const baseline = copy(getContext().chatMetadata[MEMORY_KEY] ?? prepared);
      await Promise.all(pending.map(save => save.promise));
      check(target);
      if (!equal(getContext().chatMetadata[MEMORY_KEY] ?? prepared, baseline)) throw new Error('保存冲突，请返回列表重新读取');
    }
    const current = check(target), context = capabilities();
    if (uncertaintyFor(current)) throw unconfirmed();
    const had = Object.hasOwn(context.chatMetadata, MEMORY_KEY);
    const previous = copy(context.chatMetadata[MEMORY_KEY]);
    if (guard(copy(context.chatMetadata[MEMORY_KEY] ?? prepared)) !== true) throw new Error('任务已取消或来源已失效');
    check(target);
    const record = { key: identity(current), epoch, binding: copy(current), previous, previousAuthority: copy(prepared), next: copy(next), workshopProof: copy(workshopProof), inFlight: true };
    let finish;
    record.completion = new Promise(resolve => { finish = resolve; });
    uncertain.set(record.key, record);
    try {
      context.chatMetadata[MEMORY_KEY] = copy(next);
      // Do not retain context/chatMetadata as an authority across awaits.
      const save = context.saveMetadata;
      await save();
      check(target);
      const rows = await serverChat(current);
      check(target);
      if (uncertain.get(record.key) !== record) throw unconfirmed();
      if (!equal(rows[0].chat_metadata[MEMORY_KEY], next)) throw new Error('保存未得到酒馆确认，草稿已保留，请重试');
      if (workshopProof !== undefined) assertWorkshopProof(rows,workshopProof);
      if (!equal(getContext().chatMetadata[MEMORY_KEY], next)) throw new Error('聊天数据已变化，请重新读取');
      prepared = copy(next);
      if (uncertain.get(record.key) === record) uncertain.delete(record.key);
      snapshotMessages();
      return copy(next);
    } catch (error) {
      // Reacquire, and restore only the exact current epoch and our own value.
      try {
        check(target);
        const fresh = getContext();
        if (uncertain.get(record.key) === record && equal(fresh.chatMetadata[MEMORY_KEY], next)) {
          if (had) fresh.chatMetadata[MEMORY_KEY] = previous;
          else delete fresh.chatMetadata[MEMORY_KEY];
        }
      } catch { /* Never restore into another loaded chat. */ }
      // Restoring a local working copy is not evidence of disk rollback.
      // The marker prevents this copy being used as writable authority.
      throw unconfirmed();
    } finally {
      record.inFlight = false;
      finish(uncertain.get(record.key) !== record);
    }
  }
  async function prepare() {
    capabilities();
    const current = observe(), ticket = epoch;
    await reconcile(current, true);
    while (uncertaintyFor(current)?.inFlight) await waitForWrite(current, ticket);
    if (ticket !== epoch || identity(observe()) !== identity(current)) throw stale();
    requireConfirmed(current);
    if (prepared) return captureTarget();
    if (preparing?.epoch === ticket) return preparing.promise;
    const promise = (async () => {
      const raw = copy(getContext().chatMetadata[MEMORY_KEY]);
      if (raw === undefined) prepared = { ...emptyRoot(uuid()), binding: current };
      else {
        assertRoot(raw, { rootId: raw?.rootId });
        if (!raw.binding || raw.binding.kind !== current.kind || raw.binding.owner !== current.owner) throw new Error('记忆聊天归属无法确认，未覆盖数据');
        if (sameBinding(raw.binding, current)) prepared = raw;
        else {
          // Official 1.18 branches keep integrity but change main_chat; 1.19
          // additionally mints a new integrity slug. Same integrity AND lineage
          // identify a rename across reload without requiring an in-memory map.
          const stableRename = !!raw.binding.integrity && raw.binding.integrity === current.integrity
            && Object.hasOwn(raw.binding, 'lineageParent') && raw.binding.lineageParent === current.lineageParent
            && raw.binding.lineageParent !== raw.binding.name;
          if (stableRename || renames.get(identity(current))?.includes(raw.binding.name)) prepared = { ...raw, binding: current };
          else {
            const parentName = getContext().chatMetadata.main_chat;
            if (parentName !== raw.binding.name) throw new Error('聊天改名或分支来源尚未确认，请重新打开兰台');
            const rows = await serverChat(raw.binding);
            if (ticket !== epoch || identity(observe()) !== identity(current)) throw stale();
            const live = branchPoints.get(identity(current));
            const points = live?.parent === parentName && live.rootId === raw.rootId ? [live.floor]
              : rows.slice(1).flatMap((message, floor) => Array.isArray(message.extra?.branches) && message.extra.branches.includes(current.name) ? [floor] : []);
            if (points.length !== 1 || rows[0].chat_metadata[MEMORY_KEY]?.rootId !== raw.rootId) throw new Error('无法确认准确分支楼层，未猜测继承记忆');
            prepared = { ...inheritMemoryRoot(raw,uuid(),points[0],{timeMessages:raw.time?.manualAnchor?chatSourceMessages(true):null}), binding: current };
          }
          await persist(targetFor(prepared, current), prepared);
        }
      }
      if (ticket !== epoch || identity(observe()) !== identity(current)) throw stale();
      requireConfirmed(current);
      return captureTarget();
    })();
    preparing = { epoch: ticket, promise };
    try { return await promise; } catch (error) { if (ticket === epoch) prepared = null; throw error; }
    finally { if (preparing?.promise === promise) preparing = null; }
  }
  function captureTarget() {
    const current = observe();
    if (!prepared) throw new Error('请等待当前聊天读取完成');
    return targetFor(prepared, current);
  }
  async function renamed(data) {
    const oldName = data?.oldFileName?.replace(/\.jsonl$/, ''), newName = data?.newFileName?.replace(/\.jsonl$/, '');
    const kind = data?.groupId != null && data.groupId !== '' ? 'group' : 'character';
    const owner = kind === 'group' ? String(data.groupId) : data?.avatarId;
    if (!oldName || !newName || typeof owner !== 'string' || !owner) return false;
    const oldBinding = { kind, owner, name: oldName }, newBinding = { kind, owner, name: newName };
    renames.set(identity(newBinding), [...new Set([oldName, ...(renames.get(identity(oldBinding)) ?? [])])]);
    const current = observe(), ticket = epoch;
    await reconcile(current);
    if (ticket !== epoch || identity(observe()) !== identity(current)) throw stale();
    requireConfirmed(current);
    const raw = copy(getContext().chatMetadata[MEMORY_KEY]);
    if (!raw || !renames.get(identity(current))?.includes(raw.binding?.name) || current.name !== newName || raw.binding.kind !== kind || raw.binding.owner !== owner || owner !== current.owner) return false;
    assertRoot(raw, { rootId: raw.rootId });
    epoch++;
    prepared = { ...raw, binding: current };
    const target = targetFor(prepared, current);
    try { await persist(target, prepared); }
    catch {
      // A delayed rename failure belongs to its original epoch, not the chat
      // opened while the save was pending. Never clear or refresh that new UI.
      try {
        if (sameTarget(target, captureTarget())) { prepared = null; notify(); }
      } catch { /* A changed or disposed target requires no UI work. */ }
      return false;
    }
    return target;
  }
  function notify(kind = 'changed') { for (const listener of listeners) listener(kind); }
  const context = capabilities(), source = context.eventSource;
  function on(name, handler) { const type = context.eventTypes[name]; source.on(type, handler); subscriptions.push([type, handler]); }
  on('CHAT_CHANGED', () => {
    let unchanged = false;
    try {
      const current = binding(), raw = getContext().chatMetadata[MEMORY_KEY];
      unchanged = !!prepared && observed === identity(current) && (equal(raw, prepared) || (raw === undefined && prepared.revision === 0 && prepared.events.length === 0));
    } catch { /* A missing/new identity is a real target change. */ }
    captureBranchPoint(); epoch++;sourceEpoch++;sourceVersions.clear();
    if (unchanged) observed = identity(binding());
    else { observed = null; prepared = null; }
    regenerationRemoval=null;refreshDeletionBaseline(true);snapshotMessages(); notify(unchanged ? 'reload' : 'changed');
  });
  on('CHAT_RENAMED', data => {
    let origin;
    try { origin = { chatId: identity(binding()), epoch }; } catch { /* No active target. */ }
    void renamed(data).then(target => {
      if (!target) return;
      try { check(target); notify(); } catch { /* Ignore delayed success in a different epoch too. */ }
    }).catch(() => {
      // Synchronous invalid-data errors can be shown only in their own scope.
      try { if (origin && epoch === origin.epoch && identity(binding()) === origin.chatId) notify(); } catch { /* No active target. */ }
    });
  });
  for (const name of ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_DELETED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED']) {
    if (context.eventTypes[name]) on(name, name==='MESSAGE_DELETED'?deletedMessages:['MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_SWIPED'].includes(name)?sourceChanged:()=>{snapshotMessages();refreshDeletionBaseline();});
  }
  if(context.eventTypes.GENERATION_STARTED)on('GENERATION_STARTED',(type,_options,dryRun)=>{const tail=getContext()?.chat?.at(-1);regenerationRemoval=type==='regenerate'&&dryRun!==true&&tail?.is_user===false?tail:null;});
  for(const name of ['GENERATION_ENDED','GENERATION_STOPPED'])if(context.eventTypes[name])on(name,()=>{regenerationRemoval=null;refreshDeletionBaseline(true);});
  function sourceRole(message,includeHidden=false){
    // Native visibility is not story chronology. TIME retains the original
    // speaker for hidden narrative messages, while summary keeps its old filter.
    return (includeHidden||message.is_system!==true)&&typeof message.is_user==='boolean'&&!message.extra?.type&&!message.extra?.tool_invocations&&(!includeHidden||message.role!=='system'&&message.role!=='tool')?(message.is_user?'user':'assistant'):'system';
  }
  function chatSourceMessages(includeHidden=false,messages=getContext().chat){
    return messages.map((message,floor)=>{
        if(!message||typeof message.mes!=='string')throw new Error('总结原始消息不可用');
        const role=sourceRole(message,includeHidden);
        const date=message.send_date==null?null:String(message.send_date);
        const identity=JSON.stringify([floor,typeof message.id==='string'||Number.isSafeInteger(message.id)?message.id:null,date]);
        return {floor,identity,objectTicket:messageIdentity(message,floor),revision:sourceVersions.get(floor)??0,role,system:message.is_system===true,text:message.mes,date,swipeId:Number.isSafeInteger(message.swipe_id)&&message.swipe_id>=0?message.swipe_id:null};
      });
  }
  function captureChatSource(target,includeHidden=false) {
      const current=check(target);requireConfirmed(current);
      if(['MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED'].some(name=>!context.eventTypes[name]))throw new Error('酒馆缺少总结来源变化监听能力');
      const messages=chatSourceMessages(includeHidden);
      check(target);return copy({epoch:sourceEpoch,messages});
  }
  function matchesSource(target,snapshot,includeHidden=false) {
      try {
        const current=check(target);requireConfirmed(current);
        const chat=getContext().chat;
        if(!snapshot||snapshot.epoch!==sourceEpoch||!Array.isArray(snapshot.messages)||snapshot.messages.length!==chat.length)return false;
        const matches=chat.every((message,floor)=>{
          const saved=snapshot.messages[floor];if(!message||typeof message.mes!=='string'||!saved)return false;
          const role=sourceRole(message,includeHidden);
          const date=message.send_date==null?null:String(message.send_date),id=typeof message.id==='string'||Number.isSafeInteger(message.id)?message.id:null;
          const swipeId=Number.isSafeInteger(message.swipe_id)&&message.swipe_id>=0?message.swipe_id:null;
          return saved.floor===floor&&saved.identity===JSON.stringify([floor,id,date])&&saved.objectTicket===messageIdentity(message,floor)&&saved.revision===(sourceVersions.get(floor)??0)&&saved.role===role&&saved.system===(message.is_system===true)&&saved.text===message.mes&&saved.date===date&&saved.swipeId===swipeId;
        });
        check(target);return matches;
      } catch {return false;}
   }
  // Native hide/unhide mutates is_system without emitting a host event.
  // Observers exist only while a consuming page is open. DOM notifications
  // cover visible rows; the small flag-only check covers paged-out /hide ranges.
  function observeSourceVisibility(listener,{document:doc=globalThis.document,MutationObserver:Observer=globalThis.MutationObserver,intervalMs=500}={}) {
    let stopped=false,queued=false,visibilityMutation=false;
    let rootRevision=null,memoryKey='';
    const capture=()=>{
      const context=getContext(),root=context.chatMetadata?.[MEMORY_KEY];
      if(rootRevision!==root?.revision){rootRevision=root?.revision;memoryKey=JSON.stringify([root?.summary?.revision,root?.cumulative?.revision,root?.events?.map(event=>[event.id,event.supersededBy])]);}
      return {chatId:identity(binding()),memoryKey,rows:context.chat.map(message=>[message,message?.is_system===true])};
    };
    let previous;try{previous=capture();}catch{return ()=>{};}
    const checkVisibility=()=>{
      if(stopped||disposed)return;
      try{
        const next=capture();
        const changed=next.chatId===previous.chatId&&(visibilityMutation||next.rows.some(([message,hidden],index)=>previous.rows[index]?.[0]===message&&previous.rows[index][1]!==hidden));
        visibilityMutation=false;
        const memoryChanged=next.chatId===previous.chatId&&next.memoryKey!==previous.memoryKey;
        previous=next;if(changed||memoryChanged)listener({visibilityChanged:changed,memoryChanged});
      }catch{/* Chat changes are handled by the normal lifecycle. */}
    };
    const schedule=()=>{if(stopped||queued)return;queued=true;queueMicrotask(()=>{queued=false;checkVisibility();});};
    const observer=Observer&&doc?.body?new Observer(records=>{if(records.some(record=>record.target?.matches?.('#chat .mes')&&record.attributeName==='is_system')){visibilityMutation=true;schedule();}}):null;
    observer?.observe(doc.body,{attributes:true,subtree:true,attributeFilter:['is_system']});
    const timer=setInterval(checkVisibility,intervalMs);timer.unref?.();
    doc?.addEventListener?.('visibilitychange',schedule);globalThis.addEventListener?.('focus',schedule);
    const stop=()=>{if(stopped)return;stopped=true;clearInterval(timer);observer?.disconnect();doc?.removeEventListener?.('visibilitychange',schedule);globalThis.removeEventListener?.('focus',schedule);visibilityObservers.delete(stop);};
    visibilityObservers.add(stop);return stop;
  }
  snapshotMessages();refreshDeletionBaseline(true);
  return {
    prepare, captureTarget,
    subscribeSourceDeletions(listener){deletionListeners.add(listener);return()=>deletionListeners.delete(listener);},
    hasTimeCalendar() {
      try {observe();const root=getContext().chatMetadata[MEMORY_KEY]??prepared;return !!root?.time?.activeCalendarId&&Array.isArray(root.time.calendars)&&root.time.calendars.some(item=>item.id===root.time.activeCalendarId);}catch{return false;}
    },
    captureChatSource, captureSummarySource: captureChatSource,observeSourceVisibility,
    // Storage ownership only: never pass this visibility-neutral source to a
    // generation or prompt consumer. Hidden story replies still own summaries.
    captureLatestRetentionSource(target){const source=captureChatSource(target,true);return {...source,messages:source.messages.map(message=>({...message,system:message.role==='system'}))};},
    // Narrative reads story chronology even after summary has hidden originals.
    // Preserve genuine system/tool exclusion, without treating visibility as a
    // change to the speaker or to the durable narrative source proof.
    captureNarrativeSource(target){const source=captureChatSource(target,true);return {...source,messages:source.messages.map(message=>({...message,system:message.role==='system'}))};},
    captureTimeSource:target=>captureChatSource(target,true),
    matchesChatSource:(target,snapshot)=>matchesSource(target,snapshot),
    matchesTimeSource:(target,snapshot)=>matchesSource(target,snapshot,true),
    peekConfirmed(target) {
      const current = check(target); requireConfirmed(current);
      const root = getContext().chatMetadata[MEMORY_KEY] ?? prepared;
      if (!sameBinding(root.binding, current)) throw new Error('记忆聊天归属已变化，请重新读取');
      return assertRoot(root, target);
    },
    async read(target) {
      const current = check(target);
      await reconcile(current, true);
      while (uncertaintyFor(current)?.inFlight) await waitForWrite(current, target.epoch);
      requireConfirmed(check(target));
      const raw = getContext().chatMetadata[MEMORY_KEY];
      const root = raw === undefined ? prepared : raw;
      if (!sameBinding(root.binding, binding())) throw new Error('记忆聊天归属已变化，请重新读取');
      return assertRoot(root, target);
    },
    async commit(target, next, expectedRevision, { guard = () => true, workshopProof, requireConfirmation = false } = {}) {
      check(target);
      await reconcile();
      requireConfirmed(check(target));
      const raw = getContext().chatMetadata[MEMORY_KEY] ?? prepared;
      assertRoot(raw, target); assertRoot(next, target);
      if (!sameBinding(raw.binding, binding()) || raw.revision !== expectedRevision || next.revision !== expectedRevision + 1) throw new Error('保存冲突，请返回列表重新读取');
      const candidate = { ...next, binding: binding() };
      if (!requireConfirmation && workshopProof === undefined && equal(protectedContent(raw), protectedContent(candidate))) {
        return persistConfiguration(target, candidate, guard);
      }
      return persist(target, candidate, guard, workshopProof);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { for(const stop of [...visibilityObservers])stop();disposed = true; epoch++; prepared = null; listeners.clear();deletionListeners.clear(); for (const [type, handler] of subscriptions) (source.removeListener ?? source.off).call(source, type, handler); },
  };
}
