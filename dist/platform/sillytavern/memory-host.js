import {createTransitionSampleInnerScroll} from './transition-sample-inner-scroll.js';
import {createSampleHiddenFilter} from './transition-sample-hidden-filter.js';
import {createTransitionSampleFixture} from './transition-sample-fixture.js';
import {bindGenerationDiagnostic,bindGenerationDiagnosticPanel,downloadGenerationDiagnostic} from './generation-diagnostic.js';
import {createUITransitionDiagnostic} from './ui-transition-diagnostic.js';
import {mountUITransitionCaptureControl} from './ui-transition-capture-control.js';
import {createWorkshopHistoryTicket} from './workshop-history.js';
import {createNativeSummaryHider} from './native-summary-hide.js';
import {createSummaryNarrativeActions} from '../../app/summary-controller.js';
import { ensureBookThemeFont } from '../../app/styles/book-font.js';
import { MEMORY_SHELL_CSS } from './memory-shell-style.js';
import {createNarrativeRuntime} from './narrative-runtime.js';
import {mountWorkshopBackgroundDisplay} from './workshop-background-display.js';
import {createWorkshopDisplayFormatter} from './workshop-display-formatter.js';
import {createFloorDisplayCoordinator} from './floor-display-coordinator.js';
import {createLatestSummaryRuntime} from './latest-summary-runtime.js';
import {mountLatestSummaryDisplay} from './latest-summary-display.js';
import {createBenmoController} from '../../app/benmo-controller.js';
import {mountBenmoView} from '../../app/benmo-view.js';
import {createSourceDeletionRuntime} from './source-deletion-runtime.js';
import {createSourceDeletionDialog} from '../../app/source-deletion-dialog.js';
import {createControlSession} from '../../app/control-session.js';
import {mountSettingsRootView} from '../../app/settings-root-view.js';
import {mountWorkshopLoading} from '../../app/workshop-loading-view.js';
import {mountStorybarTheme} from './storybar-theme.js';
import {createWorkshopRegexInstaller} from './workshop-regex.js';
import {createWorkshopRuntime} from './workshop-runtime.js';
import {createWorkshopController} from '../../app/workshop-controller.js';
import {mountWorkshopView} from '../../app/workshop-view.js';
import {createTrackingRuntime} from './tracking-runtime.js';
import {createScheduleRuntime} from './schedule-runtime.js';
import {createTimeController} from '../../app/time-controller.js';
import {mountTimeView} from '../../app/time-view.js';
import {createTimePromptRuntime} from './time-prompts.js';
import {createTimeRuntime} from './time-runtime.js';
import { createSillyTavernMemoryAdapter } from './memory-adapter.js';
import { createRepository, sameTarget } from '../../domain/memory/repository.js';
import { summaryOf } from '../../domain/summary/data.js';
import { cumulativeOf } from '../../domain/cumulative/data.js';
import { mountMemoryApp } from '../../app/memory-app.js';
import { getSillyTavernContext } from './context.js';
import { createManagementRuntime } from './management-runtime.js';
import { createApiSettingsSession } from '../../app/api-settings-session.js';
import { mountApiSettingsView } from '../../app/api-settings-view.js';
import { createTaskApiSettingsSession } from '../../app/task-api-settings-session.js';
import { mountTaskApiSettingsView } from '../../app/task-api-settings-view.js';
import { createManagementNotifications } from './management-notifications.js';
import { mountSummaryView } from '../../app/summary-view.js';
import { createSummarySettingsController } from '../../app/summary-settings-controller.js';
import { mountSummarySettingsView } from '../../app/summary-settings-view.js';
import { summaryReadonlyContent } from '../../domain/summary/requests.js';
import {createSummaryNotifications} from './summary-notifications.js';
import {createRecallRuntime} from './recall-runtime.js';
import {createRecallController} from '../../app/recall-controller.js';
import {mountRecallView} from '../../app/recall-view.js';
import {createCumulativeRuntime} from './cumulative-runtime.js';
import {mountCumulativeView} from '../../app/cumulative-view.js';
import {createCumulativeSettingsController} from '../../app/cumulative-settings-controller.js';
import {mountCumulativeSettingsView} from '../../app/cumulative-settings-view.js';
import '../../app/shared-ui/compact-group-candidate.js';
import {BASE_STYLE_ENTRIES,SHARED_STYLE_ENTRIES,SNOW_ERMINE_STYLE_ENTRIES,SPRING_STYLE_ENTRIES,BOOK_THEME_STYLE_ENTRIES} from '../../app/styles/style-entries.js';

import { DEFAULT_THEME, applyTheme, resolveStyleAssets } from '../../app/styles/theme.js';
import {createPersistentDecoration} from '../../app/persistent-decoration.js';
import { createAppearanceAdapter } from './appearance-adapter.js';
import { createAppearanceSession } from '../../app/appearance-session.js';

// A shared manager includes independently gated feature owners. Ask the
// existing services whether they own a task; absence of cumulative data is not
// evidence that it belongs to event memory.
export function cancelDisabledManagedTasks(runtime,policy){
  for(const task of runtime.manager.list()){
    if(!['starting','running','committing'].includes(task.status))continue;
    if(!policy.event&&(runtime.summaryService?.inspect(task.taskId)||runtime.service?.inspect(task.taskId)))runtime.manager.cancel(task.taskId);
    if(!policy.cumulative&&runtime.cumulativeService?.inspect(task.taskId))runtime.manager.cancel(task.taskId);
  }
}

