// Shared ordinary-event layout: callers supply field bindings, never a new
// candidate-specific visual grammar.
export function eventEditorSections({modes,title,body,times,sources,participants,keywords}) {
  const section=(label,content)=>`<details open class="lt-section"><summary>${label}</summary><div class="lt-stack">${content}</div></details>`;
  return `<section class="lt-section">${modes}${title}</section>${section('正文',body)}${section('时间与来源',`<div class="lt-stack"><h3 class="ui-field__label">故事时间</h3>${times}</div><div class="lt-stack"><h3 class="ui-field__label">来源楼层</h3>${sources}</div>`)}${section('人物与地点',participants)}${section('关键词',keywords)}`;
}
