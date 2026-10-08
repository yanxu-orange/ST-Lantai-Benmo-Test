// Keep navigation available while first-use storage and host setup are pending.
export function mountWorkshopLoading(container,{onBack,onClose,onRetry,titleText='工坊',messageText='正在读取工坊…'}={}){
  const doc=container.ownerDocument,surface=doc.createElement('section');
  surface.className='lantai workshop';
  const header=doc.createElement('header');header.className='lt-header ui-header ui-header--centered';
  function control(label,file,action){const b=doc.createElement('button');b.type='button';b.className='ui-icon-button ui-button--tertiary';b.setAttribute('aria-label',label);const img=doc.createElement('img');img.className='lt-icon';img.alt='';img.width=18;img.height=18;img.src=new URL(`./icons/${file}.svg`,import.meta.url).href;b.append(img);b.addEventListener('click',action);return b;}
  const title=doc.createElement('h1');title.className='ui-page-title';title.textContent=titleText;
  header.append(control('返回记忆','back',onBack),title,control('关闭兰台','close',onClose));
  const main=doc.createElement('main');main.className='lt-main lt-stack';
  const message=doc.createElement('p');message.setAttribute('role','status');message.textContent=messageText;
  const retry=doc.createElement('button');retry.type='button';retry.className='ui-button ui-button--secondary';retry.textContent='重新读取';retry.hidden=true;retry.addEventListener('click',onRetry);
  main.append(message,retry);surface.append(header,main);container.replaceChildren(surface);
  return {progress(text){message.textContent=text;},fail(error){message.setAttribute('role','alert');message.className='lt-error';message.textContent=error?.message||'工坊读取失败，请重试';retry.hidden=false;}};
}
