import api from'../../api/api';
import ReturnDetailDialog from'../salesReturns/ReturnDetailDialog';
import {printReturn}from'../SalesReturns';

// P1-02A — Entity Viewer Registry.
//
// The ONLY place in the codebase that maps an audit_logs.entity_type to
// (a) a human label and (b) optionally how to load + render a real detail
// view for it. AuditLogViewer.jsx imports ONLY the three functions exported
// below — it has no knowledge of Sales Return, ReturnDetailDialog, or any
// other domain-specific component. Adding a new entity type tomorrow
// (customers -> CustomerDetailDialog, suppliers -> SupplierDetailDialog,
// inventory_adjustments -> InventoryAdjustmentDialog, ...) means adding one
// entry to REGISTRY below and nothing else — AuditLogViewer.jsx does not
// change.
//
// An entity_type with no `load`+`Component` (or not present in REGISTRY at
// all) simply has no "Xem đối tượng" action — AuditLogViewer's own existing
// "Xem chi tiết" note dialog (entity-agnostic: shows action/entity_type/
// entity_id/note/user/time as stored) already IS the generic fallback view
// for every entity_type, known or not, so there is no second "Generic Audit
// Detail" component to build or duplicate here.
const REGISTRY = {
  sales_returns: {
    label: 'Phiếu trả hàng',
    load: (entityId) => api.get('/sales-returns/' + entityId).then(r => r.data),
    Component: ReturnDetailDialog,
    // Adapts the loaded detail + a close handler to ReturnDetailDialog's own
    // prop contract. canReview is always false: this is a read-only jump
    // from the audit trail, never a workflow entry point, so no mutation
    // action (Receive/Inspect/Complete/Reject/Cancel) is ever rendered here
    // regardless of the loaded record's status.
    toProps: (detail, { onClose }) => ({
      detail, onClose, onPrint: printReturn, canReview: false,
      onCancel: () => {}, onReceive: () => {}, onInspect: () => {}, onComplete: () => {}, onReject: () => {},
      completingId: null,
    }),
  },
  // purchase_orders: label-only for now (AI Supplier Ordering writes this
  // entity_type to audit_logs, but no reusable read-only PO detail component
  // exists yet to wire up without duplicating one) — still contributes a
  // Vietnamese label to the table/filter; simply has no "Xem đối tượng"
  // action until a load/Component/toProps triplet is added here.
  purchase_orders: {
    label: 'Phiếu mua hàng',
  },
};

// Returns the entry only when it can actually render a detail view
// (load + Component both present) — this is what gates the "Xem đối tượng"
// button in AuditLogViewer.jsx.
export function getEntityViewerEntry(entityType) {
  const entry = REGISTRY[entityType];
  return (entry && entry.load && entry.Component) ? entry : null;
}

// Label lookup used for both the table column and the filter dropdown.
// Unknown entity_type values fall back to the raw code itself — rendered as
// plain text (React escapes text nodes by default), never as HTML.
export function getEntityLabel(entityType) {
  return REGISTRY[entityType]?.label || entityType || '';
}

// Every entity_type with at least a label — drives the "Loại đối tượng"
// filter dropdown without AuditLogViewer.jsx needing its own hardcoded list.
export function knownEntityTypes() {
  return Object.keys(REGISTRY);
}
