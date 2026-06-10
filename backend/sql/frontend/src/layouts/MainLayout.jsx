import React from 'react';
import {BarChart3,Beef,ClipboardList,CreditCard,Home,LogOut,Package,ShoppingCart,Truck,Users,Bot,Trash2,TableProperties,Settings,CalendarDays,Megaphone} from 'lucide-react';

const menu=[
  ['dashboard','Dashboard',Home],
  ['create-order','Tạo bill POS',ShoppingCart],
  ['orders','Bill bán hàng',ClipboardList],
  ['payments','Thu tiền',CreditCard],
  ['installments','Góp nợ theo tháng',CalendarDays],
  ['customers','Khách hàng',Users],
  ['products','Mặt hàng',Package],
  ['product-import','Import mặt hàng từ ảnh',Package],
  ['ocr-providers','Cấu hình OCR nâng cao',Bot],
  ['prices','Giá riêng',Package],
  ['price-matrix','Bảng giá riêng',TableProperties],
  ['lots','Nhập lô / NCC',Truck],
  ['revenue','Doanh thu',BarChart3],
  ['agents','Agent AI',Bot],
  ['production-check','Kiểm tra production',Bot],
  ['trash','Đã xóa / lịch sử',Trash2],
  ['settings','Cấu hình cửa hàng',Settings],
  ['portal','Trang thông tin / tài trợ',Megaphone],
  ['sponsor-videos','Video nhà tài trợ',Megaphone],
  ['user-permissions','Phân quyền user',Settings],
  ['registrations','Đăng ký khách hàng',Settings],
  ['user-mapping','Mapping user-KH',Settings],
];

export default function MainLayout({page,setPage,user,children,onLogout,allowedMenus}){
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
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Beef size={32}/>
          <span>MeatBiz</span>
        </div>

        <nav className="menu">
          {menu.filter(([key])=>!allowedMenus||allowedMenus.includes(key)).map(([key,label,Icon])=>(
            <button
              key={key}
              type="button"
              className={'menu-item '+(page===key?'active':'')}
              onClick={()=>setPage(key)}
            >
              <Icon size={18}/>
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="muted">{user?.full_name||user?.username||'ADMIN'}</div>
          <button type="button" className="menu-item logout" onClick={logout}>
            <LogOut size={18}/>
            <span>Đăng xuất</span>
          </button>
        </div>
      </aside>

      <main className="main">
        {children}
      </main>
    </div>
  );
}
