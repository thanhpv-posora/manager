import React from 'react';

export default function POSAdvancedTools({
  toolsOpen,
  setToolsOpen,
  cid,
  saveOrder,
  toolsFirstInputRef,
  importOpen,
  setImportOpen,
  importSheetFilter,
  setImportSheetFilter,
  importExcelFileRef,
  importImageFileRef,
  startFreshImportSession,
  readExcelFile,
  readImageFile,
  importText,
  setImportText,
  importApplyMode,
  setImportApplyMode,
  previewImport,
  previewHandwriting,
  applyImport,
  importPreview,
  clearCurrentBillQty,
  importMsg,
  updateImportRow,
  addMissingToCatalog,
}) {
  if (!toolsOpen) return null;

  return (
    <div className="card pos-advanced-tools-card">
      <div className="pos-advanced-tools-head">
        <h3 style={{ margin: 0 }}>Công cụ khác</h3>
        <button type="button" className="btn secondary" onClick={() => setToolsOpen(false)}>
          Thu gọn ▴
        </button>
      </div>

      <div className="actions pos-agent-action-row">
        <button ref={toolsFirstInputRef} className="btn secondary" onClick={() => setImportOpen(!importOpen)}>
          {importOpen ? '− Thu gọn import' : '+ Import Excel/Ảnh/Viết tay'}
        </button>
        <button type="button" className="btn tiny secondary" onClick={saveOrder} disabled={!cid}>
          Lưu thứ tự hiển thị
        </button>
      </div>

      {importOpen && (
        <div className="card inner-card">
          <h3>Import đơn từ Excel / hình ảnh</h3>
          <p className="muted">
            File chỉ cần 2 cột: <b>Tên mặt hàng</b> và <b>Số lượng</b>.
          </p>
          <div className="actions">
            <input className="input" style={{ maxWidth: 360 }} placeholder="Sheet cần đọc (trống = tất cả, nhiều sheet cách nhau dấu phẩy)" value={importSheetFilter} onChange={e => setImportSheetFilter(e.target.value)} />
            <input ref={importExcelFileRef} type="file" accept=".xlsx,.xls,.csv" onClick={e => { e.currentTarget.value = ''; startFreshImportSession(); }} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; readExcelFile(file); }} />
            <input ref={importImageFileRef} type="file" accept="image/*" onClick={e => { e.currentTarget.value = ''; startFreshImportSession(); }} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; readImageFile(file); }} />
          </div>
          <textarea className="input" style={{ minHeight: 120, marginTop: 10 }} placeholder={'Bò búp 10+12\nĐùi bò 5.5'} value={importText} onChange={e => setImportText(e.target.value)} />
          <div className="actions" style={{ marginTop: 10 }}>
            <select className="select" style={{ width: 220 }} value={importApplyMode} onChange={e => setImportApplyMode(e.target.value)}>
              <option value="REPLACE">Ghi đè số lượng trong bill</option>
              <option value="ADD">Cộng thêm vào số lượng cũ</option>
            </select>
            <button className="btn secondary" onClick={() => previewImport('text')}>Xem trước import text/excel</button>
            <button className="btn secondary" onClick={() => previewImport('image')}>Xem trước OCR ảnh</button>
            <button className="btn secondary" onClick={previewHandwriting}>Xem ảnh viết tay</button>
            <button className="btn" onClick={applyImport} disabled={!importPreview.length}>Đưa dòng đã chọn vào bill</button>
            <button className="btn danger" onClick={clearCurrentBillQty}>Xóa SL bill hiện tại</button>
          </div>
          {importMsg && <p className="muted">{importMsg}</p>}

          {importPreview.length > 0 && (
            <div className="card inner-card">
              <h3>Preview import</h3>
              <table className="table">
                <thead>
                  <tr>
                    <th>Chọn</th>
                    <th>Raw</th>
                    <th>Mặt hàng khớp</th>
                    <th>Số lượng</th>
                    <th>Trạng thái</th>
                    <th>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {importPreview.map((r, idx) => (
                    <tr key={idx} style={{ background: r.status === 'ERROR' ? '#fee2e2' : (r.status === 'WARN' ? '#fef3c7' : '#dcfce7') }}>
                      <td>
                        <input type="checkbox" checked={!!r.selected} disabled={!r.canApply} onChange={e => updateImportRow(idx, { selected: e.target.checked })} />
                      </td>
                      <td><b>{r.name || r.raw || ''}</b><br /><span className="muted">{r.raw || ''}</span></td>
                      <td>{r.product ? <span>{r.product.product_code} - {r.product.product_name}</span> : <span className="muted">Chưa khớp danh mục</span>}</td>
                      <td>
                        <input inputMode="decimal" className="input" style={{ width: 120 }} value={r.qtyExpr || r.quantity_expr || r.qty || ''} onChange={e => updateImportRow(idx, { qtyExpr: e.target.value })} />
                      </td>
                      <td>
                        {r.errors?.length ? <span>🔴 {r.errors.join(', ')}</span> : r.warnings?.length ? <span>🟡 {r.warnings.join(', ')}</span> : <span>🟢 OK</span>}
                      </td>
                      <td>
                        {r.product_id && !r.inCustomerCatalog && (
                          <button className="btn secondary" onClick={() => addMissingToCatalog(r)}>
                            Thêm vào DM khách
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
