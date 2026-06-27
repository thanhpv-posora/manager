import React, {useEffect, useState} from 'react';
import {BarChart3,Beef,ClipboardList,CreditCard,Home,KeyRound,LogOut,Package,ShoppingCart,Truck,Users,Bot,Trash2,TableProperties,Settings,CalendarDays,Megaphone,PanelLeftClose,PanelLeftOpen} from 'lucide-react';
import ChangePasswordModal from'../components/ChangePasswordModal';

const menu=[
  ['dashboard','Dashboard',Home],
  ['create-order','Tạo bill POS',ShoppingCart],
  ['orders','Bill bán hàng',ClipboardList],
  ['retail-daily-summary','Bán lẻ tổng hợp',BarChart3],
  ['payments','Thu tiền',CreditCard],
  ['installments','Góp bill',CalendarDays],
  ['customers','Đối tác',Users],
  ['products','Mặt hàng',Package],
  ['product-import','Import mặt hàng từ ảnh',Package],
  ['ocr-providers','Cấu hình OCR nâng cao',Bot],
  ['price-matrix','Bảng giá riêng',TableProperties],
  ['lots','Nhập hàng',Truck],
  ['units','Đơn vị tính',TableProperties],
  ['supplier-purchase-options','Cấu hình quy cách nhập',Truck],
  ['inventory-purchases','Nhập hàng tồn kho',Package],
  ['revenue','Doanh thu',BarChart3],
  ['profit','Lợi nhuận',BarChart3],
  ['agents','Agent AI',Bot],
  ['production-check','Kiểm tra production',Bot],
  ['trash','Đã xóa / lịch sử',Trash2],
  ['settings','Cấu hình cửa hàng',Settings],
  ['portal','Trang thông tin / tài trợ',Megaphone],
  ['sponsor-videos','Video nhà tài trợ',Megaphone],
  ['user-permissions','Phân quyền user',Settings],
  ['registrations','Đăng ký khách hàng',Settings],
  ['user-mapping','Quản lý tài khoản',Settings],
];

const pageMeta={
  dashboard:['AI Operating Center','Tổng quan điều hành, cảnh báo và hành động AI trong ngày.'],
  'create-order':['Tạo bill POS','Tạo bill nhanh, kiểm tồn, công nợ và hỗ trợ nhập bằng AI.'],
  orders:['Bill bán hàng','Theo dõi bill, in phiếu và trạng thái thanh toán.'],
  payments:['Thu tiền','Ghi nhận tiền mặt, chuyển khoản và lịch sử thu.'],
  installments:['Góp bill','Quản lý góp bill theo khách hàng và lịch âm/dương.'],
  customers:['Đối tác','Quản lý đối tác, khách hàng và nhà cung cấp.'],
  products:['Mặt hàng','Quản lý sản phẩm, tồn kho, giá bán và chế độ kiểm tồn.'],
  'product-import':['Import mặt hàng từ ảnh','Nhập danh mục nhanh từ hình ảnh hoặc file dữ liệu.'],
  'ocr-providers':['Cấu hình OCR nâng cao','Thiết lập nhận diện hình ảnh và alias sản phẩm.'],
  prices:['Giá riêng','Quản lý giá bán riêng cho từng khách.'],
  'price-matrix':['Bảng giá riêng','Sắp xếp danh mục và bảng giá theo từng bạn hàng.'],
  lots:['Nhập hàng / Nhà cung cấp','Quản lý nhập lô, trọng lượng, thanh toán và nhà cung cấp.'],
  units:['Đơn vị tính','Quản lý đơn vị quy đổi dùng cho nhập hàng và tồn kho.'],
  'supplier-purchase-options':['Cấu hình quy cách nhập','Cấu hình đơn vị và quy đổi kg theo từng nhà cung cấp và sản phẩm.'],
  'inventory-purchases':['Nhập hàng tồn kho','Nhập hàng có kiểm tồn kho, theo đối tác và quy cách nhập hàng.'],
  'retail-daily-summary':['Bán lẻ tổng hợp','Ghi nhận tổng tiền bán lẻ theo ngày kinh doanh (không liên kết đơn hàng).'],
  revenue:['Doanh thu','Xem doanh thu, đã thu và công nợ theo thời gian.'],
  profit:['Lợi nhuận','Thống kê lợi nhuận theo ngày/tháng/năm, giá vốn FIFO và ngày nhập NCC.'],
  agents:['Agent AI','Các kỹ năng AI phục vụ vận hành bán sỉ.'],
  'production-check':['Kiểm tra production','Kiểm tra cấu hình, dữ liệu và trạng thái hệ thống.'],
  trash:['Đã xóa / lịch sử','Theo dõi dữ liệu đã xóa mềm và audit.'],
  settings:['Cấu hình cửa hàng','Thông tin cửa hàng, in bill và thiết lập chung.'],
  portal:['Trang thông tin / tài trợ','Quản lý nội dung giới thiệu và portal.'],
  'sponsor-videos':['Video nhà tài trợ','Quản lý video và nội dung truyền thông.'],
  'user-permissions':['Phân quyền user','Thiết lập quyền truy cập chức năng theo user.'],
  registrations:['Đăng ký khách hàng','Duyệt tài khoản đăng ký mới.'],
  'user-mapping':['Quản lý tài khoản','Tạo user nội bộ, quản lý khách hàng và duyệt đăng ký.']
};

