import React from 'react';
import {calcQtyExpression} from '../../utils/qtyExpression';
import {movePosGridFocus} from '../../utils/posKeyboard';
import {formatQty} from '../../utils/quantity';
import {isQtyOverStock} from '../../utils/inventoryStockWarning';

const money = n => Number(n || 0).toLocaleString('en-US') + 'đ';

const fmtPrice = v => v > 0 ? Number(v).toLocaleString('en-US') : '';
const parsePrice = str => {
  const raw = String(str || '').replace(/[^0-9]/g, '');
  return raw ? parseInt(raw, 10) : 0;
};

export default function POSProductTableAgent({
  shown,
  items,
  filter,
  setFilter,
  qtyRefs,
  focusNext,
  focusFirstFilteredItem,
  updateQtyExpr,
  dragId,
  setDragId,
  handleDrop,
  allowManualPrice,
  updatePrice,
  priceRefs,
  onQuickAdd,
  onOpenTools,
  onClearRow,
  quickOpen,
  toolsOpen,
}){
  return (
    <div className="card pos-agent-products-card">
      <div className="actions pos-agent-products-toolbar">
        <span className="pos-search-wrap">
          <span className="pos-search-icon">🔍</span>
          <input
            className="input pos-agent-search-input"
            placeholder="Tìm mã, tên mặt hàng..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            onKeyDown={e=>{
              if(e.key==='Enter'){
                e.preventDefault();
                focusFirstFilteredItem?.();
              }
            }}
          />
        </span>
        {onQuickAdd && (
          <button type="button" className="btn secondary" onClick={onQuickAdd}>
            {quickOpen ? '− Thu gọn' : '+ Thêm nhanh'}
          </button>
        )}
        {onOpenTools && (
          <button type="button" className="btn secondary" onClick={onOpenTools}>
            {toolsOpen ? '− Thu gọn công cụ' : '⚙ Công cụ'}
          </button>
        )}
      </div>

      <div className="pos-agent-table-scroll">
        <table className="table pos-agent-table">
          <thead>
            <tr>
              <th className="pos-col-stt">#</th>
              <th>Tên</th>
              <th className="pos-col-unit">ĐVT</th>
              <th className="pos-col-unit">Tồn</th>
              <th>Số lượng</th>
              <th>Đơn giá</th>
              <th>Thành tiền</th>
              <th className="pos-col-del"/>
            </tr>
          </thead>
          <tbody>
            {shown.map((i, rowNo) => {
              const rowIndex = items.findIndex(x => x.product_id === i.product_id);
              const qty = Number(calcQtyExpression(i.quantity_expr) || 0);
              const rowKey = String(i.product_id);
              const overStock = i.quantity_expr ? isQtyOverStock(i.inventory_mode, i.allow_negative_stock, i.stock_quantity, qty) : false;
              const modeLabel = i.inventory_mode === 'TRACK_STOCK'
                ? `Kiểm tồn${Number(i.allow_negative_stock) === 1 ? ' · Cho bán âm' : ''}`
                : i.inventory_mode === 'CARCASS_PART' ? 'Bò Xô' : 'Không kiểm tồn';
              return (
                <tr
                  key={i.product_id}
                  draggable
                  onDragStart={() => setDragId(i.product_id)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={() => handleDrop(i.product_id)}
                  className={String(dragId) === String(i.product_id) ? 'dragging' : ''}
                  style={overStock ? { background: '#fef2f2' } : undefined}
                >
                  <td className="pos-col-stt muted">{rowNo + 1}</td>
                  <td>
                    <b>{i.product_name}</b>
                    <div className="muted" style={{ fontSize: 11 }}>{modeLabel}</div>
                  </td>
                  <td className="pos-col-unit muted">{i.unit || 'kg'}</td>
                  <td className="pos-col-unit muted">
                    {i.inventory_mode === 'TRACK_STOCK'
                      ? `${formatQty(i.stock_quantity)}${i.unit ? ' ' + i.unit : ''}`
                      : <span title={i.inventory_mode === 'CARCASS_PART' ? 'Bò Xô / bán trực tiếp, không kiểm tồn' : 'Mặt hàng không quản lý tồn'}>—</span>}
                  </td>

                  <td>
                    <input
                      ref={el => qtyRefs.current[i.product_id] = el}
                      className="input pos-agent-qty-input"
                      style={overStock ? { borderColor: '#dc2626', background: '#fef2f2' } : undefined}
                      data-pos-col="qty"
                      data-pos-row={rowKey}
                      value={i.quantity_expr || ''}
                      onKeyDown={e => movePosGridFocus(e)}
                      onChange={e => updateQtyExpr(rowIndex, e.target.value)}
                      placeholder="10+12"
                    />
                    {i.quantity_expr && <span className="pos-qty-computed">= {formatQty(qty)}</span>}
                    {overStock && (
                      <div style={{ color: '#dc2626', fontSize: 11, marginTop: 2 }}>
                        Vượt tồn: còn {formatQty(i.stock_quantity)}, đang nhập {formatQty(qty)}
                      </div>
                    )}
                  </td>

                  <td>
                    {allowManualPrice
                      ? <input
                          ref={el => { if(priceRefs) priceRefs.current[i.product_id] = el; }}
                          className="input pos-agent-qty-input"
                          inputMode="numeric"
                          data-pos-col="price"
                          data-pos-row={rowKey}
                          value={fmtPrice(i.sale_price)}
                          placeholder="Giá bán"
                          onChange={e => updatePrice && updatePrice(rowIndex, e.target.value)}
                          onKeyDown={e => movePosGridFocus(e)}
                        />
                      : money(i.sale_price)
                    }
                  </td>

                  <td><b>{money(qty * Number(i.sale_price || 0))}</b></td>

                  <td className="pos-col-del">
                    {i.quantity_expr && (
                      <button type="button" className="pos-row-del-btn" title="Xóa số lượng dòng này" onClick={() => onClearRow && onClearRow(rowIndex)}>✕</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
