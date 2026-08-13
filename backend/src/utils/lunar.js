// Vietnamese lunar calendar helpers.
// Returns lunar date as dd/mm/yyyy text to match existing MeatBiz fields.

const PI = Math.PI;

function jdFromDate(dd, mm, yy) {
  const a = Math.floor((14 - mm) / 12);
  const y = yy + 4800 - a;
  const m = mm + 12 * a - 3;
  let jd = dd + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
  if (jd < 2299161) {
    jd = dd + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - 32083;
  }
  return jd;
}

// CAL-FIX-001: the original 14-term correction series below (now
// meanNewMoonSeed) is a known truncation of Meeus's full New Moon algorithm
// ("Astronomical Algorithms" Ch.49) — close enough for almost every date, but
// for a new moon landing within minutes of local midnight, its residual
// error (tens of minutes) can flip which side of midnight it's assigned to,
// corrupting an entire lunar month's day numbering (confirmed: 2026 lunar
// month 7 skipped day 30 of month 6 and mislabeled every day
// 2026-08-12..2026-09-10 by +1, verified against multiple independent
// Vietnamese calendar sources). getNewMoonDay now uses the full-precision
// Meeus Ch.49 series — same public-domain formulas, hand-ported, no new
// dependency. meanNewMoonSeed is kept only to locate which lunation a given k
// refers to (needs ~half-a-synodic-month precision, which it already has);
// the returned instant always comes from the full series. Verified against a
// 65-date corpus sourced from live Vietnamese calendar references (100%
// match) and an exhaustive day-by-day sweep of 2024-01-01..2027-12-31
// (matches the old formula on every day except the one 30-day block above,
// which it corrects) before shipping.
function horner(x) {
  const c = Array.prototype.slice.call(arguments, 1);
  let r = c[c.length - 1];
  for (let i = c.length - 2; i >= 0; i--) r = r * x + c[i];
  return r;
}
function meanNewMoonSeed(k) {
  const T = k / 1236.85;
  const T2 = T * T;
  const T3 = T2 * T;
  const dr = PI / 180;
  let Jd1 = 2415020.75933 + 29.53058868 * k + 0.0001178 * T2 - 0.000000155 * T3;
  Jd1 += 0.00033 * Math.sin((166.56 + 132.87 * T - 0.009173 * T2) * dr);
  const M = 359.2242 + 29.10535608 * k - 0.0000333 * T2 - 0.00000347 * T3;
  const Mpr = 306.0253 + 385.81691806 * k + 0.0107306 * T2 + 0.00001236 * T3;
  const F = 21.2964 + 390.67050646 * k - 0.0016528 * T2 - 0.00000239 * T3;
  let C1 = (0.1734 - 0.000393 * T) * Math.sin(M * dr) + 0.0021 * Math.sin(2 * dr * M);
  C1 -= 0.4068 * Math.sin(Mpr * dr) + 0.0161 * Math.sin(2 * dr * Mpr);
  C1 -= 0.0004 * Math.sin(3 * dr * Mpr);
  C1 += 0.0104 * Math.sin(2 * dr * F) - 0.0051 * Math.sin((M + Mpr) * dr);
  C1 -= 0.0074 * Math.sin((M - Mpr) * dr) + 0.0004 * Math.sin((2 * F + M) * dr);
  C1 -= 0.0004 * Math.sin((2 * F - M) * dr) - 0.0006 * Math.sin((2 * F + Mpr) * dr);
  C1 += 0.0010 * Math.sin((2 * F - Mpr) * dr) + 0.0005 * Math.sin((2 * Mpr + M) * dr);
  return Jd1 + C1;
}
// Meeus Ch.49 New Moon: mean position + 25-term periodic correction +
// 14-term planetary-perturbation correction. k here follows Meeus's own
// epoch (near JD 2451550.09766, year 2000) — unrelated to the k passed into
// getNewMoonDay (this file's older, JD-2415021-based epoch); getNewMoonDay
// bridges the two via meanNewMoonSeed + a decimal-year guess, see below.
const MEEUS_NC = [-0.4072, 0.17241, 0.01608, 0.01039, 0.00739, -0.00514, 0.00208, -0.00111, -0.00057, 0.00056, -0.00042, 0.00042, 0.00038, -0.00024, -0.00017, -0.00007, 0.00004, 0.00004, 0.00003, 0.00003, -0.00003, 0.00003, -0.00002, -0.00002, 0.00002];
const MEEUS_AC = [0.000325, 0.000165, 0.000164, 0.000126, 0.00011, 0.000062, 0.00006, 0.000056, 0.000047, 0.000042, 0.000040, 0.000037, 0.000035, 0.000023];
function meeusNewMoonJDE(k) {
  const D2R = PI / 180;
  const ck = 1 / 1236.85;
  const T = k * ck;
  const E = horner(T, 1, -0.002516, -0.0000074);
  const M = horner(T, 2.5534 * D2R, 29.1053567 * D2R / ck, -0.0000014 * D2R, -0.00000011 * D2R);
  const Mp = horner(T, 201.5643 * D2R, 385.81693528 * D2R / ck, 0.0107582 * D2R, 0.00001238 * D2R, -0.000000058 * D2R);
  const F = horner(T, 160.7108 * D2R, 390.67050284 * D2R / ck, -0.0016118 * D2R, -0.00000227 * D2R, 0.000000011 * D2R);
  const Om = horner(T, 124.7746 * D2R, -1.56375588 * D2R / ck, 0.0020672 * D2R, 0.00000215 * D2R);
  const A = [
    299.7 * D2R + 0.107408 * D2R * k - 0.009173 * T * T, 251.88 * D2R + 0.016321 * D2R * k, 251.83 * D2R + 26.651886 * D2R * k,
    349.42 * D2R + 36.412478 * D2R * k, 84.66 * D2R + 18.206239 * D2R * k, 141.74 * D2R + 53.303771 * D2R * k,
    207.17 * D2R + 2.453732 * D2R * k, 154.84 * D2R + 7.30686 * D2R * k, 34.52 * D2R + 27.261239 * D2R * k,
    207.19 * D2R + 0.121824 * D2R * k, 291.34 * D2R + 1.844379 * D2R * k, 161.72 * D2R + 24.198154 * D2R * k,
    239.56 * D2R + 25.513099 * D2R * k, 331.55 * D2R + 3.592518 * D2R * k
  ];
  const mean = horner(T, 2451550.09766, 29.530588861 / ck, 0.00015437, -0.00000015, 0.00000000073);
  let corr = MEEUS_NC[0] * Math.sin(Mp) + MEEUS_NC[1] * Math.sin(M) * E + MEEUS_NC[2] * Math.sin(2 * Mp) + MEEUS_NC[3] * Math.sin(2 * F)
    + MEEUS_NC[4] * Math.sin(Mp - M) * E + MEEUS_NC[5] * Math.sin(Mp + M) * E + MEEUS_NC[6] * Math.sin(2 * M) * E * E
    + MEEUS_NC[7] * Math.sin(Mp - 2 * F) + MEEUS_NC[8] * Math.sin(Mp + 2 * F) + MEEUS_NC[9] * Math.sin(2 * Mp + M) * E
    + MEEUS_NC[10] * Math.sin(3 * Mp) + MEEUS_NC[11] * Math.sin(M + 2 * F) * E + MEEUS_NC[12] * Math.sin(M - 2 * F) * E
    + MEEUS_NC[13] * Math.sin(2 * Mp - M) * E + MEEUS_NC[14] * Math.sin(Om) + MEEUS_NC[15] * Math.sin(Mp + 2 * M)
    + MEEUS_NC[16] * Math.sin(2 * (Mp - F)) + MEEUS_NC[17] * Math.sin(3 * M) + MEEUS_NC[18] * Math.sin(Mp + M - 2 * F)
    + MEEUS_NC[19] * Math.sin(2 * (Mp + F)) + MEEUS_NC[20] * Math.sin(Mp + M + 2 * F) + MEEUS_NC[21] * Math.sin(Mp - M + 2 * F)
    + MEEUS_NC[22] * Math.sin(Mp - M - 2 * F) + MEEUS_NC[23] * Math.sin(3 * Mp + M) + MEEUS_NC[24] * Math.sin(4 * Mp);
  let add = 0;
  for (let i = 0; i < MEEUS_AC.length; i++) add += MEEUS_AC[i] * Math.sin(A[i]);
  return mean + corr + add;
}
// ΔT (TT - UT), Espenak & Meeus long-term polynomial, valid 2005-2050 — this
// app's entire operating range. Self-contained (no interpolated data table).
function deltaTSeconds(dyear) {
  const t = (dyear - 2000) / 100;
  return 62.92 + 32.217 * t + 55.89 * t * t;
}
function snapMeeusK(decimalYear) {
  return Math.floor((decimalYear - 2000) * 12.3685 + 0.5);
}
const newMoonDayCache = new Map();
function getNewMoonDay(k, timeZone) {
  const cacheKey = k + '|' + timeZone;
  if (newMoonDayCache.has(cacheKey)) return newMoonDayCache.get(cacheKey);
  const seedJdUT = meanNewMoonSeed(k);
  const decimalYear = 2000 + (seedJdUT - 2451545.0) / 365.25;
  const kMeeus = snapMeeusK(decimalYear);
  const jde = meeusNewMoonJDE(kMeeus);
  const jdUT = jde - deltaTSeconds(decimalYear) / 86400;
  const result = Math.floor(jdUT + timeZone / 24 + 0.5);
  newMoonDayCache.set(cacheKey, result);
  return result;
}

