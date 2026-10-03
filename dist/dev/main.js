import { createFakeAdapter } from '../platform/fake/memory-adapter.js';
import { createRepository } from '../domain/memory/repository.js';
import { mountMemoryApp } from '../app/memory-app.js';
import { createManagementFixture,managementSeed } from '../platform/fake/management-fixture.js';
// localStorage belongs exclusively to this disposable harness, never to SillyTavern.
const managementCandidate=new URLSearchParams(location.search).has('management');
const adapter=createFakeAdapter({persistence:localStorage,key:managementCandidate?'lantai-task014-fiction-only':'lantai-task009-fiction-only',seed:managementCandidate?managementSeed:{}});adapter.switchChat('A');
const repository=createRepository(adapter),fixture=createManagementFixture(repository,{delay:450});
const app=mountMemoryApp(document.querySelector('#app'),repository,{managementController:fixture.controller,openSettings:()=>{document.querySelector('.dev-tools').open=true;document.querySelector('#dev-api').focus();}});
document.querySelector('#dev-chat').addEventListener('change',async event=>{adapter.switchChat(event.target.value);await app.refresh();});
document.querySelector('#dev-fail').addEventListener('click',()=>adapter.failNextSave());
document.querySelector('#dev-api').addEventListener('click',()=>{fixture.config.source?fixture.disable():fixture.enable();document.querySelector('#dev-api').textContent=fixture.config.source?'关闭 fake AI 配置':'启用 fake AI 配置';});
document.querySelector('#dev-ai-fail').addEventListener('click',()=>fixture.failNext());
globalThis.LantaiDev={adapter,app,fixture};
