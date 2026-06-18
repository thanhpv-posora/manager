# V49 Voice POS Product Stable

Đã sửa backend để AI Voice POS chạy ổn định hơn:

- Không tự học alias mới từ AI Voice POS nữa, tránh DB bị nhiễm alias sai.
- Resolver ưu tiên exact alias / exact product name.
- Không fuzzy-match bừa với alias ngắn như nam, nầm, nấp, gan, gầu.
- Nếu alias trùng nhiều sản phẩm thì báo lỗi rõ, không chọn đại.
- Bill nhiều dòng: dòng đầu không có số lượng được hiểu là tên khách.
- SQL dọn product_ocr_aliases: `sql/V49_VOICE_POS_PRODUCT_STABLE_CLEAN.sql`.

Sau deploy:
1. Chạy SQL V49.
2. Restart backend.
3. Test: `Chiến\nxương ống 10 kg\nnam 10 kg`.
