import React, { useEffect, useState, useCallback } from 'react';
import api from '../api/api';
import SafePage from '../components/SafePage';
import { showSuccess, showError, showWarning } from '../utils/toast';

// TODO: PurchaseOrder status should migrate CONFIRMED → APPROVED in future stabilization.
//       InventoryPurchaseAgent.updateStatus() currently writes 'CONFIRMED'.
//       Until migrated, this page uses 'CONFIRMED' as the receivable status.

// Supplier purchase price: resolved via GET /api/supplier-purchase-price?supplier_id=X&product_ids=...
// which reads from product_supplier_links (negotiated per-supplier price).
// See backend/src/services/PurchasePriceResolver.js for the resolution chain.
// Price init: PO snapshot (>0) → supplier link price → 0 (manual entry).

const todayISO = () => new Date().toISOString().slice(0, 10);
const fmt = n => Number(n || 0).toLocaleString('vi-VN');
const fmtDate = s => s ? String(s).slice(0, 10) : '—';

const STATUS_LABEL = {
  PENDING: 'Chờ nhập kho',
  RECEIVED: 'Đã nhập kho',
  CANCELLED: 'Đã hủy',
};
const STATUS_STYLE = {
  PENDING:   { background: '#fef9c3', color: '#854d0e' },
  RECEIVED:  { background: '#dcfce7', color: '#166534' },
  CANCELLED: { background: '#fee2e2', color: '#991b1b' },
};
const PO_STATUS_LABEL = {
  CONFIRMED:        'Đã xác nhận',
  PARTIAL_RECEIVED: 'Nhận một phần',
  RECEIVED:         'Đã nhận đủ',
};
const badge = s => ({
  ...(STATUS_STYLE[s] || { background: '#f3f4f6', color: '#374151' }),
  border: '1px solid currentColor', borderRadius: 4, padding: '2px 9px', fontSize: 12,
  fontWeight: 700, letterSpacing: 0.2, display: 'inline-block',
});
const LBL = { fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 3, color: '#374151' };

