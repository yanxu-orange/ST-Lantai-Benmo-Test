// Extracted from the event and cumulative summary reading views. Callers supply
// business rows and action attributes; all pages keep the same disclosure DOM.
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const readingText=text=>String(text??'').replace(/<br\s*\/?>/giu,'\n').replace(/\\r\\n|\\[nr]/gu,'\n');
export const summaryPreviewSource=(label,text,attributes='',{lineBreaks=false}={})=>`<details class="lt-summary-source" ${attributes}><summary><span>${esc(label)}</span></summary><p>${esc(lineBreaks?readingText(text):text)}</p></details>`;
export const summaryPreviewPrompt=(part,attributes='',readingRows=null)=>`<details class="lt-summary-prompt" ${attributes}><summary><span class="lt-summary-prompt-label"><span>${esc(part.name)}</span><small class="lt-meta">${esc(String(part.role??'').toUpperCase())}</small></span></summary>${readingRows?readingRows.map(([label,text,lineBreaks=false])=>summaryPreviewSource(label,text,'open',{lineBreaks})).join(''):`<pre>${esc(part.content)}</pre>`}</details>`;
export const summaryPreviewStage=(title,body)=>`<details class="lt-summary-stage"><summary><span>${esc(title)}</span></summary>${body}</details>`;
export const summaryPreviewTabs=(tabs,current,attributes)=>`<nav class="lt-summary-switches ui-preview-tabs" aria-label="预览视图">${tabs.map(([id,label])=>`<button type="button" class="ui-button ui-button--tertiary ui-segment" ${attributes(id)} aria-pressed="${current===id}">${esc(label)}</button>`).join('')}</nav>`;
export const summaryPreviewPanel=(tabs,content)=>`<section class="lt-summary-preview ui-preview-panel">${tabs}${content}</section>`;
