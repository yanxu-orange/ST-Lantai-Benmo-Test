import {locationAliasesFor} from '../domain/memory/location-aliases.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const fields=(event,index)=>`<label class="lt-term-field ui-field__label">地点<input class="ui-input" data-location-field="name" value="${esc(event.places[index])}"></label><label class="lt-term-field ui-field__label">别名<input class="ui-input" data-location-field="aliases" value="${esc(locationAliasesFor(event,event.places[index]).join('，'))}"></label>`;
const row=(event,index,open)=>`<div class="lt-term" data-location-row="${index}" data-open="${open}" data-aliases="${locationAliasesFor(event,event.places[index]).length>0}"><div class="lt-term-head"><button type="button" class="ui-button ui-button--tertiary" data-location-toggle="${index}" aria-expanded="${open}">${esc(event.places[index])}</button><button type="button" class="ui-icon-button ui-button--tertiary" data-location-remove="${index}" aria-label="删除${esc(event.places[index])}"><img class="lt-icon" src="${new URL('./icons/close.svg',import.meta.url)}" alt=""></button></div>${open?`<div class="lt-term-fields">${fields(event,index)}</div>`:''}</div>`;

export const locationEditorRows=(event,openIndex=null)=>event.places.map((_,index)=>row(event,index,index===openIndex)).join('');

// Preserve input nodes and raw text while updating the full-name header and binding.
export function updateLocationEditorRow(node,event,index){
  node.setAttribute('data-location-row',String(index));
  node.setAttribute('data-aliases',String(locationAliasesFor(event,event.places[index]).length>0));
  const toggle=node.querySelector('[data-location-toggle]'),remove=node.querySelector('[data-location-remove]');
  toggle.setAttribute('data-location-toggle',String(index));toggle.textContent=event.places[index];
  remove.setAttribute('data-location-remove',String(index));remove.setAttribute('aria-label',`删除${event.places[index]}`);
}

export function setLocationEditorError(field,message=''){
  let error=field.closest('[data-location-row]').querySelector(`[data-location-error-message="${field.dataset.locationField}"]`);
  if(!message){field.removeAttribute('data-location-error');field.removeAttribute('aria-invalid');error?.remove();return;}
  field.setAttribute('data-location-error',message);field.setAttribute('aria-invalid','true');
  if(!error){error=field.ownerDocument.createElement('p');error.className='lt-error';error.setAttribute('role','alert');error.setAttribute('data-location-error-message',field.dataset.locationField);field.closest('.lt-term-fields').append(error);}
  error.textContent=message;
}

export function focusLocationEditorError(container){
  const field=container.querySelector('[data-location-error]'),group=field?.closest('details');
  if(group)group.open=true;field?.focus({preventScroll:true});return !!field;
}

export function syncLocationEditor(list,event,openIndex=null){
  for(let index=list.children.length;index<event.places.length;index++){
    const wrapper=list.ownerDocument.createElement('div');wrapper.innerHTML=row(event,index,false);list.append(wrapper.children[0]);
  }
  for(const [index,node] of [...list.children].entries()){
    if(index>=event.places.length){node.remove();continue;}
    updateLocationEditorRow(node,event,index);
    const open=index===openIndex,existing=node.querySelector('.lt-term-fields');
    node.setAttribute('data-open',String(open));node.querySelector('[data-location-toggle]').setAttribute('aria-expanded',String(open));
    if(open&&!existing){const section=list.ownerDocument.createElement('div');section.className='lt-term-fields';section.innerHTML=fields(event,index);node.append(section);}
    if(!open)existing?.remove();
  }
}
