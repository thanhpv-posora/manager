import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Trash2, ExternalLink } from 'lucide-react';
import api from '../api/api';
import SafePage from '../components/SafePage';
import { showSuccess, showError, showWarning } from '../utils/toast';
import EnterpriseAutocomplete from '../components/common/EnterpriseAutocomplete';
import MoneyInput from '../components/MoneyInput';
import { formatQty } from '../utils/quantity';

const STATUS_LABEL = {
  DRAFT: 'Nháp',
  CONFIRMED: 'Đã xác nhận',
  PARTIAL_RECEIVED: 'Nhận một phần',
  RECEIVED: 'Đã nhận đủ',
  SHORT_CLOSED: 'Đã đóng phần còn lại',
  CANCELLED: 'Đã hủy',
};
const STATUS_STYLE = {
  DRAFT:            { background: '#f3f4f6', color: '#374151' },
  CONFIRMED:        { background: '#dcfce7', color: '#166534' },
  PARTIAL_RECEIVED: { background: '#fef9c3', color: '#854d0e' },
  RECEIVED:         { background: '#bbf7d0', color: '#166534' },
  SHORT_CLOSED:     { background: '#e5e7eb', color: '#4b5563' },
  CANCELLED:        { background: '#fee2e2', color: '#991b1b' },
};
const badge = s => ({
  ...STATUS_STYLE[s] || {},
  border: '1px solid currentColor', borderRadius: 4, padding: '2px 9px', fontSize: 12,
  fontWeight: 700, letterSpacing: 0.2, display: 'inline-block',
});

// ── Receive History Timeline (S4.3) ───────────────────────────────────────
const RECEIVE_STATUS_LABEL = { PENDING: 'Chờ nhập kho', RECEIVED: 'Đã nhập kho', CANCELLED: 'Đã hủy' };
const RECEIVE_STATUS_STYLE = {
  PENDING:   { background: '#fef9c3', color: '#854d0e' },
  RECEIVED:  { background: '#dcfce7', color: '#166534' },
  CANCELLED: { background: '#fee2e2', color: '#991b1b' },
};
const receiveBadge = s => ({
  ...(RECEIVE_STATUS_STYLE[s] || { background: '#f3f4f6', color: '#374151' }),
  border: '1px solid currentColor', borderRadius: 4, padding: '2px 9px', fontSize: 12,
  fontWeight: 700, letterSpacing: 0.2, display: 'inline-block',
});
const LBL = { fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 3, color: '#374151' };
const REQ = <span style={{ color: '#ef4444' }}> *</span>;

function todayISO() { return new Date().toISOString().slice(0, 10); }
const fmt    = n => Math.round(Number(n || 0)).toLocaleString('en-US');
const fmtQty = formatQty;
const fmtDate = s => s ? String(s).slice(0, 10) : '—';
// dd/mm/yyyy hh:mm — used for timeline event_time, which is a full datetime (unlike receive_date/DATE fields above)
const fmtDateTime = s => {
  if (!s) return '—';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return fmtDate(s);
  const [, y, mo, d, h, mi] = m;
  return `${d}/${mo}/${y} ${h}:${mi}`;
};
const mkHdr = () => ({ partner_id: '', purchase_date: todayISO(), note: '', reference_no: '' });
const PRODUCT_SEARCH_FIELDS = ['name', 'product_code'];

// ── Merge catalog rows with existing PO items into unified grid ───────────────
function mergePoRows(catalogItems, existingItems) {
  const rows = [];
  const existingByProduct = {};
  for (const it of existingItems) existingByProduct[String(it.product_id)] = it;
  const seen = new Set();

  for (const cat of catalogItems) {
    const ex = existingByProduct[String(cat.product_id)];
    seen.add(String(cat.product_id));
    rows.push({
      product_id:              cat.product_id,
      product_name:            cat.product_name,
      product_code:            cat.product_code || null,
      category_name:           cat.category_name || null,
      spo_id:                  ex?.supplier_purchase_option_id || cat.default_spo_id || null,
      purchase_price:          ex ? String(ex.purchase_price || '') : String(cat.purchase_price || ''),
      quantity:                ex ? String(ex.quantity || '') : '',
      note:                    ex ? (ex.note || '') : '',
      unit_label:              ex?.unit || cat.default_spo_label || null,
      spos:                    cat.spos || [],
      item_id:                 ex?.id || null,
      expected_conversion_qty: ex?.expected_conversion_qty ?? null,
      expected_stock_qty:      ex?.expected_stock_qty ?? null,
    });
  }

  for (const it of existingItems) {
    if (!seen.has(String(it.product_id))) {
      rows.push({
        product_id:              it.product_id,
        product_name:            it.product_name,
        product_code:            null,
        category_name:           null,
        spo_id:                  it.supplier_purchase_option_id || null,
        purchase_price:          String(it.purchase_price || ''),
        quantity:                String(it.quantity || ''),
        note:                    it.note || '',
        unit_label:              it.unit || null,
        spos:                    [],
        item_id:                 it.id,
        expected_conversion_qty: it.expected_conversion_qty ?? null,
        expected_stock_qty:      it.expected_stock_qty ?? null,
      });
    }
  }
  return rows;
}

function focusGridCell(rowIndex, field) {
  const el = document.querySelector(`[data-po-row-index="${rowIndex}"][data-po-field="${field}"]`);
  if (el) el.focus();
}

