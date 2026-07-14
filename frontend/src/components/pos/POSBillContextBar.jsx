import React from 'react';
import EnterpriseAutocomplete from '../common/EnterpriseAutocomplete';

export default function POSBillContextBar({
  customers,
  cid,
  currentCustomer,
  customerAutocompleteRef,
  onChangeCustomer,
  walkInCustomer,
  paymentPolicyText,
  orderDate,
  today,
  billCalendarType,
  billLunarDateText,
  onOpenShipDateModal,
  selectedCategoryId,
  categories,
  categorySelection,
  categoryChooserOpen,
  setCategoryChooserOpen,
  unassignedCategories,
  addCategoryPickerId,
  setAddCategoryPickerId,
  addCategoryBusy,
  onPickExistingCategory,
  onConfirmAddCategory,
  noPrivatePrice,
  catalogLoading,
  activeBookEffectiveFrom,
  categorySelectRef,
  onStartChangeCustomer,
}) {
  const categoryName = categories.find(c => String(c.id) === String(selectedCategoryId))?.name || '';
  const effectiveFromDisplay = activeBookEffectiveFrom
    ? String(activeBookEffectiveFrom).slice(0, 10).split('-').reverse().join('/')
    : '';
  const priceStatusClass = catalogLoading ? 'loading' : (noPrivatePrice ? 'none' : 'ok');
  const dateValue = billCalendarType === 'LUNAR'
    ? (billLunarDateText || 'chưa chọn')
    : String(orderDate || today).slice(0, 10).split('-').reverse().join('/');

  return (
    <div className="card pos-context-card">
      <div className="pos-context-row">
        <div className="pos-field pos-field-customer">
          <span className="pos-field-label">Khách hàng</span>
          <EnterpriseAutocomplete
            ref={customerAutocompleteRef}
            items={customers}
            value={customers.find(c => String(c.id) === String(cid)) || null}
            onChange={item => onChangeCustomer(item ? String(item.id) : '')}
            placeholder="Tìm khách hàng..."
            displayField="name"
            secondaryFields={['customer_code', 'phone']}
            searchFields={['name', 'customer_code', 'phone', 'address']}
            filter={item => (Number(item.partner_type || 2) & 2) === 2}
            emptyText="Không tìm thấy khách hàng"
            getItemKey={item => item.id}
          />
        </div>

        {currentCustomer && selectedCategoryId && !categoryChooserOpen && (
          <div className="pos-field" title="Mỗi bill chỉ áp dụng cho 1 danh mục hàng hóa (1 bill = 1 khách hàng + 1 danh mục)">
            <span className="pos-field-label">Danh mục</span>
            <div className="pos-field-value-row">
              <span className="pos-field-value">{categoryName}</span>
              <button type="button" className="btn tiny secondary" onClick={() => setCategoryChooserOpen(true)}>Đổi</button>
            </div>
          </div>
        )}

        {currentCustomer && (
          <div className="pos-field" title="Ngày xuất hàng dùng để lấy bảng giá riêng đúng thời gian bill">
            <span className="pos-field-label">Ngày bill</span>
            <div className="pos-field-value-row">
              <span className="pos-field-value">{dateValue}</span>
              <button type="button" className="btn tiny secondary" onClick={() => onOpenShipDateModal(currentCustomer)}>Đổi</button>
            </div>
          </div>
        )}

        {currentCustomer && (
          <div className="pos-field">
            <span className="pos-field-label">Lịch</span>
            <span className="pos-field-value">{billCalendarType === 'LUNAR' ? 'Âm lịch' : 'Dương lịch'}</span>
          </div>
        )}

        {currentCustomer && selectedCategoryId && !categoryChooserOpen && (
          <div className="pos-field" title="Trạng thái bảng giá riêng của khách hàng cho danh mục này">
            <span className="pos-field-label">Bảng giá</span>
            {catalogLoading ? (
              <span className="pos-field-value">
                <span className="pos-price-dot pos-price-dot-loading"/>
                Đang tải giá
              </span>
            ) : noPrivatePrice ? (
              <span className="pos-field-value">
                <span className="pos-price-dot pos-price-dot-none"/>
                Chưa có bảng giá riêng
              </span>
            ) : (
              <span className="pos-field-value pos-field-value-stack">
                <span><span className={`pos-price-dot pos-price-dot-${priceStatusClass}`}/>{categoryName}</span>
                {effectiveFromDisplay && <span className="pos-field-sub">Hiệu lực: {effectiveFromDisplay}</span>}
              </span>
            )}
          </div>
        )}

        {currentCustomer && (
          <div className="pos-field pos-field-change">
            <span className="pos-field-label">&nbsp;</span>
            <button type="button" className="btn secondary" onClick={onStartChangeCustomer}>
              Đổi khách
            </button>
          </div>
        )}
      </div>

      {currentCustomer && (
        <div className={walkInCustomer ? 'pos-policy-note warn' : 'pos-policy-note'}>
          {paymentPolicyText}
        </div>
      )}

      {currentCustomer && (categoryChooserOpen || !selectedCategoryId) && (
        <div className="pos-category-chooser">
          {categorySelection.needs_initialization && (
            <p className="notice">Khách hàng này chưa có danh mục giá nào. Chọn danh mục hàng hóa để bắt đầu tạo bill.</p>
          )}
          {categorySelection.requires_selection && (
            <p className="notice">Khách hàng có nhiều danh mục giá và chưa đặt mặc định. Vui lòng chọn danh mục cho bill này.</p>
          )}

          {categorySelection.categories.length > 0 && (
            <div className="pos-bill-context-row">
              <b>Chọn danh mục đã có:</b>
              <select ref={categorySelectRef} className="select" value={selectedCategoryId} onChange={e => onPickExistingCategory(e.target.value)}>
                <option value="">-- Chọn danh mục --</option>
                {categorySelection.categories.map(c => (
                  <option key={c.id} value={c.category_id}>{c.category_name}{c.is_default ? ' (mặc định)' : ''}</option>
                ))}
              </select>
            </div>
          )}

          <div className="pos-bill-context-row" style={{ marginTop: 8 }}>
            <b>{categorySelection.categories.length > 0 ? '+ Thêm danh mục khác:' : 'Chọn danh mục hàng hóa mới:'}</b>
            <select ref={categorySelection.categories.length > 0 ? undefined : categorySelectRef} className="select" value={addCategoryPickerId} onChange={e => setAddCategoryPickerId(e.target.value)}>
              <option value="">-- Chọn danh mục --</option>
              {unassignedCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button type="button" className="btn secondary" disabled={!addCategoryPickerId || addCategoryBusy} onClick={onConfirmAddCategory}>
              {addCategoryBusy ? 'Đang tạo...' : 'Xác nhận tạo'}
            </button>
          </div>

          {selectedCategoryId && (
            <button type="button" className="btn tiny secondary" style={{ marginTop: 8 }} onClick={() => setCategoryChooserOpen(false)}>
              Đóng
            </button>
          )}
        </div>
      )}
    </div>
  );
}
