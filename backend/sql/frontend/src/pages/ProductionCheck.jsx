import React,{useEffect,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';

export default function ProductionCheck(){
 const[rows,setRows]=useState([]),[learning,setLearning]=useState([]),[schemaRows,setSchemaRows]=useState([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
 useEffect(()=>{Promise.all([api.get('/production-check'),api.get('/ai-learning'),api.get('/schema/check')]).then(([c,l,s])=>{setRows(c.data||[]);setLearning(l.data||[]);setSchemaRows(s.data||[])}).catch(e=>setError(e.response?.data?.message||e.message)).finally(()=>setLoading(false))},[]);
 return <SafePage loading={loading} error={error}>
  <div className="card portal-hero"><h1>Production Completeness Agent</h1><p>Agent AI rà soát các module, CRUD, quyền, data clean và learning logs.</p></div>
  <div className="card"><h3>Checklist chức năng</h3><table className="table"><thead><tr><th>Module</th><th>Mô tả</th><th>Trạng thái</th></tr></thead><tbody>{rows.map(r=><tr key={r.module}><td>{r.module}</td><td>{r.description}</td><td>{r.status}</td></tr>)}</tbody></table></div>
  <div className="card"><h3>Schema Health Check</h3><table className="table"><thead><tr><th>Bảng</th><th>Cột</th><th>Trạng thái</th></tr></thead><tbody>{schemaRows.map((x,i)=><tr key={i}><td>{x.table}</td><td>{x.column}</td><td>{x.status}</td></tr>)}</tbody></table><button className="btn" onClick={async()=>{await api.post('/schema/migrate');location.reload();}}>Chạy migration</button></div><div className="card"><h3>AI Learning Logs</h3><table className="table"><tbody>{learning.map(x=><tr key={x.id}><td>{x.agent_name}<br/><span className="muted">{x.module_name} · {x.action_name}</span></td><td>{x.feedback_text||x.output_text}</td></tr>)}</tbody></table></div>
 </SafePage>
}
