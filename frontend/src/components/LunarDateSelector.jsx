import React,{useEffect,useState}from'react';
import {formatLunarDate} from'../utils/lunarDate';

export default function LunarDateSelector({solarDate,value,onChange,calendarType,onCalendarTypeChange}){
  const[mode,setMode]=useState(calendarType||'SOLAR');
  const[text,setText]=useState(value||'');

  useEffect(()=>setMode(calendarType||'SOLAR'),[calendarType]);
  useEffect(()=>setText(value||''),[value]);

  const suggest=()=>{
    const s=formatLunarDate(solarDate||new Date()).replace(/^ÂL\s*/,'');
    setText(s);
    onChange&&onChange(s);
  };

  const changeMode=(m)=>{
    setMode(m);
    onCalendarTypeChange&&onCalendarTypeChange(m);
    if(m==='LUNAR'&&!text){
      setTimeout(()=>suggest(),0);
    }
  };

  return <div className="lunar-picker compact">
    <div className="lunar-tabs">
      <button type="button" className={mode==='SOLAR'?'active':''} onClick={()=>changeMode('SOLAR')}>Ngày dương lịch</button>
      <button type="button" className={mode==='LUNAR'?'active':''} onClick={()=>changeMode('LUNAR')}>Ngày âm lịch</button>
    </div>
    {mode==='SOLAR'&&<p className="muted">Bill sẽ in theo ngày dương lịch đang chọn.</p>}
    {mode==='LUNAR'&&<div className="form-grid">
      <input className="input" value={text} onChange={e=>{setText(e.target.value);onChange&&onChange(e.target.value)}} placeholder="VD: 28/03/2026 âm lịch"/>
      <button type="button" className="btn secondary" onClick={suggest}>Lấy âm lịch theo ngày dương</button>
      <div className="muted" style={{gridColumn:'1 / -1'}}>Có thể nhập ngày âm bất kỳ để tạo bill cho ngày trước đó.</div>
    </div>}
  </div>;
}
