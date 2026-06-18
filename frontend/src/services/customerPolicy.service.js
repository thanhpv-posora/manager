function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .trim();
}

function getCustomerPolicy(customer = {}) {
  const joined = [
    customer.customer_type,
    customer.type,
    customer.group_type,
    customer.customer_group,
    customer.name,
    customer.code,
    customer.customer_code,
    customer.phone,
    customer.note
  ].map(normalizeText).join(' ');

  const isWalkIn =
    joined.includes('walk') ||
    joined.includes('vang lai') ||
    joined.includes('khach le') ||
    joined.includes('khach vang') ||
    joined.includes('le') && joined.includes('khach');

  if (isWalkIn) {
    return {
      customer_payment_type: 'WALK_IN',
      requires_immediate_payment: true,
      allow_pos_payment: true,
      default_payment_status: 'PAID',
      note: 'Khách vãng lai: lấy hàng và thu tiền ngay tại POS.'
    };
  }

  return {
    customer_payment_type: 'REGULAR',
    requires_immediate_payment: false,
    allow_pos_payment: false,
    default_payment_status: 'UNPAID',
    note: 'Khách hàng thường: tạo bill trước, thu tiền xử lý ở màn Thu tiền.'
  };
}

module.exports = {
  getCustomerPolicy
};
