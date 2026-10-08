// Calendar-native date arithmetic candidate for TASK-028. No host or storage IO.
export const MAX_YEAR = 9999;
const integer = (value, min, max, label) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${label}超出范围`);
  return value;
};
const deepFreeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); } return value; };
const year = value => integer(value, 1, MAX_YEAR, '年份');
export const isLeapYear = value => value % 4 === 0 && (value % 100 !== 0 || value % 400 === 0);
const gregorianBefore = value => {
  const previous = value - 1;
  return previous * 365 + Math.floor(previous / 4) - Math.floor(previous / 100) + Math.floor(previous / 400);
};
function checkedMonths(list, max) {
  if (!Array.isArray(list) || !list.length || list.length > max) throw new RangeError('月份数量无效');
  const names = new Set();
  return Array.from(list, month => {
    if (!month || typeof month.name !== 'string' || !month.name.trim() || names.has(month.name.trim())) throw new Error('月份名称须填写且不能重复');
    names.add(month.name.trim());
    return {...month, name: month.name.trim(), days: integer(month.days, 1, 31, '每月天数')};
  });
}
export function normalizeCalendar(input) {
  if (!input || !['modern', 'custom', 'dynasty'].includes(input.type)) throw new TypeError('历法类型无效');
  if (typeof input.id !== 'string' || !input.id.trim()) throw new TypeError('历法身份无效');
  const result = structuredClone(input);
  result.name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!result.name) throw new TypeError('请填写历法名称');
  if (input.type === 'custom') result.months = checkedMonths(result.months, 12);
  if (input.type === 'dynasty') {
    if (!Array.isArray(input.importedYears) || !input.importedYears.length || input.importedYears.length > 88) throw new RangeError('请导入有效的农历年份');
    const sources = new Set();
    result.importedYears = Array.from(result.importedYears, item => {
      if (!item || typeof item !== 'object') throw new TypeError('导入年份无效');
      const sourceYear = integer(item.sourceYear, 1949, 2036, '农历来源年份');
      if (sources.has(sourceYear)) throw new Error('导入年份不能重复');
      sources.add(sourceYear);
      return {...item, sourceYear, months: checkedMonths(item.months, 13)};
    });
  }
  return result;
}
function sameMonth(left,right){
 const a=left.number??left.ordinal,b=right.number??right.ordinal;
 if(Number.isInteger(a)&&Number.isInteger(b))return a===b&&Boolean(left.isLeap)===Boolean(right.isLeap);
 if(typeof left.id==='string'&&typeof right.id==='string')return left.id===right.id;
 return left.name===right.name;
}
// A compiled calculator belongs to one confirmed calendar configuration.
// Callers rebuild it when configuration changes, not for every rendered day.
export function createCalendar(input) {
  const definition = deepFreeze(normalizeCalendar(input));
  const modern = definition.type === 'modern';
  const schemes = modern ? [] : definition.type === 'custom' ? [definition.months] : definition.importedYears.map(item => item.months);
  const lengths = schemes.map(months => months.reduce((sum, item) => sum + item.days, 0));
  const prefix = [0];
  for (const days of lengths) prefix.push(prefix.at(-1) + days);
  const cycleDays = prefix.at(-1);
  const months = value => {
    year(value);
    return modern
      ? [31, isLeapYear(value) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].map((days, i) => ({name: `${i + 1}月`, days}))
      : structuredClone(schemes[(value - 1) % schemes.length]);
  };
  const beforeYear = value => {
    integer(value, 1, MAX_YEAR + 1, '年份');
    if (modern) return gregorianBefore(value);
    const n = value - 1;
    return Math.floor(n / schemes.length) * cycleDays + prefix[n % schemes.length];
  };
  const validate = inputDate => {
    if (!inputDate || inputDate.calendarId !== definition.id) throw new Error('日期不属于当前历法');
    const y = year(inputDate.year), list = months(y);
    const m = integer(inputDate.month, 1, list.length, '月份');
    const d = integer(inputDate.day, 1, list[m - 1].days, '日期');
    return {calendarId: definition.id, year: y, month: m, day: d};
  };
  const ordinal = inputDate => {
    const date = validate(inputDate), list = months(date.year);
    return beforeYear(date.year) + list.slice(0, date.month - 1).reduce((sum, item) => sum + item.days, 0) + date.day - 1;
  };
  const fromOrdinal = value => {
    if (!Number.isSafeInteger(value) || value < 0 || value >= beforeYear(MAX_YEAR + 1)) return null;
    let lo = 1, hi = MAX_YEAR;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (beforeYear(mid) <= value) lo = mid; else hi = mid - 1;
    }
    let remaining = value - beforeYear(lo), m = 0;
    const list = months(lo);
    while (remaining >= list[m].days) remaining -= list[m++].days;
    return {calendarId: definition.id, year: lo, month: m + 1, day: remaining + 1};
  };
  const shiftDays = (date, amount) => {
    if (!Number.isSafeInteger(amount)) throw new RangeError('日期偏移须为整数');
    return fromOrdinal(ordinal(date) + amount);
  };
  const monthPrefix = [0];
  for (const scheme of schemes) monthPrefix.push(monthPrefix.at(-1) + scheme.length);
  const beforeYearMonths = value => {
    integer(value, 1, MAX_YEAR + 1, '年份');
    if (modern) return (value - 1) * 12;
    const n = value - 1;
    return Math.floor(n / schemes.length) * monthPrefix.at(-1) + monthPrefix[n % schemes.length];
  };
  const shiftMonths = (inputDate, amount) => {
    if (!Number.isSafeInteger(amount)) throw new RangeError('月份偏移须为整数');
    const date = validate(inputDate), index = beforeYearMonths(date.year) + date.month - 1 + amount;
    if (!Number.isSafeInteger(index) || index < 0 || index >= beforeYearMonths(MAX_YEAR + 1)) return null;
    let lo = 1, hi = MAX_YEAR;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (beforeYearMonths(mid) <= index) lo = mid; else hi = mid - 1;
    }
    const month = index - beforeYearMonths(lo) + 1;
    return {calendarId:definition.id,year:lo,month,day:Math.min(date.day,months(lo)[month-1].days)};
  };
  const shiftYears = (inputDate, amount) => {
    if (!Number.isSafeInteger(amount)) throw new RangeError('年份偏移须为整数');
    const date = validate(inputDate), targetYear = date.year + amount;
    if (!Number.isSafeInteger(targetYear) || targetYear < 1 || targetYear > MAX_YEAR) return null;
    const target = months(targetYear), original = months(date.year)[date.month-1];
    const index = definition.type === 'dynasty' ? target.findIndex(item=>sameMonth(item,original)) : date.month-1;
    if (index < 0 || !target[index]) return null;
    return {calendarId:definition.id,year:targetYear,month:index+1,day:Math.min(date.day,target[index].days)};
  };
  const annualDate = (inputDate, targetYear) => {
    const date = validate(inputDate); year(targetYear);
    if (targetYear < date.year) return null;
    const original = months(date.year)[date.month - 1], target = months(targetYear);
    // A leap month and the regular month retain separate identities.
    const index = definition.type === 'dynasty' ? target.findIndex(item => sameMonth(item,original)) : date.month - 1;
    if (index < 0 || !target[index] || date.day > target[index].days) return null;
    return {calendarId: definition.id, year: targetYear, month: index + 1, day: date.day};
  };
  return Object.freeze({definition, months, validate, ordinal, fromOrdinal, shiftDays, shiftMonths, shiftYears, annualDate,
    distance: (a, b) => ordinal(b) - ordinal(a), compare: (a, b) => Math.sign(ordinal(a) - ordinal(b))});
}
