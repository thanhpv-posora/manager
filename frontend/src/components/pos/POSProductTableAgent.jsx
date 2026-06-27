import React from 'react';
import {calcQtyExpression} from '../../utils/qtyExpression';
import {movePosGridFocus} from '../../utils/posKeyboard';

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
  saveOrder,
  cid,
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
}){
  return (
    <div className="card pos-agent-products-card">
      <h3>2. Danh mục mặt hàng của khách</h3>

      <div className="actions pos-agent-products-toolbar">
        <input
          className="input"
          placeholder="Tìm mặt hàng..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          onKeyDown={e=>{
            if(e.key==='Enter'){
              e.preventDefault();
              focusFirstFilteredItem?.();
            }
          }}
        />
        <button type="button" className="btn secondary" onClick={saveOrder} disabled={!cid}>
          Lưu thứ tự
        </button>
      </div>

      <div className="pos-agent-table-scroll">
        <table className="table pos-agent-table">
          <thead>
            <tr>
              <th>Mặt hàng</th>
              <th>SL nhập</th>
              <th>SL tính</th>
              <th>Giá</th>
              <th>Thành tiền</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(i => {
              const rowIndex = items.findIndex(x => x.product_id === i.product_id);
              const qty = Number(calcQtyExpression(i.quantity_expr) || 0);
              const rowKey = String(i.product_id);
              return (
                <tr
                  key={i.product_id}
                  draggable
                  onDragStart={() => setDragId(i.product_id)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={() => handleDrop(i.product_id)}
                  className={String(dragId) === String(i.product_id) ? 'dragging' : ''}
                >
                  <td>
                    <b>{i.product_name}</b>
                    <br/>
                    <span className="muted">{i.category_name}</span>
                  </td>

                  <td>
                    <input
                      ref={el => qtyRefs.current[i.product_id] = el}
                      className="input pos-agent-qty-input"
                      data-pos-col="qty"
                      data-pos-row={rowKey}
                      value={i.quantity_expr || ''}
                      onKeyDown={e => movePosGridFocus(e)}
                      onChange={e => updateQtyExpr(rowIndex, e.target.value)}
                      placeholder="10+12"
                    />
                  </td>

                  <td><b>{qty}</b></td>

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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
