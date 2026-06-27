import React, {useEffect, useState} from 'react';
import {BarChart3,Beef,Bot,CalendarDays,Circle,ClipboardList,CreditCard,Home,KeyRound,LogOut,Megaphone,Package,PanelLeftClose,PanelLeftOpen,Settings,ShoppingCart,TableProperties,Trash2,Truck,Users} from 'lucide-react';
import ChangePasswordModal from'../components/ChangePasswordModal';

const ICON_MAP={BarChart3,Bot,CalendarDays,ClipboardList,CreditCard,Home,Megaphone,Package,Settings,ShoppingCart,TableProperties,Trash2,Truck,Users};
const getIcon=(key)=>ICON_MAP[key]||Circle;

export default function MainLayout({page,setPage,user,children,onLogout,allowedMenus,menusMeta}){
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
    if(onLogout){ onLogout(); return; }
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.reload();
  };

  const sidebarItems=(menusMeta||[]).filter(m=>m.visible_in_sidebar&&(!allowedMenus||allowedMenus.includes(m.menu_key)));
  const currentMeta=(menusMeta||[]).find(m=>m.menu_key===page);

  return (
    <div className={'app-shell '+(collapsed?'sidebar-collapsed ':'')+(isMobileMenuOpen?'mobile-menu-open':'')}>
      <aside className="sidebar">
        <div className="brand sidebar-brand">
          <Beef size={32}/>
          <span>MeatBiz</span>
        </div>
        <nav className="menu sidebar-scroll">
          {sidebarItems.map(m=>{
            const Icon=getIcon(m.icon_key);
            return (
              <button
                key={m.menu_key}
                type="button"
                className={'menu-item '+(page===m.menu_key?'active':'')}
                onClick={()=>choosePage(m.menu_key)}
              >
                <Icon size={18}/>
                <span className="menu-label">{m.title}</span>
              </button>
            );
          })}
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
            <h1>{currentMeta?.title||'MeatBiz'}</h1>
            <p>{currentMeta?.subtitle||'Quản lý bán sỉ thịt bằng workflow rõ ràng và dễ dùng.'}</p>
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
