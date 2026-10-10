/* Candidate component measurement, independent of Theme and business data.
   Call after group styles load and whenever owner border geometry changes.
   Uses actual computed borders, never a presumed Theme token. */
globalThis.UICompactGroupCandidate={sync(root=document){
 for(const group of root.querySelectorAll('.ui-segment-group[data-ui-interaction-profile="compact-group-candidate"]')){
  const owners=[...group.querySelectorAll(':scope > .ui-hit-owner')];
  owners.forEach((owner,i)=>owner.style.setProperty('--ui-hit-partition-order',String(owners.length-i)));
 }
 for(const group of root.querySelectorAll('.ui-tool-group[data-ui-interaction-profile="compact-group-candidate"]')){
  for(const owner of group.querySelectorAll(':scope > .ui-hit-owner')){
   const style=getComputedStyle(owner);
   owner.style.setProperty('--ui-hit-owner-border-inline-size',
     (parseFloat(style.borderLeftWidth)+parseFloat(style.borderRightWidth))+'px');
  }
 }
}};
