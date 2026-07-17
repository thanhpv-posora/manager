import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../api/api';
import SafePage from '../components/SafePage';
import EnterpriseAutocomplete from '../components/common/EnterpriseAutocomplete';
import { formatQty } from '../utils/quantity';
import { showSuccess, showError, showWarning } from '../utils/toast';

// S11 — Bán hàng kho (Warehouse Sales), TRACK_STOCK only.
//
// Deliberately NOT a copy of CreateOrder.jsx (the Bò Xô / CARCASS_PART POS
// screen) — a separate, minimal page per the S11 domain-separation decision.
// Reuses only: customer/category/catalog APIs, OrderAgent.create() (via
// POST /orders with sales_flow='INVENTORY_SALE'), formatQty(), toast.
// No Excel Import, AI Voice, OCR, Quick Add, or manual price entry in V1.
// Backend (InventoryService/postOut, OrderAgent's sales_flow guard) remains
// the sole authority — every check here is early-warning only.

const money = n => Number(n || 0).toLocaleString('en-US') + 'đ';
const isOverStock = (allowNegativeStock, stockQuantity, qty) =>
  Number(allowNegativeStock) !== 1 && Number(qty || 0) > Number(stockQuantity || 0);

export default function InventorySales() {
  const [customers, setCustomers] = useState([]);
  const [cid, setCid] = useState('');
  const [categorySelection, setCategorySelection] = useState({ categories: [], auto_selected_category_id: null });
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const today = new Date().toISOString().slice(0, 10);
  const qtyRefs = useRef({});
  const idempotencyKeyRef = useRef(null);

  useEffect(() => {
    api.get('/partners', { params: { role: 'customer' } })
      .then(r => {
        setCustomers(r.data || []);
        // S1F Task 4: consume the one-shot customer handoff left by CreateOrder's
        // S1E auto-navigation (default_sales_flow=INVENTORY_SALE redirect), so
        // the user never has to re-pick the customer here. Read once, then clear
        // immediately regardless of outcome — App.jsx's page dispatcher takes no
        // navigation params, so sessionStorage is the only channel available
        // without touching App.jsx (not in this task's allowed files). Bill
        // date/calendar context in the handoff is intentionally not applied —
        // this page has no bill-date/calendar picker to receive it (V1, "where
        // already supported" — adding one would be a redesign, out of scope).
        // default_sales_flow is never treated as a pricing rule here; this
        // screen's own explicit sales_flow='INVENTORY_SALE' context (already
        // sent on every request) remains the sole branch authority.
        try {
          const raw = sessionStorage.getItem('s1e_pending_customer_context');
          if (raw) {
            sessionStorage.removeItem('s1e_pending_customer_context');
            const ctx = JSON.parse(raw);
            if (ctx?.customer_id && (r.data || []).some(c => String(c.id) === String(ctx.customer_id))) {
              selectCustomer(String(ctx.customer_id));
            }
          }
        } catch (e) { /* malformed/stale handoff — ignore, user picks manually */ }
      })
      .catch(e => setError(e.response?.data?.message || e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentCustomer = useMemo(() => customers.find(c => String(c.id) === String(cid)), [customers, cid]);

  const loadCatalog = async (customerId, categoryId) => {
    if (!customerId || !categoryId) { setItems([]); return; }
    setCatalogLoading(true);
    try {
      const r = (await api.get(`/price-matrix/${customerId}/catalog/order`, {
        // S1F: explicit branch context on every request — this screen is always
        // INVENTORY_SALE. Never falls back to a Legacy NULL or CARCASS_POS
        // category; the backend rejects a category that doesn't match with a
        // clear business error, surfaced below rather than silently swallowed.
        // S1I Patch B: sales_flow alone determines the catalog — inventory_mode
        // is an independent Inventory Domain axis and must never be sent as a
        // second, redundant catalog-determining filter (INVENTORY_SALE already
        // implies TRACK_STOCK server-side).
        params: { category_id: categoryId, sales_flow: 'INVENTORY_SALE' },
      })).data;
      setItems((r.products || []).map(p => ({ ...p, quantity_expr: '', quantity: 0 })));
    } catch (e) {
      showError(e.response?.data?.message || e.message || 'Không tải được danh mục hàng hóa');
      setItems([]);
    } finally { setCatalogLoading(false); }
  };

  const selectCustomer = async (id) => {
    setCid(id);
    setSelectedCategoryId('');
    setItems([]);
    if (!id) { setCategorySelection({ categories: [], auto_selected_category_id: null }); return; }
    try {
      // S1F: INVENTORY_SALE has no Legacy-NULL fallback (unlike CreateOrder's
      // CARCASS_POS) — the backend returns an empty category list rather than
      // ever handing back a NULL or CARCASS_POS category. needs_initialization
      // in that case is a normal, valid response (shown via the existing
      // "chưa có danh mục giá nào" message below), not an error.
      const sel = (await api.get(`/price-matrix/${id}/categories`, { params: { sales_flow: 'INVENTORY_SALE' } })).data;
      setCategorySelection(sel || { categories: [], auto_selected_category_id: null });
      if (sel?.auto_selected_category_id) {
        const catId = String(sel.auto_selected_category_id);
        setSelectedCategoryId(catId);
        await loadCatalog(id, catId);
      }
    } catch (e) {
      // A genuine backend rejection (e.g. invalid sales_flow) must be shown, not
      // silently swallowed — this used to reset to an empty selection with no
      // feedback at all.
      showError(e.response?.data?.message || e.message || 'Không tải được danh mục giá của khách hàng');
      setCategorySelection({ categories: [], auto_selected_category_id: null });
    }
  };

  const selectCategory = async (catId) => {
    setSelectedCategoryId(catId);
    await loadCatalog(cid, catId);
  };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter(x =>
      String(x.product_name || '').toLowerCase().includes(q) ||
      String(x.product_code || '').toLowerCase().includes(q)
    );
  }, [items, filter]);

  const updateQty = (productId, value) => {
    const qty = Number(String(value || '').replace(',', '.')) || 0;
    setItems(prev => prev.map(x => x.product_id === productId ? { ...x, quantity_expr: value, quantity: qty } : x));
  };

  const selected = items.filter(i => Number(i.quantity) > 0);
  const total = selected.reduce((s, i) => s + Number(i.quantity || 0) * Number(i.sale_price || 0), 0);
  const totalQty = selected.reduce((s, i) => s + Number(i.quantity || 0), 0);

  const save = async () => {
    if (saving) return;
    if (!cid) return showWarning('Chọn khách hàng');
    if (!selectedCategoryId) return showWarning('Chọn danh mục giá');
    if (!selected.length) return showWarning('Nhập số lượng ít nhất 1 mặt hàng');

    // Non-blocking nudge only — backend InventoryService/postOut() remains the
    // sole authority on whether a sale is actually allowed (same S9 rule).
    const overStockItem = selected.find(i => isOverStock(i.allow_negative_stock, i.stock_quantity, i.quantity));
    if (overStockItem) qtyRefs.current[overStockItem.product_id]?.focus();

    setSaving(true);
    try {
      if (!idempotencyKeyRef.current) {
        idempotencyKeyRef.current = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      }
      const r = await api.post('/orders', {
        customer_id: cid,
        order_date: today,
        calendar_type: 'SOLAR',
        current_bill_amount: total,
        paid_amount: 0,
        items: selected.map(i => ({
          product_id: i.product_id,
          product_name: i.product_name,
          unit: i.unit || 'kg',
          quantity: Number(i.quantity),
          sale_price: Number(i.sale_price || 0),
          price_type: i.price_type || 'COMMON_PRICE',
          price_book_id: i.price_book_id || null,
        })),
        idempotency_key: idempotencyKeyRef.current,
        sales_flow: 'INVENTORY_SALE',
      });
      idempotencyKeyRef.current = null;
      showSuccess(`Đã lưu ${r.data.order_code}`);
      await loadCatalog(cid, selectedCategoryId); // refresh stock + clear quantities
    } catch (e) {
      showError(e.response?.data?.message || e.message || 'Không lưu được bill');
    } finally { setSaving(false); }
  };

  return (
    <SafePage loading={loading} error={error}>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Bán hàng kho</h3>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ minWidth: 240 }}>
            <label className="field-label"><span>Chọn khách hàng</span>
              <EnterpriseAutocomplete
                items={customers}
                value={currentCustomer || null}
                onChange={c => selectCustomer(c ? String(c.id) : '')}
                displayField="name"
                secondaryFields={['customer_code', 'phone']}
                searchFields={['name', 'customer_code', 'phone']}
                placeholder="Tìm khách hàng..."
                emptyText="Không tìm thấy khách hàng"
                getItemKey={c => c.id}
              />
            </label>
          </div>
          <div style={{ minWidth: 200 }}>
            <label className="field-label"><span>Chọn danh mục giá</span>
              <select className="select" value={selectedCategoryId} disabled={!cid} onChange={e => selectCategory(e.target.value)}>
                <option value="">-- Chọn danh mục --</option>
                {categorySelection.categories.map(c => (
                  <option key={c.category_id} value={c.category_id}>{c.category_name}{c.is_default ? ' (mặc định)' : ''}</option>
                ))}
              </select>
            </label>
            {cid && !categorySelection.categories.length && (
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Khách hàng chưa có danh mục giá nào.</div>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label className="field-label"><span>Tìm mặt hàng</span>
              <input className="input" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Tìm mã, tên mặt hàng..." />
            </label>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Mã hàng</th><th>Tên mặt hàng</th><th>ĐVT</th><th>Tồn hiện tại</th>
                <th>Số lượng bán</th><th>Đơn giá</th><th>Thành tiền</th>
              </tr>
            </thead>
            <tbody>
              {catalogLoading && <tr><td colSpan={7} style={{ textAlign: 'center' }}>Đang tải...</td></tr>}
              {!catalogLoading && !shown.length && (
                <tr><td colSpan={7} style={{ textAlign: 'center' }} className="muted">
                  {!cid ? 'Chọn khách hàng' : !selectedCategoryId ? 'Chọn danh mục giá' : 'Không có mặt hàng quản lý tồn kho trong danh mục này'}
                </td></tr>
              )}
              {shown.map(i => {
                const overStock = i.quantity_expr && isOverStock(i.allow_negative_stock, i.stock_quantity, i.quantity);
                return (
                  <tr key={i.product_id} style={overStock ? { background: '#fef2f2' } : undefined}>
                    <td className="muted">{i.product_code}</td>
                    <td>
                      <b>{i.product_name}</b>
                      {Number(i.allow_negative_stock) === 1 && <div className="muted" style={{ fontSize: 11 }}>Cho bán âm</div>}
                    </td>
                    <td className="muted">{i.unit || 'kg'}</td>
                    <td>{formatQty(i.stock_quantity)}</td>
                    <td>
                      <input
                        ref={el => qtyRefs.current[i.product_id] = el}
                        className="input"
                        style={overStock ? { borderColor: '#dc2626', background: '#fef2f2' } : undefined}
                        inputMode="decimal"
                        value={i.quantity_expr || ''}
                        onChange={e => updateQty(i.product_id, e.target.value)}
                        placeholder="0"
                      />
                      {overStock && (
                        <div style={{ color: '#dc2626', fontSize: 11, marginTop: 2 }}>
                          Vượt tồn: còn {formatQty(i.stock_quantity)}, đang nhập {formatQty(i.quantity)}
                        </div>
                      )}
                    </td>
                    <td>{money(i.sale_price)}</td>
                    <td><b>{money(Number(i.quantity || 0) * Number(i.sale_price || 0))}</b></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div>Số lượng: <b>{formatQty(totalQty)}</b></div>
          <div>Tổng bill: <b>{money(total)}</b></div>
        </div>
        <button className="btn" disabled={saving || !cid || !selectedCategoryId || !selected.length} onClick={save}>
          {saving ? 'Đang lưu...' : 'Lưu bill'}
        </button>
      </div>
    </SafePage>
  );
}