// ── Main component ───────────────────────────────────────────────────────────
export default function InventoryPurchases() {
  // master data
  const [partners, setPartners] = useState([]);
  const [allProducts, setAllProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [masterLoading, setMasterLoading] = useState(true);
  const [masterError, setMasterError] = useState('');

  // list view
  const [view, setView] = useState('list');
  const [orders, setOrders] = useState([]);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterSup, setFilterSup] = useState('');
  const [listLoading, setListLoading] = useState(false);

  // order detail
  const [order, setOrder] = useState(null);
  const [orderLoading, setOrderLoading] = useState(false);
  const [detailTab, setDetailTab] = useState('detail'); // 'detail' | 'timeline'

  // receive history timeline (S4.3, read-only)
  const [timeline, setTimeline] = useState([]);
  const [timelineSummary, setTimelineSummary] = useState(null);
  const [timelinePage, setTimelinePage] = useState(1);
  const [timelineTotal, setTimelineTotal] = useState(0);
  const TIMELINE_PAGE_SIZE = 20;
  const [timelineLoading, setTimelineLoading] = useState(false);

  // header form
  const [hdrForm, setHdrForm] = useState(mkHdr());
  const [hdrEditing, setHdrEditing] = useState(false);
  const [hdrSaving, setHdrSaving] = useState(false);

  // unified PO detail grid (catalog rows merged with existing items)
  const [poRows, setPoRows]               = useState([]);
  const [gridSaving, setGridSaving]       = useState(false);

  // catalog loader
  const [catalog, setCatalog]               = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogCalType, setCatalogCalType] = useState('SOLAR');

  // "Thêm sản phẩm" dialog state
  const [addDlg, setAddDlg]                       = useState(null);
  const [addDlgOpts, setAddDlgOpts]               = useState([]);
  const [addDlgOptsLoading, setAddDlgOptsLoading] = useState(false);
  const [addDlgSaving, setAddDlgSaving]           = useState(false);
  const [statusSaving, setStatusSaving]           = useState(false);
  const addDlgProductRef                          = useRef();

  // short close dialog
  const [shortCloseDlg, setShortCloseDlg]         = useState(false);
  const [shortCloseReason, setShortCloseReason]   = useState('');
  const [shortCloseSaving, setShortCloseSaving]   = useState(false);

  // ── Master data ────────────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      api.get('/partners', { params: { role: 'supplier' } }),
      api.get('/products'),
      api.get('/products/categories'),
    ]).then(([s, p, c]) => {
      setPartners(s.data || []);
      setAllProducts((p.data || []).filter(x => (x.inventory_mode === 'TRACK_STOCK' || x.inventory_mode === 'STOCK') && !x.del_flg));
      setCategories(c.data || []);
    }).catch(e => setMasterError(e.response?.data?.message || e.message))
      .finally(() => setMasterLoading(false));
  }, []);

  // ── List ───────────────────────────────────────────────────────────────────
  const loadList = useCallback(async () => {
    setListLoading(true);
    try {
      const params = {};
      if (filterStatus) params.status    = filterStatus;
      if (filterSup)    params.partner_id = filterSup;
      const r = await api.get('/inventory-purchases', { params });
      setOrders(r.data?.items || []);
    } catch (e) { showError(e.response?.data?.message || e.message || 'Không tải được danh sách'); }
    finally { setListLoading(false); }
  }, [filterStatus, filterSup]);

  useEffect(() => { if (view === 'list') loadList(); }, [view, loadList]);

  // ── Order detail ───────────────────────────────────────────────────────────
  const loadOrder = useCallback(async id => {
    setOrderLoading(true);
    try {
      const r = await api.get(`/inventory-purchases/${id}`);
      setOrder(r.data);
    } catch (e) {
      showError(e.response?.data?.message || e.message || 'Lỗi tải phiếu');
      setView('list');
    } finally { setOrderLoading(false); }
  }, []);

  // ── Load supplier catalog (DRAFT orders only) ─────────────────────────────
  useEffect(() => {
    if (!order?.partner_id || order?.status !== 'DRAFT') { setCatalog([]); return; }
    setCatalogLoading(true);
    const pDate = String(order.purchase_date || todayISO()).slice(0, 10);
    api.get('/supplier-catalog', { params: { partner_id: order.partner_id, purchase_date: pDate, calendar_type: catalogCalType } })
      .then(r => setCatalog(r.data?.items || []))
      .catch(() => setCatalog([]))
      .finally(() => setCatalogLoading(false));
  }, [order?.id, order?.partner_id, order?.purchase_date, catalogCalType, order?.status]);

  // ── Merge catalog + existing items into unified grid ──────────────────────
  useEffect(() => {
    setPoRows(mergePoRows(catalog, order?.items || []));
  }, [catalog, order?.items]);

  // ── Receive History Timeline (S4.3, read-only) ────────────────────────────
  const loadTimeline = useCallback(async (id, page) => {
    setTimelineLoading(true);
    try {
      const r = await api.get(`/inventory-purchases/${id}/timeline`, {
        params: { page, pageSize: TIMELINE_PAGE_SIZE },
      });
      setTimeline(r.data?.items || []);
      setTimelineSummary(r.data?.summary || null);
      setTimelineTotal(Number(r.data?.total || 0));
    } catch (e) {
      showError(e.response?.data?.message || e.message || 'Không tải được lịch sử nhận hàng');
      setTimeline([]);
      setTimelineSummary(null);
      setTimelineTotal(0);
    } finally { setTimelineLoading(false); }
  }, []);

  // Fetched regardless of active tab — the lifecycle summary (expected/received/
  // remaining/completion%) is also shown in the ERP header, not just the Timeline tab.
  useEffect(() => {
    if (order?.id) loadTimeline(order.id, timelinePage);
  }, [order?.id, timelinePage, loadTimeline]);

  // ── Add-dialog SPO load ────────────────────────────────────────────────────
  useEffect(() => {
    if (!addDlg?.product_id || !order?.partner_id) { setAddDlgOpts([]); return; }
    setAddDlgOptsLoading(true);
    api.get('/supplier-purchase-options', { params: { partner_id: order.partner_id, product_id: addDlg.product_id } })
      .then(r => setAddDlgOpts(r.data || []))
      .catch(() => setAddDlgOpts([]))
      .finally(() => setAddDlgOptsLoading(false));
  }, [addDlg?.product_id, order?.partner_id]);

  // ── Esc closes Add Product dialog ─────────────────────────────────────────
  useEffect(() => {
    if (!addDlg) return;
    const handler = e => { if (e.key === 'Escape') { setAddDlg(null); setAddDlgOpts([]); } };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [addDlg]);

  // ── Navigation ─────────────────────────────────────────────────────────────
  const openNew = () => {
    setView('order'); setOrder(null); setPoRows([]); setDetailTab('detail'); setTimeline([]); setTimelinePage(1);
    setHdrForm(mkHdr()); setHdrEditing(true);
  };

  const openOrder = async id => {
    setView('order'); setOrder(null); setPoRows([]); setHdrEditing(false); setDetailTab('detail'); setTimeline([]); setTimelinePage(1);
    await loadOrder(id);
  };

  const goList = () => { setView('list'); setOrder(null); setPoRows([]); setDetailTab('detail'); setTimeline([]); setTimelinePage(1); };

  // ── Header CRUD ────────────────────────────────────────────────────────────
  const saveHeader = async () => {
    if (!hdrForm.partner_id)   { showWarning('Chọn nhà cung cấp'); return; }
    if (!hdrForm.purchase_date) { showWarning('Chọn ngày nhập'); return; }
    setHdrSaving(true);
    try {
      if (!order) {
        const r = await api.post('/inventory-purchases', hdrForm);
        showSuccess(`Tạo phiếu ${r.data.order_code} thành công`);
        setHdrEditing(false);
        await loadOrder(r.data.id);
      } else {
        await api.put(`/inventory-purchases/${order.id}`, hdrForm);
        showSuccess('Đã cập nhật phiếu mua hàng');
        setHdrEditing(false);
        await loadOrder(order.id);
      }
    } catch (e) { showError(e.response?.data?.message || e.message || 'Lưu thất bại'); }
    finally { setHdrSaving(false); }
  };

  const startEditHdr = () => {
    setHdrForm({
      partner_id:    String(order.partner_id || ''),
      purchase_date:  fmtDate(order.purchase_date),
      note:           order.note || '',
      reference_no:   order.reference_no || '',
    });
    setHdrEditing(true);
  };

  // ── PO grid handlers ───────────────────────────────────────────────────────
  const updatePoRow = (idx, field, value) =>
    setPoRows(prev => prev.map((r, i) => i === idx ? { ...r, [field]: value } : r));

  const removePoRow = idx =>
    setPoRows(prev => prev.filter((_, i) => i !== idx));

  const savePoGrid = async () => {
    if (!order) return;
    setGridSaving(true);
    try {
      const rows = poRows.map(r => ({
        item_id:                     r.item_id || null,
        product_id:                  r.product_id,
        supplier_purchase_option_id: r.spo_id || null,
        quantity:                    Number(String(r.quantity || '0').replace(',', '.')),
        purchase_price:              Number(r.purchase_price || 0),
        note:                        r.note || null,
      }));
      const res = await api.post(`/inventory-purchases/${order.id}/sync`, { rows });
      showSuccess(res.data.message || 'Đã lưu phiếu mua hàng');
      await loadOrder(order.id);
    } catch (e) { showError(e.response?.data?.message || e.message || 'Lưu thất bại'); }
    finally { setGridSaving(false); }
  };

  // ── Status change ──────────────────────────────────────────────────────────
  const changeStatus = async status => {
    if (statusSaving) return;
    const isCancelling = status === 'CANCELLED';
    const ok = window.appConfirm
      ? await window.appConfirm(
          isCancelling
            ? `Bạn có chắc chắn muốn hủy phiếu mua hàng ${order.order_code}?\n\nThao tác này không thể hoàn tác.`
            : `Xác nhận phiếu ${order.order_code}?`,
          {
            title: isCancelling ? 'Hủy phiếu mua hàng' : 'Xác nhận phiếu mua hàng',
            confirmText: isCancelling ? 'Hủy phiếu' : 'Xác nhận',
            cancelText: 'Đóng',
            variant: isCancelling ? 'danger' : 'primary',
          }
        )
      : window.confirm(isCancelling ? `Hủy phiếu ${order.order_code}?` : `Xác nhận phiếu ${order.order_code}?`);
    if (!ok) return;
    setStatusSaving(true);
    try {
      const r = await api.patch(`/inventory-purchases/${order.id}/status`, { status });
      showSuccess(r.data.message || 'Thành công');
      await loadOrder(order.id);
    } catch (e) { showError(e.response?.data?.message || e.message || 'Lỗi'); }
    finally { setStatusSaving(false); }
  };

  // ── Short close ────────────────────────────────────────────────────────────
  const openShortCloseDlg = () => { setShortCloseReason(''); setShortCloseDlg(true); };

  const submitShortClose = async () => {
    if (!shortCloseReason.trim()) { showWarning('Cần nhập lý do đóng phần còn lại'); return; }
    setShortCloseSaving(true);
    try {
      const r = await api.patch(`/inventory-purchases/${order.id}/short-close`, { reason: shortCloseReason.trim() });
      showSuccess(r.data.message || 'Đã đóng phần còn lại');
      setShortCloseDlg(false);
      await loadOrder(order.id);
    } catch (e) { showError(e.response?.data?.message || e.message || 'Lỗi'); }
    finally { setShortCloseSaving(false); }
  };

  // ── Add-dialog: open / save ────────────────────────────────────────────────
  const openAddDlg = () => {
    setAddDlg({ product_id: '', spo_id: '', price: '', qty: '', note: '', saveToCatalog: true });
    setAddDlgOpts([]);
    setTimeout(() => addDlgProductRef.current?.focus(), 60);
  };

  const saveAddDlg = async () => {
    if (!addDlg) return;
    if (!addDlg.product_id) { showWarning('Chọn sản phẩm'); addDlgProductRef.current?.focus(); return; }
    if (!(Number(addDlg.qty) > 0)) { showWarning('Số lượng phải lớn hơn 0'); return; }
    setAddDlgSaving(true);
    try {
      if (addDlg.saveToCatalog && order?.supplier_id && Number(addDlg.price) > 0) {
        await api.post('/supplier-purchase-price', {
          supplier_id:    Number(order.supplier_id),
          product_id:     Number(addDlg.product_id),
          purchase_price: Number(addDlg.price),
        });
      }
      const prod = allProducts.find(p => String(p.id) === String(addDlg.product_id));
      const newRow = {
        product_id:     Number(addDlg.product_id),
        product_name:   prod?.name || '',
        product_code:   prod?.product_code || null,
        category_name:  null,
        spo_id:         addDlg.spo_id ? Number(addDlg.spo_id) : null,
        purchase_price: String(addDlg.price || ''),
        quantity:       String(addDlg.qty || ''),
        note:           addDlg.note || '',
        unit_label:     null,
        spos:           addDlgOpts.map(o => ({ id: o.id, label: spoLabel(o), conversion_qty: o.default_conversion_qty, unit_name: o.unit_name })),
        item_id:        null,
      };
      setPoRows(prev => {
        const idx = prev.findIndex(r => String(r.product_id) === String(addDlg.product_id));
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], ...newRow, item_id: updated[idx].item_id };
          return updated;
        }
        return [...prev, newRow];
      });
      showSuccess('Đã thêm sản phẩm vào phiếu. Nhấn "Lưu nháp" để lưu.');
      setAddDlg(null);
      setAddDlgOpts([]);
    } catch (e) { showError(e.response?.data?.message || e.message || 'Thêm thất bại'); }
    finally { setAddDlgSaving(false); }
  };

  // ── Derived ────────────────────────────────────────────────────────────────
  const isDraft  = order?.status === 'DRAFT';
  // Short Close closes the remainder after a partial receipt — must not double as cancel.
  // Matches the backend guard in InventoryPurchaseAgent.shortClose() (PARTIAL_RECEIVED, or
  // CONFIRMED with total received_stock_qty > 0).
  const canShortClose = order?.status === 'PARTIAL_RECEIVED' || Number(timelineSummary?.received_qty || 0) > 0;
  const spoLabel = o => o.display_label || `${o.unit_name} (${o.default_conversion_qty}kg)`;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <SafePage loading={masterLoading} error={masterError}>

      {/* ══════════════════════ LIST VIEW ═════════════════════════════════════ */}
      {view === 'list' && <>
        <div className="card" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label style={LBL}>Trạng thái</label>
            <select className="select" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              <option value="">Tất cả</option>
              <option value="DRAFT">Nháp</option>
              <option value="CONFIRMED">Đã xác nhận</option>
              <option value="CANCELLED">Đã hủy</option>
            </select>
          </div>
          <div>
            <label style={LBL}>Nhà cung cấp</label>
            <select className="select" value={filterSup} onChange={e => setFilterSup(e.target.value)}>
              <option value="">Tất cả</option>
              {partners.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <button className="btn secondary" onClick={loadList} disabled={listLoading}>Tải lại</button>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={openNew}>+ Tạo phiếu mua hàng</button>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Phiếu mua hàng ({orders.length})</h3>
          {listLoading && <p className="muted">Đang tải...</p>}
          {!listLoading && <table className="table">
            <thead><tr>
              <th>Mã phiếu</th><th>Nhà cung cấp</th><th>Ngày nhập</th>
              <th>Số tham chiếu</th><th style={{ textAlign: 'right' }}>Số dòng</th>
              <th style={{ textAlign: 'right' }}>Tổng tiền</th><th>Trạng thái</th><th></th>
            </tr></thead>
            <tbody>
              {orders.map(o => (
                <tr key={o.id}>
                  <td><b>{o.order_code}</b></td>
                  <td>{o.supplier_name || '—'}</td>
                  <td>{fmtDate(o.purchase_date)}</td>
                  <td>{o.reference_no || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{o.item_count || 0}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(o.total_amount)} ₫</td>
                  <td><span style={badge(o.status)}>{STATUS_LABEL[o.status] || o.status}</span></td>
                  <td>
                    <button className="btn secondary" onClick={() => openOrder(o.id)}>
                      {o.status === 'DRAFT' ? 'Sửa' : 'Xem'}
                    </button>
                  </td>
                </tr>
              ))}
              {!orders.length && <tr><td colSpan={8} style={{ textAlign: 'center', padding: '28px 0' }}>
                <p className="muted">Chưa có phiếu mua hàng nào.</p>
              </td></tr>}
            </tbody>
          </table>}
        </div>
      </>}

      {/* ══════════════════════ ORDER VIEW ════════════════════════════════════ */}
      {view === 'order' && <>
        <div style={{ marginBottom: 12 }}>
          <button className="btn secondary" onClick={goList}>← Danh sách</button>
        </div>

        {orderLoading && <div className="card"><p className="muted">Đang tải phiếu mua hàng...</p></div>}

        {!orderLoading && <>

          {/* ── Header card ── */}
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>
                {/* CEO review: Status moved into the ERP Summary section below (Expected/Received/Remaining/Completion/Status) */}
                {order ? order.order_code : 'Phiếu mua hàng mới'}
              </h3>
              {order && isDraft && !hdrEditing && (
                <button className="btn secondary" onClick={startEditHdr}>Sửa thông tin</button>
              )}
            </div>

            {hdrEditing ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 20px' }}>
                  <div>
                    <label style={LBL}>Nhà cung cấp{REQ}</label>
                    <select className="select" value={hdrForm.partner_id}
                      onChange={e => setHdrForm(f => ({ ...f, partner_id: e.target.value }))}>
                      <option value="">Chọn nhà cung cấp...</option>
                      {partners.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={LBL}>Ngày nhập{REQ}</label>
                    <input className="input" type="date" value={hdrForm.purchase_date}
                      onChange={e => setHdrForm(f => ({ ...f, purchase_date: e.target.value }))} />
                  </div>
                  <div>
                    <label style={LBL}>Số tham chiếu (tuỳ chọn)</label>
                    <input className="input" placeholder="Ví dụ: INV-2024-001"
                      value={hdrForm.reference_no}
                      onChange={e => setHdrForm(f => ({ ...f, reference_no: e.target.value }))} />
                  </div>
                  <div>
                    <label style={LBL}>Ghi chú</label>
                    <input className="input" placeholder="Ghi chú..."
                      value={hdrForm.note}
                      onChange={e => setHdrForm(f => ({ ...f, note: e.target.value }))} />
                  </div>
                </div>
                <div className="actions" style={{ marginTop: 12 }}>
                  <button className="btn" onClick={saveHeader} disabled={hdrSaving}>
                    {hdrSaving ? 'Đang lưu...' : (order ? 'Lưu thay đổi' : 'Tạo phiếu mua hàng')}
                  </button>
                  {order && <button className="btn secondary" onClick={() => setHdrEditing(false)}>Đóng</button>}
                </div>
              </>
            ) : order && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '8px 16px', fontSize: 14 }}>
                  <div><span style={{ color: '#6b7280', fontSize: 12 }}>Nhà cung cấp</span><div><b>{order.supplier_name || '—'}</b></div></div>
                  <div><span style={{ color: '#6b7280', fontSize: 12 }}>Ngày nhập</span><div><b>{fmtDate(order.purchase_date)}</b></div></div>
                  <div><span style={{ color: '#6b7280', fontSize: 12 }}>Số tham chiếu</span><div>{order.reference_no || '—'}</div></div>
                  <div><span style={{ color: '#6b7280', fontSize: 12 }}>Ghi chú</span><div>{order.note || '—'}</div></div>
                </div>

                {/* ERP lifecycle summary — reuses the existing timeline API's summary object, no new endpoint.
                    CEO review: Status lives here now (Expected/Received/Remaining/Completion/Status), not on the title. */}
                {timelineSummary && (
                  <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #e5e7eb' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: '8px 16px', fontSize: 14, marginBottom: 10 }}>
                      <div><span style={{ color: '#6b7280', fontSize: 12 }}>Dự kiến (kg)</span><div><b>{fmtQty(timelineSummary.expected_qty)}</b></div></div>
                      <div><span style={{ color: '#6b7280', fontSize: 12 }}>Đã nhận (kg)</span><div><b style={{ color: '#166534' }}>{fmtQty(timelineSummary.received_qty)}</b></div></div>
                      <div><span style={{ color: '#6b7280', fontSize: 12 }}>Còn lại (kg)</span><div><b style={{ color: timelineSummary.remaining_qty > 0.001 ? '#b45309' : '#9ca3af' }}>{fmtQty(timelineSummary.remaining_qty)}</b></div></div>
                      <div><span style={{ color: '#6b7280', fontSize: 12 }}>Hoàn thành</span><div><b>{fmtQty(timelineSummary.completion_percent)}%</b></div></div>
                      <div><span style={{ color: '#6b7280', fontSize: 12 }}>Trạng thái</span><div><span style={badge(order.status)}>{STATUS_LABEL[order.status] || order.status}</span></div></div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4, fontSize: 12 }}>
                      <span style={{ color: '#374151' }}>
                        <b>{fmtQty(timelineSummary.received_qty)}</b> / {fmtQty(timelineSummary.expected_qty)} kg
                      </span>
                      <span style={{ fontWeight: 700, color: '#374151' }}>{fmtQty(timelineSummary.completion_percent)}%</span>
                    </div>
                    <div style={{ height: 10, borderRadius: 4, background: '#e5e7eb', overflow: 'hidden' }}>
                      <div style={{
                        height: '100%',
                        width: `${Math.min(100, Math.max(0, timelineSummary.completion_percent))}%`,
                        background: timelineSummary.completion_percent >= 100 ? '#16a34a' : '#3b82f6',
                      }} />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── Tabs ── */}
          {order && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button className={detailTab === 'detail' ? 'btn' : 'btn secondary'} onClick={() => setDetailTab('detail')}>
                Chi tiết
              </button>
              <button className={detailTab === 'timeline' ? 'btn' : 'btn secondary'} onClick={() => setDetailTab('timeline')}>
                Lịch sử nhận hàng
              </button>
            </div>
          )}

          {detailTab === 'detail' && <>

          {/* ── Unified PO Detail Grid ── */}
          {order && (
            <div className="card" style={{ padding: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap' }}>
                <div style={{ flex: 1 }}>
                  <b style={{ fontSize: 16 }}>Chi tiết phiếu mua hàng</b>
                  {catalogLoading && <span style={{ marginLeft: 8, color: '#6b7280', fontSize: 12 }}>Đang tải danh mục...</span>}
                  {!catalogLoading && catalog.length > 0 && (
                    <span style={{ marginLeft: 8, color: '#6b7280', fontSize: 12 }}>{catalog.length} sản phẩm từ danh mục NCC</span>
                  )}
                </div>
                {isDraft && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <select className="select" style={{ fontSize: 12, width: 130 }}
                      value={catalogCalType}
                      onChange={e => setCatalogCalType(e.target.value)}>
                      <option value="SOLAR">Dương lịch</option>
                      <option value="LUNAR">Âm lịch</option>
                    </select>
                    <button className="btn secondary" onClick={openAddDlg}>+ Thêm sản phẩm</button>
                    <button className="btn" onClick={savePoGrid}
                      disabled={gridSaving || !poRows.some(r => Number(r.quantity) > 0)}>
                      {gridSaving ? 'Đang lưu...' : 'Lưu nháp'}
                    </button>
                  </div>
                )}
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table className="table" style={{ minWidth: 920 }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      <th style={{ minWidth: 160 }}>Sản phẩm</th>
                      <th style={{ width: 100 }}>Đơn vị</th>
                      <th style={{ width: 90, textAlign: 'right' }}>Số lượng nhập</th>
                      <th style={{ width: 110, textAlign: 'right' }}>Số lượng quy đổi (kg)</th>
                      <th style={{ width: 120, textAlign: 'right' }}>Đơn giá (đ/kg)</th>
                      <th style={{ width: 130, textAlign: 'right' }}>Thành tiền (đ)</th>
                      <th style={{ minWidth: 100 }}>Ghi chú</th>
                      {isDraft && <th style={{ width: 44 }}></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {poRows.length === 0 && !catalogLoading && (
                      <tr><td colSpan={isDraft ? 8 : 7} style={{ textAlign: 'center', padding: '28px 0' }}>
                        <p className="muted">
                          {order.partner_id
                            ? 'Nhà cung cấp chưa có sản phẩm trong danh mục. Nhấn "+ Thêm sản phẩm" để thêm.'
                            : 'Chưa có sản phẩm nào.'}
                        </p>
                      </td></tr>
                    )}
                    {catalogLoading && poRows.length === 0 && (
                      <tr><td colSpan={isDraft ? 8 : 7} style={{ textAlign: 'center', padding: '20px 0' }}>
                        <p className="muted">Đang tải danh mục...</p>
                      </td></tr>
                    )}
                    {poRows.map((row, idx) => {
                      const qty          = Number(row.quantity || 0);
                      const price        = Number(row.purchase_price || 0);
                      const activeSpo    = row.spos?.find(s => String(s.id) === String(row.spo_id)) || null;
                      const draftUnit    = activeSpo?.unit_name || '';
                      const draftConv    = Number(activeSpo?.conversion_qty ?? 1);
                      const readConv     = Number(row.expected_conversion_qty ?? 1);
                      const readStock    = Number(row.expected_stock_qty ?? 0);
                      // line total = converted_qty × price/kg (CEO business rule)
                      const convertedQty = isDraft
                        ? qty * draftConv
                        : (readStock > 0 ? readStock : qty * readConv);
                      const lineTotal    = convertedQty * price;
                      return (
                        <tr key={`${row.product_id}-${row.item_id ?? 'new'}`}
                          style={{ background: qty > 0 ? '#f0fdf4' : undefined }}>
                          <td>
                            <b style={{ fontSize: 13, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }} title={row.product_name}>{row.product_name}</b>
                            {row.product_code && <div style={{ fontSize: 12, color: '#6b7280' }}>{row.product_code}</div>}
                          </td>
                          <td>
                            {isDraft && row.spos && row.spos.length > 1 ? (
                              <select className="select" style={{ fontSize: 12, minWidth: 120 }}
                                value={row.spo_id || ''}
                                onChange={e => updatePoRow(idx, 'spo_id', Number(e.target.value) || null)}>
                                <option value="">kg</option>
                                {row.spos.map(s => <option key={s.id} value={s.id}>{s.unit_name}</option>)}
                              </select>
                            ) : (
                              <span style={{ fontSize: 13 }}>{activeSpo?.unit_name || row.unit_label || 'kg'}</span>
                            )}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {isDraft ? (
                              <input className="input"
                                  data-po-row-index={idx}
                                  data-po-field="quantity"
                                  type="text"
                                  inputMode="decimal"
                                  placeholder="0"
                                  style={{ width: 68, textAlign: 'right' }}
                                  value={row.quantity}
                                  onChange={e => updatePoRow(idx, 'quantity', e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter' || e.key === 'ArrowDown') {
                                      e.preventDefault();
                                      focusGridCell(idx + 1, 'quantity');
                                    } else if (e.key === 'ArrowUp') {
                                      e.preventDefault();
                                      focusGridCell(idx - 1, 'quantity');
                                    }
                                  }}
                                />
                            ) : (
                              <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                                {fmtQty(row.quantity)}
                              </span>
                            )}
                          </td>
                          <td style={{ textAlign: 'right', color: '#374151' }}>
                            {qty > 0 ? (
                              <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                                {fmtQty(convertedQty)}
                              </span>
                            ) : <span style={{ color: '#9ca3af' }}>—</span>}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {isDraft ? (
                              <MoneyInput
                                data-po-row-index={idx}
                                data-po-field="price"
                                style={{ width: 110, textAlign: 'right' }}
                                value={Number(row.purchase_price || 0)}
                                onChange={v => updatePoRow(idx, 'purchase_price', v)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    focusGridCell(idx + 1, 'quantity');
                                  }
                                }} />
                            ) : (
                              <span style={{ fontWeight: 600, fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{fmt(row.purchase_price)}</span>
                            )}
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: lineTotal > 0 ? 'inherit' : '#9ca3af', fontVariantNumeric: 'tabular-nums' }}>
                            {lineTotal > 0 ? fmt(lineTotal) : '—'}
                          </td>
                          <td>
                            {isDraft ? (
                              <input className="input" placeholder="Ghi chú..." style={{ width: 110 }}
                                value={row.note}
                                onChange={e => updatePoRow(idx, 'note', e.target.value)} />
                            ) : (
                              <span style={{ fontSize: 13, color: '#6b7280' }}>{row.note || '—'}</span>
                            )}
                          </td>
                          {isDraft && (
                            <td>
                              <button className="btn danger" title="Xóa hàng" onClick={() => removePoRow(idx)}
                                style={{ padding: 0, width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                                <Trash2 size={14} />
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                  {poRows.some(r => Number(r.quantity || 0) > 0) && (
                    <tfoot>
                      <tr style={{ background: '#f9fafb', fontWeight: 700 }}>
                        <td colSpan={2} style={{ textAlign: 'right', paddingRight: 12, color: '#374151', fontSize: 13 }}>Tổng cộng:</td>
                        <td style={{ fontWeight: 700, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {fmtQty(poRows.reduce((a, r) => a + Number(r.quantity || 0), 0))}
                        </td>
                        <td></td>
                        <td></td>
                        <td style={{ textAlign: 'right', fontSize: 15, fontVariantNumeric: 'tabular-nums' }}>
                          {fmt(poRows.reduce((a, r) => {
                            const q = Number(r.quantity || 0);
                            if (q <= 0) return a;
                            const p = Number(r.purchase_price || 0);
                            const spo = r.spos?.find(s => String(s.id) === String(r.spo_id)) || null;
                            const conv = isDraft ? Number(spo?.conversion_qty ?? 1) : Number(r.expected_conversion_qty ?? 1);
                            const stock = isDraft ? q * conv : (Number(r.expected_stock_qty || 0) || q * conv);
                            return a + stock * p;
                          }, 0))}
                        </td>
                        <td colSpan={isDraft ? 2 : 1}></td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          )}

          {/* Confirm / Cancel — DRAFT: primary business action first, destructive separated to the right */}
          {order && isDraft && <div className="card">
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button className="btn" onClick={() => changeStatus('CONFIRMED')}
                disabled={!(order?.items?.length > 0) || statusSaving}>
                Xác nhận phiếu mua hàng
              </button>
              <button className="btn danger" style={{ marginLeft: 'auto' }}
                onClick={() => changeStatus('CANCELLED')} disabled={statusSaving}>
                Hủy phiếu
              </button>
            </div>
            {!(order?.items?.length > 0) && (
              <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                Lưu ít nhất 1 dòng hàng trước khi xác nhận.
              </p>
            )}
          </div>}

          {/* Short Close (CONFIRMED / PARTIAL_RECEIVED) + Cancel (CONFIRMED only, no received inventory) —
              primary business action first, destructive separated to the right */}
          {order && (order.status === 'CONFIRMED' || order.status === 'PARTIAL_RECEIVED') && <div className="card">
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button className="btn" onClick={openShortCloseDlg} disabled={statusSaving || !canShortClose}
                title={!canShortClose ? 'Chỉ dùng khi phiếu đã nhận hàng một phần' : undefined}>
                Đóng phần còn lại
              </button>
              {order.status === 'CONFIRMED' && (
                <button className="btn danger" style={{ marginLeft: 'auto' }}
                  onClick={() => changeStatus('CANCELLED')} disabled={statusSaving}>
                  Hủy phiếu
                </button>
              )}
            </div>
          </div>}

          {/* Short close reason — SHORT_CLOSED */}
          {order && order.status === 'SHORT_CLOSED' && order.short_close_reason && <div className="card">
            <span style={{ color: '#6b7280', fontSize: 12 }}>Lý do đóng phần còn lại</span>
            <div style={{ marginTop: 4 }}>{order.short_close_reason}</div>
          </div>}

          </>}

          {/* ── Receive History Timeline (read-only) ── */}
          {detailTab === 'timeline' && order && (
            <>
              {/* Summary cards */}
              {timelineSummary && (
                <div className="card">
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: '8px 16px', fontSize: 14 }}>
                    <div><span style={{ color: '#6b7280', fontSize: 12 }}>Đặt hàng (kg)</span><div><b>{fmtQty(timelineSummary.expected_qty)}</b></div></div>
                    <div><span style={{ color: '#6b7280', fontSize: 12 }}>Đã nhận (kg)</span><div><b>{fmtQty(timelineSummary.received_qty)}</b></div></div>
                    <div><span style={{ color: '#6b7280', fontSize: 12 }}>Còn lại (kg)</span><div><b>{fmtQty(timelineSummary.remaining_qty)}</b></div></div>
                    <div><span style={{ color: '#6b7280', fontSize: 12 }}>Hoàn thành</span><div><b>{fmtQty(timelineSummary.completion_percent)}%</b></div></div>
                    <div><span style={{ color: '#6b7280', fontSize: 12 }}>Số lần nhận</span><div><b>{timelineSummary.receive_count}</b></div></div>
                    <div><span style={{ color: '#6b7280', fontSize: 12 }}>Trạng thái</span><div><span style={badge(timelineSummary.status)}>{STATUS_LABEL[timelineSummary.status] || timelineSummary.status}</span></div></div>
                  </div>
                </div>
              )}

              <div className="card">
                <h3 style={{ marginTop: 0, marginBottom: 12 }}>Lịch sử nhận hàng</h3>
                {timelineLoading && <p className="muted">Đang tải...</p>}
                {!timelineLoading && timeline.length === 0 && (
                  <p className="muted">Chưa có lịch sử nhận hàng.</p>
                )}
                {!timelineLoading && timeline.length > 0 && (
                  <>
                    <div style={{ position: 'relative', paddingLeft: 20 }}>
                      <div style={{ position: 'absolute', left: 4, top: 4, bottom: 4, width: 2, background: '#e5e7eb' }} />
                      {timeline.map((ev, idx) => (
                        <div key={idx} style={{ position: 'relative', marginBottom: 10 }}>
                          <div style={{
                            position: 'absolute', left: -20, top: 4, width: 9, height: 9, borderRadius: '50%',
                            background: ev.type === 'SHORT_CLOSE' ? '#f97316' : '#16a34a',
                          }} />
                          {ev.type === 'RECEIVE' ? (
                            /* CEO review: ERP block — vertically grouped identity (code/status/time)
                               then detail (warehouse/receiver/quantity). Data unchanged. */
                            <div className="card" style={{ margin: 0, padding: '10px 14px' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, padding: '3px 0' }}>
                                <span style={{ color: '#6b7280', fontSize: 12 }}>📦 Mã phiếu nhận</span>
                                {/* TODO: InventoryReceives.jsx has no route/id-based deep link
                                    to open a specific receive voucher from outside its own page.
                                    Kept as link-style text only until that navigation exists —
                                    do not invent a new route. */}
                                <span style={{ color: '#2563eb', textDecoration: 'underline', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                                  title="Xem chi tiết">
                                  <b>{ev.receive_code}</b>
                                  <ExternalLink size={12} />
                                </span>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, padding: '3px 0' }}>
                                <span style={{ color: '#6b7280', fontSize: 12 }}>Trạng thái</span>
                                <span style={receiveBadge(ev.status)}>{RECEIVE_STATUS_LABEL[ev.status] || ev.status}</span>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
                                <span style={{ color: '#6b7280', fontSize: 12 }}>Thời gian</span>
                                <span>{fmtDateTime(ev.event_time)}</span>
                              </div>

                              <div style={{ borderTop: '1px dashed #e5e7eb', margin: '6px 0' }} />

                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
                                <span style={{ color: '#6b7280', fontSize: 12 }}>Kho</span>
                                <span>{ev.warehouse_name || '—'}</span>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
                                <span style={{ color: '#6b7280', fontSize: 12 }}>Người nhận</span>
                                <span>{ev.received_by_name || '—'}</span>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
                                <span style={{ color: '#6b7280', fontSize: 12 }}>Số lượng</span>
                                <span><b>{fmtQty(ev.total_qty)} kg</b></span>
                              </div>
                              {/* Total Amount intentionally omitted: the timeline API returns no
                                  price/amount data, and this sprint is frontend-only (no backend/API
                                  change) — per CEO decision. */}
                            </div>
                          ) : (
                            <div className="card" style={{ margin: 0, padding: '10px 14px', border: '1px solid #f97316' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, padding: '3px 0' }}>
                                <span style={{ color: '#6b7280', fontSize: 12 }}>Trạng thái</span>
                                <span style={{ background: '#ffedd5', color: '#9a3412', border: '1px solid currentColor', borderRadius: 4, padding: '2px 9px', fontSize: 12, fontWeight: 700, display: 'inline-block' }}>
                                  ⚠ ĐÃ ĐÓNG PHẦN CÒN LẠI
                                </span>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
                                <span style={{ color: '#6b7280', fontSize: 12 }}>Thời gian</span>
                                <span>{fmtDateTime(ev.event_time)}</span>
                              </div>

                              <div style={{ borderTop: '1px dashed #fed7aa', margin: '6px 0' }} />

                              <div style={{ fontSize: 13, padding: '3px 0' }}>
                                <span style={{ color: '#6b7280', fontSize: 12 }}>Lý do</span><div>{ev.reason || '—'}</div>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
                                <span style={{ color: '#6b7280', fontSize: 12 }}>Đóng bởi</span>
                                <span><b>{ev.short_closed_by_name || '—'}</b></span>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    {timelineTotal > TIMELINE_PAGE_SIZE && (
                      <div style={{ display: 'flex', justifyContent: 'center', gap: 10, alignItems: 'center', marginTop: 8 }}>
                        <button className="btn secondary" disabled={timelinePage <= 1}
                          onClick={() => setTimelinePage(p => Math.max(1, p - 1))}>
                          ← Trước
                        </button>
                        <span style={{ fontSize: 13, color: '#6b7280' }}>
                          Trang {timelinePage} / {Math.max(1, Math.ceil(timelineTotal / TIMELINE_PAGE_SIZE))}
                        </span>
                        <button className="btn secondary"
                          disabled={timelinePage >= Math.ceil(timelineTotal / TIMELINE_PAGE_SIZE)}
                          onClick={() => setTimelinePage(p => p + 1)}>
                          Sau →
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}

        </>}
      </>}

      {/* ── "Thêm sản phẩm" Dialog ────────────────────────────────────────── */}
      {addDlg !== null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1200,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onMouseDown={e => { if (e.target === e.currentTarget) { setAddDlg(null); setAddDlgOpts([]); } }}>
          <div className="card" style={{ width: 480, maxWidth: '92vw', maxHeight: '88vh', overflowY: 'auto' }}>
            <h3 style={{ margin: '0 0 16px' }}>Thêm sản phẩm vào phiếu</h3>

            <div style={{ marginBottom: 12 }}>
              <label style={LBL}>Sản phẩm{REQ}</label>
              <EnterpriseAutocomplete
                ref={addDlgProductRef}
                items={allProducts}
                value={allProducts.find(p => String(p.id) === String(addDlg.product_id)) || null}
                onChange={prod => {
                  setAddDlg(d => ({ ...d, product_id: prod ? String(prod.id) : '', spo_id: '', price: prod ? '' : '' }));
                  setAddDlgOpts([]);
                }}
                displayField="name"
                secondaryFields={['product_code']}
                searchFields={PRODUCT_SEARCH_FIELDS}
                getItemKey={p => p.id}
                placeholder="Tìm sản phẩm..."
              />
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={LBL}>Quy cách nhập</label>
              <select className="select" value={addDlg.spo_id}
                disabled={!addDlg.product_id || addDlgOptsLoading}
                onChange={e => setAddDlg(d => ({ ...d, spo_id: e.target.value }))}>
                <option value="">{addDlgOptsLoading ? 'Đang tải...' : 'Mặc định (kg)'}</option>
                {addDlgOpts.map(o => <option key={o.id} value={o.id}>{spoLabel(o)}</option>)}
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
              <div>
                <label style={LBL}>Số lượng{REQ}</label>
                <input className="input" type="text" inputMode="decimal" placeholder="0"
                  style={{ textAlign: 'right' }}
                  value={addDlg.qty}
                  onChange={e => setAddDlg(d => ({ ...d, qty: e.target.value }))} />
              </div>
              <div>
                <label style={LBL}>Đơn giá (₫)</label>
                <MoneyInput
                  value={Number(addDlg.price || 0)}
                  onChange={v => setAddDlg(d => ({ ...d, price: v }))} />
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={LBL}>Ghi chú</label>
              <input className="input" placeholder="Ghi chú..."
                value={addDlg.note}
                onChange={e => setAddDlg(d => ({ ...d, note: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') saveAddDlg(); }} />
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 18, cursor: 'pointer' }}>
              <input type="checkbox" checked={addDlg.saveToCatalog}
                onChange={e => setAddDlg(d => ({ ...d, saveToCatalog: e.target.checked }))} />
              Lưu sản phẩm này vào danh mục nhà cung cấp (cho lần nhập kế tiếp)
            </label>

            <div className="actions">
              <button className="btn" onClick={saveAddDlg} disabled={addDlgSaving}>
                {addDlgSaving ? 'Đang lưu...' : '+ Thêm'}
              </button>
              <button className="btn secondary" onClick={() => { setAddDlg(null); setAddDlgOpts([]); }}>
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Short Close Dialog ────────────────────────────────────────────── */}
      {shortCloseDlg && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1200,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onMouseDown={e => { if (e.target === e.currentTarget) setShortCloseDlg(false); }}>
          <div className="card" style={{ width: 420, maxWidth: '92vw' }}>
            <h3 style={{ margin: '0 0 16px' }}>Đóng phần còn lại</h3>
            <div style={{ marginBottom: 14 }}>
              <label style={LBL}>Lý do{REQ}</label>
              <textarea className="input" rows={3} style={{ width: '100%', resize: 'vertical' }}
                value={shortCloseReason}
                onChange={e => setShortCloseReason(e.target.value)}
                placeholder="Nhập lý do đóng phần còn lại của phiếu..." />
            </div>
            <div className="actions">
              <button className="btn" onClick={submitShortClose} disabled={shortCloseSaving}>
                {shortCloseSaving ? 'Đang lưu...' : 'Đóng phiếu'}
              </button>
              <button className="btn secondary" onClick={() => setShortCloseDlg(false)}>
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

    </SafePage>
  );
}