export default function InventoryReceives() {
  const [view, setView] = useState('list'); // 'list' | 'create' | 'detail'

  // list
  const [vouchers, setVouchers] = useState([]);
  const [listLoading, setListLoading] = useState(false);
  const [filterStatus, setFilterStatus] = useState('');

  // create
  const [pos, setPos] = useState([]);
  const [posLoading, setPosLoading] = useState(false);
  const [selectedPoId, setSelectedPoId] = useState('');
  const [poDetail, setPoDetail] = useState(null);
  const [poLoading, setPoLoading] = useState(false);
  const [receiveDate, setReceiveDate] = useState(todayISO());
  const [note, setNote] = useState('');
  const [supplierDocNo, setSupplierDocNo] = useState('');
  const [warehouses, setWarehouses] = useState([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [recvQtys, setRecvQtys] = useState({});
  const [receivedSummary, setReceivedSummary] = useState({}); // purchase_order_item_id → kg already received (derived, S4.1-B)
  const [recvPrices, setRecvPrices] = useState({});    // item.id → price string (editable)
  const [supplierPrices, setSupplierPrices] = useState({}); // product.id → negotiated price from product_supplier_links
  const [creating, setCreating] = useState(false);

  // detail
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // ── List ───────────────────────────────────────────────────────────────────
  const loadList = useCallback(async () => {
    setListLoading(true);
    try {
      const params = {};
      if (filterStatus) params.status = filterStatus;
      const r = await api.get('/inventory-receives', { params });
      setVouchers(r.data || []);
    } catch (e) { showError(e.response?.data?.message || e.message || 'Không tải được danh sách'); }
    finally { setListLoading(false); }
  }, [filterStatus]);

  useEffect(() => { if (view === 'list') loadList(); }, [view, loadList]);

  // ── Create: load receivable POs ────────────────────────────────────────────
  const loadPos = async () => {
    setPosLoading(true);
    try {
      const [r1, r2] = await Promise.all([
        api.get('/inventory-purchases', { params: { status: 'CONFIRMED', limit: 200 } }),
        api.get('/inventory-purchases', { params: { status: 'PARTIAL_RECEIVED', limit: 200 } }),
      ]);
      setPos([...(r1.data?.items || []), ...(r2.data?.items || [])]);
    } catch (e) { showError(e.response?.data?.message || e.message || 'Không tải được phiếu mua hàng'); }
    finally { setPosLoading(false); }
  };

  const loadWarehouses = async () => {
    try {
      const r = await api.get('/warehouses');
      const list = r.data || [];
      setWarehouses(list);
      const def = list.find(w => w.is_default) || list[0];
      setWarehouseId(def ? String(def.id) : '');
    } catch (e) { showError(e.response?.data?.message || e.message || 'Không tải được danh sách kho'); }
  };

  const openCreate = () => {
    setView('create');
    setSelectedPoId('');
    setPoDetail(null);
    setReceiveDate(todayISO());
    setNote('');
    setSupplierDocNo('');
    setRecvQtys({});
    setReceivedSummary({});
    setRecvPrices({});
    setSupplierPrices({});
    loadPos();
    loadWarehouses();
  };

  // ── Create: load PO detail + price suggestions when PO selected ────────────
  useEffect(() => {
    if (!selectedPoId) { setPoDetail(null); setRecvQtys({}); setReceivedSummary({}); setRecvPrices({}); setSupplierPrices({}); return; }
    setPoLoading(true);

    api.get(`/inventory-purchases/${selectedPoId}`)
      .then(async r => {
        const poData = r.data;
        setPoDetail(poData);

        // S4.1-B CEO review: kg received-so-far per PO line is NOT read from
        // purchase_order_items.received_quantity (purchase-unit basis, and this
        // sprint doesn't write a kg accumulator there either — see
        // InventoryReceiveService._getReceivedSoFarMap). Derived from the receive
        // ledger via GET /inventory-receives/received-summary instead.
        let summary = {};
        try {
          const sumR = await api.get('/inventory-receives/received-summary', { params: { purchase_order_id: selectedPoId } });
          summary = sumR.data || {};
        } catch { /* non-fatal — treat as nothing received yet */ }
        setReceivedSummary(summary);

        // Init actual-receive quantities — default to full remaining (Expected Stock
        // Qty basis, kg — S4.1-B), not the ordered purchase-unit quantity.
        const initQty = {};
        for (const item of poData?.items || []) {
          const rem = Math.max(0, Number(item.expected_stock_qty) - Number(summary[item.id] || 0));
          initQty[item.id] = rem > 0 ? String(rem) : '0';
        }
        setRecvQtys(initQty);

        // Init prices: PO snapshot (>0) → supplier link price → 0 (manual entry)
        // Supplier prices from GET /api/supplier-purchase-price (product_supplier_links table).
        let sMap = {};
        const supplierId = poData?.supplier_id;
        const productIds = (poData?.items || []).map(i => i.product_id).filter(Boolean);
        if (supplierId && productIds.length) {
          try {
            const sr = await api.get('/supplier-purchase-price', {
              params: { supplier_id: supplierId, product_ids: productIds.join(',') },
            });
            sMap = sr.data?.prices || {};
          } catch { /* non-fatal — manual entry */ }
        }
        setSupplierPrices(sMap);

        const initPrice = {};
        for (const item of poData?.items || []) {
          const poPrice = Number(item.purchase_price || 0);
          const supplierPrice = sMap[item.product_id] ? Number(sMap[item.product_id]) : 0;
          initPrice[item.id] = String(poPrice > 0 ? poPrice : supplierPrice > 0 ? supplierPrice : '');
        }
        setRecvPrices(initPrice);
      })
      .catch(e => showError(e.response?.data?.message || e.message || 'Không tải được chi tiết phiếu'))
      .finally(() => setPoLoading(false));
  }, [selectedPoId]);

  // S4.1-B: remaining is always against Expected Stock Qty (kg, the ordered × conversion
  // snapshot), never against the PO's ordered quantity in its purchase unit (e.g. crate).
  // received-so-far comes from the derived receivedSummary (ledger sum), not
  // purchase_order_items.received_quantity — see loading effect above.
  const remaining = item => Math.max(0, Number(item.expected_stock_qty) - Number(receivedSummary[item.id] || 0));

  // ── Create voucher ─────────────────────────────────────────────────────────
  const createVoucher = async () => {
    if (!selectedPoId) { showWarning('Chọn phiếu mua hàng'); return; }
    if (!receiveDate) { showWarning('Chọn ngày nhận hàng'); return; }

    for (const item of poDetail?.items || []) {
      const qty = Number(recvQtys[item.id] || 0);
      const rem = remaining(item);
      if (qty > rem + 0.001) {
        showWarning(`Số lượng thực nhận cho "${item.product_name}" (${qty} kg) vượt quá tồn kho dự kiến còn lại (${rem.toFixed(3)} kg)`);
        return;
      }
    }

    const items = (poDetail?.items || [])
      .filter(item => Number(recvQtys[item.id] || 0) > 0)
      .map(item => ({
        purchase_order_item_id: item.id,
        actual_stock_qty: Number(recvQtys[item.id]),
        // Snapshot purchase price at receive time (user-editable; falls back to PO price or default)
        purchase_price: Number(recvPrices[item.id] || 0),
      }));

    if (!items.length) { showWarning('Nhập số lượng thực nhận cho ít nhất một sản phẩm'); return; }

    setCreating(true);
    try {
      const r = await api.post('/inventory-receives', {
        purchase_order_id: Number(selectedPoId),
        receive_date: receiveDate,
        note: note || null,
        supplier_document_no: supplierDocNo || null,
        warehouse_id: warehouseId ? Number(warehouseId) : null,
        items,
      });
      showSuccess(`Đã tạo phiếu ${r.data.receive_code}`);
      openDetail(r.data.id);
    } catch (e) { showError(e.response?.data?.message || e.message || 'Tạo phiếu thất bại'); }
    finally { setCreating(false); }
  };

  // ── Detail ─────────────────────────────────────────────────────────────────
  const openDetail = async id => {
    setView('detail');
    setDetailLoading(true);
    try {
      const r = await api.get(`/inventory-receives/${id}`);
      setDetail(r.data);
    } catch (e) {
      showError(e.response?.data?.message || e.message || 'Không tải được phiếu');
      setView('list');
    } finally { setDetailLoading(false); }
  };

  const postVoucher = async () => {
    const ok = window.appConfirm
      ? await window.appConfirm(`Nhập kho phiếu ${detail.receive_code}?`, { title: 'Xác nhận nhập kho', confirmText: 'Nhập kho', variant: 'primary' })
      : window.confirm(`Nhập kho phiếu ${detail.receive_code}?`);
    if (!ok) return;
    setPosting(true);
    try {
      const r = await api.post(`/inventory-receives/${detail.id}/receive`);
      showSuccess(r.data.message || 'Đã nhập kho');
      await openDetail(detail.id);
    } catch (e) { showError(e.response?.data?.message || e.message || 'Nhập kho thất bại'); }
    finally { setPosting(false); }
  };

  const cancelVoucher = async () => {
    const ok = window.appConfirm
      ? await window.appConfirm(`Hủy phiếu ${detail.receive_code}?`, { title: 'Hủy phiếu nhận', confirmText: 'Hủy phiếu', variant: 'danger' })
      : window.confirm(`Hủy phiếu ${detail.receive_code}?`);
    if (!ok) return;
    setCancelling(true);
    try {
      const r = await api.post(`/inventory-receives/${detail.id}/cancel`);
      showSuccess(r.data.message || 'Đã hủy');
      await openDetail(detail.id);
    } catch (e) { showError(e.response?.data?.message || e.message || 'Hủy thất bại'); }
    finally { setCancelling(false); }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <SafePage loading={false} error="">

      {/* ══════════════════ LIST VIEW ════════════════════════════════════════ */}
      {view === 'list' && <>
        <div className="card" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label style={LBL}>Trạng thái</label>
            <select className="select" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              <option value="">Tất cả</option>
              <option value="PENDING">Chờ nhập kho</option>
              <option value="RECEIVED">Đã nhập kho</option>
              <option value="CANCELLED">Đã hủy</option>
            </select>
          </div>
          <button className="btn secondary" onClick={loadList} disabled={listLoading}>Tải lại</button>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={openCreate}>+ Tạo phiếu nhận hàng</button>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Phiếu nhận hàng ({vouchers.length})</h3>
          {listLoading && <p className="muted">Đang tải...</p>}
          {!listLoading && <table className="table">
            <thead><tr>
              <th>Mã phiếu</th>
              <th>Phiếu mua hàng</th>
              <th>Nhà cung cấp</th>
              <th>Ngày nhận</th>
              <th>Trạng thái</th>
              <th></th>
            </tr></thead>
            <tbody>
              {vouchers.map(v => (
                <tr key={v.id}>
                  <td><b>{v.receive_code}</b></td>
                  <td>{v.purchase_order_code || '—'}</td>
                  <td>{v.supplier_name || '—'}</td>
                  <td>{fmtDate(v.receive_date)}</td>
                  <td><span style={badge(v.status)}>{STATUS_LABEL[v.status] || v.status}</span></td>
                  <td><button className="btn secondary" onClick={() => openDetail(v.id)}>Xem</button></td>
                </tr>
              ))}
              {!vouchers.length && (
                <tr><td colSpan={6} style={{ textAlign: 'center', padding: '28px 0' }}>
                  <p className="muted">Chưa có phiếu nhận hàng nào.</p>
                </td></tr>
              )}
            </tbody>
          </table>}
        </div>
      </>}

      {/* ══════════════════ CREATE VIEW ══════════════════════════════════════ */}
      {view === 'create' && <>
        <div style={{ marginBottom: 12 }}>
          <button className="btn secondary" onClick={() => setView('list')}>← Danh sách</button>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 14 }}>Tạo phiếu nhận hàng</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px 20px', marginBottom: 16 }}>
            <div>
              <label style={LBL}>Phiếu mua hàng <span style={{ color: '#ef4444' }}>*</span></label>
              <select className="select" value={selectedPoId} disabled={posLoading}
                onChange={e => setSelectedPoId(e.target.value)}>
                <option value="">{posLoading ? 'Đang tải...' : 'Chọn phiếu mua hàng...'}</option>
                {pos.map(po => (
                  <option key={po.id} value={po.id}>
                    {po.order_code} — {po.supplier_name || '?'} — {PO_STATUS_LABEL[po.status] || po.status}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={LBL}>Ngày nhận hàng <span style={{ color: '#ef4444' }}>*</span></label>
              <input className="input" type="date" value={receiveDate}
                onChange={e => setReceiveDate(e.target.value)} />
            </div>
            <div>
              <label style={LBL}>Kho nhận</label>
              <select className="select" value={warehouseId} onChange={e => setWarehouseId(e.target.value)}>
                {!warehouses.length && <option value="">Đang tải...</option>}
                {warehouses.map(w => (
                  <option key={w.id} value={w.id}>{w.name}{w.is_default ? ' (mặc định)' : ''}</option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 20px', marginBottom: 16 }}>
            <div>
              <label style={LBL}>Số chứng từ NCC (phiếu giao hàng / hóa đơn)</label>
              <input className="input" placeholder="VD: PGH-00231" value={supplierDocNo}
                onChange={e => setSupplierDocNo(e.target.value)} />
            </div>
            <div>
              <label style={LBL}>Ghi chú</label>
              <input className="input" placeholder="Ghi chú..." value={note}
                onChange={e => setNote(e.target.value)} />
            </div>
          </div>

          {poLoading && <p className="muted">Đang tải chi tiết phiếu mua hàng...</p>}

          {!poLoading && poDetail && <>
            <div style={{ background: '#f0fdf4', borderRadius: 6, padding: '10px 14px', marginBottom: 14, fontSize: 13 }}>
              <b>{poDetail.order_code}</b> · {poDetail.supplier_name} ·{' '}
              <span style={{ color: '#6b7280' }}>{fmtDate(poDetail.purchase_date)}</span> ·{' '}
              <span style={{ color: '#2563eb', fontWeight: 600 }}>{PO_STATUS_LABEL[poDetail.status] || poDetail.status}</span>
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ minWidth: 820 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    <th>Sản phẩm</th>
                    <th style={{ textAlign: 'right' }}>Đặt hàng</th>
                    <th style={{ textAlign: 'right' }}>Dự kiến (kg)</th>
                    <th style={{ textAlign: 'right' }}>Đã nhận (kg)</th>
                    <th style={{ textAlign: 'right' }}>Còn lại (kg)</th>
                    <th style={{ textAlign: 'right', width: 140 }}>Thực nhận (kg)</th>
                    <th style={{ width: 170 }}>Giá mua NCC / Giá nhập</th>
                  </tr>
                </thead>
                <tbody>
                  {poDetail.items.map(item => {
                    const rem = remaining(item);
                    const qty = Number(recvQtys[item.id] || 0);
                    const price = Number(recvPrices[item.id] || 0);
                    const overLimit = qty > rem + 0.001;
                    const poPrice = Number(item.purchase_price || 0);
                    const supplierLinkPrice = supplierPrices[item.product_id] ? Number(supplierPrices[item.product_id]) : 0;
                    const usingSupplierLink = !(poPrice > 0) && supplierLinkPrice > 0 && price === supplierLinkPrice;
                    const priceIsZero = !(price > 0);

                    return (
                      <tr key={item.id} style={rem === 0 ? { opacity: 0.45 } : {}}>
                        <td>
                          <b style={{ fontSize: 13 }}>{item.product_name}</b>
                        </td>
                        <td style={{ textAlign: 'right' }}>{fmt(item.quantity)} <span style={{ color: '#9ca3af', fontSize: 11 }}>{item.unit}</span></td>
                        <td style={{ textAlign: 'right', color: '#6b7280' }}>{fmt(item.expected_stock_qty)}</td>
                        <td style={{ textAlign: 'right', color: '#6b7280' }}>{fmt(receivedSummary[item.id] || 0)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: rem > 0 ? '#059669' : '#9ca3af' }}>
                          {fmt(rem)}
                        </td>
                        <td>
                          <input
                            className="input"
                            type="number"
                            min={0}
                            max={rem}
                            step={0.001}
                            style={{ width: '100%', borderColor: overLimit ? '#ef4444' : '', textAlign: 'right' }}
                            value={recvQtys[item.id] ?? ''}
                            disabled={rem === 0}
                            onChange={e => setRecvQtys(q => ({ ...q, [item.id]: e.target.value }))}
                          />
                          {overLimit && (
                            <div style={{ color: '#ef4444', fontSize: 11, marginTop: 2 }}>
                              Vượt còn lại ({fmt(rem)})
                            </div>
                          )}
                        </td>
                        <td>
                          <input
                            className="input"
                            type="number"
                            min={0}
                            step={1000}
                            style={{
                              width: '100%',
                              textAlign: 'right',
                              borderColor: priceIsZero ? '#f59e0b' : '',
                            }}
                            value={recvPrices[item.id] ?? ''}
                            disabled={rem === 0}
                            onChange={e => setRecvPrices(p => ({ ...p, [item.id]: e.target.value }))}
                          />
                          {priceIsZero && (
                            <div style={{ color: '#f59e0b', fontSize: 11, marginTop: 2 }}>
                              Chưa có giá — nhập thủ công
                            </div>
                          )}
                          {!priceIsZero && usingSupplierLink && (
                            <div style={{ color: '#6b7280', fontSize: 11, marginTop: 2 }}>
                              Giá NCC đã ký kết
                            </div>
                          )}
                          {!priceIsZero && !usingSupplierLink && poPrice > 0 && price !== poPrice && (
                            <div style={{ color: '#6b7280', fontSize: 11, marginTop: 2 }}>
                              Giá PO: {fmt(poPrice)} ₫
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
              <button className="btn" onClick={createVoucher} disabled={creating}>
                {creating ? 'Đang tạo...' : 'Tạo phiếu nhận hàng'}
              </button>
              <button className="btn secondary" onClick={() => setView('list')}>Hủy</button>
            </div>
          </>}

          {!poLoading && !poDetail && !selectedPoId && (
            <p className="muted" style={{ fontSize: 13 }}>
              Chọn phiếu mua hàng để xem danh sách hàng cần nhận.
            </p>
          )}
        </div>
      </>}

      {/* ══════════════════ DETAIL VIEW ══════════════════════════════════════ */}
      {view === 'detail' && <>
        <div style={{ marginBottom: 12 }}>
          <button className="btn secondary" onClick={() => setView('list')}>← Danh sách</button>
        </div>

        {detailLoading && <div className="card"><p className="muted">Đang tải phiếu nhận hàng...</p></div>}

        {!detailLoading && detail && <>
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h3 style={{ margin: 0 }}>
                {detail.receive_code}
                <span style={{ marginLeft: 10, ...badge(detail.status) }}>{STATUS_LABEL[detail.status] || detail.status}</span>
              </h3>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '8px 16px', fontSize: 13 }}>
              <div><span style={{ color: '#6b7280', fontSize: 11 }}>Nhà cung cấp</span><div><b>{detail.supplier_name || '—'}</b></div></div>
              <div><span style={{ color: '#6b7280', fontSize: 11 }}>Ngày nhận</span><div><b>{fmtDate(detail.receive_date)}</b></div></div>
              <div><span style={{ color: '#6b7280', fontSize: 11 }}>Phiếu mua hàng #</span><div>{detail.purchase_order_id}</div></div>
              <div><span style={{ color: '#6b7280', fontSize: 11 }}>Kho nhận</span><div>{detail.warehouse_name || '—'}</div></div>
              <div><span style={{ color: '#6b7280', fontSize: 11 }}>Số chứng từ NCC</span><div>{detail.supplier_document_no || '—'}</div></div>
              <div><span style={{ color: '#6b7280', fontSize: 11 }}>Người tạo</span><div>{detail.created_by_name || '—'}</div></div>
              <div><span style={{ color: '#6b7280', fontSize: 11 }}>Người nhập kho</span><div>{detail.received_by_name ? `${detail.received_by_name} · ${fmtDate(detail.received_at)}` : '—'}</div></div>
              <div><span style={{ color: '#6b7280', fontSize: 11 }}>Ghi chú</span><div>{detail.note || '—'}</div></div>
            </div>
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: '14px 20px 10px', borderBottom: '1px solid #e5e7eb' }}>
              <h4 style={{ margin: 0 }}>Danh sách hàng nhận</h4>
            </div>
            <div style={{ overflowX: 'auto', padding: '0 20px 16px' }}>
              <table className="table" style={{ minWidth: 540 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    <th>Sản phẩm</th>
                    <th style={{ textAlign: 'right' }}>Đặt hàng</th>
                    <th style={{ textAlign: 'right' }}>Dự kiến (kg)</th>
                    <th style={{ textAlign: 'right' }}>Thực nhận (kg)</th>
                    <th style={{ textAlign: 'right' }}>Chênh lệch (kg)</th>
                    <th style={{ textAlign: 'right' }}>Giá mua NCC / Giá nhập</th>
                    <th style={{ textAlign: 'right' }}>Thành tiền</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Chênh lệch (Difference) = Dự kiến − Thực nhận, calculated here only — never stored (S4.1-B). */}
                  {(detail.items || []).map(item => {
                    const diff = Number(item.expected_stock_qty) - Number(item.actual_stock_qty);
                    return (
                      <tr key={item.id}>
                        <td>
                          <b style={{ fontSize: 13 }}>{item.product_name}</b>
                        </td>
                        <td style={{ textAlign: 'right' }}>{fmt(item.ordered_qty)} <span style={{ color: '#9ca3af', fontSize: 11 }}>{item.ordered_unit}</span></td>
                        <td style={{ textAlign: 'right', color: '#6b7280' }}>{fmt(item.expected_stock_qty)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(item.actual_stock_qty)}</td>
                        <td style={{ textAlign: 'right', color: Math.abs(diff) < 0.001 ? '#9ca3af' : (diff > 0 ? '#f59e0b' : '#2563eb') }}>
                          {diff > 0 ? '−' : diff < 0 ? '+' : ''}{fmt(Math.abs(diff))}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {Number(item.purchase_price) > 0
                            ? `${fmt(item.purchase_price)} ₫`
                            : <span style={{ color: '#f59e0b', fontSize: 12 }}>Chưa có giá</span>}
                        </td>
                        <td style={{ textAlign: 'right', color: '#059669', fontWeight: 600 }}>
                          {fmt(Number(item.actual_stock_qty) * Number(item.purchase_price))} ₫
                        </td>
                      </tr>
                    );
                  })}
                  {!(detail.items || []).length && (
                    <tr><td colSpan={7} style={{ textAlign: 'center', padding: '20px 0' }}>
                      <p className="muted">Không có dòng hàng</p>
                    </td></tr>
                  )}
                </tbody>
                {(detail.items || []).length > 0 && (
                  <tfoot>
                    <tr style={{ background: '#f9fafb', fontWeight: 700 }}>
                      <td colSpan={6} style={{ textAlign: 'right', paddingRight: 12 }}>Tổng tiền:</td>
                      <td style={{ textAlign: 'right', color: '#059669', fontSize: 15 }}>
                        {fmt((detail.items || []).reduce((a, item) => a + Number(item.actual_stock_qty) * Number(item.purchase_price), 0))} ₫
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          {detail.status === 'PENDING' && (
            <div className="card">
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button className="btn" onClick={postVoucher} disabled={posting}>
                  {posting ? 'Đang nhập kho...' : '✓ Nhập kho'}
                </button>
                <button className="btn danger" style={{ marginLeft: 'auto' }} onClick={cancelVoucher} disabled={cancelling}>
                  {cancelling ? 'Đang hủy...' : '✕ Hủy phiếu'}
                </button>
              </div>
              <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                Nhấn "Nhập kho" để cộng tồn kho theo phiếu này.
              </p>
            </div>
          )}

          {detail.status === 'RECEIVED' && (
            <div className="card" style={{ background: '#f0fdf4', border: '1px solid #86efac' }}>
              <p style={{ margin: 0, color: '#166534', fontWeight: 600 }}>
                ✓ Phiếu đã nhập kho thành công. Tồn kho đã được cộng.
              </p>
            </div>
          )}

          {detail.status === 'CANCELLED' && (
            <div className="card" style={{ background: '#fef2f2', border: '1px solid #fca5a5' }}>
              <p style={{ margin: 0, color: '#991b1b', fontWeight: 600 }}>✕ Phiếu đã bị hủy.</p>
            </div>
          )}
        </>}
      </>}

    </SafePage>
  );
}
