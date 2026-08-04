import React,{useEffect,useState}from'react';
import {Eye,FileSearch}from'lucide-react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import Dialog from'../components/common/Dialog';
import {showError}from'../utils/toast';
import ReturnDetailDialog from'./salesReturns/ReturnDetailDialog';
import {printReturn}from'./SalesReturns';

// P1-02 — Audit Log Viewer (Production Readiness audit finding C2).
//
// Read-only page over GET /api/audit-logs (AuditLogAgent.js), ADMIN-only —
// backend enforces this with auth(['ADMIN']); the menu itself is also only
// granted to ADMIN by default (bootstrap.js app_menus seed), but the real
// security boundary is the backend 403, not sidebar visibility.
//
// Scope: audit_logs only. This does NOT show delete_logs (Trash page's own
// domain), orders.cancelled_* columns, or debt_transactions reversal rows —
// unifying those is explicitly out of scope for this story (see the audit's
// finding M4).
//
// "Xem phiếu trả hàng" reuses the REAL ReturnDetailDialog + printReturn from
// SalesReturns.jsx (not a reimplementation) when entity_type='sales_returns'
// — canReview is always false here, so no mutation action (Receive/Inspect/
// Complete/Reject/Cancel) is ever rendered from this read-only context; only
// Đóng/In are available, matching what this page is for (inspection, not
// workflow entry). There is no client-side router with deep-linkable URLs in
// this app (App.jsx is a flat page-key switch, not React Router) — "opening"
// a Sales Return from here is an in-place dialog, not a URL navigation; see
// the PR report's Known Limitations for that trade-off.

const ACTION_LABELS = {
  SALES_RETURN_CREATED: 'Tạo yêu cầu trả hàng',
  SALES_RETURN_CANCELLED: 'Hủy yêu cầu trả hàng',
  SALES_RETURN_RECEIVED: 'Nhận hàng trả',
  SALES_RETURN_INSPECTED: 'Kiểm tra hàng trả',
  SALES_RETURN_COMPLETED: 'Hoàn tất trả hàng',
  SALES_RETURN_REJECTED: 'Từ chối trả hàng',
  AI_CREATE_PURCHASE_ORDER_DRAFT: 'AI tạo nháp phiếu mua hàng',
};
const ENTITY_LABELS = {
  sales_returns: 'Phiếu trả hàng',
  purchase_orders: 'Phiếu mua hàng',
};
// Unknown action/entity_type values render safely as their raw code (React
// text nodes are escaped by default — no dangerouslySetInnerHTML anywhere in
// this file, satisfying "notes rendered as stored, never execute HTML").
const actionLabel = a => ACTION_LABELS[a] || a || '';
const entityLabel = e => ENTITY_LABELS[e] || e || '';

