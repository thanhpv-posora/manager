import React,{useEffect,useRef}from'react';

// Generic reusable dialog shell — Patch 01 of the Unified POS Product Entry
// refactor. Visually identical to CalendarDialog (same .modal-backdrop/
// .modal-card/.modal-header/.modal-footer classes, same header+close-button
// layout) but adds the interaction behaviors CalendarDialog doesn't have:
// Esc-to-close, backdrop-click-to-close, and focus in/out handling. Carries
// no workflow-specific logic — callers supply title/children/footer.
//
// Master Data Dialog Design System addition: optional primaryAction/
// secondaryAction/submitting props build a standardized Hủy(left)/Save(right)
// footer, so Product/Partner (and any future Master Data screen) don't each
// hand-roll identical footer markup. Purely additive and backward-compatible:
// a caller that still passes only `footer` (or neither) renders exactly as
// before — this does not touch or require changes in any existing caller
// (CalendarDialog.jsx doesn't use this component at all; CreateOrder.jsx's
// three dialogs pass neither prop and are unaffected). The scrollable-body/
// pinned-header-footer treatment lives on a new `dialog-shell` class, scoped
// so it never touches the bare `.modal-card` CalendarDialog.jsx uses.
export default function Dialog({
  open,title,onClose,children,footer,maxWidth=520,
  primaryAction,secondaryAction,submitting=false,
}){
  const cardRef=useRef(null);
  const previouslyFocusedRef=useRef(null);
  // Root-cause fix for the sheet-filter-input-loses-focus bug: every call site
  // passes an inline arrow function for onClose, which is a new reference on
  // every parent render (including every keystroke in any input inside this
  // dialog, since that updates the parent's state). The effect below used to
  // depend on [open,onClose] — so it re-ran on every keystroke, and its cleanup
  // (previouslyFocusedRef.current?.focus?.()) yanked focus back to whatever
  // triggered the dialog, then the re-run's setTimeout moved it again to the
  // modal card. Keeping onClose in a ref lets Escape always call the *latest*
  // onClose without the effect needing onClose in its dependency array, so the
  // effect (and its focus-management side effects) now only runs when `open`
  // actually changes — never on every render while the dialog stays open.
  const onCloseRef=useRef(onClose);
  onCloseRef.current=onClose;

  useEffect(()=>{
    if(!open)return;
    previouslyFocusedRef.current=document.activeElement;
    const onKeyDown=(e)=>{
      if(e.key==='Escape'){
        e.preventDefault();
        onCloseRef.current&&onCloseRef.current();
      }
    };
    document.addEventListener('keydown',onKeyDown);
    const t=setTimeout(()=>{cardRef.current?.focus();},0);
    return()=>{
      document.removeEventListener('keydown',onKeyDown);
      clearTimeout(t);
      previouslyFocusedRef.current?.focus?.();
    };
  },[open]);

  if(!open)return null;

  const onBackdropMouseDown=(e)=>{
    if(e.target===e.currentTarget)onClose&&onClose();
  };

  // Standardized footer only activates when a caller opts in via
  // primaryAction. Explicit `footer` still wins if a caller passes both
  // (none currently do) — this keeps the prop backward-compatible rather than
  // silently overriding a caller's own footer content.
  const standardFooter=!footer&&primaryAction&&(
    <>
      <button type="button" className="btn secondary" onClick={secondaryAction?.onClick||onClose} disabled={submitting}>
        {secondaryAction?.label||'Hủy'}
      </button>
      <button type="button" className="btn" onClick={primaryAction.onClick} disabled={submitting||primaryAction.disabled}>
        {submitting?(primaryAction.loadingLabel||'Đang lưu...'):primaryAction.label}
      </button>
    </>
  );
  const resolvedFooter=footer||standardFooter;
  // dialog-shell only applies the new pinned-header/scrollable-body/pinned-
  // footer treatment when there's a footer to pin against — a caller with no
  // footer at all (none currently) keeps the original single-scroll behavior.
  const useShell=!!resolvedFooter;

  return(
    <div className="modal-backdrop" onMouseDown={onBackdropMouseDown}>
      <div
        className={useShell?'modal-card dialog-shell':'modal-card'}
        style={{maxWidth}}
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title||undefined}
      >
        <div className="modal-header">
          <div>{title&&<h2>{title}</h2>}</div>
          <button type="button" className="btn secondary" onClick={onClose}>Đóng</button>
        </div>
        <div className={useShell?'dialog-body':undefined} style={useShell?undefined:{padding:'16px 0'}}>{children}</div>
        {resolvedFooter&&<div className="modal-footer">{resolvedFooter}</div>}
      </div>
    </div>
  );
}
