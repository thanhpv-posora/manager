# MeatBiz V65.47 - Order Lock + Payment Edit/Reallocation

Nền: V65.45.
Không dùng V65.46 rời rạc. Bản này đã gộp các thay đổi của V65.46 và bổ sung luồng Thu tiền production-safe.

## SQL migration
Chạy trước khi deploy:

```sql
sql/V65_47_ORDER_PAYMENT_LOCK_AND_REALLOCATION.sql
```

## Backend
- Bill không nhận tiền từ POS nữa. `OrderAgent.create()` ép `paid_amount = 0`.
- Thêm API chốt bill: `POST /api/orders/:id/lock`.
- Bill đã chốt hoặc đã có `payment_allocations` thì không cho thêm/sửa dòng hàng.
- Thêm API sửa phiếu thu: `PUT /api/payments/:id`.
- Khi sửa phiếu thu:
  1. Lock phiếu thu.
  2. Trừ ngược các allocation cũ khỏi orders.
  3. Xóa allocation/credit/debt_transaction cũ theo payment.
  4. Update cash/bank/amount.
  5. Phân bổ lại từ bill cũ đến mới theo ngày xuất hàng.
- Thêm API hủy phiếu thu: `POST /api/payments/:id/cancel`.
- Thêm API chốt phiếu thu: `POST /api/payments/:id/lock`.
- Phiếu thu đã chốt không cho sửa/hủy.

## Frontend
- POS Bill hiển thị thông tin tổng bill, không còn nhập tiền mặt/chuyển khoản ở Bill.
- Thu tiền có nút Sửa / Hủy / Chốt phiếu thu.
- Khi sửa phiếu thu, UI đưa dữ liệu lên form và gọi `PUT /payments/:id`.
- Danh sách bill có nút Chốt.

## Test chính
1. Tạo 2 bill còn nợ cho cùng khách.
2. Thu tiền 60tr, kiểm tra `payment_allocations` phân bổ cũ -> mới.
3. Sửa phiếu thu từ 60tr xuống 30tr, kiểm tra allocation cũ bị xóa và tạo lại.
4. Sửa phiếu thu từ 30tr lên 70tr, kiểm tra allocation lại.
5. Chốt phiếu thu, thử sửa/hủy phải bị chặn.
6. Chốt bill, thử thêm/sửa hàng phải bị chặn.