const dt = v => {
  if (!v) return '';
  const d = new Date(String(v).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(v);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const truncate = (s, n = 80) => {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n) + '…' : str;
};

const EMPTY_FILTERS = { entity_type: '', entity_id: '', action: '', user_id: '', from_date: '', to_date: '', search: '' };

export default function AuditLogViewer() {
  const [rows, setRows] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 50, total: 0, total_pages: 1 });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // `filters` = live, uncommitted form inputs (controlled inputs only).
  // `appliedFilters` = the values actually driving the query, only updated by
  // Lọc/Xóa lọc — decoupled on purpose so load() never reads a stale closure
  // of `filters` right after a setFilters() call (setState is async; reading
  // `filters` synchronously after setting it would still see the old value).
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState(EMPTY_FILTERS);
  const [users, setUsers] = useState([]);

  const [noteDlg, setNoteDlg] = useState(null); // { action, entity_type, entity_id, note, user_name, created_at } | null

  const [salesReturnDetail, setSalesReturnDetail] = useState(null); // ReturnDetailDialog `detail` shape | null
  const [salesReturnLoadingId, setSalesReturnLoadingId] = useState(null);

  useEffect(() => {
    api.get('/permissions/users').then(r => setUsers(r.data || [])).catch(() => setUsers([]));
  }, []);

  const load = async () => {
    try {
      setLoading(true);
      const params = { page, limit: pagination.limit };
      if (appliedFilters.entity_type) params.entity_type = appliedFilters.entity_type;
      if (appliedFilters.entity_id) params.entity_id = appliedFilters.entity_id;
      if (appliedFilters.action) params.action = appliedFilters.action;
      if (appliedFilters.user_id) params.user_id = appliedFilters.user_id;
      if (appliedFilters.from_date) params.from_date = appliedFilters.from_date;
      if (appliedFilters.to_date) params.to_date = appliedFilters.to_date;
      if (appliedFilters.search) params.search = appliedFilters.search;
      const r = await api.get('/audit-logs', { params });
      setRows(r.data?.rows || []);
      setPagination(r.data?.pagination || { page: 1, limit: 50, total: 0, total_pages: 1 });
    } catch (e) { setError(e.response?.data?.message || e.message); }
    finally { setLoading(false); }
  };
  // Declarative reload: fires on mount, on page change, and whenever
  // appliedFilters is replaced by applyFilters()/resetFilters() below —
  // single source of "when to reload", no imperative load() calls scattered
  // at each call site (which is what caused the stale-closure bug above).
  useEffect(() => { load(); }, [page, appliedFilters]);

  const changeFilter = (k, v) => setFilters(f => ({ ...f, [k]: v }));
  const applyFilters = () => { setPage(1); setAppliedFilters(filters); };
  const resetFilters = () => { setFilters(EMPTY_FILTERS); setPage(1); setAppliedFilters(EMPTY_FILTERS); };

  const openSalesReturn = async (row) => {
    if (salesReturnLoadingId) return;
    try {
      setSalesReturnLoadingId(row.id);
      const detail = (await api.get('/sales-returns/' + row.entity_id)).data;
      setSalesReturnDetail(detail);
    } catch (e) { showError(e.response?.data?.message || e.message || 'Không tải được phiếu trả hàng'); }
    finally { setSalesReturnLoadingId(null); }
  };

  return <SafePage loading={loading} error={error}>
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ margin: 0 }}>Nhật ký hoạt động</h2>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16, alignItems: 'flex-end' }}>
        <label className="field-label"><span>Khoảng ngày</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="date" className="input" style={{ maxWidth: 150 }} value={filters.from_date} onChange={e => changeFilter('from_date', e.target.value)} />
            <input type="date" className="input" style={{ maxWidth: 150 }} value={filters.to_date} onChange={e => changeFilter('to_date', e.target.value)} />
          </div>
        </label>
        <label className="field-label"><span>Hành động</span>
          <select className="select" style={{ minWidth: 180 }} value={filters.action} onChange={e => changeFilter('action', e.target.value)}>
            <option value="">Tất cả hành động</option>
            {Object.keys(ACTION_LABELS).map(a => <option key={a} value={a}>{ACTION_LABELS[a]}</option>)}
          </select>
        </label>
        <label className="field-label"><span>Loại đối tượng</span>
          <select className="select" style={{ minWidth: 160 }} value={filters.entity_type} onChange={e => changeFilter('entity_type', e.target.value)}>
            <option value="">Tất cả loại</option>
            {Object.keys(ENTITY_LABELS).map(t => <option key={t} value={t}>{ENTITY_LABELS[t]}</option>)}
          </select>
        </label>
        <label className="field-label"><span>Người dùng</span>
          <select className="select" style={{ minWidth: 160 }} value={filters.user_id} onChange={e => changeFilter('user_id', e.target.value)}>
            <option value="">Tất cả người dùng</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.full_name || u.username}</option>)}
          </select>
        </label>
        <label className="field-label"><span>Từ khóa</span>
          <input className="input" style={{ maxWidth: 200 }} placeholder="Tìm trong nội dung..." value={filters.search} onChange={e => changeFilter('search', e.target.value)} />
        </label>
        <button type="button" className="btn secondary" onClick={resetFilters}>Xóa lọc</button>
        <button type="button" className="btn" onClick={applyFilters}>Lọc</button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr>
            <th>Thời gian</th><th>Người thực hiện</th><th>Hành động</th>
            <th>Loại đối tượng</th><th>Mã đối tượng</th><th>Nội dung</th><th></th>
          </tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td>{dt(r.created_at)}</td>
                <td>{r.user_name || (r.user_id ? `#${r.user_id}` : '—')}</td>
                <td>{actionLabel(r.action)}</td>
                <td>{entityLabel(r.entity_type)}</td>
                <td>{r.entity_id ?? '—'}</td>
                <td>{truncate(r.note)}</td>
                <td>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button type="button" className="btn secondary" title="Xem chi tiết" onClick={() => setNoteDlg(r)}><Eye size={14} /></button>
                    {r.entity_type === 'sales_returns' && r.entity_id && (
                      <button type="button" className="btn secondary" title="Xem phiếu trả hàng" disabled={salesReturnLoadingId === r.id} onClick={() => openSalesReturn(r)}><FileSearch size={14} /></button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} style={{ textAlign: 'center', color: '#6b7280' }}>Không có nhật ký nào phù hợp.</td></tr>}
          </tbody>
        </table>
      </div>

      {pagination.total_pages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, alignItems: 'center', marginTop: 16 }}>
          <button className="btn secondary" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>← Trước</button>
          <span style={{ fontSize: 13, color: '#6b7280' }}>Trang {pagination.page} / {pagination.total_pages} ({pagination.total} bản ghi)</span>
          <button className="btn secondary" disabled={page >= pagination.total_pages} onClick={() => setPage(p => p + 1)}>Sau →</button>
        </div>
      )}
    </div>

    <Dialog open={!!noteDlg} title="Chi tiết nhật ký" onClose={() => setNoteDlg(null)} maxWidth={560}>
      {noteDlg && <div style={{ display: 'grid', gap: 8 }}>
        <div><b>Thời gian:</b> {dt(noteDlg.created_at)}</div>
        <div><b>Người thực hiện:</b> {noteDlg.user_name || (noteDlg.user_id ? `#${noteDlg.user_id}` : '—')}</div>
        <div><b>Hành động:</b> {actionLabel(noteDlg.action)}</div>
        <div><b>Loại đối tượng:</b> {entityLabel(noteDlg.entity_type)}</div>
        <div><b>Mã đối tượng:</b> {noteDlg.entity_id ?? '—'}</div>
        <div><b>Nội dung:</b></div>
        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#f9fafb', borderRadius: 8, padding: 10 }}>{noteDlg.note || '—'}</div>
      </div>}
    </Dialog>

    <ReturnDetailDialog
      detail={salesReturnDetail}
      onClose={() => setSalesReturnDetail(null)}
      onPrint={printReturn}
      canReview={false}
      onCancel={() => {}} onReceive={() => {}} onInspect={() => {}} onComplete={() => {}} onReject={() => {}}
      completingId={null}
    />
  </SafePage>;
}
