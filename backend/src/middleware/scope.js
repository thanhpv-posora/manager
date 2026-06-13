function customerScope(req) {
  const user=req.user||{};
  if(user.role==='CUSTOMER') {
    return {customer_id:user.customer_id, isCustomer:true};
  }
  return {customer_id:null, isCustomer:false};
}

function customerWhere(alias='c', user, includeChildren=true){
  if(!user || user.role!=='CUSTOMER') return {sql:'', params:[]};
  const col=alias?`${alias}.id`:'id';
  const parent=alias?`${alias}.parent_customer_id`:'parent_customer_id';
  if(includeChildren){
    return {sql:` AND (${col}=? OR ${parent}=?)`, params:[user.customer_id,user.customer_id]};
  }
  return {sql:` AND ${col}=?`, params:[user.customer_id]};
}

function requireOwnCustomer(req, customerId) {
  const user=req.user||{};
  if(user.role==='CUSTOMER' && String(user.customer_id)!==String(customerId)) {
    const err=new Error('Không có quyền xem dữ liệu khách hàng khác');
    err.status=403;
    throw err;
  }
}

module.exports={customerScope,customerWhere,requireOwnCustomer};
