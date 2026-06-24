export function validatePasswordStrength(password){
  const pw=String(password||'');
  if(pw.length<8||pw.length>16) return {ok:false,message:'Mật khẩu phải từ 8 đến 16 ký tự'};
  if(!/[A-Z]/.test(pw)) return {ok:false,message:'Mật khẩu phải có ít nhất 1 chữ hoa'};
  if(!/[a-z]/.test(pw)) return {ok:false,message:'Mật khẩu phải có ít nhất 1 chữ thường'};
  if(!/[0-9]/.test(pw)) return {ok:false,message:'Mật khẩu phải có ít nhất 1 số'};
  if(!/[^A-Za-z0-9]/.test(pw)) return {ok:false,message:'Mật khẩu phải có ít nhất 1 ký tự đặc biệt'};
  return {ok:true};
}
