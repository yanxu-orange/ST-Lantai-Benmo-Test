// Optional injection preserves independent runtime tests and non-host consumers.
export function featureGate(getControls,key){
 return {
  allowed:()=>!getControls||!!getControls()?.allowed(key),
  capture:()=>getControls?.()?.capture(key)??null,
  matches:proof=>!getControls||!!getControls()?.matches(proof),
 };
}
