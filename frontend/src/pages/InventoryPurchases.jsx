import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {Pencil,Trash2}from'lucide-react';
import api from '../api/api';
import SafePage from '../components/SafePage';
import { showSuccess, showError, showWarning } from '../utils/toast';

const STATUS_LABEL = { DRAFT: 'Nháp', CONFIRMED: 'Đã xác nhận', CANCELLED: 'Đã hủy' };
const STATUS_STYLE = {
  DRAFT:     { background: '#fef9c3', color: '#854d0e' },
  CONFIRMED: { background: '#dcfce7', color: '#166534' },
  CANCELLED: { background: '#fee2e2', color: '#991b1b' },
};
const badge = s => ({ ...STATUS_STYLE[s] || {}, borderRadius: 4, padding: '2px 8px', fontSize: 12, fontWeight: 600, display: 'inline-block' });
const LBL = { fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 3, color: '#374151' };
const REQ = <span style={{ color: '#ef4444' }}> *</span>;

function todayISO() { return new Date().toISOString().slice(0, 10); }
const fmt = n => Number(n || 0).toLocaleString('vi-VN');
const fmtDate = s => s ? String(s).slice(0, 10) : '—';
const mkHdr = () => ({ partner_id: '', purchase_date: todayISO(), note: '', reference_no: '' });
const EMPTY_ROW = {
  category_id: '', productSearch: '', product_id: '',
  supplier_purchase_option_id: '', quantity: '', purchase_price: '', note: '',
};

