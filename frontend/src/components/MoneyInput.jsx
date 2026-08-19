import React,{forwardRef,useEffect,useState}from'react';
import {formatMoney,parseMoney}from'../utils/money';
import {evalMoneyExpression}from'../utils/moneyExpression';

// allowExpression (default false, opt-in only — see Price Matrix fast entry):
// while focused, keeps the raw typed text as-is instead of parsing+
// reformatting on every keystroke (parseMoney doesn't understand "/", "+",
// etc. — reformatting mid-type would collapse "2000000/12.5" to "0" the
// instant "/" is typed). On blur, evaluates the raw text as a safe
// arithmetic expression (see utils/moneyExpression.js) and commits the
// numeric result through the existing onChange — same contract as always,
// the caller/parent state never sees a non-numeric value. An invalid
// expression on blur is discarded back to the last committed value, never
// silently saved as 0. Enter-key evaluation/commit for the fast-entry loop
// is handled by the caller (PriceMatrix.jsx owns that flow); this component
// only guarantees the raw text survives typing and blur normalizes it.
//
// allowExpression=false (default): behavior is byte-for-byte the original
// MoneyInput — every other screen using this component is unaffected.
const MoneyInput=forwardRef(function MoneyInput({value,onChange,placeholder='',style={},className='input',disabled=false,allowExpression=false,onFocus,onBlur,...rest},ref){
  const[text,setText]=useState(formatMoney(value));
  const[focused,setFocused]=useState(false);

  useEffect(()=>{
    if(allowExpression&&focused)return; // don't stomp in-progress typing
    setText(formatMoney(value));
  },[value,allowExpression,focused]);

  const handleChange=e=>{
    const raw=e.target.value;
    if(allowExpression){
      setText(raw);
      return;
    }
    const n=parseMoney(raw);
    setText(formatMoney(n));
    onChange&&onChange(n);
  };

  const handleFocus=e=>{
    if(allowExpression)setFocused(true);
    onFocus&&onFocus(e);
  };

  const handleBlur=e=>{
    if(allowExpression){
      setFocused(false);
      const result=evalMoneyExpression(text);
      if(result.ok){
        setText(formatMoney(result.value));
        onChange&&onChange(result.value);
      }else{
        // Invalid/incomplete expression left on blur — discard, never commit 0.
        setText(formatMoney(value));
      }
    }
    onBlur&&onBlur(e);
  };

  return <input
    ref={ref}
    className={className}
    style={style}
    disabled={disabled}
    placeholder={placeholder}
    value={text}
    onChange={handleChange}
    onFocus={handleFocus}
    onBlur={handleBlur}
    inputMode={allowExpression?'text':'numeric'}
    type="text"
    {...rest}
  />
});

export default MoneyInput;
