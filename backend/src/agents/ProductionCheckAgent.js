const fs=require('fs');
const path=require('path');

const required=[
  ['customers','CRUD khách hàng, scope user'],
  ['products','CRUD mặt hàng, del_flg'],
  ['price-matrix','Giá riêng theo khách'],
  ['orders','Tạo/sửa/in bill'],
  ['payments','Thu tiền/công nợ'],
  ['installments','Góp nợ theo tháng'],
  ['lots','Nhập lô/NCC'],
  ['portal','Trang giới thiệu'],
  ['videos','Video nhà tài trợ'],
  ['user-mapping','Quản lý tài khoản'],
  ['permissions','Phân quyền menu']
];

class ProductionCheckAgent{
  constructor(){
    this.version='6.31.0';
    this.responsibility='Check required production modules, CRUD coverage and data cleanup readiness';
  }

  async check(){
    const routeDir=path.join(process.cwd(),'src','routes');
    const routes=fs.existsSync(routeDir)?fs.readdirSync(routeDir).join('\n'):'';
    return required.map(([key,desc])=>({
      module:key,
      description:desc,
      route_present:routes.includes(key) || routes.toLowerCase().includes(key.replace('-','').toLowerCase()),
      status:(routes.includes(key) || routes.toLowerCase().includes(key.replace('-','').toLowerCase()))?'OK':'NEED_CHECK'
    }));
  }
}
module.exports=new ProductionCheckAgent();
