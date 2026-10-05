import { createSillyTavernMemoryAdapter } from './memory-adapter.js';
import { createRepository, sameTarget } from '../../domain/memory/repository.js';
import { mountMemoryApp } from '../../app/memory-app.js';
import { getSillyTavernContext } from './context.js';
import { createManagementRuntime } from './management-runtime.js';
import { createApiSettingsSession } from '../../app/api-settings-session.js';
import { mountApiSettingsView } from '../../app/api-settings-view.js';
import { createManagementNotifications } from './management-notifications.js';
import { mountSummaryView } from '../../app/summary-view.js';
import { createSummarySettingsController } from '../../app/summary-settings-controller.js';
import { mountSummarySettingsView } from '../../app/summary-settings-view.js';
import { summaryReadonlyContent } from '../../domain/summary/requests.js';
import {createSummaryNotifications} from './summary-notifications.js';
import {createSummaryHistoryHook} from './summary-history.js';
import {createRecallRuntime} from './recall-runtime.js';
import {createRecallController} from '../../app/recall-controller.js';
import {mountRecallView} from '../../app/recall-view.js';
import {createCumulativeRuntime} from './cumulative-runtime.js';
import {createCumulativeHistoryHook} from './cumulative-history.js';
import {mountCumulativeView} from '../../app/cumulative-view.js';
import {createCumulativeSettingsController} from '../../app/cumulative-settings-controller.js';
import {mountCumulativeSettingsView} from '../../app/cumulative-settings-view.js';
import '../../app/memphis/compact-group-candidate.js';
import {BASE_STYLE_ENTRIES,MEMPHIS_STYLE_ENTRIES,SNOW_ERMINE_STYLE_ENTRIES} from '../../app/styles/style-entries.js';

import { DEFAULT_THEME, applyTheme, resolveStyleAssets } from '../../app/styles/theme.js';
import { createAppearanceAdapter } from './appearance-adapter.js';
import { createAppearanceSession } from '../../app/appearance-session.js';