// ── ProductSearch ────────────────────────────────────────────────────────────
function ProductSearch({ products, categoryId, value, search, onSearchChange, onSelect, disabled, inputRef, onKeyDown }) {
  const [open, setOpen] = useState(false);
  const [hiIdx, setHiIdx] = useState(0);

  const filtered = useMemo(() => {
    const base = categoryId
      ? products.filter(p => String(p.category_id) === String(categoryId))
      : products;
    if (!search) return base.slice(0, 15);
    return base.filter(p => p.name.toLowerCase().includes(search.toLowerCase())).slice(0, 15);
  }, [products, categoryId, search]);

  const selected = value ? products.find(p => String(p.id) === String(value)) : null;

  const pick = prod => {
    onSelect(prod.id, prod.name);
    setOpen(false);
    setHiIdx(0);
  };

  const handleKey = e => {
    if (!open && e.key === 'ArrowDown') { setOpen(true); return; }
    if (open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHiIdx(i => Math.min(i + 1, filtered.length - 1)); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setHiIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter')     { e.preventDefault(); if (filtered[hiIdx]) { pick(filtered[hiIdx]); return; } }
      if (e.key === 'Escape')    { setOpen(false); return; }
    }
    onKeyDown && onKeyDown(e);
  };

  if (selected) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 160 }}>
        <span style={{ fontSize: 13, flex: 1, color: '#111827' }}>{selected.name}</span>
        {!disabled && (
          <button type="button" onClick={() => onSelect('', '')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 0, fontSize: 18, lineHeight: 1 }}>
            ×
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', minWidth: 160 }}>
      <input
        ref={inputRef}
        className="input"
        style={{ width: '100%' }}
        placeholder="Tìm sản phẩm..."
        value={search}
        disabled={disabled}
        onChange={e => { onSearchChange(e.target.value); setOpen(true); setHiIdx(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 160)}
        onKeyDown={handleKey}
        autoComplete="off"
      />
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, minWidth: 240, zIndex: 300,
          background: '#fff', border: '1px solid #d1d5db', borderRadius: 4,
          boxShadow: '0 4px 16px rgba(0,0,0,0.13)', maxHeight: 240, overflowY: 'auto',
        }}>
          {filtered.length === 0
            ? <div style={{ padding: '8px 12px', fontSize: 13, color: '#6b7280' }}>Không tìm thấy</div>
            : filtered.map((p, i) => (
              <div key={p.id}
                onMouseDown={e => { e.preventDefault(); pick(p); }}
                style={{
                  padding: '7px 12px', cursor: 'pointer', fontSize: 13,
                  background: i === hiIdx ? '#eff6ff' : '',
                  borderBottom: '1px solid #f3f4f6',
                }}>
                {p.name}
              </div>
            ))
          }
        </div>
      )}
    </div>
  );
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

  // header form
  const [hdrForm, setHdrForm] = useState(mkHdr());
  const [hdrEditing, setHdrEditing] = useState(false);
  const [hdrSaving, setHdrSaving] = useState(false);

  // new entry row
  const [entry, setEntry] = useState(EMPTY_ROW);
  const [entryOpts, setEntryOpts] = useState([]);
  const [entryOptsLoading, setEntryOptsLoading] = useState(false);
  const [entrySaving, setEntrySaving] = useState(false);

  // edit existing row
  const [editId, setEditId] = useState(null);
  const [editData, setEditData] = useState(EMPTY_ROW);
  const [editOpts, setEditOpts] = useState([]);
  const [editOptsLoading, setEditOptsLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);

  // focus refs — entry row
  const entryProductRef = useRef();
  const entrySpoRef     = useRef();
  const entryQtyRef     = useRef();
  const entryPriceRef   = useRef();
  const entryNoteRef    = useRef();

  // focus refs — edit row
  const editProductRef = useRef();
  const editSpoRef     = useRef();
  const editQtyRef     = useRef();
  const editPriceRef   = useRef();
  const editNoteRef    = useRef();

  // ── Master data ────────────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      api.get('/partners', { params: { role: 'supplier' } }),
      api.get('/products'),
      api.get('/products/categories'),
    ]).then(([s, p, c]) => {
      setPartners(s.data || []);
      setAllProducts((p.data || []).filter(x => x.inventory_mode === 'TRACK_STOCK' && !x.del_flg));
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

  // ── Load options for entry row ─────────────────────────────────────────────
  useEffect(() => {
    if (!entry.product_id || !order?.partner_id) { setEntryOpts([]); return; }
    setEntryOptsLoading(true);
    api.get('/supplier-purchase-options', { params: { partner_id: order.partner_id, product_id: entry.product_id } })
      .then(r => setEntryOpts(r.data || []))
      .catch(() => setEntryOpts([]))
      .finally(() => setEntryOptsLoading(false));
  }, [entry.product_id, order?.partner_id]);

  // ── Load options for edit row ──────────────────────────────────────────────
  useEffect(() => {
    if (!editData.product_id || !order?.partner_id) { setEditOpts([]); return; }
    setEditOptsLoading(true);
    api.get('/supplier-purchase-options', { params: { partner_id: order.partner_id, product_id: editData.product_id } })
      .then(r => setEditOpts(r.data || []))
      .catch(() => setEditOpts([]))
      .finally(() => setEditOptsLoading(false));
  }, [editData.product_id, order?.partner_id]);

  // ── Navigation ─────────────────────────────────────────────────────────────
  const resetEntry = () => { setEntry(EMPTY_ROW); setEntryOpts([]); };
  const cancelEdit = () => { setEditId(null); setEditData(EMPTY_ROW); setEditOpts([]); };

  const openNew = () => {
    setView('order'); setOrder(null);
    setHdrForm(mkHdr()); setHdrEditing(true);
    resetEntry(); cancelEdit();
  };

  const openOrder = async id => {
    setView('order'); setOrder(null); setHdrEditing(false);
    resetEntry(); cancelEdit();
    await loadOrder(id);
  };

  const goList = () => { setView('list'); setOrder(null); resetEntry(); cancelEdit(); };

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
        showSuccess('Đã cập nhật phiếu nhập');
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

  // ── Add entry-row item ─────────────────────────────────────────────────────
  const saveEntry = async () => {
    if (!order) return;
    if (!entry.product_id) { showWarning('Chọn sản phẩm'); entryProductRef.current?.focus(); return; }
    if (!(Number(entry.quantity) > 0)) { showWarning('Số lượng phải lớn hơn 0'); entryQtyRef.current?.focus(); return; }
    setEntrySaving(true);
    try {
      await api.post(`/inventory-purchases/${order.id}/items`, {
        product_id: Number(entry.product_id),
        supplier_purchase_option_id: entry.supplier_purchase_option_id ? Number(entry.supplier_purchase_option_id) : null,
        quantity:       Number(entry.quantity),
        purchase_price: Number(entry.purchase_price || 0),
        note: entry.note || null,
      });
      showSuccess('Đã thêm dòng hàng');
      resetEntry();
      await loadOrder(order.id);
      setTimeout(() => entryProductRef.current?.focus(), 60);
    } catch (e) { showError(e.response?.data?.message || e.message || 'Lưu thất bại'); }
    finally { setEntrySaving(false); }
  };

  // ── Edit existing row ──────────────────────────────────────────────────────
  const startEdit = item => {
    const prod = allProducts.find(p => String(p.id) === String(item.product_id));
    cancelEdit();
    setEditId(item.id);
    setEditData({
      category_id:                  prod ? String(prod.category_id) : '',
      productSearch:                '',
      product_id:                   String(item.product_id),
      supplier_purchase_option_id:  item.supplier_purchase_option_id ? String(item.supplier_purchase_option_id) : '',
      quantity:                     String(item.quantity),
      purchase_price:               String(item.purchase_price),
      note:                         item.note || '',
    });
  };

  const saveEdit = async () => {
    if (!editData.product_id) { showWarning('Chọn sản phẩm'); return; }
    if (!(Number(editData.quantity) > 0)) { showWarning('Số lượng phải lớn hơn 0'); return; }
    setEditSaving(true);
    try {
      await api.put(`/inventory-purchases/${order.id}/items/${editId}`, {
        product_id: Number(editData.product_id),
        supplier_purchase_option_id: editData.supplier_purchase_option_id ? Number(editData.supplier_purchase_option_id) : null,
        quantity:       Number(editData.quantity),
        purchase_price: Number(editData.purchase_price || 0),
        note: editData.note || null,
      });
      showSuccess('Đã cập nhật dòng hàng');
      cancelEdit();
      await loadOrder(order.id);
    } catch (e) { showError(e.response?.data?.message || e.message || 'Lưu thất bại'); }
    finally { setEditSaving(false); }
  };

  const deleteItem = async item => {
    const ok = window.appConfirm
      ? await window.appConfirm(`Xóa "${item.product_name}"?`, { title: 'Xóa dòng hàng', confirmText: 'Xóa', variant: 'danger' })
      : window.confirm(`Xóa dòng hàng "${item.product_name}"?`);
    if (!ok) return;
    try {
      await api.delete(`/inventory-purchases/${order.id}/items/${item.id}`);
      showSuccess('Đã xóa dòng hàng');
      await loadOrder(order.id);
    } catch (e) { showError(e.response?.data?.message || e.message || 'Lỗi'); }
  };

  // ── Status change ──────────────────────────────────────────────────────────
  const changeStatus = async status => {
    const label = status === 'CONFIRMED' ? 'Xác nhận' : 'Hủy';
    const ok = window.appConfirm
      ? await window.appConfirm(`${label} phiếu ${order.order_code}?`, {
          title: `${label} phiếu nhập`, confirmText: label,
          variant: status === 'CANCELLED' ? 'danger' : 'primary',
        })
      : window.confirm(`${label} phiếu ${order.order_code}?`);
    if (!ok) return;
    try {
      const r = await api.patch(`/inventory-purchases/${order.id}/status`, { status });
      showSuccess(r.data.message || 'Thành công');
      await loadOrder(order.id);
    } catch (e) { showError(e.response?.data?.message || e.message || 'Lỗi'); }
  };

  // ── Derived ────────────────────────────────────────────────────────────────
  const isDraft  = order?.status === 'DRAFT';
  const items    = order?.items || [];
  const totalQty = items.reduce((a, x) => a + Number(x.quantity || 0), 0);

  const spoLabel = o => o.display_label || `${o.unit_name} (${o.default_conversion_qty}kg)`;

  const catName = item => {
    const prod = allProducts.find(p => String(p.id) === String(item.product_id));
    return prod ? (categories.find(c => String(c.id) === String(prod.category_id))?.name || '—') : '—';
  };

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
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={openNew}>+ Tạo phiếu nhập</button>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Phiếu nhập hàng tồn kho ({orders.length})</h3>
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
                <p className="muted">Chưa có phiếu nhập nào.</p>
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

        {orderLoading && <div className="card"><p className="muted">Đang tải phiếu nhập...</p></div>}

        {!orderLoading && <>

          {/* ── Header card ── */}
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>
                {order ? order.order_code : 'Phiếu nhập mới'}
                {order && <span style={{ marginLeft: 10, ...badge(order.status) }}>{STATUS_LABEL[order.status]}</span>}
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
                    {hdrSaving ? 'Đang lưu...' : (order ? 'Lưu thay đổi' : 'Tạo phiếu nhập')}
                  </button>
                  {order && <button className="btn secondary" onClick={() => setHdrEditing(false)}>Hủy</button>}
                </div>
              </>
            ) : order && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '8px 16px', fontSize: 14 }}>
                <div><span style={{ color: '#6b7280', fontSize: 12 }}>Nhà cung cấp</span><div><b>{order.supplier_name || '—'}</b></div></div>
                <div><span style={{ color: '#6b7280', fontSize: 12 }}>Ngày nhập</span><div><b>{fmtDate(order.purchase_date)}</b></div></div>
                <div><span style={{ color: '#6b7280', fontSize: 12 }}>Số tham chiếu</span><div>{order.reference_no || '—'}</div></div>
                <div><span style={{ color: '#6b7280', fontSize: 12 }}>Ghi chú</span><div>{order.note || '—'}</div></div>
              </div>
            )}
          </div>

          {/* ── Items section ── */}
          {order && <>
            <div className="card" style={{ padding: 0 }}>

              {/* Mode tabs */}
              <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #e5e7eb', padding: '0 20px' }}>
                <div style={{
                  padding: '10px 20px', fontWeight: 600, fontSize: 14, cursor: 'default',
                  borderBottom: '2px solid #2563eb', color: '#2563eb', marginBottom: -2,
                }}>
                  Nhập liệu trực tiếp
                </div>
                <div style={{
                  padding: '10px 20px', fontSize: 14, color: '#9ca3af', cursor: 'not-allowed',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  Excel Import
                  <span style={{
                    background: '#f3f4f6', color: '#6b7280', fontSize: 10, fontWeight: 700,
                    borderRadius: 10, padding: '2px 8px', letterSpacing: 0.3,
                  }}>Sắp ra mắt</span>
                </div>
              </div>

              {/* Grid */}
              <div style={{ overflowX: 'auto', padding: '16px 20px' }}>
                <table className="table" style={{ minWidth: 960 }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      <th style={{ width: 130 }}>Nhóm hàng</th>
                      <th style={{ minWidth: 180 }}>Sản phẩm</th>
                      <th style={{ minWidth: 160 }}>Quy cách nhập</th>
                      <th style={{ width: 90, textAlign: 'right' }}>Số lượng</th>
                      <th style={{ width: 130, textAlign: 'right' }}>Đơn giá (₫)</th>
                      <th style={{ width: 130, textAlign: 'right' }}>Thành tiền</th>
                      <th style={{ minWidth: 130 }}>Ghi chú</th>
                      <th style={{ width: 130 }}>Thao tác</th>
                    </tr>
                  </thead>
                  <tbody>

                    {/* Saved rows */}
                    {items.map(item => {
                      if (editId === item.id) {
                        // Inline edit row
                        const editPreview = Number(editData.quantity || 0) * Number(editData.purchase_price || 0);
                        return (
                          <tr key={item.id} style={{ background: '#eff6ff' }}>
                            <td>
                              <select className="select" style={{ minWidth: 100 }}
                                value={editData.category_id}
                                onChange={e => setEditData(d => ({
                                  ...d, category_id: e.target.value,
                                  product_id: '', productSearch: '', supplier_purchase_option_id: '',
                                }))}>
                                <option value="">Tất cả</option>
                                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                              </select>
                            </td>
                            <td>
                              <ProductSearch
                                products={allProducts}
                                categoryId={editData.category_id}
                                value={editData.product_id}
                                search={editData.productSearch}
                                onSearchChange={s => setEditData(d => ({ ...d, productSearch: s }))}
                                onSelect={(id) => {
                                  setEditData(d => ({ ...d, product_id: String(id || ''), productSearch: '', supplier_purchase_option_id: '' }));
                                  if (id) setTimeout(() => editSpoRef.current?.focus(), 60);
                                }}
                                inputRef={editProductRef}
                                onKeyDown={e => { if (e.key === 'Enter' && editData.product_id) editSpoRef.current?.focus(); }}
                              />
                            </td>
                            <td>
                              <select className="select" ref={editSpoRef}
                                value={editData.supplier_purchase_option_id}
                                disabled={!editData.product_id || editOptsLoading}
                                onChange={e => { setEditData(d => ({ ...d, supplier_purchase_option_id: e.target.value })); editQtyRef.current?.focus(); }}
                                onKeyDown={e => { if (e.key === 'Enter') editQtyRef.current?.focus(); }}>
                                <option value="">{editOptsLoading ? 'Đang tải...' : 'Mặc định (kg)'}</option>
                                {editOpts.map(o => <option key={o.id} value={o.id}>{spoLabel(o)}</option>)}
                              </select>
                            </td>
                            <td>
                              <input className="input" type="number" placeholder="0" min={0.001} step={0.001}
                                ref={editQtyRef} style={{ width: 80 }}
                                value={editData.quantity}
                                onChange={e => setEditData(d => ({ ...d, quantity: e.target.value }))}
                                onKeyDown={e => { if (e.key === 'Enter') editPriceRef.current?.focus(); }} />
                            </td>
                            <td>
                              <input className="input" type="number" placeholder="0" min={0}
                                ref={editPriceRef} style={{ width: 110 }}
                                value={editData.purchase_price}
                                onChange={e => setEditData(d => ({ ...d, purchase_price: e.target.value }))}
                                onKeyDown={e => { if (e.key === 'Enter') editNoteRef.current?.focus(); }} />
                            </td>
                            <td style={{ textAlign: 'right', color: '#059669', fontWeight: 600 }}>
                              {fmt(editPreview)} ₫
                            </td>
                            <td>
                              <input className="input" placeholder="Ghi chú..."
                                ref={editNoteRef} style={{ width: 110 }}
                                value={editData.note}
                                onChange={e => setEditData(d => ({ ...d, note: e.target.value }))}
                                onKeyDown={e => { if (e.key === 'Enter') saveEdit(); }} />
                            </td>
                            <td>
                              <button className="btn" onClick={saveEdit} disabled={editSaving} style={{ marginRight: 4 }}>
                                {editSaving ? '...' : 'Lưu'}
                              </button>
                              <button className="btn secondary" onClick={cancelEdit}>Hủy</button>
                            </td>
                          </tr>
                        );
                      }

                      // Read-only row
                      return (
                        <tr key={item.id}>
                          <td style={{ fontSize: 13, color: '#6b7280' }}>{catName(item)}</td>
                          <td><b style={{ fontSize: 13 }}>{item.product_name}</b></td>
                          <td style={{ fontSize: 13, color: '#374151' }}>{item.unit}</td>
                          <td style={{ textAlign: 'right' }}>{fmt(item.quantity)}</td>
                          <td style={{ textAlign: 'right' }}>{fmt(item.purchase_price)} ₫</td>
                          <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(item.total_price)} ₫</td>
                          <td style={{ fontSize: 13, color: '#6b7280' }}>{item.note || <span style={{ color: '#d1d5db' }}>—</span>}</td>
                          <td>
                            {isDraft && <div style={{display:'flex',flexWrap:'nowrap',gap:6,alignItems:'center',justifyContent:'center'}}>
                              <button className="btn secondary" title="Sửa" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={() => startEdit(item)}><Pencil size={14}/></button>
                              <button className="btn danger" title="Xóa" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={() => deleteItem(item)}><Trash2 size={14}/></button>
                            </div>}
                          </td>
                        </tr>
                      );
                    })}

                    {!items.length && !isDraft && (
                      <tr><td colSpan={8} style={{ textAlign: 'center', padding: '24px 0' }}>
                        <p className="muted">Chưa có dòng hàng.</p>
                      </td></tr>
                    )}

                    {/* Entry row — always visible for DRAFT */}
                    {isDraft && (() => {
                      const entryPreview = Number(entry.quantity || 0) * Number(entry.purchase_price || 0);
                      return (
                        <tr style={{ background: '#f0fdf4', borderTop: '2px dashed #86efac' }}>
                          <td>
                            <select className="select" style={{ minWidth: 100 }}
                              value={entry.category_id}
                              onChange={e => setEntry(f => ({
                                ...f, category_id: e.target.value,
                                product_id: '', productSearch: '', supplier_purchase_option_id: '',
                              }))}>
                              <option value="">Tất cả</option>
                              {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                          </td>
                          <td>
                            <ProductSearch
                              products={allProducts}
                              categoryId={entry.category_id}
                              value={entry.product_id}
                              search={entry.productSearch}
                              onSearchChange={s => setEntry(f => ({ ...f, productSearch: s }))}
                              onSelect={(id) => {
                                setEntry(f => ({ ...f, product_id: String(id || ''), productSearch: '', supplier_purchase_option_id: '' }));
                                if (id) setTimeout(() => entrySpoRef.current?.focus(), 60);
                              }}
                              inputRef={entryProductRef}
                              onKeyDown={e => { if (e.key === 'Enter' && entry.product_id) entrySpoRef.current?.focus(); }}
                            />
                          </td>
                          <td>
                            <select className="select" ref={entrySpoRef}
                              value={entry.supplier_purchase_option_id}
                              disabled={!entry.product_id || entryOptsLoading}
                              onChange={e => { setEntry(f => ({ ...f, supplier_purchase_option_id: e.target.value })); entryQtyRef.current?.focus(); }}
                              onKeyDown={e => { if (e.key === 'Enter') entryQtyRef.current?.focus(); }}>
                              <option value="">{entryOptsLoading ? 'Đang tải...' : 'Mặc định (kg)'}</option>
                              {entryOpts.map(o => <option key={o.id} value={o.id}>{spoLabel(o)}</option>)}
                            </select>
                          </td>
                          <td>
                            <input className="input" type="number" placeholder="0" min={0.001} step={0.001}
                              ref={entryQtyRef} style={{ width: 80 }}
                              value={entry.quantity}
                              onChange={e => setEntry(f => ({ ...f, quantity: e.target.value }))}
                              onKeyDown={e => { if (e.key === 'Enter') entryPriceRef.current?.focus(); }} />
                          </td>
                          <td>
                            <input className="input" type="number" placeholder="0" min={0}
                              ref={entryPriceRef} style={{ width: 110 }}
                              value={entry.purchase_price}
                              onChange={e => setEntry(f => ({ ...f, purchase_price: e.target.value }))}
                              onKeyDown={e => { if (e.key === 'Enter') entryNoteRef.current?.focus(); }} />
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: entryPreview > 0 ? '#059669' : '#9ca3af' }}>
                            {entryPreview > 0 ? `${fmt(entryPreview)} ₫` : '—'}
                          </td>
                          <td>
                            <input className="input" placeholder="Ghi chú..."
                              ref={entryNoteRef} style={{ width: 110 }}
                              value={entry.note}
                              onChange={e => setEntry(f => ({ ...f, note: e.target.value }))}
                              onKeyDown={e => { if (e.key === 'Enter') saveEntry(); }} />
                          </td>
                          <td>
                            <button className="btn" onClick={saveEntry} disabled={entrySaving}>
                              {entrySaving ? '...' : '+ Thêm'}
                            </button>
                          </td>
                        </tr>
                      );
                    })()}

                  </tbody>

                  {items.length > 0 && (
                    <tfoot>
                      <tr style={{ background: '#f9fafb', fontWeight: 700 }}>
                        <td colSpan={3} style={{ textAlign: 'right', paddingRight: 12, color: '#374151' }}>Tổng cộng:</td>
                        <td style={{ textAlign: 'right' }}>{fmt(totalQty)}</td>
                        <td></td>
                        <td style={{ textAlign: 'right', fontSize: 15, color: '#059669' }}>{fmt(order.total_amount)} ₫</td>
                        <td colSpan={2}></td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>

            {/* Confirm / Cancel */}
            {isDraft && <div className="card">
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button className="btn" onClick={() => changeStatus('CONFIRMED')} disabled={!items.length}>
                  ✓ Xác nhận phiếu nhập
                </button>
                <button className="btn danger" onClick={() => changeStatus('CANCELLED')}>
                  ✕ Hủy phiếu
                </button>
              </div>
              {!items.length && (
                <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                  Cần ít nhất 1 dòng hàng để xác nhận.
                </p>
              )}
            </div>}
          </>}

        </>}
      </>}

    </SafePage>
  );
}
