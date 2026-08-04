// P1-01A (CTO review correction) — single source of the "final-state" formula
// for a Sales Return document, used by both SalesReturns.jsx (grid row
// actions) and ReturnDetailDialog.jsx (detail footer actions), so the two
// never drift on when Hoàn tất / Từ chối should be available. Mirrors
// ReturnAgent.js's own backend authority (_resolveFinalization()) exactly:
//   - a line is "classified" when accepted_qty + rejected_qty (from its
//     LATEST inspection, i.e. the last entry of that line's `inspections`
//     array — same array shape ReturnAgent.get()/list() already return)
//     equals quantity_received, within QTY_TOLERANCE.
//   - a line never received (quantity_received=0) and never inspected is
//     trivially classified (0+0=0).
//   - totalAccepted is the document-wide sum of each line's latest
//     accepted_qty.
//
// This is a client-side PREVIEW only — the backend re-derives and enforces
// the exact same numbers inside its own transaction (ReturnAgent.js
// complete()/reject()) and remains authoritative; this utility only decides
// whether to show/enable a button and give an early, friendlier warning
// before opening a confirmation dialog.
export const RETURN_QTY_TOLERANCE = 0.0001;

export function computeReturnFinalization(items) {
  let totalAccepted = 0;
  let fullyClassified = true;
  for (const it of items || []) {
    const received = Number(it.quantity_received || 0);
    const inspections = it.inspections || [];
    const latest = inspections.length ? inspections[inspections.length - 1] : null;
    const accepted = latest ? Number(latest.accepted_qty || 0) : 0;
    const rejected = latest ? Number(latest.rejected_qty || 0) : 0;
    totalAccepted += accepted;
    if (Math.abs((accepted + rejected) - received) > RETURN_QTY_TOLERANCE) fullyClassified = false;
  }
  return {
    fullyClassified,
    totalAccepted,
    canComplete: fullyClassified && totalAccepted > RETURN_QTY_TOLERANCE,
    canReject: fullyClassified && totalAccepted <= RETURN_QTY_TOLERANCE,
  };
}
