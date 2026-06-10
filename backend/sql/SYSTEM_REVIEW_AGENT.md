# SystemReviewAgent V6.26

## Đã rà soát scope dữ liệu theo user

Rule:
- ADMIN: xem toàn hệ thống.
- STAFF: xem dữ liệu vận hành.
- CUSTOMER: chỉ xem customer gắn với user đó và khách con do họ tạo.

## Các màn hình đã chỉnh scope
- Khách hàng
- Bảng giá riêng
- Bill bán hàng
- Mặt hàng theo catalog của customer

## Chức năng bổ sung
- User khách có thể tạo khách hàng riêng/khách con.
- Khách con có `parent_customer_id`.
- Customer dropdown chỉ trả về dữ liệu trong scope của user đang login.

## Tiền tệ
- Chuẩn hiển thị: `200,000`.
- MoneyInput dùng comma thousands.

## Việc tiếp theo nên làm
- Audit log phân quyền.
- Readonly mode rõ ràng cho CUSTOMER.
- Tenant/business_id nếu triển khai nhiều hộ kinh doanh trên cùng DB.
