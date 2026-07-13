import React, { useEffect, useState, useCallback } from 'react';
import api from '../api/api';
import SafePage from '../components/SafePage';
import { showError } from '../utils/toast';
import { formatQty } from '../utils/quantity';

// S5.2 — Stock Ledger. Read-only view over stock_transactions
// (backend/src/agents/StockLedgerAgent.js). This page never writes anything —
// there is no create/edit/delete UI here by design.

const fmt = formatQty;
const fmtDate = s => s ? String(s).slice(0, 10) : '—';

const TYPE_LABEL = {
  IN: 'Nhập',
  OUT: 'Xuất',
  ADJUSTMENT_INCREASE: 'Điều chỉnh tăng',
  ADJUSTMENT_DECREASE: 'Điều chỉnh giảm',
};
const REF_TYPE_LABEL = {
  LOT: 'Nhập xô',
  SALE: 'Bán hàng (Bill)',
  MANUAL: 'Thủ công',
  RECEIVE_VOUCHER: 'Phiếu nhận hàng',
  OPENING_BALANCE: 'Tồn đầu kỳ',
};
// S5.2-B — direct bò xô/carcass sales never touch products.stock_quantity;
// default view hides those rows so the running balance reads as a true stock
// ledger. STOCK_EFFECT_LABEL keys are the backend's stock_effect param values.
const STOCK_EFFECT_LABEL = {
  AFFECTING: 'Ảnh hưởng tồn',
  NOT_AFFECTING: 'Không ảnh hưởng tồn',
  ALL: 'Tất cả',
};
// Which page owns the "original document" for a given reference_type —
// used only to navigate there (this app has no per-record deep-link/URL
// routing; every list page manages its own detail state internally).
const REF_TYPE_PAGE = {
  SALE: 'orders',
  RECEIVE_VOUCHER: 'inventory-receives',
  LOT: 'lots',
};

const LBL = { fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 3, color: '#374151' };
const PAGE_SIZE = 50;

