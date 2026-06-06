// Vietnamese lunar calendar conversion adapted from common public domain algorithm by Ho Ngoc Duc.
// Timezone default Vietnam GMT+7.
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
function getNewMoonDay(k,tz){
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
  let deltaT;
  if(T<-11) deltaT=0.001+0.000839*T+0.0002261*T2-0.00000845*T3-0.000000081*T*T3;
  else deltaT=-0.000278+0.000265*T+0.000262*T2;
  return INT(Jd1+C1-deltaT+0.5+tz/24);
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
export function solarToLunar(dateInput,tz=7){
  const d=new Date(dateInput);
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
export function formatLunarDate(dateInput){
  const l=solarToLunar(dateInput);
  return `${String(l.day).padStart(2,'0')}/${String(l.month).padStart(2,'0')}/${l.year}${l.leap?' nhuận':''}`;
}
