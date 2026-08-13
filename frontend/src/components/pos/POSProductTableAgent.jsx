import React from 'react';
import {calcQtyExpression} from '../../utils/qtyExpression';
import {movePosGridFocus} from '../../utils/posKeyboard';
import {formatQty, formatQtyTrim, isOverStock} from '../../utils/quantity';

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
  searchInputRef,
  fastEntryFromSearchRef,
  focusNext,
  focusFirstFilteredItem,
  onQtyCommitEnter,
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
  onBrowseOtherFlow,
  otherFlowLabel,
  onOpenImportDialog,
}){
  const hasStockColumn = shown.some(i => String(i.inventory_mode || '').toUpperCase() === 'TRACK_STOCK');
  return (
    <div className="card pos-agent-products-card">
      <div className="actions pos-agent-products-toolbar">
        <span className="pos-search-wrap">
          <span className="pos-search-icon">🔍</span>
          <input
            ref={searchInputRef}
            className="input pos-agent-search-input"
            placeholder="Tìm mã, tên mặt hàng..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            onKeyDown={e=>{
              if(e.key==='Enter'){
                e.preventDefault();
                focusFirstFilteredItem?.();
              } else if(e.key==='Escape'){
                setFilter('');
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
        {onBrowseOtherFlow && (
          <button type="button" className="btn secondary" onClick={onBrowseOtherFlow}>
            + Thêm hàng {otherFlowLabel}
          </button>
        )}
        {/* Patch 01 scaffolding — new dialog-framework entry point for Import,
            empty until Patch 04 relocates it. Add Product's and Quick Add's
            scaffolding buttons are gone: Patches 02/03 made their existing
            production buttons above the one entry point for each workflow,
            opening the same dialogs these placeholders used to.
            import.meta.env.DEV is Vite's built-in dev-server flag: true only
            under `npm run dev`, always false in a production build — so these
            never render for a real end user, only for local/dev verification. */}
        {import.meta.env.DEV && onOpenImportDialog && (
          <button type="button" className="btn secondary" onClick={onOpenImportDialog}>
            Import
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
              {hasStockColumn && <th>Tồn kho</th>}
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
              const overStock = i.quantity_expr && isOverStock(i.inventory_mode, i.allow_negative_stock, i.stock_quantity, qty);
              return (
                <tr
                  key={i.product_id}
                  draggable
                  onDragStart={() => setDragId(i.product_id)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={() => handleDrop(i.product_id)}
                  className={String(dragId) === String(i.product_id) ? 'dragging' : ''}
                  style={overStock ? {background:'#fef2f2'} : undefined}
                >
                  <td className="pos-col-stt muted">{rowNo + 1}</td>
                  <td><b>{i.product_name}</b></td>
                  <td className="pos-col-unit muted">{i.unit || 'kg'}</td>
                  {hasStockColumn && (
                    <td className="muted">{String(i.inventory_mode||'').toUpperCase()==='TRACK_STOCK' ? formatQty(i.stock_quantity) : ''}</td>
                  )}

                  <td>
                    <input
                      ref={el => qtyRefs.current[i.product_id] = el}
                      className="input pos-agent-qty-input"
                      style={overStock ? {borderColor:'#dc2626'} : undefined}
                      data-pos-col="qty"
                      data-pos-row={rowKey}
                      value={i.quantity_expr || ''}
                      onFocus={() => { if (fastEntryFromSearchRef) fastEntryFromSearchRef.current = false; }}
                      onKeyDown={e => {
                        // Only the one row that search's Enter just landed on gets the
                        // "return to search" behavior; every other qty Enter (manual click,
                        // or already mid-grid) keeps the original next-row grid navigation.
                        if (e.key === 'Enter' && !e.shiftKey && fastEntryFromSearchRef?.current) {
                          e.preventDefault();
                          // A valid, in-stock quantity sends focus back to search for the
                          // next product. An overstock or empty/zero quantity keeps focus
                          // here — the inline warning above already covers the overstock
                          // case, nothing more to show.
                          if (!overStock && qty > 0) {
                            fastEntryFromSearchRef.current = false;
                            onQtyCommitEnter?.();
                          }
                          return;
                        }
                        movePosGridFocus(e);
                      }}
                      onChange={e => updateQtyExpr(rowIndex, e.target.value)}
                      placeholder="10+12"
                    />
                    {i.quantity_note
                      ? <span className="pos-qty-computed">= {i.quantity_note}</span>
                      : (i.quantity_expr && <span className="pos-qty-computed">= {formatQtyTrim(qty)}</span>)}
                    {overStock && <div style={{color:'#dc2626',fontSize:11,marginTop:2}}>Vượt tồn: còn {formatQty(i.stock_quantity)}</div>}
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
