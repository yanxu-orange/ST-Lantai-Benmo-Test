// Memory-local corresponding names, never inferred from substrings or a global map.
export function assertLocationAliases(value, places) {
  if (!Array.isArray(value)) throw new Error('地点别名无效');
  const parents = new Set();
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 2
      || !Object.hasOwn(row, 'parentLocation') || !Object.hasOwn(row, 'aliases')
      || !places.includes(row.parentLocation) || parents.has(row.parentLocation)
      || !Array.isArray(row.aliases) || !row.aliases.length
      || new Set(row.aliases).size !== row.aliases.length
      || row.aliases.some(alias => typeof alias !== 'string' || !alias.trim() || alias !== alias.trim() || alias === row.parentLocation)) throw new Error('地点别名或所属地点无效');
    parents.add(row.parentLocation);
  }
  return value;
}
export const locationAliasesFor = (event, parentLocation) => event.locationAliases?.find(row => row.parentLocation === parentLocation)?.aliases ?? [];
export function setLocationAliases(event, parentLocation, aliases) {
  if (!event.places.includes(parentLocation)) throw new Error('地点不存在');
  const names = [...new Set(aliases.map(alias => String(alias).trim()).filter(alias => alias && alias !== parentLocation))];
  event.locationAliases = (event.locationAliases ?? []).filter(row => row.parentLocation !== parentLocation);
  if (names.length) event.locationAliases.push({parentLocation, aliases:names});
}
export function pruneLocationAliases(event) {
  if (Object.hasOwn(event, 'locationAliases')) event.locationAliases = event.locationAliases.filter(row => event.places.includes(row.parentLocation));
  return event;
}
export function renameLocation(event, index, name) {
  const previous = event.places[index];
  if (previous === undefined) throw new Error('地点不存在');
  if (event.places.some((place, position) => position !== index && place === name)) throw new Error('地点名称不能重复');
  event.places[index] = name;
  if (Object.hasOwn(event, 'locationAliases')) event.locationAliases = event.locationAliases.map(row => row.parentLocation === previous ? {...row,parentLocation:name} : row);
}
export function removeLocation(event, index) {
  event.places.splice(index, 1);
  pruneLocationAliases(event);
}
export function mergeLocationAliases(events, places) {
  const result = {places,locationAliases:[]};
  for (const parent of places) {
    const aliases = events.flatMap(event => locationAliasesFor(event, parent));
    if (aliases.length) setLocationAliases(result, parent, aliases);
  }
  return result.locationAliases;
}