export default function MainLayout({page,setPage,user,children,onLogout,allowedMenus}){
  const [showChangePw, setShowChangePw] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window !== 'undefined' && window.innerWidth <= 1024) return true;
    return localStorage.getItem('meatbiz_sidebar_collapsed') === '1';
  });
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth > 1024 && localStorage.getItem('meatbiz_sidebar_collapsed') !== '1';
  });

  useEffect(() => {
    localStorage.setItem('meatbiz_sidebar_collapsed', collapsed ? '1' : '0');
  }, [collapsed]);

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth <= 1024) {
        setCollapsed(true);
        setIsMobileMenuOpen(false);
      }
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const choosePage = (key) => {
    setPage(key);
    if (window.innerWidth <= 1024) {
      setCollapsed(true);
      setIsMobileMenuOpen(false);
    }
  };

  const logout=()=>{
    if(onLogout){
      onLogout();
      return;
    }
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.reload();
  };

  return (
    <div className={'app-shell '+(collapsed?'sidebar-collapsed ':'')+(isMobileMenuOpen?'mobile-menu-open':'')}>
      <aside className="sidebar">
        <div className="brand sidebar-brand">
          <Beef size={32}/>
          <span>MeatBiz</span>
        </div>
        <nav className="menu sidebar-scroll">
          {menu.filter(([key])=>!allowedMenus||allowedMenus.includes(key)).map(([key,label,Icon])=>(
            <button
              key={key}
              type="button"
              className={'menu-item '+(page===key?'active':'')}
              onClick={()=>choosePage(key)}
            >
              <Icon size={18}/>
              <span className="menu-label">{label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="muted">{user?.full_name||user?.username||'ADMIN'}</div>
          <button type="button" className="menu-item" onClick={()=>setShowChangePw(true)}>
            <KeyRound size={18}/>
            <span className="menu-label">Đổi mật khẩu</span>
          </button>
          <button type="button" className="menu-item logout" onClick={logout}>
            <LogOut size={18}/>
            <span className="menu-label">Đăng xuất</span>
          </button>
        </div>

        <button
          type="button"
          className="sidebar-toggle"
          onClick={() => {
            if (window.innerWidth <= 1024) {
              setIsMobileMenuOpen(v => !v);
              setCollapsed(true);
              return;
            }
            setCollapsed(v => !v);
          }}
          title={collapsed ? 'Mở rộng menu' : 'Thu gọn menu'}
          aria-label={collapsed ? 'Mở rộng menu' : 'Thu gọn menu'}
        >
          {(collapsed || !isMobileMenuOpen) ? <PanelLeftOpen size={18}/> : <PanelLeftClose size={18}/>}
          <span>{window.innerWidth <= 1024 ? (isMobileMenuOpen ? 'Đóng menu' : 'Mở menu') : (collapsed ? 'Mở menu' : 'Thu gọn')}</span>
        </button>
      </aside>

      {showChangePw&&<ChangePasswordModal onClose={()=>setShowChangePw(false)}/>}

      <main className="main">
        <div className="page-hero">
          <div>
            <div className="page-eyebrow">MeatBiz AI-native ERP</div>
            <h1>{pageMeta[page]?.[0]||'MeatBiz'}</h1>
            <p>{pageMeta[page]?.[1]||'Quản lý bán sỉ thịt bằng workflow rõ ràng và dễ dùng.'}</p>
          </div>
          <div className="page-hero-badge">AI Ready</div>
        </div>
        <div className="page-content">
          {children}
        </div>
      </main>
    </div>
  );
}