export default function StockLedger({ setPage }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPageNum] = useState(1);
  const [loading, setLoading] = useState(false);

  const [products, setProducts] = useState([]);
  const [productId, setProductId] = useState('');
  const [type, setType] = useState('');
  const [referenceType, setReferenceType] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [stockEffect, setStockEffect] = useState('AFFECTING');

  useEffect(() => {
    api.get('/products').then(r => setProducts(r.data || []))
      .catch(() => { /* non-fatal — product filter just stays empty */ });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: PAGE_SIZE };
      if (productId) params.product_id = productId;
      if (type) params.type = type;
      if (referenceType) params.reference_type = referenceType;
      if (dateFrom) params.date_from = dateFrom;
      if (dateTo) params.date_to = dateTo;
      params.stock_effect = stockEffect;
      const r = await api.get('/stock-ledger', { params });
      setRows(r.data?.items || []);
      setTotal(Number(r.data?.total || 0));
    } catch (e) {
      showError(e.response?.data?.message || e.message || 'Không tải được sổ kho');
    } finally { setLoading(false); }
  }, [page, productId, type, referenceType, dateFrom, dateTo, stockEffect]);

  useEffect(() => { load(); }, [load]);

  const applyFilters = () => { setPageNum(1); };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const openReference = (row) => {
    const target = REF_TYPE_PAGE[row.reference_type];
    if (target && setPage) setPage(target);
  };

  return (
    <SafePage loading={false} error="">
      <div className="card" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <label style={LBL}>Từ ngày</label>
          <input className="input" type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        </div>
        <div>
          <label style={LBL}>Đến ngày</label>
          <input className="input" type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
        </div>
        <div>
          <label style={LBL}>Sản phẩm</label>
          <select className="select" value={productId} onChange={e => setProductId(e.target.value)}>
            <option value="">Tất cả</option>
            {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label style={LBL}>Loại giao dịch</label>
          <select className="select" value={type} onChange={e => setType(e.target.value)}>
            <option value="">Tất cả</option>
            {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div>
          <label style={LBL}>Loại chứng từ</label>
          <select className="select" value={referenceType} onChange={e => setReferenceType(e.target.value)}>
            <option value="">Tất cả</option>
            {Object.entries(REF_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div>
          <label style={LBL}>Ảnh hưởng tồn kho</label>
          <select className="select" value={stockEffect} onChange={e => setStockEffect(e.target.value)}>
            {Object.entries(STOCK_EFFECT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <button className="btn" onClick={applyFilters} disabled={loading}>Lọc</button>
        <button className="btn secondary" onClick={load} disabled={loading}>Tải lại</button>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>Sổ kho ({total})</h3>
        {loading && <p className="muted">Đang tải...</p>}
        {!loading && (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ minWidth: 960 }}>
              <thead>
                <tr>
                  <th>Ngày giao dịch</th>
                  <th>Số chứng từ</th>
                  <th>Loại chứng từ</th>
                  <th>Sản phẩm</th>
                  <th style={{ textAlign: 'right' }}>Nhập</th>
                  <th style={{ textAlign: 'right' }}>Xuất</th>
                  <th style={{ textAlign: 'right' }}>Tồn sau</th>
                  <th>Người thực hiện</th>
                  <th>Ghi chú</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const isIn = row.type === 'IN' || row.type === 'ADJUSTMENT_INCREASE';
                  const isOut = row.type === 'OUT' || row.type === 'ADJUSTMENT_DECREASE';
                  const clickable = !!REF_TYPE_PAGE[row.reference_type] && row.reference_id;
                  return (
                    <tr key={row.id}>
                      <td>{fmtDate(row.transaction_date)}</td>
                      <td>
                        {clickable ? (
                          <button
                            type="button"
                            className="btn secondary"
                            style={{ padding: '2px 8px', fontSize: 12 }}
                            onClick={() => openReference(row)}
                            title="Mở chứng từ gốc"
                          >
                            {row.reference_no || `#${row.reference_id}`}
                          </button>
                        ) : (row.reference_no || '—')}
                      </td>
                      <td>{REF_TYPE_LABEL[row.reference_type] || row.reference_type}</td>
                      <td>
                        <b style={{ fontSize: 13 }}>{row.product_name || `#${row.product_id}`}</b>
                        {row.product_code && <div style={{ color: '#9ca3af', fontSize: 11 }}>{row.product_code}</div>}
                      </td>
                      <td style={{ textAlign: 'right', color: '#059669', fontWeight: isIn ? 600 : 400 }}>
                        {isIn ? fmt(row.quantity) : '—'}
                      </td>
                      <td style={{ textAlign: 'right', color: '#dc2626', fontWeight: isOut ? 600 : 400 }}>
                        {isOut ? fmt(row.quantity) : '—'}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>
                        {row.affect_stock ? fmt(row.balance_after) : (
                          <>
                            —
                            <div style={{ color: '#f59e0b', fontSize: 11, fontWeight: 400, marginTop: 2 }}>
                              Không ảnh hưởng tồn
                            </div>
                          </>
                        )}
                      </td>
                      <td>{row.created_by_name || '—'}</td>
                      <td>{row.note || '—'}</td>
                    </tr>
                  );
                })}
                {!rows.length && (
                  <tr><td colSpan={9} style={{ textAlign: 'center', padding: '28px 0' }}>
                    <p className="muted">Không có giao dịch tồn kho nào.</p>
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 10, alignItems: 'center', marginTop: 14 }}>
            <button className="btn secondary" disabled={page <= 1} onClick={() => setPageNum(p => Math.max(1, p - 1))}>← Trước</button>
            <span style={{ fontSize: 13, color: '#6b7280' }}>Trang {page} / {totalPages}</span>
            <button className="btn secondary" disabled={page >= totalPages} onClick={() => setPageNum(p => p + 1)}>Sau →</button>
          </div>
        )}
      </div>
    </SafePage>
  );
}
