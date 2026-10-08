/* Offline TIME lunar import adapter. Ported from layouts/approved/time/index.html (user-approved v8).
 * Compatibility: old TIME importer bounds, traditional names and term formula.
 * Lunar month data replaces platform-dependent Intl. Full bounded ranges work.
 * The embedded 1949–2036 table is a slice of solarlunar's 1900–2100 table.
 * ISC License: Copyright (c) 2015, yize
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
const lunar = (() => {
  'use strict';
  var MIN_YEAR = 1949, MAX_YEAR = 2036, MAX_IMPORT_YEARS = MAX_YEAR - MIN_YEAR + 1, DAY = 86400000;
  var CODES = Object.freeze([
    0xb557,0x6ca0,0xb550,0x15355,0x4da0,0xa5b0,0x14573,0x52b0,0xa9a8,0xe950,
    0x6aa0,0xaea6,0xab50,0x4b60,0xaae4,0xa570,0x5260,0xf263,0xd950,0x5b57,
    0x56a0,0x96d0,0x4dd5,0x4ad0,0xa4d0,0xd4d4,0xd250,0xd558,0xb540,0xb6a0,
    0x195a6,0x95b0,0x49b0,0xa974,0xa4b0,0xb27a,0x6a50,0x6d40,0xaf46,0xab60,
    0x9570,0x4af5,0x4970,0x64b0,0x74a3,0xea50,0x6b58,0x5ac0,0xab60,0x96d5,
    0x92e0,0xc960,0xd954,0xd4a0,0xda50,0x7552,0x56a0,0xabb7,0x25d0,0x92d0,
    0xcab5,0xa950,0xb4a0,0xbaa4,0xad50,0x55d9,0x4ba0,0xa5b0,0x15176,0x52b0,
    0xa930,0x7954,0x6aa0,0xad50,0x5b52,0x4b60,0xa6e6,0xa4e0,0xd260,0xea65,
    0xd530,0x5aa0,0x76a3,0x96d0,0x4afb,0x4ad0,0xa4d0,0x1d0b6
  ]);
  var MONTH_NAMES = Object.freeze(['正月','二月','三月','四月','五月','六月','七月','八月','九月','十月','冬月','腊月']);
  var TERM_NAMES = Object.freeze(['小寒','大寒','立春','雨水','惊蛰','春分','清明','谷雨','立夏','小满','芒种','夏至','小暑','大暑','立秋','处暑','白露','秋分','寒露','霜降','立冬','小雪','大雪','冬至']);
  var TERM_MINUTES = Object.freeze([0,21208,42467,63836,85337,107014,128867,150921,173149,195551,218072,240693,263343,285989,308563,331033,353350,375494,397447,419210,440795,462224,483532,504758]);
  if (CODES.length !== MAX_YEAR - MIN_YEAR + 1) throw new Error('内置农历表不完整');
  function assertYear(value) {
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') throw new RangeError('请填写导入年份');
    var year = Number(value);
    if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) throw new RangeError('可导入的现实农历年份为 ' + MIN_YEAR + '–' + MAX_YEAR + '。');
    return year;
  }
  function monthsFor(year) {
    var code = CODES[year - MIN_YEAR], leap = code & 15, result = [];
    for (var m = 1; m <= 12; m++) {
      result.push({ id: 'month-' + m, name: MONTH_NAMES[m - 1], number: m, isLeap: false, days: code & (0x10000 >> m) ? 30 : 29 });
      if (m === leap) result.push({ id: 'leap-month-' + m, name: '闰' + MONTH_NAMES[m - 1], number: m, isLeap: true, days: code & 0x10000 ? 30 : 29 });
    }
    return result;
  }
  var YEAR_STARTS = [Date.UTC(1949, 0, 29)];
  for (var y = MIN_YEAR; y <= MAX_YEAR; y++) YEAR_STARTS.push(YEAR_STARTS[YEAR_STARTS.length - 1] + monthsFor(y).reduce(function (sum, month) { return sum + month.days; }, 0) * DAY);
  Object.freeze(YEAR_STARTS);
  function solarDate(time) {
    var date = new Date(time);
    return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
  }
  // Preserve the old plugin's approximate day-level solar-term calculation.
  // year+1 is intentionally allowed here to finish the final lunar year.
  function solarTermsForYear(year) {
    if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR + 1) return [];
    return TERM_MINUTES.map(function (minutes, index) {
      var date = solarDate(31556925974.7 * (year - 1900) + minutes * 60000 + Date.UTC(1900, 0, 6, 2, 5));
      return { name: TERM_NAMES[index], month: date.m, day: date.d, sourceYear: year, approximate: true };
    });
  }
  function importYear(year, includeTerms) {
    var months = monthsFor(year), start = YEAR_STARTS[year - MIN_YEAR], end = YEAR_STARTS[year - MIN_YEAR + 1];
    var leap = months.find(function (month) { return month.isLeap; });
    var solarTerms = [];
    if (includeTerms) {
      [year, year + 1].forEach(function (sourceYear) {
        solarTermsForYear(sourceYear).forEach(function (term) {
          var time = Date.UTC(sourceYear, term.month - 1, term.day);
          if (time < start || time >= end) return;
          var rest = (time - start) / DAY, index = 0;
          while (rest >= months[index].days) { rest -= months[index].days; index++; }
          solarTerms.push({ name: term.name, monthId: months[index].id, monthIndex: index + 1, day: rest + 1,
            sourceDate: { y: sourceYear, m: term.month, d: term.day }, approximate: true });
        });
      });
    }
    return { id: 'real-' + year, name: '参考 ' + year + ' 年农历', sourceYear: year, months: months,
      leapMonth: leap ? { afterMonth: leap.number, days: leap.days } : null,
      solarStart: solarDate(start), totalDays: (end - start) / DAY, solarTerms: solarTerms };
  }
  function importYears(startYear, endYear, options) {
    var start = assertYear(startYear), end = assertYear(endYear);
    if (end < start) throw new RangeError('导入结束年份不能早于起始年份。');
    var result = [], includeTerms = !!(options && options.includeTerms === true);
    for (var year = start; year <= end; year++) result.push(importYear(year, includeTerms));
    return result;
  }
  // monthIndex is 1-based chronological position, including any intercalary month.
  // Story years repeat the complete imported range; they do not select sourceYear.
  function termFor(cal, date) {
    if (!cal || cal.type !== 'dynasty' || cal.includeTerms !== true || !Array.isArray(cal.importedYears) || !cal.importedYears.length || !date || !Number.isSafeInteger(date.y) || date.y < 1 || !Number.isInteger(date.m) || !Number.isInteger(date.d)) return null;
    var year = cal.importedYears[(date.y - 1) % cal.importedYears.length];
    var month = year && Array.isArray(year.months) && year.months[date.m - 1];
    if (!month || date.d < 1 || date.d > month.days) return null;
    var matches = (year.solarTerms || []).filter(function (term) { return term.monthIndex === date.m && term.day === date.d; });
    return matches.length ? matches.map(function (term) { return term.name; }).join('、') : null;
  }
  // Optional shared conversion, bounded by the same table; never coerces invalid dates.
  function toModern(date, isLeap) {
    if (!date || !Number.isInteger(date.y) || date.y < MIN_YEAR || date.y > MAX_YEAR || !Number.isInteger(date.m) || date.m < 1 || date.m > 12 || !Number.isInteger(date.d) || date.d < 1) return null;
    var months = monthsFor(date.y), offset = date.d - 1;
    for (var i = 0; i < months.length; i++) {
      var month = months[i];
      if (month.number === date.m && month.isLeap === (isLeap === true)) return date.d <= month.days ? solarDate(YEAR_STARTS[date.y - MIN_YEAR] + offset * DAY) : null;
      offset += month.days;
    }
    return null;
  }
  return Object.freeze({ MIN_YEAR: MIN_YEAR, MAX_YEAR: MAX_YEAR, MAX_IMPORT_YEARS: MAX_IMPORT_YEARS,
    importYears: importYears, termFor: termFor, toModern: toModern, solarTermsForYear: solarTermsForYear,
    sourceInfo: '1949–2036 年内置农历表；月长源自 solarlunar 固定表，节气沿用旧插件近似算法，未逐年作天文台校验' });
})();
export const {MIN_YEAR,MAX_YEAR,MAX_IMPORT_YEARS,importYears,termFor,toModern,solarTermsForYear,sourceInfo}=lunar;
