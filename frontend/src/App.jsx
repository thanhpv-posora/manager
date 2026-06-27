import React,{useEffect,useState}from'react';
import Login from'./pages/Login';
import RegisterAccount from'./pages/RegisterAccount';
import VerifyEmail from'./pages/VerifyEmail';
import Dashboard from'./pages/Dashboard';
import CreateOrder from'./pages/CreateOrder';
import Orders from'./pages/Orders';
import Payments from'./pages/Payments';
import Customers from'./pages/Customers';
import Products from'./pages/Products';import ProductImageImport from'./pages/ProductImageImport';import OCRProviders from'./pages/OCRProviders';
import Prices from'./pages/Prices';
import Lots from'./pages/Lots';
import Units from'./pages/Units';
import SupplierPurchaseOptions from'./pages/SupplierPurchaseOptions';
import InventoryPurchases from'./pages/InventoryPurchases';
import Revenue from'./pages/Revenue';
import Profit from'./pages/Profit';
import RetailDailySummary from'./pages/RetailDailySummary';
import Agents from'./pages/Agents';
import Trash from'./pages/Trash';
import PriceMatrix from'./pages/PriceMatrix';
import SettingsPage from'./pages/Settings';
import Installments from'./pages/Installments';
import BusinessPortal from'./pages/BusinessPortal';import SponsorVideos from'./pages/SponsorVideos';import ProductionCheck from'./pages/ProductionCheck';
import UserPermissions from'./pages/UserPermissions';
import Registrations from'./pages/Registrations';import UserCustomerMapping from'./pages/UserCustomerMapping';
import LandingPage from'./pages/LandingPage';
import MainLayout from'./layouts/MainLayout';
import api from'./api/api';

function roleDefaultPage(user,menus){
  const role=user?.role||'ADMIN';
  const preferred=role==='CUSTOMER'?'orders':(role==='STAFF'?'create-order':'dashboard');
  if(!menus||menus.includes(preferred))return preferred;
  return menus[0]||preferred;
}

export default function App(){
  const[token,setToken]=useState(localStorage.getItem('token'));
  const[user,setUser]=useState(()=>{try{return JSON.parse(localStorage.getItem('user')||'null')}catch{return null}});
  const[allowedMenus,setAllowedMenus]=useState(()=>{try{return JSON.parse(localStorage.getItem('allowedMenus')||'null')}catch{return null}});
  const[menusMeta,setMenusMeta]=useState(()=>{try{return JSON.parse(localStorage.getItem('menusMeta')||'[]')}catch{return[]}});
  const[showLogin,setShowLogin]=useState(false);
  const[showRegister,setShowRegister]=useState(false);
  const[page,setPage]=useState(()=>roleDefaultPage(user,allowedMenus));

  const refreshPermissions=async()=>{
    if(!localStorage.getItem('token'))return;
    try{
      const r=await api.get('/permissions/me');
      const menus=r.data?.allowedMenus||null;
      const meta=r.data?.menus||[];
      setAllowedMenus(menus);
      setMenusMeta(meta);
      localStorage.setItem('allowedMenus',JSON.stringify(menus));
      localStorage.setItem('menusMeta',JSON.stringify(meta));
      setPage(p=>menus&&menus.includes(p)?p:roleDefaultPage(user,menus));
    }catch(e){
      console.warn('Permission reload failed',e);
    }
  };

  useEffect(()=>{ if(token) refreshPermissions(); },[token]);

  const onLoggedIn=(data)=>{
    localStorage.setItem('token',data.token);
    localStorage.setItem('user',JSON.stringify(data.user));
    const menus=data.permissions?.allowedMenus||null;
    localStorage.setItem('allowedMenus',JSON.stringify(menus));
    setToken(data.token);
    setUser(data.user);
    setAllowedMenus(menus);
    setShowLogin(false);
    setPage(roleDefaultPage(data.user,menus));
  };

  const logout=()=>{
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem('allowedMenus');
    localStorage.removeItem('menusMeta');
    setToken(null);
    setUser(null);
    setAllowedMenus(null);
    setMenusMeta([]);
    setShowLogin(false);
  };

  if(!token){
    if(window.location.pathname==='/verify-email')return <VerifyEmail onBack={()=>{window.history.replaceState({},'', '/');setShowLogin(true)}}/>;
    if(showRegister)return <RegisterAccount onBack={()=>{setShowRegister(false);setShowLogin(true)}}/>;
    if(showLogin)return <Login onLogin={onLoggedIn} onRegister={()=>setShowRegister(true)}/>;
    return <LandingPage onLoginClick={()=>setShowLogin(true)} onRegisterClick={()=>setShowRegister(true)}/>;
  }

  const pages={
    dashboard:<Dashboard/>,
    'create-order':<CreateOrder setPage={setPage}/>,
    orders:<Orders/>,
    payments:<Payments/>,
    installments:<Installments/>,
    customers:<Customers/>,
    products:<Products/>,
    'product-import':<ProductImageImport/>,
    'ocr-providers':<OCRProviders/>,
    prices:<Prices/>,
    'price-matrix':<PriceMatrix/>,
    lots:<Lots/>,
    units:<Units/>,
    'supplier-purchase-options':<SupplierPurchaseOptions/>,
    'inventory-purchases':<InventoryPurchases/>,
    revenue:<Revenue/>,
    profit:<Profit/>,
    'retail-daily-summary':<RetailDailySummary/>,
    agents:<Agents/>,
    trash:<Trash/>,
    settings:<SettingsPage/>,
    portal:<BusinessPortal/>,
    'sponsor-videos':<SponsorVideos/>,
    'production-check':<ProductionCheck/>,
    'user-permissions':<UserPermissions onSaved={refreshPermissions}/>,
    'registrations':<Registrations/>,
    'user-mapping':<UserCustomerMapping setPage={setPage}/>
  };

  const visiblePage=allowedMenus&&allowedMenus.includes(page)?page:roleDefaultPage(user,allowedMenus);

  return <MainLayout page={visiblePage} setPage={setPage} user={user} onLogout={logout} allowedMenus={allowedMenus} menusMeta={menusMeta}>
    {pages[visiblePage]||pages[roleDefaultPage(user,allowedMenus)]}
  </MainLayout>
}
