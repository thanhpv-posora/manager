import React,{useEffect,useState}from'react';
import {formatMoney,parseMoney}from'../utils/money';

export default function MoneyInput({value,onChange,placeholder='',style={},className='input',disabled=false,...rest}){
  const[text,setText]=useState(formatMoney(value));

  useEffect(()=>{setText(formatMoney(value))},[value]);

  const handleChange=e=>{
    const raw=e.target.value;
    const n=parseMoney(raw);
    setText(formatMoney(n));
    onChange&&onChange(n);
  };

  return <input
    className={className}
    style={style}
    disabled={disabled}
    placeholder={placeholder}
    value={text}
    onChange={handleChange}
    inputMode="numeric"
    type="text"
    {...rest}
  />
}