function getSunLongitude(jdn, timeZone) {
  const T = (jdn - 2451545.5 - timeZone / 24) / 36525;
  const T2 = T * T;
  const dr = PI / 180;
  const M = 357.52910 + 35999.05030 * T - 0.0001559 * T2 - 0.00000048 * T * T2;
  const L0 = 280.46645 + 36000.76983 * T + 0.0003032 * T2;
  let DL = (1.914600 - 0.004817 * T - 0.000014 * T2) * Math.sin(dr * M);
  DL += (0.019993 - 0.000101 * T) * Math.sin(2 * dr * M) + 0.000290 * Math.sin(3 * dr * M);
  let L = L0 + DL;
  L *= dr;
  L = L - PI * 2 * Math.floor(L / (PI * 2));
  return Math.floor(L / PI * 6);
}

function getLunarMonth11(yy, timeZone) {
  const off = jdFromDate(31, 12, yy) - 2415021;
  const k = Math.floor(off / 29.530588853);
  let nm = getNewMoonDay(k, timeZone);
  const sunLong = getSunLongitude(nm, timeZone);
  if (sunLong >= 9) nm = getNewMoonDay(k - 1, timeZone);
  return nm;
}

function getLeapMonthOffset(a11, timeZone) {
  const k = Math.floor((a11 - 2415021.076998695) / 29.530588853 + 0.5);
  let last = 0;
  let i = 1;
  let arc = getSunLongitude(getNewMoonDay(k + i, timeZone), timeZone);
  do {
    last = arc;
    i += 1;
    arc = getSunLongitude(getNewMoonDay(k + i, timeZone), timeZone);
  } while (arc !== last && i < 14);
  return i - 1;
}

