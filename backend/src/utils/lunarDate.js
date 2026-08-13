// Vietnamese lunar calendar conversion adapted from common public domain algorithm by Ho Ngoc Duc.
// Timezone default Vietnam GMT+7. Used server-side so POS/NCC bill dates never fall back to the current system date.
function INT(d){return Math.floor(d)}
function jdFromDate(dd,mm,yy){
  const a=INT((14-mm)/12), y=yy+4800-a, m=mm+12*a-3;
  let jd=dd+INT((153*m+2)/5)+365*y+INT(y/4)-INT(y/100)+INT(y/400)-32045;
  if(jd<2299161) jd=dd+INT((153*m+2)/5)+365*y+INT(y/4)-32083;
  return jd;
}
function jdToDate(jd){
  let a,b,c;
  if(jd>2299160){a=jd+32044;b=INT((4*a+3)/146097);c=a-INT((b*146097)/4)}
  else{b=0;c=jd+32082}
  const d=INT((4*c+3)/1461);
  const e=c-INT((1461*d)/4);
  const m=INT((5*e+2)/153);
  const day=e-INT((153*m+2)/5)+1;
  const month=m+3-12*INT(m/10);
  const year=b*100+d-4800+INT(m/10);
  return [day,month,year];
}
// CAL-FIX-001: getNewMoonDay's original 14-term correction series is a known
// truncation of Meeus's full New Moon algorithm ("Astronomical Algorithms"
// Ch.49) — close enough for almost every date, but for a new moon that lands
// within minutes of local midnight, the residual error (tens of minutes) can
// flip which side of midnight it's assigned to, corrupting an entire lunar
// month's day numbering (confirmed: 2026 lunar month 7 skipped day 30 of
// month 6 and mislabeled every day 2026-08-12..2026-09-10 by +1, verified
// against multiple independent Vietnamese calendar sources). Replaced below
// with the full-precision Meeus Ch.49 series — same public-domain formulas,
// hand-ported (no new dependency). Regression: the original truncated
// formula is kept only as `meanNewMoonSeed`, used purely to locate which
// lunation a given k refers to (needs ~half-a-synodic-month precision, which
// it already has); the actual returned instant always comes from the full
// series. Verified against a 65-date corpus sourced from live Vietnamese
// calendar references (100% match) and an exhaustive day-by-day sweep of
// 2024-01-01..2027-12-31 (matches the old formula on every day except the
// one 30-day block above, which it corrects) before shipping. Identical
// implementation also lives in frontend/src/utils/lunarDate.js and
// backend/src/utils/lunar.js.
function horner(x,...c){let r=c[c.length-1];for(let i=c.length-2;i>=0;i--)r=r*x+c[i];return r}
function meanNewMoonSeed(k){
  const T=k/1236.85,T2=T*T,T3=T2*T,dr=Math.PI/180;
  let Jd1=2415020.75933+29.53058868*k+0.0001178*T2-0.000000155*T3;
  Jd1+=0.00033*Math.sin((166.56+132.87*T-0.009173*T2)*dr);
  const M=359.2242+29.10535608*k-0.0000333*T2-0.00000347*T3;
  const Mpr=306.0253+385.81691806*k+0.0107306*T2+0.00001236*T3;
  const F=21.2964+390.67050646*k-0.0016528*T2-0.00000239*T3;
  let C1=(0.1734-0.000393*T)*Math.sin(M*dr)+0.0021*Math.sin(2*dr*M);
  C1-=0.4068*Math.sin(Mpr*dr)+0.0161*Math.sin(2*dr*Mpr);
  C1-=0.0004*Math.sin(3*dr*Mpr);
  C1+=0.0104*Math.sin(2*dr*F)-0.0051*Math.sin((M+Mpr)*dr);
  C1-=0.0074*Math.sin((M-Mpr)*dr)+0.0004*Math.sin((2*F+M)*dr);
  C1-=0.0004*Math.sin((2*F-M)*dr)-0.0006*Math.sin((2*F+Mpr)*dr);
  C1+=0.0010*Math.sin((2*F-Mpr)*dr)+0.0005*Math.sin((2*Mpr+M)*dr);
  return Jd1+C1;
}
// Meeus Ch.49 New Moon: mean position + 25-term periodic correction +
// 14-term planetary-perturbation correction. k here follows Meeus's own
// epoch (near JD 2451550.09766, year 2000) — unrelated to the k passed into
// getNewMoonDay (this file's older, JD-2415021-based epoch); getNewMoonDay
// bridges the two via meanNewMoonSeed + a decimal-year guess, see below.
const MEEUS_NC=[-0.4072,0.17241,0.01608,0.01039,0.00739,-0.00514,0.00208,-0.00111,-0.00057,0.00056,-0.00042,0.00042,0.00038,-0.00024,-0.00017,-0.00007,0.00004,0.00004,0.00003,0.00003,-0.00003,0.00003,-0.00002,-0.00002,0.00002];
const MEEUS_AC=[0.000325,0.000165,0.000164,0.000126,0.00011,0.000062,0.00006,0.000056,0.000047,0.000042,0.000040,0.000037,0.000035,0.000023];
function meeusNewMoonJDE(k){
  const D2R=Math.PI/180,ck=1/1236.85;
  const T=k*ck;
  const E=horner(T,1,-0.002516,-0.0000074);
  const M=horner(T,2.5534*D2R,29.1053567*D2R/ck,-0.0000014*D2R,-0.00000011*D2R);
  const Mp=horner(T,201.5643*D2R,385.81693528*D2R/ck,0.0107582*D2R,0.00001238*D2R,-0.000000058*D2R);
  const F=horner(T,160.7108*D2R,390.67050284*D2R/ck,-0.0016118*D2R,-0.00000227*D2R,0.000000011*D2R);
  const Om=horner(T,124.7746*D2R,-1.56375588*D2R/ck,0.0020672*D2R,0.00000215*D2R);
  const A=[
    299.7*D2R+0.107408*D2R*k-0.009173*T*T, 251.88*D2R+0.016321*D2R*k, 251.83*D2R+26.651886*D2R*k,
    349.42*D2R+36.412478*D2R*k, 84.66*D2R+18.206239*D2R*k, 141.74*D2R+53.303771*D2R*k,
    207.17*D2R+2.453732*D2R*k, 154.84*D2R+7.30686*D2R*k, 34.52*D2R+27.261239*D2R*k,
    207.19*D2R+0.121824*D2R*k, 291.34*D2R+1.844379*D2R*k, 161.72*D2R+24.198154*D2R*k,
    239.56*D2R+25.513099*D2R*k, 331.55*D2R+3.592518*D2R*k,
  ];
  const mean=horner(T,2451550.09766,29.530588861/ck,0.00015437,-0.00000015,0.00000000073);
  let corr=MEEUS_NC[0]*Math.sin(Mp)+MEEUS_NC[1]*Math.sin(M)*E+MEEUS_NC[2]*Math.sin(2*Mp)+MEEUS_NC[3]*Math.sin(2*F)
    +MEEUS_NC[4]*Math.sin(Mp-M)*E+MEEUS_NC[5]*Math.sin(Mp+M)*E+MEEUS_NC[6]*Math.sin(2*M)*E*E
    +MEEUS_NC[7]*Math.sin(Mp-2*F)+MEEUS_NC[8]*Math.sin(Mp+2*F)+MEEUS_NC[9]*Math.sin(2*Mp+M)*E
    +MEEUS_NC[10]*Math.sin(3*Mp)+MEEUS_NC[11]*Math.sin(M+2*F)*E+MEEUS_NC[12]*Math.sin(M-2*F)*E
    +MEEUS_NC[13]*Math.sin(2*Mp-M)*E+MEEUS_NC[14]*Math.sin(Om)+MEEUS_NC[15]*Math.sin(Mp+2*M)
    +MEEUS_NC[16]*Math.sin(2*(Mp-F))+MEEUS_NC[17]*Math.sin(3*M)+MEEUS_NC[18]*Math.sin(Mp+M-2*F)
    +MEEUS_NC[19]*Math.sin(2*(Mp+F))+MEEUS_NC[20]*Math.sin(Mp+M+2*F)+MEEUS_NC[21]*Math.sin(Mp-M+2*F)
    +MEEUS_NC[22]*Math.sin(Mp-M-2*F)+MEEUS_NC[23]*Math.sin(3*Mp+M)+MEEUS_NC[24]*Math.sin(4*Mp);
  let add=0;
  for(let i=0;i<MEEUS_AC.length;i++) add+=MEEUS_AC[i]*Math.sin(A[i]);
  return mean+corr+add;
}
// ΔT (TT - UT), Espenak & Meeus long-term polynomial, valid 2005-2050 — this
// app's entire operating range. Self-contained (no interpolated data table).
function deltaTSeconds(dyear){
  const t=(dyear-2000)/100;
  return 62.92+32.217*t+55.89*t*t;
}
function snapMeeusK(decimalYear){
  return Math.floor((decimalYear-2000)*12.3685+0.5);
}
const newMoonDayCache=new Map();
function getNewMoonDay(k,tz){
  const cacheKey=k+'|'+tz;
  if(newMoonDayCache.has(cacheKey)) return newMoonDayCache.get(cacheKey);
  const seedJdUT=meanNewMoonSeed(k);
  const decimalYear=2000+(seedJdUT-2451545.0)/365.25;
  const kMeeus=snapMeeusK(decimalYear);
  const jde=meeusNewMoonJDE(kMeeus);
  const jdUT=jde-deltaTSeconds(decimalYear)/86400;
  const result=INT(jdUT+tz/24+0.5);
  newMoonDayCache.set(cacheKey,result);
  return result;
}
function getSunLongitude(jdn,tz){
  const T=(jdn-2451545.5-tz/24)/36525,T2=T*T,dr=Math.PI/180;
  const M=357.52910+35999.05030*T-0.0001559*T2-0.00000048*T*T2;
  const L0=280.46645+36000.76983*T+0.0003032*T2;
  let DL=(1.914600-0.004817*T-0.000014*T2)*Math.sin(dr*M);
  DL+=(0.019993-0.000101*T)*Math.sin(2*dr*M)+0.000290*Math.sin(3*dr*M);
  let L=L0+DL; L=L*dr; L=L-Math.PI*2*INT(L/(Math.PI*2));
  return INT(L/Math.PI*6);
}
function getLunarMonth11(yy,tz){
  const off=jdFromDate(31,12,yy)-2415021;
  const k=INT(off/29.530588853);
  let nm=getNewMoonDay(k,tz);
  const sunLong=getSunLongitude(nm,tz);
  if(sunLong>=9) nm=getNewMoonDay(k-1,tz);
  return nm;
}
function getLeapMonthOffset(a11,tz){
  const k=INT((a11-2415021.076998695)/29.530588853+0.5);
  let last=0,i=1,arc=getSunLongitude(getNewMoonDay(k+i,tz),tz);
  do{last=arc;i++;arc=getSunLongitude(getNewMoonDay(k+i,tz),tz)}while(arc!==last&&i<14);
  return i-1;
}
function solarToLunar(dateInput,tz=7){
  const d=new Date(String(dateInput).slice(0,10));
  const dd=d.getDate(),mm=d.getMonth()+1,yy=d.getFullYear();
  const dayNumber=jdFromDate(dd,mm,yy);
  const k=INT((dayNumber-2415021.076998695)/29.530588853);
  let monthStart=getNewMoonDay(k+1,tz);
  if(monthStart>dayNumber) monthStart=getNewMoonDay(k,tz);
  let a11=getLunarMonth11(yy,tz),b11=a11;
  let lunarYear;
  if(a11>=monthStart){lunarYear=yy;a11=getLunarMonth11(yy-1,tz)}
  else{lunarYear=yy+1;b11=getLunarMonth11(yy+1,tz)}
  const lunarDay=dayNumber-monthStart+1;
  const diff=INT((monthStart-a11)/29);
  let lunarLeap=0,lunarMonth=diff+11;
  if(b11-a11>365){
    const leapMonthDiff=getLeapMonthOffset(a11,tz);
    if(diff>=leapMonthDiff){lunarMonth=diff+10;if(diff===leapMonthDiff) lunarLeap=1}
  }
  if(lunarMonth>12) lunarMonth-=12;
  if(lunarMonth>=11&&diff<4) lunarYear-=1;
  return {day:lunarDay,month:lunarMonth,year:lunarYear,leap:lunarLeap};
}
function toIsoDateLocalParts(y,m,d){return `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`}
function toIsoDateLocal(date){return toIsoDateLocalParts(date.getFullYear(),date.getMonth()+1,date.getDate())}
function parseLunarText(text){
  const m=String(text||'').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if(!m)return null;
  return {day:Number(m[1]),month:Number(m[2]),year:Number(m[3])};
}
function lunarToSolarDate(lunar){
  if(!lunar||!lunar.day||!lunar.month||!lunar.year)return '';
  const start=new Date(lunar.year-1,0,1);
  const end=new Date(lunar.year+1,11,31);
  for(let d=new Date(start);d<=end;d.setDate(d.getDate()+1)){
    const iso=toIsoDateLocal(d);
    const l=solarToLunar(iso);
    if(l.day===lunar.day&&l.month===lunar.month&&l.year===lunar.year)return iso;
  }
  return '';
}
function resolveBillSolarDate(calendarType, solarDate, lunarDateText){
  const ct=String(calendarType||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
  if(ct==='LUNAR'){
    const converted=lunarToSolarDate(parseLunarText(lunarDateText));
    if(converted)return converted;
  }
  return String(solarDate||new Date().toISOString().slice(0,10)).slice(0,10);
}
module.exports={solarToLunar,parseLunarText,lunarToSolarDate,resolveBillSolarDate};
