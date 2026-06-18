import React,{useEffect,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';

const labels={
 dashboard:'Dashboard','create-order':'Tạo bill POS',orders:'Bill bán hàng',payments:'Thu tiền',
 installments:'Góp nợ hằng ngày',customers:'Khách hàng',products:'Mặt hàng',prices:'Giá riêng',
 'price-matrix':'Bảng giá riêng',lots:'Nhập lô / NCC',revenue:'Doanh thu',profit:'Lợi nhuận',agents:'Agent AI',
 trash:'Đã xóa / lịch sử',settings:'Cấu hình cửa hàng',portal:'Trang thông tin / tài trợ',
 'user-permissions':'Phân quyền user'
};

export default function UserPermissions({onSaved}){
 const[users,setUsers]=useState([]),[selected,setSelected]=useState(''),[detail,setDetail]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const load=async()=>{try{const r=await api.get('/permissions/users');setUsers(r.data||[])}catch(e){setError(e.response?.data?.message||e.message)}finally{setLoading(false)}};useEffect(()=>{load()},[]);
 const open=async(id)=>{setSelected(id);const r=await api.get('/permissions/users/'+id+'/menus');setDetail(r.data)};
 const toggle=(key)=>{const current=!!(detail.override&&detail.override[key]);setDetail({...detail,override:{...(detail.override||{}),[key]:!current}})};
 const save=async()=>{const menus=detail.all_menus.map(k=>({menu_key:k,is_enabled:!!detail.override[k]}));await api.put('/permissions/users/'+selected+'/menus',{menus});alert('Đã lưu phân quyền');await open(selected);onSaved&&onSaved()};
 return <SafePage loading={loading} error={error}><div className="grid cols-2"><div className="card"><h3>Danh sách user</h3><table className="table"><tbody>{users.map(u=><tr key={u.id}><td><b>{u.username}</b><br/><span className="muted">{u.full_name} · {u.role}</span></td><td><button className="btn secondary" onClick={()=>open(u.id)}>Phân quyền</button></td></tr>)}</tbody></table></div><div className="card"><h3>Menu được phép hiển thị</h3>{!detail&&<p className="muted">Chọn user bên trái.</p>}{detail&&<><p><b>{detail.user.username}</b> · {detail.user.role}</p><p className="muted">Tick menu nào thì user đó được thấy menu đó. Quyền dữ liệu vẫn bị giới hạn theo role/customer để không xem nhầm dữ liệu người khác.</p><div className="form-grid">{detail.all_menus.map(k=><label key={k} className="input" style={{display:'flex',gap:10,alignItems:'center'}}><input type="checkbox" checked={!!detail.override[k]} onChange={()=>toggle(k)}/>{labels[k]||k}</label>)}</div><button className="btn" style={{marginTop:12}} onClick={save}>Lưu phân quyền</button></>}</div></div></SafePage>
}
