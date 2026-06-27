import React,{useEffect,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';

const labels={
 dashboard:'Dashboard','create-order':'Tạo bill POS',orders:'Bill bán hàng','retail-daily-summary':'Bán lẻ tổng hợp',payments:'Thu tiền',
 installments:'Góp bill',customers:'Đối tác',products:'Mặt hàng','product-import':'Import mặt hàng từ ảnh',
 'ocr-providers':'Cấu hình OCR nâng cao','price-matrix':'Bảng giá riêng',lots:'Nhập hàng',
 units:'Đơn vị tính','supplier-purchase-options':'Cấu hình quy cách nhập','inventory-purchases':'Nhập hàng tồn kho',
 revenue:'Doanh thu',profit:'Lợi nhuận',agents:'Agent AI','production-check':'Kiểm tra production',
 trash:'Đã xóa / lịch sử',settings:'Cấu hình cửa hàng',portal:'Trang thông tin / tài trợ',
 'sponsor-videos':'Video nhà tài trợ','user-permissions':'Phân quyền user',
 registrations:'Đăng ký khách hàng','user-mapping':'Quản lý tài khoản'
};

const groups=[
 {label:'Bán hàng',keys:['dashboard','create-order','orders','retail-daily-summary','payments','installments','customers']},
 {label:'Danh mục',keys:['products','product-import','ocr-providers','price-matrix']},
 {label:'Mua hàng',keys:['lots','units','supplier-purchase-options','inventory-purchases']},
 {label:'Báo cáo',keys:['revenue','profit']},
 {label:'AI & Portal',keys:['agents','portal','sponsor-videos','production-check']},
 {label:'Hệ thống',keys:['trash','settings','user-permissions','registrations','user-mapping']},
];

export default function UserPermissions({onSaved}){
 const[users,setUsers]=useState([]),[selected,setSelected]=useState(''),[detail,setDetail]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const load=async()=>{try{const r=await api.get('/permissions/users');setUsers(r.data||[])}catch(e){setError(e.response?.data?.message||e.message)}finally{setLoading(false)}};useEffect(()=>{load()},[]);
 const open=async(id)=>{setSelected(id);const r=await api.get('/permissions/users/'+id+'/menus');setDetail(r.data)};
 const toggle=(key)=>{const current=!!(detail.override&&detail.override[key]);setDetail({...detail,override:{...(detail.override||{}),[key]:!current}})};
 const save=async()=>{const menus=detail.all_menus.map(k=>({menu_key:k,is_enabled:!!detail.override[k]}));await api.put('/permissions/users/'+selected+'/menus',{menus});alert('Đã lưu phân quyền');await open(selected);onSaved&&onSaved()};
 return <SafePage loading={loading} error={error}><div className="grid cols-2"><div className="card"><h3>Danh sách user</h3><table className="table"><tbody>{users.map(u=><tr key={u.id}><td><b>{u.username}</b><br/><span className="muted">{u.full_name} · {u.role}</span></td><td><button className="btn secondary" onClick={()=>open(u.id)}>Phân quyền</button></td></tr>)}</tbody></table></div><div className="card"><h3>Menu được phép hiển thị</h3>{!detail&&<p className="muted">Chọn user bên trái.</p>}{detail&&<><p><b>{detail.user.username}</b> · {detail.user.role}</p><p className="muted">Tick menu nào thì user đó được thấy menu đó. Quyền dữ liệu vẫn bị giới hạn theo role/customer để không xem nhầm dữ liệu người khác.</p>{groups.map(g=>{const keys=g.keys.filter(k=>detail.all_menus.includes(k));if(!keys.length)return null;return <div key={g.label} style={{marginBottom:16}}><p style={{fontWeight:700,fontSize:12,color:'#64748B',textTransform:'uppercase',letterSpacing:'0.05em',marginBottom:6}}>{g.label}</p><div className="form-grid">{keys.map(k=><label key={k} className="input" style={{display:'flex',gap:10,alignItems:'center'}}><input type="checkbox" checked={!!detail.override[k]} onChange={()=>toggle(k)}/>{labels[k]||k}</label>)}</div></div>})}<button className="btn" style={{marginTop:12}} onClick={save}>Lưu phân quyền</button></>}</div></div></SafePage>;
}
