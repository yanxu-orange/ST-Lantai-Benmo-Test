// Named eras map onto a positive, continuous calendar year axis.
export function normalizeChronology(input = {eras: []}) {
  if (!Array.isArray(input.eras)) throw new TypeError('年号列表无效');
  const names = new Set();
  let finishedYears = 0;
  const eras = Array.from(input.eras, (item, index) => {
    if (typeof item?.name !== 'string' || !item.name.trim() || names.has(item.name.trim())) throw new Error('年号名称须填写且不能重复');
    names.add(item.name.trim());
    const current = index === input.eras.length - 1;
    if (current && item.endYear != null) throw new Error('当前年号不能填写末年');
    const endYear = current ? null : item.endYear;
    if (!current && (!Number.isSafeInteger(endYear) || endYear < 1 || endYear > 9999)) throw new RangeError('已结束年号须填写末年');
    if (!current) finishedYears += endYear;
    if (finishedYears >= 9999) throw new RangeError('累计纪年超出范围');
    return {name:item.name.trim(), endYear};
  });
  return {eras};
}
export function toUnifiedYear(chronology, name, relativeYear) {
  if (!Number.isSafeInteger(relativeYear) || relativeYear < 1) return null;
  const {eras} = normalizeChronology(chronology);
  let offset=0;
  for (const era of eras) {
    if (era.name===name) {
      if (era.endYear!==null && relativeYear>era.endYear || offset+relativeYear>9999) return null;
      return offset+relativeYear;
    }
    if (era.endYear!==null) offset+=era.endYear;
  }
  return null;
}
export function fromUnifiedYear(chronology, year) {
  if (!Number.isSafeInteger(year) || year<1 || year>9999) return null;
  const {eras}=normalizeChronology(chronology);
  let offset=0;
  for (const era of eras) {
    if (era.endYear===null || year<=offset+era.endYear) return {name:era.name,year:year-offset};
    offset+=era.endYear;
  }
  return null;
}
export function yearLabel(chronology, year) {
  if (!Number.isSafeInteger(year) || year < 1 || year > 9999) return '';
  const era=fromUnifiedYear(chronology,year);
  return era?`${era.name}${era.year}年`:`${year}年`;
}
