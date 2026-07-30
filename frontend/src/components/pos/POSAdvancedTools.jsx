import React from 'react';

export default function POSAdvancedTools({
  toolsOpen,
  setToolsOpen,
  cid,
  saveOrder,
  toolsFirstInputRef,
  onOpenExcelImportDialog,
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
        {/* Patch 04C — production cutover: this button now opens the Excel
            Import dialog (excelImportDialogOpen) instead of toggling importOpen
            to reveal an inline card. The inline card and every control that used
            to live inside it have been removed — relocated to CreateOrder.jsx's
            Excel Import dialog in Patch 04B, now the sole production copy. */}
        <button ref={toolsFirstInputRef} className="btn secondary" onClick={onOpenExcelImportDialog}>
          + Import Excel/Ảnh/Viết tay
        </button>
        <button type="button" className="btn tiny secondary" onClick={saveOrder} disabled={!cid}>
          Lưu thứ tự hiển thị
        </button>
      </div>
    </div>
  );
}
