// Consume existing low-frequency layout evidence; never read or modify the DOM here.
export function assessMainScroll(layout,expected='clip'){
 expected=expected==='hidden'?'hidden':'clip';
 const byRole=Object.fromEntries(layout.map(row=>[row.role,row]));
 const overflow=byRole.main?.overflow;
 if(!overflow?.x||!overflow?.y)return {status:'pending',reason:'unknown-overflow'};
 if(overflow.x!==expected||overflow.y!==expected)return {status:'invalid',reason:expected==='hidden'?'overflow-not-hidden':'overflow-not-clip'};
 const roles=['surface','header','main','footer'],rects=roles.map(role=>byRole[role]?.rect);
 const keys=['left','right','top','bottom','width','height'];
 if(rects.some(rect=>!rect||keys.some(key=>!Number.isFinite(rect[key]))))return {status:'pending',reason:'unknown-geometry'};
 if(rects.some(rect=>rect.width<=0||rect.height<=0))return {status:'invalid',reason:'empty-layout'};
 const [surface,header,main,footer]=rects,epsilon=1e-7;
 if([header,main,footer].some(rect=>rect.left<surface.left-epsilon||rect.right>surface.right+epsilon||rect.top<surface.top-epsilon||rect.bottom>surface.bottom+epsilon))return {status:'invalid',reason:'outside-surface'};
 if(header.bottom>main.top+epsilon||main.bottom>footer.top+epsilon)return {status:'invalid',reason:'overlapping-layout'};
 return {status:'applied',reason:null};
}