// Only this platform module touches the host document. Shadow DOM prevents
// host skins from changing the approved UI and prevents our UI CSS leakage.
export function createMemoryHost({ document: doc = globalThis.document, getContext = getSillyTavernContext, fetch: request = globalThis.fetch,
  runtimeOptions = {}, appearanceOptions = {}, MutationObserver: Observer = globalThis.MutationObserver,createAdapter=createSillyTavernMemoryAdapter,diagnosticSample=false,diagnosticSimpleMain=false,diagnosticSkipWarm=false,diagnosticVisibilityOnly=false,diagnosticFilterHidden=false,diagnosticMainClip=false,diagnosticInnerScroll=false,onSampleExit=null,onSampleDispose=null } = {}) {
  let adapter, repository, app, panel, content, memoryContent, benmoContent, settingsContent, apiView, apiSession, returnFocus, returnEpoch, returnTarget,
    runtime, runtimePromise, notices, entry, unsubscribe, disposed = false, closing = false, replacingPage = false, ticket = 0, openingTicket = null, stylePromise, baseCss, sharedCssCache,
    summaryContent,summaryView,summarySettingsView,summarySettingsController,summarySettingsTarget,summarySettingsFromMemory=false,summaryNotices,summaryReturnFocus,memoryEditFocus,
    recallRuntime,recallController,recallView,recallTarget,pageRequest=0,recallEntryRequest=0,
    sharedStyle,sharedObserver,sharedStylePromise,snowStyle,snowStylePromise,snowCss,springStyle,springStylePromise,springCss;
  let releasePanelDiagnostic=null,foregroundBrowsing=false,decoration=null;
  let visibilitySampleReady=false,visibilitySampleArea=null;
  const visibilitySample=diagnosticSample&&diagnosticSimpleMain&&diagnosticVisibilityOnly;
  const filterHidden=visibilitySample&&diagnosticFilterHidden===true,hiddenFilter=createSampleHiddenFilter();
  const innerScroll=diagnosticSample&&diagnosticSimpleMain&&diagnosticMainClip===true&&diagnosticInnerScroll===true;
  const mainClip=diagnosticSample&&diagnosticSimpleMain&&diagnosticMainClip===true;
  const innerScrollSetup=createTransitionSampleInnerScroll({getStyle:node=>doc.defaultView?.getComputedStyle?.(node)??globalThis.getComputedStyle?.(node)});
  let interfaceDiagnosticTarget=null,interfaceCaptureControl=null,sampleHost=null,sampleOpening=false;
  const diagnosticRecorder=createUITransitionDiagnostic({document:doc,getPanel:()=>panel,sampleMode:diagnosticSample,sampleContent:diagnosticSimpleMain?'simplified':'original',sampleObserverMode:filterHidden?'owned-hidden-filter':'normal',sampleMainScrollMode:innerScroll?'inner':mainClip?'clip':'normal',sampleWarmMode:visibilitySample?'visibility-only':diagnosticSample&&diagnosticSimpleMain&&diagnosticSkipWarm?'skip-warm-revalidation':'normal'});
  // Evidence must never prevent ordinary navigation, saving or cleanup.
  const interfaceDiagnostic=Object.fromEntries(['start','stop','mark','setSizeCondition','setClipCondition','setGridCondition','stage','observerBatch','inspect','subscribe','subscribeTimeline','subscribeGrid','subscribeObserver','subscribeMainScroll','subscribeInnerScroll','download','dispose'].map(name=>[name,(...args)=>{try{return diagnosticRecorder[name](...args);}catch{return (name==='subscribe'||name==='subscribeTimeline'||name==='subscribeGrid'||name==='subscribeObserver'||name==='subscribeMainScroll'||name==='subscribeInnerScroll')?()=>{}:name==='inspect'?{status:'stopped',reason:'failed',mode:'attributes-only',hasData:false}:false;}}]));
  const releaseInterfaceDiagnostic=interfaceDiagnostic.subscribe(value=>{if(value.status!=='recording')interfaceDiagnosticTarget=null;});
  function startInterfaceDiagnostic(){
    try{interfaceDiagnosticTarget=repository.captureTarget();if(interfaceDiagnostic.start())return true;}catch{}
    interfaceDiagnosticTarget=null;return false;
  }
  async function openTransitionSample({simpleMain=false,skipWarm=false,visibilityOnly=false,filterHidden=false,mainClip=false,innerScroll=false}={}){
    if(disposed||diagnosticSample||sampleHost||sampleOpening)return false;
    sampleOpening=true;
    try{
      const fixture=createTransitionSampleFixture({assetFetch:request,theme:panel?.getAttribute('data-ui-theme')??appearance.inspect().theme});
      close();
      const child=createMemoryHost({document:doc,getContext:()=>fixture.ctx,fetch:fixture.request,runtimeOptions:fixture.runtimeOptions,appearanceOptions:fixture.appearanceOptions,MutationObserver:Observer,diagnosticSample:true,diagnosticSimpleMain:simpleMain===true,diagnosticSkipWarm:simpleMain===true&&skipWarm===true,diagnosticVisibilityOnly:simpleMain===true&&visibilityOnly===true,diagnosticFilterHidden:filterHidden===true,diagnosticMainClip:mainClip===true,diagnosticInnerScroll:innerScroll===true,onSampleDispose:()=>fixture.dispose(),onSampleExit:()=>{
        if(sampleHost!==child)return;sampleHost=null;child.dispose();if(!disposed)void open();
      }});
      sampleHost=child;await child.open();
      if(sampleHost!==child)return false;
      if(!child.sampleReady()){sampleHost=null;child.dispose();if(!disposed)void open();return false;}
      return true;
    }catch{
      const child=sampleHost;sampleHost=null;child?.dispose();if(!disposed)void open();return false;
    }finally{sampleOpening=false;}
  }
  const generationBrowseReleases=[];
  const bookStylesByTheme = new Map();
  const storybarTheme=diagnosticSample?{dispose(){}}:mountStorybarTheme({document:doc});
  const appearance = createAppearanceSession({ adapter: createAppearanceAdapter({ getContext, fetchImpl: request, ...appearanceOptions }), prepareTheme: async theme => { if (theme === 'snow-ermine') await snowStyles(); if (theme === 'spring') await springStyles(); if (Object.hasOwn(BOOK_THEME_STYLE_ENTRIES,theme)) await bookStyles(theme); }, canSave: () => {
    try { if(controls?.inspect().busy)return false;if (apiSession && !['ready','saved'].includes(apiSession.inspect().status)) return false; runtime.settings.getEpoch(); return true; } catch { return false; }
  } });
  const unsubscribeAppearance = appearance.subscribe(() => syncAppearance());
  const entryId = 'lantai-benmo-open';
  const lifetime = new AbortController();
  let cumulativeRuntime,cumulativeView,cumulativeSettingsView,cumulativeSettingsController,cumulativeSettingsTarget,cumulativeNotices,
    cleaningController,cleaningTarget,cleaningFacade,memoryType='event',cumulativePage='root',cumulativeReturnPage='root',cumulativePageTarget=null;
  let controls,controlSubscription,previousPolicy=null,settingsRootView,settingsOpen=false;
  const allowed=key=>['benmo','summary','item','npc','self','outline'].includes(key)?availability()[key]===true:!!controls?.allowed(key);
  const availability=()=>{
    const global=controls?.inspect(),local=benmoController?.availability(),master=controls?.allowed('enabled')===true;
    let localCurrent=false;try{localCurrent=!!local?.target&&sameTarget(local.target,repository.captureTarget());}catch{/* Preparing a new chat. */}
    return {...global?.policy,...Object.fromEntries(['summary','item','npc','self','outline','benmo'].map(key=>[key,master&&local?.policy?.[key]===true])),memory:!!controls?.allowed('memory'),settings:true,transient:global?.status!=='ready'||!localCurrent};
  };
  let hostReloadSequence=0,timeRuntime,timePrompts,timeController,timeView,timeTarget,timeContainer,memoryReadProof=null;
  let sourceDeletionRuntime,sourceDeletionNotices,narrativeRuntime,latestRuntime,latestDisplay,workshopBackgroundDisplay;
  let benmoController,benmoView,benmoSubscription,benmoTarget,benmoNavigation=null,benmoPolicyKey='';
  let benmoWarmupRequested=false,benmoWarmupScheduled=false;
  let workshopRegex,workshopRegexError=null,workshopRuntime,workshopController,workshopView,workshopTarget,workshopContainer,trackingRuntime,scheduleRuntime;
  let workshopPreparation=Promise.resolve();
  // Area-owned views survive ordinary section and settings round trips. Runtime services
  // are deliberately not page resources: closing a page must not stop a task.
  const areaPages = {
    benmo: {
      open: openBenmo,
      settingsReturn: false,
      view: () => benmoView,
      mounted: () => !!benmoView,
      async reload(target,valid) {
        benmoController.rebindTarget(target);
        benmoTarget=target;
        if(this.settingsReturn)returnTarget=target;
        if(benmoView.blocking()){benmoView.invalidate('聊天已重新读取，草稿已保留。请重新读取后确认保存');return;}
        await benmoController.load().catch(()=>{});
        if(valid()&&!settingsOpen)benmoView?.resume();
      },
      visible: () => !!benmoContent && !benmoContent.hidden && !!benmoContent.children.length,
      suspend() { if(benmoView)benmoNavigation=benmoView.snapshotNavigation();benmoView?.suspend();benmoContent.hidden=true;benmoContent.inert=true; },
      resume() { if(!benmoView)return false;benmoContent.hidden=false;benmoContent.inert=false;benmoView.resume();return true; },
      unmount({preserve=true}={}) {
        if(preserve&&benmoView)benmoNavigation=benmoView.snapshotNavigation();
        if(!preserve)benmoNavigation=null;
        benmoView?.dispose();benmoView=null;
        if(benmoContent){benmoContent.hidden=true;benmoContent.inert=false;}
        this.settingsReturn=false;
      },
    },
    workshop: {
      open: openWorkshop,
      settingsReturn: false,
      view: () => workshopView,
      mounted: () => !!workshopController,
      reload(target) {
        if(workshopView?.blocking()){workshopController.rebindTarget(target);workshopView.invalidate('聊天已重新读取，草稿已保留。请重新读取后确认保存');return;}
        return openWorkshop();
      },
      visible: () => !!workshopContainer && !summaryContent.hidden && summaryContent.contains(workshopContainer),
      suspend() { if(this.visible()){summaryContent.hidden=true;summaryContent.inert=true;}workshopView?.suspend(); },
      resume() { if(!workshopView)return false;showAreaContainer(workshopContainer);workshopView.resume();return true; },
      unmount() { workshopView?.dispose();workshopView=null;workshopController?.dispose();workshopController=null;workshopContainer=null;workshopTarget=null;this.settingsReturn=false; },
    },
    time: {
      open: openTime,
      settingsReturn: false,
      view: () => timeView,
      mounted: () => !!timeView,
      reload(target) {
        timeController.rebindTarget(target);timeTarget=target;
        if(this.settingsReturn)returnTarget=target;
        if(timeController.inspect().invalidated)return;
        if(this.settingsReturn)return timeController.ensure();
        return openTime();
      },
      visible: () => !!timeContainer && !summaryContent.hidden && summaryContent.contains(timeContainer),
      suspend() { if(this.visible()){summaryContent.hidden=true;summaryContent.inert=true;}timeController?.suspend(); },
      resume() { if(!timeView)return false;showAreaContainer(timeContainer);timeController.resume();return true; },
      unmount() { timeView?.dispose();timeView=null;timeContainer=null;timeController?.suspend();this.settingsReturn=false; },
    },
  };
  function focusAreaSettings(selector) { (summaryContent.querySelector(selector)??summaryContent.querySelector('.lt-main'))?.focus({preventScroll:true}); }
  function suspendAreasForSettings() {
    for(const page of Object.values(areaPages)){
      const visible=page.visible();
      page.settingsReturn=visible&&!!page.view();
      if(visible)page.suspend();
    }
  }
  function resumeAreaFromSettings(name,policy) {
    const page=areaPages[name];
    if(!page.settingsReturn||!policy[name]||!page.view()||!sameTarget(returnTarget,repository.captureTarget()))return false;
    page.settingsReturn=false;
    void page.open().then(()=>{if(page.visible()&&!settingsOpen&&name!=='benmo')focusAreaSettings(name==='time'?'[data-time-action=settings]':'[data-action=settings]');});
    returnFocus=returnTarget=null;
    return true;
  }
  function showAreaContainer(container) {
    container.setAttribute('data-ui-theme',panel.getAttribute('data-ui-theme')??DEFAULT_THEME);
    summaryContent.replaceChildren(container);summaryContent.hidden=false;summaryContent.inert=false;
  }
  function suspendPages() {
    benmoController?.cancelLoad();
    for(const page of Object.values(areaPages))if(page.view()||page.visible())page.suspend();
    if(benmoContent){benmoContent.hidden=true;benmoContent.inert=true;}
    if(summaryContent){summaryContent.hidden=true;summaryContent.inert=true;}
    unmountCumulative();unmountSummary();unmountRecall();
  }
  const areaVisible=()=>Object.values(areaPages).some(page=>page.visible());
  function unmountAreas() {
    benmoController?.cancelLoad();
    for(const page of Object.values(areaPages))page.unmount();
    unmountCumulative();
  }
  function unmountCumulative(){cumulativeView?.dispose();cumulativeView=null;cumulativeSettingsView?.dispose();cumulativeSettingsView=null;if(cleaningFacade){summarySettingsView?.dispose();summarySettingsView=null;cleaningFacade=null;}}
  function unmountSummary(){summaryView?.dispose();summaryView=null;summarySettingsView?.dispose();summarySettingsView=null;}
  function unmountRecall(){recallView?.dispose();recallView=null;recallController?.suspend();}
  // Async summary entry keeps its old view until the controller is ready, so
  // it uses the two release phases separately. Synchronous area switches use all.
  function unmountPages(){unmountAreas();unmountSummary();unmountRecall();}
  const cumulativeEditing=()=>{const value=runtime?.cumulativeController?.inspect();return memoryType==='cumulative'&&!!(value?.editDraft||value?.restore||value?.busy||value?.reloadInvalidated||cumulativeView&&value?.draft);};
  function ensureAdapter() {
    if (adapter) return;
    adapter = createAdapter({ getContext, fetch: request });
    // Fixed sample messages never change visibility; do not observe the real chat DOM.
    if(diagnosticSample)adapter={...adapter,observeSourceVisibility:()=>()=>{}};
    repository = createRepository(adapter);
    if(typeof adapter.subscribeSourceDeletions==='function'){
      const listeners=new Set();
      sourceDeletionNotices=createManagementNotifications({document:doc,controller:{subscribeNotices(fn){listeners.add(fn);return()=>listeners.delete(fn);}},styles:notificationStyles,openTask:()=>sourceDeletionRuntime?.retry()??false});
      const themedDialog=createSourceDeletionDialog({document:doc,fetch:request,getTheme:()=>appearance.inspect().previewTheme??appearance.inspect().theme});
      const dialog={async show(options){await appearance.ensure();if(options.signal?.aborted)return null;return themedDialog.show(options);},dispose:()=>themedDialog.dispose()};
      sourceDeletionRuntime=createSourceDeletionRuntime({adapter,repository,dialog,onPending:()=>{recallEntryRequest++;recallRuntime?.clear();trackingRuntime?.clear();narrativeRuntime?.clear();},onNotice:(message,retry=false)=>{for(const fn of listeners)fn({id:'lantai-source-deletion-notice',phase:retry?'failed':'complete',action:retry,message});},onCommitted:()=>{recallRuntime?.clear();trackingRuntime?.clear();narrativeRuntime?.clear();void latestRuntime?.refresh().catch(()=>{});void narrativeRuntime?.load().catch(()=>{});if(app&&app.session.state.route!=='editor')void app.refresh();}});
    }
    timeRuntime=createTimeRuntime({adapter,repository,getContext,getControls:()=>controls});
    // Confirmed batch policy controls source hiding independently of recall.
    // ST remains responsible for its subsequent preset/budget assembly.
    unsubscribe = adapter.subscribe(kind => {
      if(interfaceDiagnosticTarget){try{if(!sameTarget(interfaceDiagnosticTarget,repository.captureTarget()))interfaceDiagnostic.stop('chat-change');else if(kind==='reload')interfaceDiagnostic.stage('reload');}catch{interfaceDiagnostic.stop('chat-change');}}
      const sequence=++hostReloadSequence;
      if(controls){controls.invalidate();void controls.ensure().then(()=>{if(disposed||sequence!==hostReloadSequence)return;if(panel)syncControls();requestBenmoWarmup();});}
      if (!panel) return;
      // Only a retained editor needs identity resolution before the changed-chat
      // path. Cold/read-only entries must still begin replacement immediately.
      const timeReload=kind!=='reload'&&timeController?.inspect().draft&&(areaPages.time.visible()||areaPages.time.settingsReturn);
      if ((kind === 'reload'||timeReload) && (app||workshopController||workshopView||benmoView||timeView)) {
        const current=app,visiblePanel=panel,previousTarget=runtime?.cumulativeController?.inspect().target;
        let eventTarget;try{eventTarget=repository.captureTarget();}catch{/* prepare establishes authority */}
        const cumulativeVisible=memoryType==='cumulative'&&settingsContent.hidden&&!!(cumulativeView||!memoryContent.hidden);
        const valid=()=>{try{return !disposed&&panel===visiblePanel&&app===current&&sequence===hostReloadSequence&&!!eventTarget&&sameTarget(eventTarget,repository.captureTarget());}catch{return false;}};
        void adapter.prepare().then(async nextTarget=>{
          if(timeReload){
            if(disposed||panel!==visiblePanel||app!==current||sequence!==hostReloadSequence)return;
            eventTarget=nextTarget;
            if(!valid())return;
            if(timeTarget?.chatId!==nextTarget.chatId||timeTarget?.rootId!==nextTarget.rootId){runtime?.controller.refresh();void open();return;}
          }
          if(!valid()||!sameTarget(nextTarget,eventTarget))return;
          await controls?.ensure();if(!valid())return;
          if(cumulativeVisible&&previousTarget?.chatId===nextTarget.chatId&&previousTarget?.rootId===nextTarget.rootId&&previousTarget.epoch!==nextTarget.epoch){runtime.cumulativeController.invalidateReload({previousTarget,nextTarget,reloadSequence:sequence});}
          // Preserve the existing reload priority, including pending workshop mounts.
          const page=Object.values(areaPages).find(page=>page.visible()||page.settingsReturn);
          if(page)return page.reload(nextTarget,valid);
          return current?.rebind();
        }).catch(error=>{if(valid())errorView(error);});
      } else { runtime?.controller.refresh(); void open(); }
    });
  }
  function close() {
    const child=sampleHost;sampleHost=null;child?.dispose();
    const wasOpen=!!panel;
    interfaceDiagnostic.stop('panel-close');innerScrollSetup.dispose();
    if (closing) return;
    closing = true;
    let cleanupError;
    const cleanup = action => { try { action(); } catch (error) { cleanupError ??= error; } };
    try {
      ticket++;pageRequest++;hostReloadSequence++;openingTicket=null;
      cleanup(()=>benmoController?.cancelLoad());
      settingsRootView?.dispose();settingsRootView=null;settingsOpen=false;
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
      for(const page of Object.values(areaPages)){cleanup(()=>page.unmount({preserve:false}));page.settingsReturn=false;}
      benmoNavigation=null;memoryReadProof=null;cleanup(()=>timeController?.dispose());timeController=null;timeTarget=null;
      const currentApp=app;app=null;cleanup(()=>currentApp?.dispose());
      hiddenFilter.reset();const currentObserver=sharedObserver;sharedObserver=null;sharedStyle=null;snowStyle=null;springStyle=null;
      for (const bundle of bookStylesByTheme.values()) bundle.style=null;
      cleanup(()=>currentObserver?.disconnect());
      cleanup(()=>decoration?.dispose());decoration=null;
    } finally {
      releasePanelDiagnostic?.();releasePanelDiagnostic=null;interfaceCaptureControl?.dispose();interfaceCaptureControl=null;
      const currentPanel=panel;panel=null;content=memoryContent=benmoContent=settingsContent=summaryContent=null;
      cleanup(()=>currentPanel?.remove());cleanup(()=>entry?.focus());closing=false;
      requestBenmoWarmup(false);
    }
    if(diagnosticSample&&wasOpen&&!disposed)onSampleExit?.();
    if(cleanupError)throw cleanupError;
  }
  function resumeSummaryNarrative(action,{summarySource='event'}={}){
    const snapshot=narrativeRuntime.snapshot();
    if(!narrativeRuntime.hasPending())return snapshot;
    if(!snapshot.run?.summary||(snapshot.run.summarySource??'event')!==summarySource)throw new Error('请返回当前批次所属的总结继续');
    return narrativeRuntime[action]();
  }
  function prepareWorkshopRegex(){
    const settled=workshopRegex.ensure({settingsReady:true}).then(
      ()=>{if(workshopPreparation===settled)workshopRegexError=null;},
      error=>{if(workshopPreparation===settled)workshopRegexError=error;});
    workshopPreparation=settled;return settled;
  }
  async function workshopReady(){
    // A re-enable can replace the attempt while a caller is waiting. Only the
    // current settled attempt owns its warning; failure keeps the old fallback.
    let attempt;do{attempt=workshopPreparation;await attempt;}while(attempt!==workshopPreparation);
  }
  async function ensureRuntime() {
    if (!runtimePromise) runtimePromise = new Promise(afterPageFrame).then(()=>disposed||lifetime.signal.aborted?null:createManagementRuntime({ repository, getContext, document: doc, fetchImpl: request, ...runtimeOptions, signal: lifetime.signal,getControls:()=>controls,afterSummaryCommit:args=>narrativeRuntime.afterSummaryCommit(args),retrySummaryCommit:args=>resumeSummaryNarrative('retry',args),skipSummaryCommit:args=>resumeSummaryNarrative('skip',args),getPendingNarrative:async()=>{if(!narrativeRuntime)return null;await narrativeRuntime.load();return narrativeRuntime.hasPending()?narrativeRuntime.snapshot().run:null;},captureSummarySource:(target,range)=>adapter.captureSummarySource(target,range),hideSource:createNativeSummaryHider({repository,getContext,captureSource:target=>adapter.captureSummarySource(target),verifyHidden:(target,rows)=>adapter.verifyNativeHidden(target,rows)}) }))
      .then(async value => { if(!value)return null;if (disposed) { value.dispose(); return null; } runtime = value;
        controls=createControlSession({settings:runtime.settings,repository,prepareTarget:()=>adapter.prepare()});
        await controls.ensure();
        if(disposed){controls.dispose();value.dispose();return null;}
        notices=createManagementNotifications({document:doc,controller:runtime.controller,styles:notificationStyles,openTask});
        summaryNotices=createSummaryNotifications({document:doc,service:runtime.summaryService,styles:notificationStyles,openTask:openSummaryTask});
        timePrompts=createTimePromptRuntime({repository,settings:runtime.settings,getControls:()=>controls,dateRuntime:timeRuntime,getContext,captureSource:target=>adapter.captureTimeSource?.(target)??adapter.captureChatSource?.(target)??adapter.captureSummarySource(target),matchesSource:typeof (adapter.matchesTimeSource??adapter.matchesChatSource)==='function'?(target,source)=>(adapter.matchesTimeSource??adapter.matchesChatSource)(target,source):null});
        // Recall uses visible-source proof, so hide/unhide invalidates an in-flight
        // result even though event summaries may read hidden original story rows.
        recallRuntime=createRecallRuntime({repository,settings:runtime.settings,recallProvider:runtime.recallProvider,getControls:()=>controls,getContext,dateRuntime:timeRuntime,captureEvents:target=>adapter.peekConfirmed(target).events,captureSource:target=>adapter.captureChatSource(target),...(typeof adapter.captureRecallSource==='function'&&typeof adapter.matchesRecallSource==='function'?{captureRecallSource:(target,scope)=>adapter.captureRecallSource(target,scope),matchesRecallSource:(target,source)=>adapter.matchesRecallSource(target,source)}:{})});
        if(runtime.settings?.captureWorkshop)workshopRegex=createWorkshopRegexInstaller({settings:runtime.settings,getContext,fetchImpl:request,...runtimeOptions.workshopRegexOptions,isCurrent:()=>!disposed&&!lifetime.signal.aborted&&allowed('workshop')});
        if(workshopRegex&&allowed('workshop'))void prepareWorkshopRegex();
        if(disposed){value.dispose();return null;}
        if(runtime.settings?.captureWorkshop)workshopRuntime=createWorkshopRuntime({repository,settings:runtime.settings,getControls:()=>controls,getContext,ensureReady:workshopReady,captureSource:t=>adapter.captureChatSource(t),matchesSource:(t,s)=>adapter.matchesChatSource(t,s),isSourceDeletionPending:()=>sourceDeletionRuntime?.hasPendingRollback()===true});
        trackingRuntime=createTrackingRuntime({repository,adapter,settings:runtime.settings,getContext,getControls:()=>controls,captureSource:t=>latestRuntime.captureSource(t),onChange:()=>{void latestRuntime.refresh().catch(()=>{});}});
        scheduleRuntime=createScheduleRuntime({repository,settings:runtime.settings,dateRuntime:timeRuntime,getControls:()=>controls,captureSource:t=>latestRuntime.captureSource(t)});
        latestRuntime=createLatestSummaryRuntime({repository,adapter,settings:runtime.settings,provider:runtime.provider,getGenerationSettings:(group='latest')=>runtime.getGenerationSettings(group),getContext,getControls:()=>controls,workshopRuntime,trackingRuntime,scheduleRuntime,isSourceDeletionPending:()=>sourceDeletionRuntime?.hasPendingRollback()===true,autoInitialize:false});
        narrativeRuntime=createNarrativeRuntime({repository,adapter,manager:runtime.manager,getSummaryActive:()=>runtime.summaryService.isBusy()||runtime.cumulativeService?.isBusy(),settings:runtime.settings,provider:runtime.provider,getGenerationSettings:()=>runtime.getGenerationSettings('narrative'),getContext,getControls:()=>controls,captureSource:t=>(adapter.captureNarrativeSource??adapter.captureSummarySource).call(adapter,t)});
        const summaryNarrativeActions={event:createSummaryNarrativeActions({runtime:narrativeRuntime,service:runtime.summaryService,runner:runtime.summaryController.runner}),cumulative:createSummaryNarrativeActions({runtime:narrativeRuntime,service:runtime.cumulativeService,runner:runtime.cumulativeRunner})};
        const narrativeActions=Object.fromEntries(['retry','resume','skip','pause'].map(action=>[action,()=>summaryNarrativeActions[narrativeRuntime.snapshot().run?.summarySource==='cumulative'?'cumulative':'event'][action]()]));
        benmoController=createBenmoController({latestRuntime,trackingRuntime,narrativeRuntime:{...narrativeRuntime,...narrativeActions},repository,adapter,getContext,getControls:()=>controls,isReadOnly:()=>foregroundBrowsing});
        benmoSubscription=benmoController.subscribeAvailability(syncBenmoAvailability);
        if(!diagnosticSample){
        const displayCoordinator=createFloorDisplayCoordinator({document:doc,runtime:latestRuntime,MutationObserver:Observer,formatter:createWorkshopDisplayFormatter({getContext})});
        latestDisplay=mountLatestSummaryDisplay({document:doc,runtime:latestRuntime,MutationObserver:Observer,coordinator:displayCoordinator});
        workshopBackgroundDisplay=mountWorkshopBackgroundDisplay({document:doc,runtime:latestRuntime,MutationObserver:Observer,coordinator:displayCoordinator,onOpenSchedule:()=>void openSchedule()});
        }
        cumulativeRuntime=createCumulativeRuntime({repository,settings:runtime.settings,getContext});
        const seen=new Set();
        const noticeController={subscribeNotices(listener){return runtime.cumulativeService.subscribe(state=>{
          let phase,message;
          if(state.status==='starting'&&!state.restoreOnly){phase='started';message='已开始总结';}
          if(state.status==='awaiting-user'&&!state.restoreOnly&&(state.snapshot.params.checkBeforeSave||state.origin==='regeneration')){phase='complete';message='总结完成，请检查后采用';}
          if(state.status==='succeeded'){phase='complete';message='本批总结已保存';}
    if(state.hiding?.status==='failed'){phase='hide-failed';message=state.hiding.message;}
          if(['failed','stale','cancelled'].includes(state.status)&&state.outcome!=='discarded'&&state.reviewResolution!=='discarded'&&!state.outcome?.startsWith('recovered-')){phase='failed';message=state.receipt?.status==='committed'?'记忆已保存；后续处理未完成，请检查酒馆隐藏状态':state.outcome==='unconfirmed'?'总结保存待确认':'总结未完成，请查看';}
          const key=JSON.stringify([state.taskId,state.attempt,phase]);if(!phase||seen.has(key))return;seen.add(key);
          // Mounted C1 pages own their own feedback; the background owner survives close.
          const pageOwnsFeedback=panel&&(!summaryContent.hidden&&cumulativeView||!memoryContent.hidden&&app?.memoryType()==='cumulative');
          if(pageOwnsFeedback&&sameTarget(state.target,repository.captureTarget())&&(phase==='started'||runtime.cumulativeController.inspect().taskId===state.taskId))return;
          listener({taskId:state.taskId,phase,message,id:'lantai-cumulative-notice'});
        });}};
        cumulativeNotices=createManagementNotifications({document:doc,controller:noticeController,styles:notificationStyles,openTask:openCumulativeTask});
        controlSubscription=controls.subscribe(syncControls);syncControls();
        // Service readiness owns subscriptions and background displays. Record
        // readiness belongs to Benmo and must not hold up the main memory page.
        requestBenmoWarmup();
        return value; });
    return runtimePromise;
  }
  function requestBenmoWarmup(requested=true){
    if(requested)benmoWarmupRequested=true;
    if(disposed||!benmoController||openingTicket!==null||benmoWarmupScheduled||!benmoWarmupRequested)return;
    benmoWarmupScheduled=true;
    afterPageFrame(()=>{
      benmoWarmupScheduled=false;
      if(disposed||openingTicket!==null||!benmoWarmupRequested)return;
      benmoWarmupRequested=false;
      // ensure joins in-flight reads and retains an unconfirmed/error state on
      // failure. The real Benmo entry still awaits it and exposes local retry.
      void benmoController.ensure().catch(()=>{});
    });
  }
  function syncControls(){
    const next=availability(),before=previousPolicy;previousPolicy=next;
    if(!next.event){runtime.summaryController?.stop();recallRuntime?.clear();}
    if(!next.cumulative)runtime.cumulativeRunner?.stop();
    cancelDisabledManagedTasks(runtime,next);
    if(before&&!before.event&&next.event)runtime.summaryService?.resumeAutoConfirm();
    if(before&&!before.cumulative&&next.cumulative)runtime.cumulativeService?.resumeAutoConfirm();
    cumulativeRuntime?.setEnabled(next.cumulative);latestRuntime?.setEnabled(next.enabled);
    if(!next.enabled)trackingRuntime?.clear();
    if(!before||['enabled','item','npc'].some(key=>before[key]!==next[key]))trackingRuntime?.controlsChanged?.();
    if(!before||['enabled','time','schedule'].some(key=>before[key]!==next[key]))scheduleRuntime?.controlsChanged?.();
    if(!before||['enabled','self','outline'].some(key=>before[key]!==next[key]))narrativeRuntime?.controlsChanged?.();
    benmoController?.refreshAvailability();
    if(!next.time){timeRuntime?.pause();timePrompts?.clear();}
    if(before&&before.time!==next.time)recallRuntime?.clear();
    if(before&&!before.workshop&&next.workshop&&workshopRegex)void prepareWorkshopRegex();
    if(!before||['prompt','collect','sync'].some(key=>before[key]!==next[key]))workshopRuntime?.clear();
  }
  async function openTask(taskId){
    if(!allowed('event'))return false;
    if(disposed||settingsOpen||areaVisible()||cumulativeEditing())return false;
    if(panel)return app?.showManagementTask(taskId)??false;
    if(!runtime?.controller.resume(taskId))return false;
    await open();return !!app?.isManagementTask(taskId);
  }
  async function openSummaryTask(taskId) {
    if(!allowed('event'))return false;
    if(disposed||settingsOpen||areaVisible()||summarySettingsView||cumulativeSettingsView||cumulativeEditing())return false;
    if(panel&&summaryContent.hidden){const active=panel.shadowRoot.activeElement;if(app?.session.state.route==='editor'||active?.matches('input,textarea,select')||panel.shadowRoot.querySelector('[data-composing=true]'))return false;}
    unmountCumulative();if(app?.memoryType()==='cumulative')app.suspendCumulative();
    const task=runtime?.summaryService.inspect(taskId);if(!task||!sameTarget(task.target,repository.captureTarget()))return false;
    if(!panel)await open();
    if(!panel||!runtime.summaryController.showTask(taskId))return false;
    memoryContent.hidden=true;memoryContent.inert=true;summaryContent.hidden=false;summaryView?.dispose();
    if(app?.memoryType()==='cumulative')app.suspendCumulative();
    areaPages.workshop.unmount();summaryView=mountSummaryView({container:summaryContent,controller:runtime.summaryController,onBack:()=>void returnFromSummary(),onClose:close,openSettings:()=>void openSummarySettings(false)});return true;
  }
  function memoryStream() {
    const context=getContext(),processor=context?.streamingProcessor;
    return JSON.stringify([(context.chat??[]).map(row=>[row?.gen_started??null,row?.gen_finished??null]),processor?[processor.messageId,processor.isFinished,processor.isStopped,!!processor.abortController?.signal?.aborted,processor.toolCalls?.length??0]:null]);
  }
  function captureMemoryRead() {
    try{const target=repository.captureTarget();if(!adapter.captureReadToken||!latestRuntime?.captureSource)return null;return {target,root:adapter.captureReadToken(target),source:latestRuntime.captureSource(target),stream:memoryStream()};}catch{return null;}
  }
  function matchesMemoryRead(proof) {
    try{return !!proof&&sameTarget(proof.target,repository.captureTarget())&&adapter.matchesReadToken(proof.target,proof.root)&&latestRuntime.matchesSource(proof.target,proof.source)&&proof.stream===memoryStream();}catch{return false;}
  }
  async function returnFromSummary() {
    interfaceDiagnostic.stage('requested','memory');
    pageRequest++;const diagnosticRequest=pageRequest;suspendPages();
    if(!panel)return;
    if(!allowed('memory')){if(allowed('time'))return openTime();if(allowed('workshop'))return openWorkshop();if(allowed('benmo'))return openBenmo();openSettings();return;}
    summaryContent.replaceChildren();summaryContent.hidden=true;summaryContent.inert=false;memoryContent.hidden=false;memoryContent.inert=false;
    interfaceDiagnostic.stage('shown','memory');
    if(!app)return open();
    await app.refreshAvailability();
    if(!matchesMemoryRead(memoryReadProof)){const proof=captureMemoryRead();await app.rebind();memoryReadProof=matchesMemoryRead(proof)?proof:null;}
    if(!panel)return;if(app?.memoryType()==='cumulative')app.resumeCumulative();
    if(app?.session.state.route==='editor'&&app.session.state.draft?.id&&!app.session.state.root.events.some(event=>event.id===app.session.state.draft.id))await app.refresh();
    if(panel&&diagnosticRequest===pageRequest&&!memoryContent.hidden)interfaceDiagnostic.stage('ready','memory');
    const previous=summaryReturnFocus;
    (previous?.isConnected&&memoryContent.contains(previous)&&!previous.closest('[hidden],[inert]')?previous:memoryContent.querySelector('[data-action=summary-manual]')??memoryContent.querySelector('.lt-main'))?.focus({preventScroll:true});
  }
  async function showSummary(origin='manual',batchId=null) {
    if(!allowed('event'))return false;
    if(!runtime?.summaryController||!panel||settingsOpen)return false;unmountAreas();
    if(summaryContent.hidden)summaryReturnFocus=batchId&&memoryEditFocus?.isConnected&&memoryContent.contains(memoryEditFocus)?memoryEditFocus:panel.shadowRoot.activeElement;
    const target=repository.captureTarget(),serial=ticket,request=++pageRequest;
    const ready=await runtime.summaryController.open(origin);
    if(!ready||!panel||serial!==ticket||request!==pageRequest||!sameTarget(target,repository.captureTarget()))return false;
    memoryContent.hidden=true;memoryContent.inert=true;summaryContent.hidden=false;
    unmountRecall();
    summarySettingsView?.dispose();summarySettingsView=null;summaryView?.dispose();
    summaryView=mountSummaryView({container:summaryContent,controller:runtime.summaryController,onBack:()=>void returnFromSummary(),onClose:close,openSettings:()=>void openSummarySettings(false)});
    if(batchId)await runtime.summaryController.regenerate(batchId);
    (summaryContent.querySelector('.lt-main'))?.focus({preventScroll:true});return true;
  }
  function syncBenmoAvailability(){
    const next=availability(),key=JSON.stringify([next.enabled,next.summary,next.item,next.npc,next.self,next.outline,next.benmo,next.transient]);
    if(key===benmoPolicyKey)return;benmoPolicyKey=key;
    // Runtime publications can originate from shared tasks. Only update UI here;
    // calling setEnabled or loading from this subscription would recurse.
    settingsRootView?.refreshAvailability?.();
    if(!panel)return;
    if(!settingsOpen&&areaPages.benmo.visible()&&!next.benmo&&!next.transient&&benmoController?.availability().status==='ready'){openSettings();return;}
    if(!next.transient)benmoView?.refreshAvailability?.();
    if(app&&!memoryContent.hidden)void app.refreshAvailability();
    if(areaPages.time.visible())timeView?.refresh?.();
    if(areaPages.workshop.visible())workshopView?.refreshAvailability?.();
  }
  function showVisibilitySample(area){
    if(!visibilitySample||!visibilitySampleReady||disposed||!panel||visibilitySampleArea===area)return false;
    if(workshopView?.failed()||benmoView?.failed()){visibilitySampleReady=false;interfaceDiagnostic.stop('failed');return false;}
    interfaceDiagnostic.stage('requested',area);
    const workshop=area==='workshop',owned=filterHidden?hiddenFilter.begin():null;let synchronized=false;
    try{
      if(owned)hiddenFilter.write(owned,summaryContent,!workshop);else summaryContent.hidden=!workshop;
      summaryContent.inert=!workshop;workshopContainer.inert=!workshop;
      if(owned)hiddenFilter.write(owned,benmoContent,workshop);else benmoContent.hidden=workshop;
      benmoContent.inert=workshop;
      const benmoMount=benmoContent.querySelector('.benmo-mount');benmoMount.inert=workshop;
      visibilitySampleArea=area;
      interfaceDiagnostic.stage('shown',area);syncAppearance();synchronized=!!panel&&!!sharedStyle;interfaceDiagnostic.stage('held',area);
      return true;
    }finally{if(owned)hiddenFilter.finish(owned,synchronized);}
  }
  async function openBenmo({kind}={}){
    if(!allowed('benmo')||!benmoController||!panel||settingsOpen)return false;
    interfaceDiagnostic.stage('requested','benmo');
    const target=repository.captureTarget(),serial=ticket,request=++pageRequest;
    const valid=()=>!!panel&&serial===ticket&&request===pageRequest&&!settingsOpen&&sameTarget(target,repository.captureTarget());
    if(benmoTarget&&!sameTarget(benmoTarget,target))areaPages.benmo.unmount({preserve:false});
    const previous=benmoView?.snapshotNavigation()??benmoNavigation;
    const initialState=kind?{...(previous??{}),tab:'records',kind,route:'list'}:previous;
    suspendPages();app?.suspendCumulative();
    memoryContent.hidden=true;memoryContent.inert=true;summaryContent.hidden=true;summaryContent.inert=false;benmoContent.hidden=false;benmoContent.inert=false;
    benmoTarget=target;
    if(benmoView){
      const view=benmoView,held=diagnosticSample&&diagnosticSimpleMain&&diagnosticSkipWarm&&!view.failed();
      view.resume(undefined,{kind,checking:true});interfaceDiagnostic.stage('shown','benmo');
      if(held){if(!valid()||view!==benmoView)return false;syncAppearance();interfaceDiagnostic.stage('held','benmo');return true;}
      try{const value=await benmoController.ensure();if(!valid()||view!==benmoView)return false;view.resume(value);syncAppearance();interfaceDiagnostic.stage('ready','benmo');return true;}
      catch(error){if(valid()&&view===benmoView){view.resume();view.fail(error);if(diagnosticSample)interfaceDiagnostic.stop('failed');}return false;}
    }
    const container=doc.createElement('div');container.className='benmo-mount';container.setAttribute('data-ui-theme',panel.getAttribute('data-ui-theme')??DEFAULT_THEME);benmoContent.replaceChildren(container);
    const prepare=async({refresh=false}={})=>{
      if(refresh||benmoController.availability().dataStatus!=='ready')await new Promise(afterPageFrame);
      if(refresh?(!panel||settingsOpen||!benmoContent.contains(container)||benmoContent.hidden||!sameTarget(target,repository.captureTarget())):!valid())return null;
      return refresh?benmoController.load():benmoController.ensure();
    };
    const view=await mountBenmoView({container,diagnosticSimpleMain:diagnosticSample&&diagnosticSimpleMain,diagnosticInnerScroll:innerScroll&&!visibilitySample,onDiagnosticSurfaceRendered:surface=>{if(innerScroll&&!visibilitySample)innerScrollSetup.apply(surface);},controller:benmoController,availability,isCurrent:valid,prepare,initialState:initialState??{},onClose:close,onOpenCleaning:openNarrativeCleaning,onNavigate:(area,snapshot)=>{
      benmoNavigation=snapshot;
      if(area==='settings'){openSettings();return;}
      if(area==='memory')void returnFromSummary();else if(area==='time')void openTime();else if(area==='workshop')void openWorkshop();
    }});
    if(!view||!valid()){view?.dispose();return false;}
    benmoView=view;syncAppearance();if(diagnosticSample&&view.failed())interfaceDiagnostic.stop('failed');else interfaceDiagnostic.stage('ready','benmo');return !view.failed();
  }
  const openLatestSummary=()=>openBenmo({kind:'summary'});
  function narrativeSettingsAccess(target){
    let readView;
    return {
      snapshot:()=>narrativeRuntime.snapshot(),
      subscribe:listener=>narrativeRuntime.subscribe(listener),
      savePreferences:(kind,patch)=>narrativeRuntime.savePreferences(kind,patch),
      async readRoot(){
        readView=await repository.capturePanelData(target);
        return readView?repository.readPanelRoot(target,readView):repository.read(target);
      },
      async load({refresh=false}={}){
        const snapshot=narrativeRuntime.snapshot();
        if(!refresh&&sameTarget(snapshot.target,target)){
          if(snapshot.preferencesWriteBlocked)throw Object.assign(new Error('保存结果尚未确认，请重新读取。'),{code:'COMMIT_UNCONFIRMED'});
          return snapshot;
        }
        let view=readView??latestRuntime.panelReadView?.();
        if(!repository.matchesPanelData(target,view))view=await repository.capturePanelData(target);
        return narrativeRuntime.load({target,readView:view});
      },
    };
  }
  async function openSummarySettings(fromMemory=true) {
    if(!allowed('event'))return false;
    if(!runtime?.settings||!panel||settingsOpen)return;unmountAreas();if(app?.memoryType()==='cumulative')app.suspendCumulative();
    if(summaryContent.hidden)summaryReturnFocus=panel.shadowRoot.activeElement;
    const target=repository.captureTarget(),serial=ticket,request=++pageRequest;
    if(!summarySettingsController||!sameTarget(target,summarySettingsTarget)) {
      summarySettingsController?.dispose();summarySettingsTarget=target;
      const current=()=>sameTarget(target,repository.captureTarget());
      const narrativeSettings=narrativeSettingsAccess(target);
      const read=async()=>summaryOf(await narrativeSettings.readRoot()).excludedFloors;
      const change=async(floor,remove)=>{const capture=await repository.captureSummary(target),records=structuredClone(capture.summary.excludedFloors);if(remove){const index=records.findIndex(item=>item.floor===Number(floor));if(index>=0)records.splice(index,1);}else{const message=adapter.captureSummarySource(target).messages.find(item=>item.floor===Number(floor));if(!message)throw new Error('楼层不存在');if(!records.some(item=>item.floor===message.floor))records.push({floor:message.floor,identity:message.identity});}await repository.setSummaryExcludedFloors(target,records,{expectedSummaryRevision:capture.summary.revision,isCurrent:current});};
      summarySettingsController=createSummarySettingsController({settings:runtime.settings,getControls:()=>controls,narrativeRuntime:narrativeSettings,exclusions:{read,add:floor=>change(floor,false),remove:floor=>change(floor,true)},isCurrent:current,onBack:()=>{if(summarySettingsFromMemory)void returnFromSummary();else void showSummary(runtime.summaryController.inspect().origin);},onClose:close});
    }
    if(!panel||serial!==ticket||!sameTarget(target,repository.captureTarget()))return;
    summarySettingsFromMemory=fromMemory;summaryView?.dispose();summaryView=null;summarySettingsView?.dispose();
    unmountRecall();
    memoryContent.hidden=true;memoryContent.inert=true;summaryContent.hidden=false;
    summarySettingsView=mountSummarySettingsView(summaryContent,summarySettingsController,{readonlyContent:summaryReadonlyContent});
    const controller=summarySettingsController;
    afterPageFrame(()=>{
      if(panel&&serial===ticket&&request===pageRequest&&summarySettingsController===controller&&sameTarget(target,repository.captureTarget()))void controller.init();
    });
  }
  // Give the existing locked surface a rendering opportunity before heavy work.
  function afterPageFrame(work){const frame=doc.defaultView?.requestAnimationFrame;if(frame&&doc.visibilityState!=='hidden')frame.call(doc.defaultView,()=>setTimeout(work,0));else setTimeout(work,0);}
  async function openRecall() {
    if(!allowed('event'))return false;
    if(!panel||settingsOpen||!recallRuntime)return false;unmountAreas();if(app?.memoryType()==='cumulative')app.suspendCumulative();
    const target=repository.captureTarget(),serial=ticket,request=++pageRequest;
    if(summaryContent.hidden)summaryReturnFocus=panel.shadowRoot.activeElement;
    if(!recallController||!sameTarget(target,recallTarget)) {
      recallController?.dispose();recallTarget=target;
      recallController=createRecallController({repository,settings:runtime.settings,runtime:recallRuntime,onBack:()=>void returnFromSummary(),onClose:close});
    }
    if(!panel||serial!==ticket||!sameTarget(target,repository.captureTarget()))return false;
    unmountSummary();recallView?.dispose();
    memoryContent.hidden=true;memoryContent.inert=true;summaryContent.hidden=false;
    recallController.resume();
      recallController.route('monitor');recallController.tab('actual');
    recallView=mountRecallView({container:summaryContent,controller:recallController});
    const controller=recallController;
    afterPageFrame(()=>{
      if(panel&&serial===ticket&&request===pageRequest&&recallController===controller&&sameTarget(target,repository.captureTarget()))void controller.init();
    });return true;
  }
  async function openTime({allowReadOnly=false,route=null,candidates=false}={}){
    if(!allowed('time')&&!(allowReadOnly&&allowed('enabled')))return false;
    if(!panel||settingsOpen||!runtime?.settings)return false;
    interfaceDiagnostic.stage('requested','time');
    const target=repository.captureTarget(),serial=ticket,request=++pageRequest;
    suspendPages();app?.suspendCumulative();
    if(timeController&&timeTarget?.chatId===target.chatId&&timeTarget?.rootId===target.rootId&&!sameTarget(timeTarget,target)){timeController.rebindTarget(target);timeTarget=target;}
    if(!timeController||!sameTarget(timeTarget,target)){
      areaPages.time.unmount();timeController?.dispose();timeTarget=target;
      timeController=createTimeController({repository,settings:runtime.settings,dateRuntime:timeRuntime,captureSource:t=>adapter.captureTimeSource?.(t)??adapter.captureChatSource?.(t)??adapter.captureSummarySource(t),matchesSource:typeof (adapter.matchesTimeSource??adapter.matchesChatSource)==='function'?(t,s)=>(adapter.matchesTimeSource??adapter.matchesChatSource)(t,s):null,onMemory:()=>void returnFromSummary(),onWorkshop:()=>void openWorkshop(),onBenmo:()=>void openBenmo(),onSettings:openSettings,onClose:close});
    }
    memoryContent.hidden=true;memoryContent.inert=true;
    if(!timeContainer){timeContainer=doc.createElement('div');timeContainer.className='time-mount lt-host-page';}
    showAreaContainer(timeContainer);timeController.resume();
    if(!timeView)timeView=mountTimeView({container:timeContainer,controller:timeController,availability});
    interfaceDiagnostic.stage('shown','time');
    const controller=timeController,valid=()=>panel&&serial===ticket&&request===pageRequest&&controller===timeController&&sameTarget(target,repository.captureTarget());
    afterPageFrame(()=>{if(valid())void controller.ensure().then(ready=>{if(ready&&valid()){if(candidates)controller.openCandidates();else if(route)controller.open(route);interfaceDiagnostic.stage('ready','time');}});});return true;
  }
  async function openSchedule({candidates=false,fromSettings=false}={}){
    if(disposed||settingsOpen&&!fromSettings)return false;
    if(!panel){const opening=open(),openingTicket=ticket;await opening;if(ticket!==openingTicket)return false;}
    if(!panel||!allowed('enabled'))return false;
    if(settingsOpen){settingsRootView?.dispose();settingsRootView=null;settingsOpen=false;settingsContent.replaceChildren();settingsContent.hidden=true;returnFocus=returnTarget=null;}
    return openTime({allowReadOnly:true,route:'schedules',candidates});
  }
  async function revalidateWorkshop(view,{kind,valid,diagnosticReady=false}){
    const controller=workshopController;
    view.resume(undefined,{kind,checking:true});
    try{const value=await controller.ensure();if(!valid()||view!==workshopView||controller!==workshopController)return false;view.resume(value);syncAppearance();if(diagnosticReady)interfaceDiagnostic.stage('ready','workshop');return true;}
    catch(error){if(valid()&&view===workshopView&&controller===workshopController){view.resume();view.fail(error);if(diagnosticSample)interfaceDiagnostic.stop('failed');}return false;}
  }
  function refreshVisibleWorkshop(){
    if(!allowed('workshop')||!panel||settingsOpen||!runtime?.settings||!workshopView||!areaPages.workshop.visible())return;
    const target=repository.captureTarget(),serial=ticket,request=pageRequest;
    const valid=()=>!!panel&&serial===ticket&&request===pageRequest&&!settingsOpen&&areaPages.workshop.visible()&&sameTarget(target,repository.captureTarget());
    // Availability changed inside this page; retain navigation and its drafts.
    // The same fresh ensure still owns the transition back to writable content.
    return revalidateWorkshop(workshopView,{valid});
  }
  async function openWorkshop({kind}={}){
    if(!allowed('workshop')||!panel||settingsOpen||!runtime?.settings)return false;
    interfaceDiagnostic.stage('requested','workshop');
    const target=repository.captureTarget(),serial=ticket,request=++pageRequest;
    const valid=()=>!!panel&&serial===ticket&&request===pageRequest&&!settingsOpen&&sameTarget(target,repository.captureTarget());
    suspendPages();app?.suspendCumulative();memoryContent.hidden=true;memoryContent.inert=true;
    if(workshopTarget&&!sameTarget(workshopTarget,target))areaPages.workshop.unmount();
    if(workshopView){
      const view=workshopView;showAreaContainer(workshopContainer);interfaceDiagnostic.stage('shown','workshop');
      if(diagnosticSample&&diagnosticSimpleMain&&diagnosticSkipWarm&&!view.failed()){view.resume(undefined,{kind,checking:true});if(!valid()||view!==workshopView)return false;syncAppearance();interfaceDiagnostic.stage('held','workshop');return true;}
      return revalidateWorkshop(view,{kind,valid,diagnosticReady:true});
    }
    // Only an unfinished mount is replaced. A confirmed view owns its drafts.
    workshopController?.dispose();workshopTarget=target;
    const container=doc.createElement('div');container.className='wk-mount';workshopContainer=container;showAreaContainer(container);
    const controller=createWorkshopController({repository,settings:runtime.settings,target,runtime:workshopRuntime,isReadOnly:()=>foregroundBrowsing,getCharacterName:binding=>getContext().characters?.find(c=>c.avatar===binding?.owner)?.name??'当前角色',ensureRegex:async()=>{await workshopReady();if(workshopRegexError)throw workshopRegexError;},onMemory:()=>void returnFromSummary(),onTime:()=>void openTime(),onSettings:openSettings,onBenmo:()=>void openBenmo(),onClose:close});
    workshopController=controller;
    const prepare=async({refresh=false}={})=>{await new Promise(afterPageFrame);if(refresh?(!panel||settingsOpen||!summaryContent.contains(container)||summaryContent.hidden||controller!==workshopController||!sameTarget(target,repository.captureTarget())):!valid())return null;return refresh?controller.load({refresh:true}):controller.ensure();};
    const view=await mountWorkshopView({container,diagnosticSimpleMain:diagnosticSample&&diagnosticSimpleMain,diagnosticInnerScroll:innerScroll&&!visibilitySample,onDiagnosticSurfaceRendered:surface=>{if(innerScroll&&!visibilitySample)innerScrollSetup.apply(surface);},controller,availability,initialKind:kind??'prompt',prepare,isCurrent:valid});
    if(!view||!valid()){view?.dispose();controller.dispose();return false;}
    workshopView=view;syncAppearance();if(diagnosticSample&&view.failed())interfaceDiagnostic.stop('failed');else interfaceDiagnostic.stage('ready','workshop');return !view.failed();
  }
  const openTracking=kind=>['item','npc'].includes(kind)?openBenmo({kind}):Promise.resolve(false);
  async function returnFromSettings(reason) {
    const returnTicket=ticket;
    if(replacingPage)return;
    const policy=availability();
    if(reason!=='close'&&!policy.memory&&!policy.time&&!policy.workshop&&!policy.benmo){mountSettingsRoot();return;}
    settingsRootView?.dispose();settingsRootView=null;settingsOpen=false;
    apiView?.dispose(); apiView = null; apiSession = null;
    if (reason === 'close') { close(); return; }
    settingsContent.replaceChildren(); settingsContent.hidden = true;
    if(Object.hasOwn(areaPages,reason)){
      if(resumeAreaFromSettings(reason,policy))return;
      areaPages[reason].settingsReturn=false;
      returnFocus=returnTarget=null;
      void areaPages[reason].open();return;
    }
    if(reason==='memory'){areaPages.time.settingsReturn=false;returnFocus=returnTarget=null;void returnFromSummary();return;}
    if(areaPages.benmo.settingsReturn){
      if(resumeAreaFromSettings('benmo',policy))return;
      areaPages.benmo.unmount();returnFocus=returnTarget=null;openSettings();return;
    }
    for(const name of Object.keys(areaPages))if(resumeAreaFromSettings(name,policy))return;
    if(!policy.memory){if(policy.time){void openTime();return;}if(policy.workshop){void openWorkshop();return;}if(policy.benmo){void openBenmo();return;}openSettings();return;}
    if(!app){void open();return;}
    areaPages.time.settingsReturn=false;memoryContent.hidden = false; memoryContent.inert = false;
    await app?.refreshAvailability();
    if(!panel||ticket!==returnTicket||settingsOpen)return;
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
  function generationEpoch() { try { return runtime.getGenerationSettings('event').epoch; } catch { return null; } }
  function openSettings() {
    if (settingsOpen || !panel || !runtime) return;
    interfaceDiagnostic.stage('requested','settings');
    settingsOpen=true;
    returnFocus = panel.shadowRoot.activeElement;
    suspendAreasForSettings();
    returnTarget = repository.captureTarget();
    returnEpoch = generationEpoch();
    memoryContent.hidden = true; memoryContent.inert = true; settingsContent.hidden = false;
    if (!runtime.settings) {
      settingsContent.textContent = '当前酒馆设置或密钥引用能力不可用。';
      const back = doc.createElement('button'); back.type = 'button'; back.textContent = '返回原页面';
      back.addEventListener('click', () => returnFromSettings('back')); settingsContent.append(back); back.focus(); return;
    }
    mountSettingsRoot();
    void controls.ensure();
  }
  function mountSettingsRoot(focusAction=null){
    if(!panel||closing||replacingPage)return;
    settingsRootView?.dispose();apiView?.dispose();apiView=null;
    settingsRootView=mountSettingsRootView(settingsContent,{controls,appearance,settings:runtime.settings,availability,focusAction,onGenerationDiagnostic:()=>downloadGenerationDiagnostic(doc),interfaceDiagnostic:{inspect:interfaceDiagnostic.inspect,subscribe:interfaceDiagnostic.subscribe,start:startInterfaceDiagnostic,stop:()=>interfaceDiagnostic.stop('manual'),download:interfaceDiagnostic.download},onSchedule:()=>void openSchedule({candidates:true,fromSettings:true}),onApi:openApiSettings,onTaskApi:openTaskApiSettings,onNavigate:reason=>returnFromSettings(reason),onClose:close});
    syncAppearance();interfaceDiagnostic.stage('shown','settings');
  }
  function openApiSettings(){
    if(!settingsOpen||apiSession||!panel)return;
    settingsRootView?.dispose();settingsRootView=null;
    apiSession=createApiSettingsSession({repository:runtime.settings,operations:runtime.apiOperations,connectionsOnly:true,onExit:reason=>{
      apiView?.dispose();apiView=null;apiSession=null;
      if(closing||replacingPage)return;
      if(reason==='close')close();else mountSettingsRoot('api');
    }});
    apiView=mountApiSettingsView(settingsContent,apiSession);settingsContent.querySelector('[data-api-action=back]')?.focus({preventScroll:true});void apiSession.initialize();
  }

  function openTaskApiSettings(){
    if(!settingsOpen||apiSession||!panel)return;
    settingsRootView?.dispose();settingsRootView=null;
    apiSession=createTaskApiSettingsSession({repository:runtime.settings,operations:runtime.apiOperations,onExit:reason=>{
      apiView?.dispose();apiView=null;apiSession=null;
      if(closing||replacingPage)return;
      if(reason==='close')close();else mountSettingsRoot('task-api');
    }});
    apiView=mountTaskApiSettingsView(settingsContent,apiSession);settingsContent.querySelector('[data-task-api-action=back]')?.focus({preventScroll:true});void apiSession.initialize();
  }

  async function notificationStyles() {
    const css = await styles();
    const theme = appearance.inspect().previewTheme ?? appearance.inspect().theme;
    // Notices live in separate short-lived shadows. Snapshot the current
    // presentation roles without making their business lifecycle theme-aware.
    if (theme === 'spring') return css + '\n' + (await springStyles()).replaceAll(':host([data-ui-theme="spring"])', ':host');
    if (theme === 'snow-ermine') return css + '\n' + (await snowStyles()).replaceAll(':host([data-ui-theme="snow-ermine"])', ':host');
    if (Object.hasOwn(BOOK_THEME_STYLE_ENTRIES,theme)) return css + '\n' + (await bookStyles(theme)).replaceAll(`:host([data-ui-theme="${theme}"])`, ':host');
    return css;
  }
  async function styles() {
    if (!stylePromise) stylePromise = Promise.all(BASE_STYLE_ENTRIES.map(async ({url}) => {
      const response = await request(url);
      if (!response.ok) throw new Error('兰台界面样式未能加载，请关闭后重试');
      return response.text();
    })).then(parts => {baseCss=parts.map(css => css.replace(/:root\b/g, ':host')).join('\n');return baseCss;}).catch(error => { stylePromise = null; throw error; });
    return stylePromise;
  }
  async function openCumulativeTask(taskId){
    if(!allowed('cumulative'))return false;
    if(disposed||settingsOpen||areaVisible()||cumulativeSettingsView||summarySettingsView)return false;
    const task=runtime?.cumulativeService.inspect(taskId);if(!task||!sameTarget(task.target,repository.captureTarget()))return false;
    if(panel){const active=panel.shadowRoot.activeElement,value=runtime.cumulativeController.inspect();if(app?.session.state.route==='editor'||value.editDraft||value.restore||active?.matches('input,textarea,select')||panel.shadowRoot.querySelector('[data-composing=true]'))return false;}
    if(!panel)await open();
    // A notice may never replace another live cumulative review.
    if(runtime.cumulativeController.inspect().taskId!==taskId){if(!['succeeded','failed','stale','cancelled'].includes(task.status))return false;await app?.setMemoryType('cumulative');await runtime.cumulativeController.refresh();return true;}
    return showCumulative(task.origin==='auto'?'auto':'manual');
  }
  async function returnFromCumulative(){
    pageRequest++;unmountAreas();cumulativePage='root';
    if(!panel)return;summaryContent.replaceChildren();summaryContent.hidden=true;summaryContent.inert=false;memoryContent.hidden=false;memoryContent.inert=false;
    await app?.setMemoryType('cumulative');app?.resumeCumulative();
    memoryContent.querySelector('.lt-main')?.focus({preventScroll:true});
  }
  async function showCumulative(origin='manual'){
    if(!allowed('cumulative'))return false;
    if(!panel||settingsOpen||!runtime?.cumulativeController)return false;
    const target=repository.captureTarget(),serial=ticket,request=++pageRequest;
    const opened=await runtime.cumulativeController.open(origin);
    // A frozen reload view may remount its existing draft for explicit readback.
    if(!opened&&!runtime.cumulativeController.inspect().reloadInvalidated||!panel||serial!==ticket||request!==pageRequest||!sameTarget(target,repository.captureTarget()))return false;
    unmountSummary();unmountRecall();unmountCumulative();app?.suspendCumulative();
    memoryType='cumulative';cumulativePage=origin;cumulativePageTarget=target;
    memoryContent.hidden=true;memoryContent.inert=true;summaryContent.hidden=false;
    cumulativeView=mountCumulativeView({container:summaryContent,controller:runtime.cumulativeController,onBack:()=>void returnFromCumulative(),onClose:close,openSettings:()=>void openCumulativeSettings(origin)});
    summaryContent.querySelector('.lt-main')?.focus({preventScroll:true});return true;
  }
  function cumulativeExclusions(target,narrativeSettings=null){
    const current=()=>sameTarget(target,repository.captureTarget());
    const read=async()=>{if(narrativeSettings)return cumulativeOf(await narrativeSettings.readRoot()).excludedFloors;const capture=await repository.captureCumulative(target);return capture.cumulative.excludedFloors;};
    const change=async(floor,remove)=>{const capture=await repository.captureCumulative(target),records=structuredClone(capture.cumulative.excludedFloors);if(remove){const index=records.findIndex(item=>item.floor===floor);if(index>=0)records.splice(index,1);}else{const message=adapter.captureSummarySource(target).messages.find(item=>item.floor===floor);if(!message)throw new Error('楼层不存在');if(!records.some(item=>item.floor===floor))records.push({floor,identity:message.identity});}await repository.setCumulativeExcludedFloors(target,capture,records,{isCurrent:current});};
    return {read,add:floor=>change(floor,false),remove:floor=>change(floor,true)};
  }
  async function openCumulativeSettings(from='root',preserve=false){
    if(!allowed('cumulative'))return false;
    if(!panel||settingsOpen||!runtime?.settings)return false;
    const target=repository.captureTarget(),serial=ticket,request=++pageRequest;
    if(!cumulativeSettingsController||!sameTarget(target,cumulativeSettingsTarget)){
      cumulativeSettingsController?.dispose();cumulativeSettingsTarget=target;
      const narrativeSettings=narrativeSettingsAccess(target);
      cumulativeSettingsController=createCumulativeSettingsController({settings:runtime.settings,getControls:()=>controls,narrativeRuntime:narrativeSettings,exclusions:cumulativeExclusions(target,narrativeSettings),isCurrent:()=>sameTarget(target,repository.captureTarget()),onBack:()=>{if(cumulativeReturnPage==='root')void returnFromCumulative();else void showCumulative(cumulativeReturnPage);},onClose:close,onOpenCleaning:()=>void openCumulativeCleaning()});
    }
    if(!preserve)cumulativeReturnPage=from;
    unmountCumulative();unmountSummary();unmountRecall();app?.suspendCumulative();
    memoryType='cumulative';cumulativePage='settings';cumulativePageTarget=target;
    memoryContent.hidden=true;memoryContent.inert=true;summaryContent.hidden=false;
    cumulativeSettingsView=mountCumulativeSettingsView({container:summaryContent,controller:cumulativeSettingsController});
    afterPageFrame(()=>{if(panel&&serial===ticket&&request===pageRequest&&sameTarget(target,repository.captureTarget()))void cumulativeSettingsController.init();});return true;
  }
  async function openNarrativeCleaning(){
    if(!allowed('benmo')||!panel||settingsOpen||!benmoView||!runtime?.settings)return false;
    const target=repository.captureTarget(),serial=ticket,request=++pageRequest;
    const current=()=>!!panel&&serial===ticket&&sameTarget(target,repository.captureTarget());
    // The Benmo view remains suspended in place, keeping both its settings
    // draft and the generation form underneath it. Cleaning uses the same
    // event-generation summaryCleaning authority as both summary pages.
    const returnToNarrative=()=>{cleaningTarget=null;void openBenmo();};
    cleaningController?.dispose();cleaningTarget=null;
    cleaningController=createSummarySettingsController({settings:runtime.settings,isCurrent:current,onBack:returnToNarrative,onClose:close});
    const controller=cleaningController;await controller.init();
    if(!current()||request!==pageRequest)return false;
    controller.navigate('cleaning');
    suspendPages();
    cleaningFacade={...controller,back(){if(controller.inspect().route==='rule')return controller.back();if(controller.inspect().status==='saving')return false;returnToNarrative();return true;}};
    memoryContent.hidden=true;memoryContent.inert=true;benmoContent.hidden=true;benmoContent.inert=true;summaryContent.hidden=false;summaryContent.inert=false;
    summarySettingsView=mountSummarySettingsView(summaryContent,cleaningFacade,{readonlyContent:summaryReadonlyContent});
    syncAppearance();return true;
  }
  async function openCumulativeCleaning(){
    if(!allowed('cumulative'))return false;
    if(!panel||settingsOpen)return false;const target=repository.captureTarget(),serial=ticket,request=++pageRequest;
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
  async function sharedStyles() {
    if(!sharedStylePromise)sharedStylePromise=Promise.all(SHARED_STYLE_ENTRIES.map(async ({url})=>{const response=await request(url);if(!response.ok)throw new Error('共用界面样式未能加载');return response.text();}))
      .then(parts=>{sharedCssCache=parts.map(css=>css.replace(/:root\b/g,':host')).join('\n');return sharedCssCache;})
      .catch(error=>{sharedStylePromise=null;throw error;});
    return sharedStylePromise;
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
  async function springStyles() {
    if (!springStylePromise) springStylePromise = Promise.all(SPRING_STYLE_ENTRIES.map(async ({url}) => {
      const response = await request(url);
      if (!response.ok) throw new Error();
      return resolveStyleAssets(await response.text(), url).replace(/:root\b/g, ':host');
    })).then(parts => { springCss = parts.join('\n'); return springCss; }).catch(() => {
      springStylePromise = null;
      throw Object.assign(new Error('皮肤资源未能加载'), { code: 'APPEARANCE_STYLE_UNAVAILABLE' });
    });
    return springStylePromise;
  }
  async function bookStyles(theme) {
    // The font has display:swap and owns its own retry. Decoration cannot hold
    // the selected theme, loading shell or business readiness hostage.
    void ensureBookThemeFont(doc,theme);
    let bundle = bookStylesByTheme.get(theme);
    if (!bundle) { bundle = {promise:null,css:null,style:null};bookStylesByTheme.set(theme,bundle); }
    if (!bundle.promise) bundle.promise = Promise.all(BOOK_THEME_STYLE_ENTRIES[theme].map(async ({url}) => {
      const response = await request(url);
      if (!response.ok) throw new Error();
      return resolveStyleAssets(await response.text(),url).replace(/:root\b/g,':host');
    })).then(parts => { bundle.css = parts.join('\n');return bundle.css; }).catch(() => {
      bundle.promise = null;
      throw Object.assign(new Error('皮肤资源未能加载'),{code:'APPEARANCE_STYLE_UNAVAILABLE'});
    });
    return bundle.promise;
  }
  function syncAppearance() {
    if (!panel || !sharedStyle) return;
    const requested = appearance.inspect().previewTheme ?? appearance.inspect().theme;
    const theme = requested === 'spring' && springCss ? 'spring' : requested === 'snow-ermine' && snowCss ? 'snow-ermine' : bookStylesByTheme.get(requested)?.css ? requested : DEFAULT_THEME;
    if(panel.getAttribute('data-ui-theme')!==theme)panel.setAttribute('data-ui-theme', theme);
    applyTheme(content, theme);
    let active = false;
    for (const page of [memoryContent,summaryContent,benmoContent,settingsContent]) {
      const themed = !!page?.querySelector('.lantai');
      // Empty page containers also own the theme before their first child is
      // inserted. Ancestor-scoped supplier rules must match on the first layout.
      if (page && page.getAttribute('data-ui-theme') !== theme) page.setAttribute('data-ui-theme', theme);
      if (themed && !page.hidden) active = true;
    }
    // The extracted candidate retains shared choice/hit-area semantics.
    // Every supported theme uses this same component and touch layer.
    // A section switch must not retire the panel's prepared presentation layer.
    const media='all';if(sharedStyle.media!==media)sharedStyle.media=media;
    if (theme === 'snow-ermine' && !snowStyle) {
      snowStyle = doc.createElement('style'); snowStyle.textContent = snowCss; panel.shadowRoot.append(snowStyle);
    }
    if(snowStyle){const snowMedia=theme==='snow-ermine'?'all':'not all';if(snowStyle.media!==snowMedia)snowStyle.media=snowMedia;}
    if (theme === 'spring' && springCss && !springStyle) {
      springStyle = doc.createElement('style'); springStyle.textContent = springCss; panel.shadowRoot.append(springStyle);
    }
    if(springStyle){const springMedia=theme==='spring'?'all':'not all';if(springStyle.media!==springMedia)springStyle.media=springMedia;}
    for (const [identity,bundle] of bookStylesByTheme) {
      if (theme === identity && bundle.css && !bundle.style) {
        bundle.style = doc.createElement('style');bundle.style.textContent = bundle.css;panel.shadowRoot.append(bundle.style);
      }
      if (bundle.style) { const bookMedia=theme===identity?'all':'not all';if(bundle.style.media!==bookMedia)bundle.style.media=bookMedia; }
    }
    if(innerScroll&&visibilitySampleReady){for(const page of [summaryContent,benmoContent])innerScrollSetup.apply(page?.querySelector('.lantai'));}
    if (active && typeof globalThis.getComputedStyle === 'function') globalThis.UICompactGroupCandidate.sync(panel.shadowRoot);
    const visiblePage=[settingsContent,benmoContent,summaryContent,memoryContent].find(page=>page&&!page.hidden&&page.querySelector('.lantai'));
    const themeReady=theme==='spring'?!!springStyle:theme==='snow-ermine'?!!snowStyle:!!bookStylesByTheme.get(theme)?.style;
    if(themeReady)decoration?.sync(visiblePage?.querySelector('.lantai'));
  }
  function errorView(error) {
    memoryContent.replaceChildren();
    const surface = doc.createElement('section'); surface.className = 'lantai';
    const main = doc.createElement('main'); main.className = 'lt-main lt-stack';
    const message = doc.createElement('p'); message.className = 'lt-error'; message.setAttribute('role', 'alert'); message.textContent = error?.code === 'APPEARANCE_STYLE_UNAVAILABLE' ? '皮肤资源未能加载，请恢复连接后重试。' : '记忆读取失败，请恢复连接后重试。';
    const retry = doc.createElement('button'); retry.type = 'button'; retry.className = 'ui-button ui-button--secondary'; retry.textContent = '重试'; retry.addEventListener('click', () => void open());
    const exit = doc.createElement('button');if(diagnosticSample)exit.setAttribute('data-action','close'); exit.type = 'button'; exit.className = 'ui-button ui-button--tertiary'; exit.textContent = '返回聊天'; exit.addEventListener('click', close);
    main.append(message, retry, exit); surface.append(main); memoryContent.append(surface); retry.focus();
  }
  function installPanelStyles(){
    if(!panel)return;
    const shadow=panel.shadowRoot;
    if(baseCss&&!shadow.querySelector('[data-host-base]')){
      const style=doc.createElement('style');style.setAttribute('data-host-base','');style.textContent=baseCss;shadow.prepend(style);
    }
    if(sharedCssCache&&!sharedStyle){
      sharedStyle=doc.createElement('style');sharedStyle.media='not all';sharedStyle.textContent=sharedCssCache;shadow.append(sharedStyle);
    }
    if(baseCss&&sharedStyle)shadow.querySelector('[data-host-shell]')?.remove();
  }
  async function open() {
    if (disposed) return;
    const child=sampleHost;sampleHost=null;child?.dispose();
    const currentTicket = ++ticket,currentPageRequest=++pageRequest;openingTicket=currentTicket;
    app?.dispose(); app = null;memoryReadProof=null;unmountPages();areaPages.time.settingsReturn=false;
    if(panel){settingsRootView?.dispose();settingsRootView=null;settingsOpen=false;summaryContent.replaceChildren();summaryContent.hidden=true;summaryContent.inert=false;memoryContent.hidden=false;memoryContent.inert=false;apiView?.dispose();apiView=null;const previous=apiSession;apiSession=null;replacingPage=true;try{previous?.exit('back');}finally{replacingPage=false;}settingsContent.replaceChildren();settingsContent.hidden=true;}
    if (!panel) {
      panel = doc.createElement('lantai-benmo-host'); panel.id = 'lantai-benmo-panel';
      if(diagnosticSample)panel.setAttribute('data-lt-transition-sample','fixed-v1');
      panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', '兰台本末');
      const shadow = panel.attachShadow({ mode: 'open' });
      releasePanelDiagnostic=diagnosticSample?null:bindGenerationDiagnosticPanel(shadow);
      if(diagnosticSample){
        const guard=event=>{
          if(event.target?.closest?.('[data-interface-capture]'))return;
          const control=event.target?.closest?.('button,a,input,select,textarea,summary');
          if(visibilitySample&&control?.dataset?.action!=='close'){
            event.preventDefault();event.stopImmediatePropagation?.();event.stopPropagation();
            if(event.type==='click'&&control?.tagName==='BUTTON'&&control.closest?.('.lt-footer')){
              const area=control.dataset?.action==='benmo'?'benmo':control.dataset?.action==='area'&&control.dataset?.id==='workshop'?'workshop':null;
              if(area)showVisibilitySample(area);
            }
            return;
          }
          if(event.type==='click'&&control?.tagName==='BUTTON'&&(['workshop','benmo','home','close'].includes(control.dataset?.action)||control.dataset?.action==='area'&&['workshop','benmo'].includes(control.dataset?.id)))return;
          if(control||event.type==='submit'){event.preventDefault();event.stopImmediatePropagation?.();event.stopPropagation();}
        };
        shadow.addEventListener('click',guard,true);shadow.addEventListener('submit',guard,true);
      }
      const shellStyle=doc.createElement('style');shellStyle.setAttribute('data-host-shell','');shellStyle.textContent=MEMORY_SHELL_CSS;shadow.prepend(shellStyle);
      let composing = false;
      shadow.addEventListener('compositionstart', () => { composing = true; });
      shadow.addEventListener('compositionend', () => { composing = false; });
      // Shadow DOM retargets input events to this host outside the panel.
      // Keep keyboard shortcuts inside Lantai without cancelling native editing
      // or child handlers (caret movement, selection, IME, Enter, Tab, Escape).
      const isolatePanelKeyboard = event => event.stopPropagation();
      for (const type of ['keydown', 'keypress', 'keyup']) panel.addEventListener(type, isolatePanelKeyboard);
      panel.addEventListener('keydown', event => {
        if (disposed || event.currentTarget!==panel || !settingsContent || !summaryContent || event.defaultPrevented || event.isComposing || composing || shadow.querySelector('[data-composing=true]')) return;
        if(diagnosticSample&&event.key==='Escape'){event.preventDefault();close();return;}
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!settingsContent.hidden) apiSession?apiSession.exit('back'):settingsRootView?.back()||returnFromSettings('back'); else if(benmoView&&!benmoContent.hidden){benmoView.back();}else if(!summaryContent.hidden){if(areaPages.workshop.visible()){if(workshopView)workshopView.back();else void returnFromSummary();}else if(areaPages.time.visible())timeController.back();else if(cleaningFacade)cleaningFacade.back();else if(cumulativeSettingsView)cumulativeSettingsController.back();else if(cumulativeView)void runtime.cumulativeController.back().then(back=>{if(back)void returnFromCumulative();});else if(recallView)recallController.back();else if(summarySettingsView)summarySettingsController.back();else void runtime.summaryController.back().then(back=>{if(back)void returnFromSummary();});}else close(); return; }
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
      benmoContent=doc.createElement('div');benmoContent.className='lt-host-page';benmoContent.hidden=true;
      content.append(memoryContent, settingsContent,summaryContent,benmoContent);
      decoration=createPersistentDecoration({container:content});
      shadow.append(content); doc.body.append(panel);
      if(mainClip){const style=doc.createElement('style');style.setAttribute('data-transition-main-clip','');style.textContent='#lt-host-content .wk-mount > .lantai > .lt-main,#lt-host-content .benmo-mount > .lantai > .lt-main{overflow:clip!important;}';shadow.append(style);}
      interfaceCaptureControl=mountUITransitionCaptureControl(shadow,{diagnostic:interfaceDiagnostic,start:startInterfaceDiagnostic,onSample:diagnosticSample?null:()=>openTransitionSample(),onSimpleSample:diagnosticSample?null:()=>openTransitionSample({simpleMain:true}),onHeldSample:diagnosticSample?null:()=>openTransitionSample({simpleMain:true,skipWarm:true}),onVisibilitySample:diagnosticSample?null:()=>openTransitionSample({simpleMain:true,visibilityOnly:true}),onNormalNoScrollSample:diagnosticSample?null:()=>openTransitionSample({simpleMain:true,mainClip:true}),onUnfilteredNoScrollSample:diagnosticSample?null:()=>openTransitionSample({simpleMain:true,visibilityOnly:true,filterHidden:false,mainClip:true}),onUnfilteredInnerSample:diagnosticSample?null:()=>openTransitionSample({simpleMain:true,visibilityOnly:true,filterHidden:false,mainClip:true,innerScroll:true}),onNormalInnerSample:diagnosticSample?null:()=>openTransitionSample({simpleMain:true,mainClip:true,innerScroll:true}),onInnerScrollSample:diagnosticSample?null:()=>openTransitionSample({simpleMain:true,visibilityOnly:true,filterHidden:true,mainClip:true,innerScroll:true}),onNoScrollSample:diagnosticSample?null:()=>openTransitionSample({simpleMain:true,visibilityOnly:true,filterHidden:true,mainClip:true}),onFilteredSample:diagnosticSample?null:()=>openTransitionSample({simpleMain:true,visibilityOnly:true,filterHidden:true}),sampleMode:diagnosticSample,sampleContent:diagnosticSimpleMain?'simplified':'original',sampleObserverMode:filterHidden?'owned-hidden-filter':'normal',sampleMainScrollMode:innerScroll?'inner':mainClip?'clip':'normal',sampleWarmMode:visibilitySample?'visibility-only':diagnosticSample&&diagnosticSimpleMain&&diagnosticSkipWarm?'skip-warm-revalidation':'normal'});
    }
    mountWorkshopLoading(memoryContent,{titleText:'兰台本末',messageText:'正在准备兰台…',onBack:close,onClose:close,onRetry:()=>void open()});
    installPanelStyles();syncAppearance();
    const visiblePanel=panel,valid=()=>!disposed&&currentTicket===ticket&&panel===visiblePanel;
    try {
      // A promise/microtask yield cannot expose the shell before synchronous
      // host preparation. Continue only in a task after a rendering opportunity.
      await new Promise(afterPageFrame);
      if(!valid())return;
      const appearanceReady=appearance.ensure();
      await Promise.all([styles(),sharedStyles()]);
      if(!valid())return;
      installPanelStyles();syncAppearance();
      await appearanceReady;
      if(!valid())return;
      // A failed settings read still uses the real default theme. Do not mount
      // business pages with Spring attributes before its stylesheet is ready.
      if (appearance.inspect().theme === DEFAULT_THEME && !springCss) await springStyles();
      if (!valid()) return;
      // Seed the presentation owner before any view creates its first root.
      syncAppearance();
      if(!sharedObserver&&Observer){
        const observedPanel=panel,currentObserver=new Observer(records=>{
          if(filterHidden&&(sharedObserver!==currentObserver||panel!==observedPanel))return;
          if(!visibilitySample){if(!(diagnosticSample&&mainClip&&!innerScroll)){if(records.some(record=>!record.target.closest?.('[data-host-decoration]')))syncAppearance();return;}const relevant=records.filter(record=>!record.target.closest?.('[data-host-decoration]'));if(relevant.length){syncAppearance();interfaceDiagnostic.observerBatch('delivered',relevant.length);}return;}
          const relevant=records.filter(record=>!record.target.closest?.('[data-host-decoration]'));
          if(!relevant.length)return;
          const skipped=filterHidden&&visibilitySampleReady&&hiddenFilter.matches(relevant);
          if(!skipped)syncAppearance();
          if(visibilitySample)interfaceDiagnostic.observerBatch(skipped?'skipped':'delivered',relevant.length);
        });sharedObserver=currentObserver;
        sharedObserver.observe(content,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','class','data-ui-theme'],...(filterHidden?{attributeOldValue:true}:{})});
      }
      ensureAdapter();
      await adapter.prepare();
      if (!valid()) return;
      await ensureRuntime();
      if (!valid()) return;
      await controls.ensure();
      if(!valid())return;
      if(diagnosticSample){
        visibilitySampleReady=false;visibilitySampleArea=null;
        startInterfaceDiagnostic();const workshopReady=await openWorkshop();if(!workshopReady)interfaceDiagnostic.stop('failed');
        if(visibilitySample&&workshopReady){
          const benmoReady=await openBenmo();
          if(!panel||disposed)return;
          if(benmoReady&&!workshopView?.failed()&&!benmoView?.failed()){
            // One-time preparation only. Measured footer clicks never resume either view.
            workshopView.resume(undefined,{checking:true});benmoView.resume(undefined,{checking:true});
            workshopContainer.inert=true;benmoContent.querySelector('.benmo-mount').inert=false;
            visibilitySampleReady=true;visibilitySampleArea='benmo';
          }else interfaceDiagnostic.stop('failed');
        }
        syncAppearance();return;
      }
      if(!allowed('memory')){if(allowed('time'))await openTime();else if(allowed('workshop'))await openWorkshop();else if(allowed('benmo'))await openBenmo();else openSettings();syncAppearance();return;}
      if(!allowed(memoryType))memoryType=allowed('event')?'event':'cumulative';
      const memoryProof=captureMemoryRead();
      app = mountMemoryApp(memoryContent, repository, { history: null, window: null, onClose: close,
        managementService: runtime?.service, managementController: runtime?.controller,
        getSettingsEpoch: () => runtime.getGenerationSettings('event').epoch,
        getOriginalSnapshot: runtime?.getOriginalSnapshot, originalAvailable: runtime?.originalAvailable, openSettings,
        openBenmo:()=>void openBenmo(),openWorkshop:()=>void openWorkshop(),openTime:()=>void openTime(),openSummary:origin=>void showSummary(origin),openSummarySettings:()=>void openSummarySettings(true),openRecall:()=>void openRecall(),regenerateBatch:id=>void showSummary('manual',id),cumulativeController:runtime.cumulativeController,initialMemoryType:memoryType,availability,onMemoryType:type=>{memoryType=type;cumulativePage='root';},openCumulative:origin=>void showCumulative(origin),openCumulativeSettings:()=>void openCumulativeSettings('root') });
      const mountedApp=app,reopenPage=cumulativePage,reopenTarget=cumulativePageTarget;await mountedApp.ready;
      if(!valid()||app!==mountedApp||currentPageRequest!==pageRequest)return;
      memoryReadProof=matchesMemoryRead(memoryProof)?memoryProof:null;
      if(memoryType==='cumulative'&&sameTarget(reopenTarget,repository.captureTarget())){if(['manual','auto'].includes(reopenPage))await showCumulative(reopenPage);else if(reopenPage==='settings'||reopenPage==='cleaning'){await openCumulativeSettings(cumulativeReturnPage,true);if(reopenPage==='cleaning')await openCumulativeCleaning();}}
      if(valid())syncAppearance();
    } catch (error) { if(diagnosticSample&&valid())interfaceDiagnostic.stop('failed');if (valid()&&currentPageRequest===pageRequest) errorView(error); }
    finally {if(openingTicket===currentTicket){openingTicket=null;requestBenmoWarmup(false);}}
  }
  function installEntry() {
    if (disposed||diagnosticSample) return;
    // Subscribe before the first page open: host renames must be observed
    // even when the user has not opened Lantai after a browser reload.
    try { ensureAdapter(); } catch { /* APP_READY/open will retry capability detection. */ }
    if (repository) void ensureRuntime().catch(() => {});
    if (entry) return;
    const menu = doc.querySelector('#extensionsMenu');
    if (!menu) return;
    entry = doc.createElement('div'); entry.id = entryId; entry.setAttribute('role','button');entry.tabIndex=0;entry.className = 'list-group-item flex-container flexGap5';
    const label = doc.createElement('span'); label.textContent = '兰台';
    const brand=doc.createElement('i');brand.className='fa-solid fa-stamp';brand.setAttribute('aria-hidden','true');
    entry.append(brand,label); entry.addEventListener('click', () => void open());entry.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();void open();}}); menu.append(entry);
  }
  const context = getContext(), source = context?.eventSource, readyEvent = context?.eventTypes?.APP_READY;
  const releaseGenerationDiagnostic=diagnosticSample?()=>{}:bindGenerationDiagnostic({document:doc,context});
  const updateBrowsing=value=>{foregroundBrowsing=value;benmoController?.refreshAvailability?.();workshopView?.refreshAvailability?.();if(!value&&areaPages.benmo.visible())void benmoController?.ensure().catch(()=>{});if(!value&&areaPages.workshop.visible())void refreshVisibleWorkshop();};
  for(const [name,listener] of [
    ['GENERATION_STARTED',(type,_options,dryRun)=>{if(dryRun!==true&&['normal','regenerate','swipe','continue'].includes(type===undefined?'normal':type))updateBrowsing(true);}],
    ...['GENERATION_ENDED','GENERATION_STOPPED','CHAT_CHANGED','CHAT_CREATED'].map(name=>[name,()=>updateBrowsing(false)]),
  ]){const event=context?.eventTypes?.[name];if(event&&source?.on){source.on(event,listener);generationBrowseReleases.push(()=>(source.removeListener??source.off)?.call(source,event,listener));}}
  const ready = () => installEntry();
  if (source?.on && readyEvent) source.on(readyEvent, ready);
  installEntry();
  // Host startup may add the Extensions menu after loading the module.
  const observer = new Observer(installEntry);
  if(!diagnosticSample)observer.observe(doc.documentElement, { childList: true, subtree: true });
  return {
    open, close, openTransitionSample,sampleReady:()=>diagnosticSample&&!!workshopView&&!workshopView.failed()&&(!visibilitySample||visibilitySampleReady), openSettings, openTask,openBenmo,openLatestSummary,openSummary:showSummary,openSummarySettings,openSummaryTask,openRecall,openTime,openSchedule,openWorkshop,openTracking,openCumulative:showCumulative,openCumulativeSettings,
    async interceptPrompt(...args){
      if(disposed)return;
      const request=++recallEntryRequest;let entryTarget;
      try{
        ensureAdapter();try{entryTarget=repository.captureTarget();}catch{/* Cold entry has no confirmed target yet. */}
        const target=await adapter.prepare();
        const current=()=>!disposed&&request===recallEntryRequest&&sameTarget(target,repository.captureTarget());
        if(!current())return;entryTarget=target;await ensureRuntime();
        if(disposed||request!==recallEntryRequest||!sameTarget(target,repository.captureTarget()))return;
        await workshopReady();if(!current())return;
        await controls.ensure();if(!current())return;
        if(sourceDeletionRuntime?.hasPendingRollback()){recallRuntime?.clear();trackingRuntime?.clear();narrativeRuntime?.clear();return;}
        const prepared=await latestRuntime.prepareSend(target);if(!current())return;
        if(!prepared)throw new Error('发送前资料准备已失效');
        latestRuntime?.replaceWorkshopSend();
        await timePrompts?.intercept(...args);if(!current())return;
        await recallRuntime?.intercept(...args);if(!current())return;
        await cumulativeRuntime?.intercept(...args);if(!current())return;
        await workshopRuntime?.intercept(...args);if(!current())return;
        await trackingRuntime?.intercept(...args);if(!current())return;
        await narrativeRuntime?.intercept(...args);if(!current())return;
        const historyBefore=Array.isArray(args[0])?args[0].map(message=>({...message})):null;
        const historyAfterSummary=historyBefore;
        const history=createWorkshopHistoryTicket({before:historyBefore,afterSummary:historyAfterSummary,afterCumulative:args[0],type:args[3]??'normal',cumulativeProof:cumulativeRuntime?.getReplacementProof(),getCurrent:()=>({target:repository.captureTarget(),original:getContext().chat,raw:adapter.captureSummarySource(target),root:adapter.peekConfirmed(target),eventEnabled:controls.allowed('event'),summaryEnabled:controls.allowed('summary'),cumulativeCurrent:proof=>controls.allowed('cumulative')&&runtime.settings.matchesCumulativeGeneration(proof.config)})});
        await latestRuntime?.intercept(...args);if(!current())return;
        const adopted=await recallRuntime?.finalizeSend();if(!current())return;if(adopted===false||typeof adopted==='function'&&!adopted()){latestRuntime?.invalidateWorkshopSend();return;}
        latestRuntime?.sealWorkshopSend(args[3]??'normal',recallRuntime?.captureWorkshopInjection()??null,history);
      }catch{if(!disposed&&request===recallEntryRequest){latestRuntime?.invalidateWorkshopSend();timePrompts?.clear();workshopRuntime?.clear();trackingRuntime?.clear();narrativeRuntime?.clear();recallRuntime?.preparationFailed(entryTarget,args[0],args[3]);cumulativeRuntime?.preparationFailed(entryTarget);}/* Keep the host prompt copy on unavailable authority. */}
    },
    latestStatus:()=>latestRuntime?.inspect()??{status:'idle'},
    timeStatus:()=>timeRuntime?.inspect()??{status:'idle',date:null},
    timePromptStatus:()=>timePrompts?.inspect()??{status:'empty'},
    cumulativeStatus:()=>cumulativeRuntime?.inspect()??{status:'empty'},
    cumulativeHistoryStatus:()=>({status:'retained',reason:'native-visibility',removed:0}),
    recallStatus:()=>recallRuntime?.inspect()??{status:'empty'},
    promptHistoryStatus:()=>({status:'retained',reason:'native-visibility',removed:0}),
    dispose() {
      if(disposed)return;disposed = true;interfaceDiagnostic.dispose();releaseInterfaceDiagnostic();generationBrowseReleases.forEach(release=>release());releaseGenerationDiagnostic();workshopBackgroundDisplay?.dispose();latestDisplay?.dispose();latestRuntime?.dispose();narrativeRuntime?.dispose();sourceDeletionRuntime?.dispose();sourceDeletionNotices?.dispose();storybarTheme.dispose();benmoSubscription?.();benmoController?.dispose();unsubscribeAppearance();appearance.dispose();timePrompts?.dispose();workshopRuntime?.dispose();trackingRuntime?.dispose();scheduleRuntime?.dispose();timeRuntime?.dispose();timeController?.dispose();let closeError;try{close();}catch(error){closeError=error;} cumulativeNotices?.dispose();cumulativeSettingsController?.dispose();cleaningController?.dispose();cumulativeRuntime?.dispose();notices?.dispose();summaryNotices?.dispose();summarySettingsController?.dispose();recallController?.dispose();recallRuntime?.dispose(); controlSubscription?.();controls?.dispose();runtime?.dispose(); lifetime.abort(); unsubscribe?.(); adapter?.dispose(); observer.disconnect();
      if (readyEvent && source) (source.removeListener ?? source.off)?.call(source, readyEvent, ready);
      entry?.remove(); entry = null;if(diagnosticSample)onSampleDispose?.();if(closeError)throw closeError;
    },
  };
}