// Only this platform module touches the host document. Shadow DOM prevents
// host skins from changing the approved UI and prevents our UI CSS leakage.
export function createMemoryHost({ document: doc = globalThis.document, getContext = getSillyTavernContext, fetch: request = globalThis.fetch,
  runtimeOptions = {}, appearanceOptions = {}, MutationObserver: Observer = globalThis.MutationObserver,createAdapter=createSillyTavernMemoryAdapter } = {}) {
  let adapter, repository, app, panel, content, memoryContent, settingsContent, apiView, apiSession, returnFocus, returnEpoch, returnTarget,
    runtime, runtimePromise, notices, entry, unsubscribe, disposed = false, closing = false, replacingPage = false, ticket = 0, stylePromise,
    summaryContent,summaryView,summarySettingsView,summarySettingsController,summarySettingsTarget,summarySettingsFromMemory=false,summaryNotices,summaryHistory,summaryReturnFocus,memoryEditFocus,
    recallRuntime,recallController,recallView,recallTarget,pageRequest=0,recallEntryRequest=0,
    memphisStyle,memphisObserver,memphisStylePromise,snowStyle,snowStylePromise,snowCss;
  const appearance = createAppearanceSession({ adapter: createAppearanceAdapter({ getContext, fetchImpl: request, ...appearanceOptions }), prepareTheme: async theme => { if (theme === 'snow-ermine') await snowStyles(); }, canSave: () => {
    try { if (apiSession && !['ready','saved'].includes(apiSession.inspect().status)) return false; runtime.settings.getEpoch(); return true; } catch { return false; }
  } });
  const unsubscribeAppearance = appearance.subscribe(() => syncMemphis());
  const entryId = 'lantai-benmo-open';
  const lifetime = new AbortController();
  let cumulativeRuntime,cumulativeHistory,cumulativeView,cumulativeSettingsView,cumulativeSettingsController,cumulativeSettingsTarget,cumulativeNotices,
    cleaningController,cleaningTarget,cleaningFacade,memoryType='event',cumulativePage='root',cumulativeReturnPage='root',cumulativePageTarget=null;
  let hostReloadSequence=0;
  function unmountCumulative(){cumulativeView?.dispose();cumulativeView=null;cumulativeSettingsView?.dispose();cumulativeSettingsView=null;if(cleaningFacade){summarySettingsView?.dispose();summarySettingsView=null;cleaningFacade=null;}}
  const cumulativeEditing=()=>{const value=runtime?.cumulativeController?.inspect();return memoryType==='cumulative'&&!!(value?.editDraft||value?.restore||value?.busy||value?.reloadInvalidated||cumulativeView&&value?.draft);};
  function ensureAdapter() {
    if (adapter) return;
    adapter = createAdapter({ getContext, fetch: request });
    repository = createRepository(adapter);
    // The proof is this round's guarded IN_CHAT system-slot write receipt.
    // ST remains responsible for its subsequent preset/budget assembly.
    summaryHistory=createSummaryHistoryHook({repository,captureSource:target=>adapter.captureSummarySource(target),getContext,getReplacementProof:()=>recallRuntime?.getReplacementProof()});
    unsubscribe = adapter.subscribe(kind => {
      const sequence=++hostReloadSequence;
      if (!panel) return;
      if (kind === 'reload' && app) {
        const current=app,visiblePanel=panel,previousTarget=runtime?.cumulativeController?.inspect().target;
        let eventTarget;try{eventTarget=repository.captureTarget();}catch{/* prepare establishes authority */}
        const cumulativeVisible=memoryType==='cumulative'&&settingsContent.hidden&&!!(cumulativeView||!memoryContent.hidden);
        const valid=()=>{try{return !disposed&&panel===visiblePanel&&app===current&&sequence===hostReloadSequence&&!!eventTarget&&sameTarget(eventTarget,repository.captureTarget());}catch{return false;}};
        void adapter.prepare().then(nextTarget=>{
          if(!valid()||!sameTarget(nextTarget,eventTarget))return;
          if(cumulativeVisible&&previousTarget?.chatId===nextTarget.chatId&&previousTarget?.rootId===nextTarget.rootId&&previousTarget.epoch!==nextTarget.epoch){runtime.cumulativeController.invalidateReload({previousTarget,nextTarget,reloadSequence:sequence});}
          return current.rebind();
        }).catch(error=>{if(valid())errorView(error);});
      } else { runtime?.controller.refresh(); void open(); }
    });
  }
  function close() {
    if (closing) return;
    closing = true;
    let cleanupError;
    const cleanup = action => { try { action(); } catch (error) { cleanupError ??= error; } };
    try {
      ticket++;pageRequest++;hostReloadSequence++;
      const currentApiView=apiView,currentApiSession=apiSession;apiView=null;apiSession=null;
      cleanup(()=>currentApiView?.dispose());cleanup(()=>currentApiSession?.exit('close'));
      const currentCumulativeView=cumulativeView,currentCumulativeSettingsView=cumulativeSettingsView;
      cumulativeView=null;cumulativeSettingsView=null;
      const currentSummaryView=summaryView,currentSummarySettingsView=summarySettingsView;
      summaryView=null;summarySettingsView=null;cleaningFacade=null;
      cleanup(()=>currentCumulativeView?.dispose());cleanup(()=>currentCumulativeSettingsView?.dispose());
      cleanup(()=>currentSummaryView?.dispose());cleanup(()=>currentSummarySettingsView?.dispose());
      const currentRecallView=recallView;recallView=null;
      cleanup(()=>currentRecallView?.dispose());cleanup(()=>recallController?.suspend());
      const currentApp=app;app=null;cleanup(()=>currentApp?.dispose());
      const currentObserver=memphisObserver;memphisObserver=null;memphisStyle=null;snowStyle=null;
      cleanup(()=>currentObserver?.disconnect());
    } finally {
      const currentPanel=panel;panel=null;content=memoryContent=settingsContent=summaryContent=null;
      cleanup(()=>currentPanel?.remove());cleanup(()=>entry?.focus());closing=false;
    }
    if(cleanupError)throw cleanupError;
  }
  async function ensureRuntime() {
    if (!runtimePromise) runtimePromise = createManagementRuntime({ repository, getContext, document: doc, fetchImpl: request, ...runtimeOptions, signal: lifetime.signal,captureSummarySource:target=>adapter.captureSummarySource(target) })
      .then(value => { if (disposed) { value.dispose(); return null; } runtime = value;
        notices=createManagementNotifications({document:doc,controller:runtime.controller,styles:notificationStyles,openTask});
        summaryNotices=createSummaryNotifications({document:doc,service:runtime.summaryService,styles:notificationStyles,openTask:openSummaryTask});
        recallRuntime=createRecallRuntime({repository,settings:runtime.settings,getContext,captureSource:target=>adapter.captureSummarySource(target)});
        cumulativeRuntime=createCumulativeRuntime({repository,settings:runtime.settings,getContext});
        cumulativeHistory=createCumulativeHistoryHook({repository,settings:runtime.settings,getContext,getReplacementProof:()=>cumulativeRuntime.getReplacementProof()});
        const seen=new Set();
        const noticeController={subscribeNotices(listener){return runtime.cumulativeService.subscribe(state=>{
          let phase,message;
          if(state.status==='starting'&&!state.restoreOnly){phase='started';message='已开始总结';}
          if(state.status==='awaiting-user'&&!state.restoreOnly&&(state.snapshot.params.checkBeforeSave||state.origin==='regeneration')){phase='complete';message='总结完成，请检查后采用';}
          if(state.status==='succeeded'){phase='complete';message='本批总结已保存';}
          if(['failed','stale','cancelled'].includes(state.status)&&state.outcome!=='discarded'&&state.reviewResolution!=='discarded'&&!state.outcome?.startsWith('recovered-')){phase='failed';message=state.outcome==='unconfirmed'?'总结保存待确认':'总结未完成，请查看';}
          const key=JSON.stringify([state.taskId,state.attempt,phase]);if(!phase||seen.has(key))return;seen.add(key);
          // Mounted C1 pages own their own feedback; the background owner survives close.
          const pageOwnsFeedback=panel&&(!summaryContent.hidden&&cumulativeView||!memoryContent.hidden&&app?.memoryType()==='cumulative');
          if(pageOwnsFeedback&&sameTarget(state.target,repository.captureTarget())&&(phase==='started'||runtime.cumulativeController.inspect().taskId===state.taskId))return;
          listener({taskId:state.taskId,phase,message,id:'lantai-cumulative-notice'});
        });}};
        cumulativeNotices=createManagementNotifications({document:doc,controller:noticeController,styles:notificationStyles,openTask:openCumulativeTask});
        return value; });
    return runtimePromise;
  }
  async function openTask(taskId){
    if(disposed||apiSession||cumulativeEditing())return false;
    if(panel)return app?.showManagementTask(taskId)??false;
    if(!runtime?.controller.resume(taskId))return false;
    await open();return !!app?.isManagementTask(taskId);
  }
  async function openSummaryTask(taskId) {
    if(disposed||apiSession||summarySettingsView||cumulativeSettingsView||cumulativeEditing())return false;
    if(panel&&summaryContent.hidden){const active=panel.shadowRoot.activeElement;if(app?.session.state.route==='editor'||active?.matches('input,textarea,select')||panel.shadowRoot.querySelector('[data-composing=true]'))return false;}
    unmountCumulative();if(app?.memoryType()==='cumulative')app.suspendCumulative();
    const task=runtime?.summaryService.inspect(taskId);if(!task||!sameTarget(task.target,repository.captureTarget()))return false;
    if(!panel)await open();
    if(!panel||!runtime.summaryController.showTask(taskId))return false;
    memoryContent.hidden=true;memoryContent.inert=true;summaryContent.hidden=false;summaryView?.dispose();
    if(app?.memoryType()==='cumulative')app.suspendCumulative();
    summaryView=mountSummaryView({container:summaryContent,controller:runtime.summaryController,onBack:()=>void returnFromSummary(),onClose:close,openSettings:()=>void openSummarySettings(false)});return true;
  }
  async function returnFromSummary() {
    pageRequest++;unmountCumulative();
    recallView?.dispose();recallView=null;recallController?.suspend();
    summaryView?.dispose();summaryView=null;summarySettingsView?.dispose();summarySettingsView=null;
    if(!panel)return;summaryContent.replaceChildren();summaryContent.hidden=true;memoryContent.hidden=false;memoryContent.inert=false;
    await app?.rebind();if(!panel)return;if(app?.memoryType()==='cumulative')app.resumeCumulative();
    if(app?.session.state.route==='editor'&&app.session.state.draft?.id&&!app.session.state.root.events.some(event=>event.id===app.session.state.draft.id))await app.refresh();
    const previous=summaryReturnFocus;
    (previous?.isConnected&&memoryContent.contains(previous)&&!previous.closest('[hidden],[inert]')?previous:memoryContent.querySelector('[data-action=summary-manual]')??memoryContent.querySelector('.lt-main'))?.focus({preventScroll:true});
  }
  async function showSummary(origin='manual',batchId=null) {
    if(!runtime?.summaryController||!panel||apiSession)return false;unmountCumulative();
    if(summaryContent.hidden)summaryReturnFocus=batchId&&memoryEditFocus?.isConnected&&memoryContent.contains(memoryEditFocus)?memoryEditFocus:panel.shadowRoot.activeElement;
    const target=repository.captureTarget(),serial=ticket,request=++pageRequest;
    const ready=await runtime.summaryController.open(origin);
    if(!ready||!panel||serial!==ticket||request!==pageRequest||!sameTarget(target,repository.captureTarget()))return false;
    memoryContent.hidden=true;memoryContent.inert=true;summaryContent.hidden=false;
    recallView?.dispose();recallView=null;recallController?.suspend();
    summarySettingsView?.dispose();summarySettingsView=null;summaryView?.dispose();
    summaryView=mountSummaryView({container:summaryContent,controller:runtime.summaryController,onBack:()=>void returnFromSummary(),onClose:close,openSettings:()=>void openSummarySettings(false)});
    if(batchId)await runtime.summaryController.regenerate(batchId);
    (summaryContent.querySelector('.lt-main'))?.focus({preventScroll:true});return true;
  }
  async function openSummarySettings(fromMemory=true) {
    if(!runtime?.settings||!panel||apiSession)return;unmountCumulative();if(app?.memoryType()==='cumulative')app.suspendCumulative();
    if(summaryContent.hidden)summaryReturnFocus=panel.shadowRoot.activeElement;
    const target=repository.captureTarget(),serial=ticket,request=++pageRequest;
    if(!summarySettingsController||!sameTarget(target,summarySettingsTarget)) {
      summarySettingsController?.dispose();summarySettingsTarget=target;
      const current=()=>sameTarget(target,repository.captureTarget());
      const read=async()=>{const capture=await repository.captureSummary(target);return capture.summary.excludedFloors;};
      const change=async(floor,remove)=>{const capture=await repository.captureSummary(target),records=structuredClone(capture.summary.excludedFloors);if(remove){const index=records.findIndex(item=>item.floor===Number(floor));if(index>=0)records.splice(index,1);}else{const message=adapter.captureSummarySource(target).messages.find(item=>item.floor===Number(floor));if(!message)throw new Error('楼层不存在');if(!records.some(item=>item.floor===message.floor))records.push({floor:message.floor,identity:message.identity});}await repository.setSummaryExcludedFloors(target,records,{expectedSummaryRevision:capture.summary.revision,isCurrent:current});};
      summarySettingsController=createSummarySettingsController({settings:runtime.settings,exclusions:{read,add:floor=>change(floor,false),remove:floor=>change(floor,true)},isCurrent:current,onBack:()=>{if(summarySettingsFromMemory)void returnFromSummary();else void showSummary(runtime.summaryController.inspect().origin);},onClose:close});
    }
    if(!panel||serial!==ticket||!sameTarget(target,repository.captureTarget()))return;
    summarySettingsFromMemory=fromMemory;summaryView?.dispose();summaryView=null;summarySettingsView?.dispose();
    recallView?.dispose();recallView=null;recallController?.suspend();
    memoryContent.hidden=true;memoryContent.inert=true;summaryContent.hidden=false;
    summarySettingsView=mountSummarySettingsView(summaryContent,summarySettingsController,{readonlyContent:summaryReadonlyContent});
    const controller=summarySettingsController;
    afterPageFrame(()=>{
      if(panel&&serial===ticket&&request===pageRequest&&summarySettingsController===controller&&sameTarget(target,repository.captureTarget()))void controller.init();
    });
  }
  // Paint the existing locked loading surface before starting reads/computation.
  function afterPageFrame(work){const frame=doc.defaultView?.requestAnimationFrame;if(frame)frame.call(doc.defaultView,()=>setTimeout(work,0));else setTimeout(work,0);}
  async function openRecall() {
    if(!panel||apiSession||!recallRuntime)return false;unmountCumulative();if(app?.memoryType()==='cumulative')app.suspendCumulative();
    const target=repository.captureTarget(),serial=ticket,request=++pageRequest;
    if(summaryContent.hidden)summaryReturnFocus=panel.shadowRoot.activeElement;
    if(!recallController||!sameTarget(target,recallTarget)) {
      recallController?.dispose();recallTarget=target;
      recallController=createRecallController({repository,settings:runtime.settings,runtime:recallRuntime,onBack:()=>void returnFromSummary(),onClose:close});
    }
    if(!panel||serial!==ticket||!sameTarget(target,repository.captureTarget()))return false;
    summaryView?.dispose();summaryView=null;summarySettingsView?.dispose();summarySettingsView=null;recallView?.dispose();
    memoryContent.hidden=true;memoryContent.inert=true;summaryContent.hidden=false;
    recallController.resume();
      recallController.route('monitor');recallController.tab('actual');
    recallView=mountRecallView({container:summaryContent,controller:recallController});
    const controller=recallController;
    afterPageFrame(()=>{
      if(panel&&serial===ticket&&request===pageRequest&&recallController===controller&&sameTarget(target,repository.captureTarget()))void controller.init();
    });return true;
  }
  function returnFromSettings(reason) {
    if(replacingPage)return;
    apiView?.dispose(); apiView = null; apiSession = null;
    if (reason === 'close') { close(); return; }
    settingsContent.replaceChildren(); settingsContent.hidden = true; memoryContent.hidden = false; memoryContent.inert = false;
    const previous = returnFocus;
    const identity = previous && ['id', 'data-action', 'data-management-field', 'data-management-entry', 'name']
      .filter(key => previous.hasAttribute(key)).map(key => [key, previous.getAttribute(key)]);
    if (generationEpoch() !== returnEpoch) runtime.controller.refresh();
    const visible = node => node?.isConnected && memoryContent.contains(node)
      && !node.disabled && !node.closest('[hidden],[inert]') && node.getClientRects().length;
    const samePage = sameTarget(returnTarget, repository.captureTarget());
    let focus = samePage && visible(previous) ? previous : null;
    if (!focus && samePage && identity?.length) focus = [...memoryContent.querySelectorAll('button,a,input,textarea,select,summary,[tabindex]')]
      .find(node => node.tagName === previous.tagName && identity.every(([key, value]) => node.getAttribute(key) === value) && visible(node));
    if (!focus) focus = [...memoryContent.querySelectorAll('[data-action=back],button,a,input,textarea,select,summary,[tabindex]')]
      .find(node => node.tabIndex >= 0 && visible(node));
    if (focus) focus.focus({ preventScroll: true });
    else { memoryContent.tabIndex = -1; memoryContent.focus({ preventScroll: true }); }
    returnFocus = returnTarget = null;
  }
  function generationEpoch() { try { return runtime.getGenerationSettings().epoch; } catch { return null; } }
  function openSettings() {
    if (apiSession || !panel || !runtime) return;
    returnFocus = panel.shadowRoot.activeElement;
    returnTarget = repository.captureTarget();
    returnEpoch = generationEpoch();
    memoryContent.hidden = true; memoryContent.inert = true; settingsContent.hidden = false;
    if (!runtime.settings) {
      settingsContent.textContent = '当前酒馆设置或密钥引用能力不可用。';
      const back = doc.createElement('button'); back.type = 'button'; back.textContent = '返回原页面';
      back.addEventListener('click', () => returnFromSettings('back')); settingsContent.append(back); back.focus(); return;
    }
    apiSession = createApiSettingsSession({ repository: runtime.settings, operations: runtime.apiOperations, onExit: returnFromSettings });
    apiView = mountApiSettingsView(settingsContent, apiSession, { appearance }); void apiSession.read();
  }
  async function notificationStyles() {
    const css = await styles();
    if ((appearance.inspect().previewTheme ?? appearance.inspect().theme) !== 'snow-ermine') return css;
    // Notices live in separate short-lived shadows. Snapshot the current
    // presentation roles without making their business lifecycle theme-aware.
    return css + '\n' + (await snowStyles()).replaceAll(':host([data-ui-theme="snow-ermine"])', ':host');
  }
  async function styles() {
    if (!stylePromise) stylePromise = Promise.all(BASE_STYLE_ENTRIES.map(async ({url}) => {
      const response = await request(url);
      if (!response.ok) throw new Error('兰台界面样式未能加载，请关闭后重试');
      return response.text();
    })).then(parts => parts.map(css => css.replace(/:root\b/g, ':host')).join('\n')).catch(error => { stylePromise = null; throw error; });
    return stylePromise;
  }
  async function openCumulativeTask(taskId){
    if(disposed||apiSession||cumulativeSettingsView||summarySettingsView)return false;
    const task=runtime?.cumulativeService.inspect(taskId);if(!task||!sameTarget(task.target,repository.captureTarget()))return false;
    if(panel){const active=panel.shadowRoot.activeElement,value=runtime.cumulativeController.inspect();if(app?.session.state.route==='editor'||value.editDraft||value.restore||active?.matches('input,textarea,select')||panel.shadowRoot.querySelector('[data-composing=true]'))return false;}
    if(!panel)await open();
    // A notice may never replace another live cumulative review.
    if(runtime.cumulativeController.inspect().taskId!==taskId){if(!['succeeded','failed','stale','cancelled'].includes(task.status))return false;await app?.setMemoryType('cumulative');await runtime.cumulativeController.refresh();return true;}
    return showCumulative(task.origin==='auto'?'auto':'manual');
  }
  async function returnFromCumulative(){
    pageRequest++;unmountCumulative();cumulativePage='root';
    if(!panel)return;summaryContent.replaceChildren();summaryContent.hidden=true;memoryContent.hidden=false;memoryContent.inert=false;
    await app?.setMemoryType('cumulative');app?.resumeCumulative();
    memoryContent.querySelector('.lt-main')?.focus({preventScroll:true});
  }
  async function showCumulative(origin='manual'){
    if(!panel||apiSession||!runtime?.cumulativeController)return false;
    const target=repository.captureTarget(),serial=ticket,request=++pageRequest;
    const opened=await runtime.cumulativeController.open(origin);
    // A frozen reload view may remount its existing draft for explicit readback.
    if(!opened&&!runtime.cumulativeController.inspect().reloadInvalidated||!panel||serial!==ticket||request!==pageRequest||!sameTarget(target,repository.captureTarget()))return false;
    summaryView?.dispose();summaryView=null;summarySettingsView?.dispose();summarySettingsView=null;recallView?.dispose();recallView=null;recallController?.suspend();unmountCumulative();app?.suspendCumulative();
    memoryType='cumulative';cumulativePage=origin;cumulativePageTarget=target;
    memoryContent.hidden=true;memoryContent.inert=true;summaryContent.hidden=false;
    cumulativeView=mountCumulativeView({container:summaryContent,controller:runtime.cumulativeController,onBack:()=>void returnFromCumulative(),onClose:close,openSettings:()=>void openCumulativeSettings(origin)});
    summaryContent.querySelector('.lt-main')?.focus({preventScroll:true});return true;
  }
  function cumulativeExclusions(target){
    const current=()=>sameTarget(target,repository.captureTarget());
    const read=async()=>{const capture=await repository.captureCumulative(target);return capture.cumulative.excludedFloors;};
    const change=async(floor,remove)=>{const capture=await repository.captureCumulative(target),records=structuredClone(capture.cumulative.excludedFloors);if(remove){const index=records.findIndex(item=>item.floor===floor);if(index>=0)records.splice(index,1);}else{const message=adapter.captureSummarySource(target).messages.find(item=>item.floor===floor);if(!message)throw new Error('楼层不存在');if(!records.some(item=>item.floor===floor))records.push({floor,identity:message.identity});}await repository.setCumulativeExcludedFloors(target,capture,records,{isCurrent:current});};
    return {read,add:floor=>change(floor,false),remove:floor=>change(floor,true)};
  }
  async function openCumulativeSettings(from='root',preserve=false){
    if(!panel||apiSession||!runtime?.settings)return false;
    const target=repository.captureTarget(),serial=ticket,request=++pageRequest;
    if(!cumulativeSettingsController||!sameTarget(target,cumulativeSettingsTarget)){
      cumulativeSettingsController?.dispose();cumulativeSettingsTarget=target;
      cumulativeSettingsController=createCumulativeSettingsController({settings:runtime.settings,exclusions:cumulativeExclusions(target),isCurrent:()=>sameTarget(target,repository.captureTarget()),onBack:()=>{if(cumulativeReturnPage==='root')void returnFromCumulative();else void showCumulative(cumulativeReturnPage);},onClose:close,onOpenCleaning:()=>void openCumulativeCleaning()});
    }
    if(!preserve)cumulativeReturnPage=from;
    unmountCumulative();summaryView?.dispose();summaryView=null;summarySettingsView?.dispose();summarySettingsView=null;recallView?.dispose();recallView=null;recallController?.suspend();app?.suspendCumulative();
    memoryType='cumulative';cumulativePage='settings';cumulativePageTarget=target;
    memoryContent.hidden=true;memoryContent.inert=true;summaryContent.hidden=false;
    cumulativeSettingsView=mountCumulativeSettingsView({container:summaryContent,controller:cumulativeSettingsController});
    afterPageFrame(()=>{if(panel&&serial===ticket&&request===pageRequest&&sameTarget(target,repository.captureTarget()))void cumulativeSettingsController.init();});return true;
  }
  async function openCumulativeCleaning(){
    if(!panel||apiSession)return false;const target=repository.captureTarget(),serial=ticket,request=++pageRequest;
    if(!cleaningController||!sameTarget(target,cleaningTarget)){
      cleaningController?.dispose();cleaningTarget=target;
      cleaningController=createSummarySettingsController({settings:runtime.settings,exclusions:cumulativeExclusions(target),isCurrent:()=>sameTarget(target,repository.captureTarget()),onBack:()=>void openCumulativeSettings(cumulativeReturnPage,true),onClose:close});
    }
    const controller=cleaningController;await controller.init();
    if(!panel||serial!==ticket||request!==pageRequest||!sameTarget(target,repository.captureTarget()))return false;
    controller.navigate('cleaning');unmountCumulative();
    // Only the list's return route changes; rule cancellation remains shared.
    cleaningFacade={...controller,back(){if(controller.inspect().route==='rule')return controller.back();if(controller.inspect().status==='saving')return false;void openCumulativeSettings(cumulativeReturnPage,true);return true;}};
    cumulativePage='cleaning';cumulativePageTarget=target;
    summarySettingsView=mountSummarySettingsView(summaryContent,cleaningFacade,{readonlyContent:summaryReadonlyContent});return true;
  }
  async function memphisStyles() {
    if(!memphisStylePromise)memphisStylePromise=Promise.all(MEMPHIS_STYLE_ENTRIES.map(async ({url})=>{const response=await request(url);if(!response.ok)throw new Error('孟菲斯候选样式未能加载');return response.text();}))
      .then(parts=>parts.map(css=>css.replace(/:root\b/g,':host')).join('\n'))
      .catch(error=>{memphisStylePromise=null;throw error;});
    return memphisStylePromise;
  }
  async function snowStyles() {
    if (!snowStylePromise) snowStylePromise = Promise.all(SNOW_ERMINE_STYLE_ENTRIES.map(async ({url}) => {
      const response = await request(url);
      if (!response.ok) throw new Error();
      return resolveStyleAssets(await response.text(), url).replace(/:root\b/g, ':host');
    })).then(parts => { snowCss = parts.join('\n'); return snowCss; }).catch(() => {
      snowStylePromise = null;
      throw Object.assign(new Error('皮肤资源未能加载'), { code: 'APPEARANCE_STYLE_UNAVAILABLE' });
    });
    return snowStylePromise;
  }
  function syncMemphis() {
    if (!panel || !memphisStyle) return;
    const theme = (appearance.inspect().previewTheme ?? appearance.inspect().theme) === 'snow-ermine' && snowCss ? 'snow-ermine' : DEFAULT_THEME;
    panel.setAttribute('data-ui-theme', theme);
    applyTheme(content, theme);
    let active = false;
    for (const page of [memoryContent,summaryContent,settingsContent]) {
      const themed = !!page?.querySelector('.lantai');
      if (themed) { if (page.getAttribute('data-ui-theme') !== theme) page.setAttribute('data-ui-theme', theme); if (!page.hidden) active = true; }
      else page?.removeAttribute('data-ui-theme');
    }
    // The complete fixed candidate contains shared choice/hit-area semantics.
    // Its Memphis visuals are scoped; both themes retain that shared layer.
    memphisStyle.media = active ? 'all' : 'not all';
    if (theme === 'snow-ermine' && !snowStyle) {
      snowStyle = doc.createElement('style'); snowStyle.textContent = snowCss; panel.shadowRoot.append(snowStyle);
    }
    if (snowStyle) snowStyle.media = active && theme === 'snow-ermine' ? 'all' : 'not all';
    if (active && typeof globalThis.getComputedStyle === 'function') globalThis.UICompactGroupCandidate.sync(panel.shadowRoot);
  }
  function errorView(error) {
    memoryContent.replaceChildren();
    const surface = doc.createElement('section'); surface.className = 'lantai';
    const main = doc.createElement('main'); main.className = 'lt-main lt-stack';
    const message = doc.createElement('p'); message.className = 'lt-error'; message.setAttribute('role', 'alert'); message.textContent = '记忆读取失败，请恢复连接后重试。';
    const retry = doc.createElement('button'); retry.type = 'button'; retry.className = 'ui-button ui-button--secondary'; retry.textContent = '重试'; retry.addEventListener('click', () => void open());
    const exit = doc.createElement('button'); exit.type = 'button'; exit.className = 'ui-button ui-button--tertiary'; exit.textContent = '返回聊天'; exit.addEventListener('click', close);
    main.append(message, retry, exit); surface.append(main); memoryContent.append(surface); retry.focus();
  }
  async function open() {
    if (disposed) return;
    const currentTicket = ++ticket;
    app?.dispose(); app = null;unmountCumulative();
    summaryView?.dispose();summaryView=null;summarySettingsView?.dispose();summarySettingsView=null;
    recallView?.dispose();recallView=null;recallController?.suspend();
    if(panel){summaryContent.replaceChildren();summaryContent.hidden=true;memoryContent.hidden=false;memoryContent.inert=false;apiView?.dispose();apiView=null;const previous=apiSession;apiSession=null;replacingPage=true;try{previous?.exit('back');}finally{replacingPage=false;}settingsContent.replaceChildren();settingsContent.hidden=true;}
    if (!panel) {
      panel = doc.createElement('lantai-benmo-host'); panel.id = 'lantai-benmo-panel';
      panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', '兰台本末');
      const shadow = panel.attachShadow({ mode: 'open' });
      let composing = false;
      shadow.addEventListener('compositionstart', () => { composing = true; });
      shadow.addEventListener('compositionend', () => { composing = false; });
      panel.addEventListener('keydown', event => {
        if (disposed || event.currentTarget!==panel || !settingsContent || !summaryContent || event.defaultPrevented || event.isComposing || composing || shadow.querySelector('[data-composing=true]')) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!settingsContent.hidden) returnFromSettings('back'); else if(!summaryContent.hidden){if(cleaningFacade)cleaningFacade.back();else if(cumulativeSettingsView)cumulativeSettingsController.back();else if(cumulativeView)void runtime.cumulativeController.back().then(back=>{if(back)void returnFromCumulative();});else if(recallView)recallController.back();else if(summarySettingsView)summarySettingsController.back();else void runtime.summaryController.back().then(back=>{if(back)void returnFromSummary();});}else close(); return; }
        if (event.key !== 'Tab') return;
        const items = [...shadow.querySelectorAll('button,a,input,textarea,select,summary,[tabindex]')]
          .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
        const first = items[0], last = items.at(-1), active = shadow.activeElement;
        if (event.shiftKey && (active === first || !items.includes(active))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (active === last || !items.includes(active))) { event.preventDefault(); first?.focus(); }
      });
      content = doc.createElement('div'); content.id = 'lt-host-content';
      memoryContent = doc.createElement('div'); memoryContent.className = 'lt-host-page';
      memoryContent.addEventListener('focusin',event=>{if(event.target.matches('input,textarea,select'))memoryEditFocus=event.target;});
      settingsContent = doc.createElement('div'); settingsContent.className = 'lt-host-page'; settingsContent.hidden = true;
      summaryContent=doc.createElement('div');summaryContent.className='lt-host-page';summaryContent.hidden=true;
      content.append(memoryContent, settingsContent,summaryContent);
      shadow.append(content); doc.body.append(panel);
    }
    memoryContent.textContent = '正在读取记忆…';
    try {
      const [css,memphisCss] = await Promise.all([styles(),memphisStyles(),appearance.read()]);
      if (disposed || currentTicket !== ticket || !panel) return;
      if (!panel.shadowRoot.querySelector('style')) { const style = doc.createElement('style'); style.textContent = css; panel.shadowRoot.prepend(style); }
      if(!memphisStyle){memphisStyle=doc.createElement('style');memphisStyle.media='not all';memphisStyle.textContent=memphisCss;panel.shadowRoot.append(memphisStyle);}
      // Seed the presentation owner before any view creates its first root.
      syncMemphis();
      if(!memphisObserver&&Observer){memphisObserver=new Observer(syncMemphis);memphisObserver.observe(content,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});}
      ensureAdapter();
      await adapter.prepare();
      if (disposed || currentTicket !== ticket || !panel) return;
      await ensureRuntime();
      if (disposed || currentTicket !== ticket || !panel) return;
      app = mountMemoryApp(memoryContent, repository, { history: null, window: null, onClose: close,
        managementService: runtime?.service, managementController: runtime?.controller,
        getSettingsEpoch: () => runtime.getGenerationSettings().epoch,
        getOriginalSnapshot: runtime?.getOriginalSnapshot, originalAvailable: runtime?.originalAvailable, openSettings,
        openSummary:origin=>void showSummary(origin),openSummarySettings:()=>void openSummarySettings(true),openRecall:()=>void openRecall(),regenerateBatch:id=>void showSummary('manual',id),cumulativeController:runtime.cumulativeController,initialMemoryType:memoryType,onMemoryType:type=>{memoryType=type;cumulativePage='root';},openCumulative:origin=>void showCumulative(origin),openCumulativeSettings:()=>void openCumulativeSettings('root') });
      const reopenPage=cumulativePage,reopenTarget=cumulativePageTarget;await app.ready;
      if(memoryType==='cumulative'&&sameTarget(reopenTarget,repository.captureTarget())){if(['manual','auto'].includes(reopenPage))await showCumulative(reopenPage);else if(reopenPage==='settings'||reopenPage==='cleaning'){await openCumulativeSettings(cumulativeReturnPage,true);if(reopenPage==='cleaning')await openCumulativeCleaning();}}
      syncMemphis();
    } catch (error) { if (!disposed && currentTicket === ticket && panel) errorView(error); }
  }
  function installEntry() {
    if (disposed) return;
    // Subscribe before the first page open: host renames must be observed
    // even when the user has not opened Lantai after a browser reload.
    try { ensureAdapter(); } catch { /* APP_READY/open will retry capability detection. */ }
    if (repository) void ensureRuntime().catch(() => {});
    if (entry) return;
    const menu = doc.querySelector('#extensionsMenu');
    if (!menu) return;
    entry = doc.createElement('button'); entry.id = entryId; entry.type = 'button'; entry.className = 'list-group-item flex-container flexGap5';
    const label = doc.createElement('span'); label.textContent = '兰台本末';
    entry.append(label); entry.addEventListener('click', () => void open()); menu.append(entry);
  }
  const context = getContext(), source = context?.eventSource, readyEvent = context?.eventTypes?.APP_READY;
  const ready = () => installEntry();
  if (source?.on && readyEvent) source.on(readyEvent, ready);
  installEntry();
  // Host startup may add the Extensions menu after loading the module.
  const observer = new Observer(installEntry);
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  return {
    open, close, openSettings, openTask,openSummary:showSummary,openSummarySettings,openSummaryTask,openRecall,openCumulative:showCumulative,openCumulativeSettings,
    async interceptPrompt(...args){
      if(disposed)return;
      const request=++recallEntryRequest;let entryTarget;
      try{
        ensureAdapter();try{entryTarget=repository.captureTarget();}catch{/* Cold entry has no confirmed target yet. */}
        const target=await adapter.prepare();
        const current=()=>!disposed&&request===recallEntryRequest&&sameTarget(target,repository.captureTarget());
        if(!current())return;await ensureRuntime();
        if(disposed||request!==recallEntryRequest||!sameTarget(target,repository.captureTarget()))return;
        await recallRuntime?.intercept(...args);if(!current())return;
        await cumulativeRuntime?.intercept(...args);if(!current())return;
        await summaryHistory.intercept(...args);if(!current())return;
        await cumulativeHistory?.intercept(...args);
      }catch{if(!disposed&&request===recallEntryRequest){recallRuntime?.preparationFailed(entryTarget,args[0],args[3]);cumulativeRuntime?.preparationFailed(entryTarget);}/* Keep the host prompt copy on unavailable authority. */}
    },
    cumulativeStatus:()=>cumulativeRuntime?.inspect()??{status:'empty'},
    cumulativeHistoryStatus:()=>cumulativeHistory?.inspect()??{status:'retained',removed:0},
    recallStatus:()=>recallRuntime?.inspect()??{status:'empty'},
    promptHistoryStatus:()=>summaryHistory?.inspect()??{status:'retained',reason:'not-initialized',removed:0},
    dispose() {
      if(disposed)return;disposed = true;unsubscribeAppearance();appearance.dispose();let closeError;try{close();}catch(error){closeError=error;} cumulativeNotices?.dispose();cumulativeSettingsController?.dispose();cleaningController?.dispose();cumulativeHistory?.dispose();cumulativeRuntime?.dispose();notices?.dispose();summaryNotices?.dispose();summarySettingsController?.dispose();summaryHistory?.dispose();recallController?.dispose();recallRuntime?.dispose(); runtime?.dispose(); lifetime.abort(); unsubscribe?.(); adapter?.dispose(); observer.disconnect();
      if (readyEvent && source) (source.removeListener ?? source.off)?.call(source, readyEvent, ready);
      entry?.remove(); entry = null;if(closeError)throw closeError;
    },
  };
}