function convertSolarToLunar(dd, mm, yy, timeZone = 7) {
  const dayNumber = jdFromDate(dd, mm, yy);
  const k = Math.floor((dayNumber - 2415021.076998695) / 29.530588853);
  let monthStart = getNewMoonDay(k + 1, timeZone);
  if (monthStart > dayNumber) monthStart = getNewMoonDay(k, timeZone);
  let a11 = getLunarMonth11(yy, timeZone);
  let b11 = a11;
  let lunarYear;
  if (a11 >= monthStart) {
    lunarYear = yy;
    a11 = getLunarMonth11(yy - 1, timeZone);
  } else {
    lunarYear = yy + 1;
    b11 = getLunarMonth11(yy + 1, timeZone);
  }
  const lunarDay = dayNumber - monthStart + 1;
  const diff = Math.floor((monthStart - a11) / 29);
  let lunarLeap = 0;
  let lunarMonth = diff + 11;
  if (b11 - a11 > 365) {
    const leapMonthDiff = getLeapMonthOffset(a11, timeZone);
    if (diff >= leapMonthDiff) {
      lunarMonth = diff + 10;
      if (diff === leapMonthDiff) lunarLeap = 1;
    }
  }
  if (lunarMonth > 12) lunarMonth -= 12;
  if (lunarMonth >= 11 && diff < 4) lunarYear -= 1;
  return { day: lunarDay, month: lunarMonth, year: lunarYear, leap: lunarLeap };
}

function parseYMD(dateText) {
  const m = String(dateText || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const d = dateText ? new Date(dateText) : new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

function toLunarDateText(dateText, timeZone = 7) {
  const p = parseYMD(dateText);
  const lunar = convertSolarToLunar(p.day, p.month, p.year, timeZone);
  return `${String(lunar.day).padStart(2, '0')}/${String(lunar.month).padStart(2, '0')}/${lunar.year}`;
}

module.exports = {
  convertSolarToLunar,
  toLunarDateText
};
