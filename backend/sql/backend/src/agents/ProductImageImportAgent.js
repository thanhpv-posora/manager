const pool=require('../config/db');

function norm(s){
  return String(s||'').trim().replace(/\s+/g,' ');
}

function safeMoney(v){
  const n=Number(String(v||'').replace(/[,\.\sđ₫]/g,''));
  return Number.isFinite(n)?n:0;
}

class ProductImageImportAgent{
  constructor(){
    this.version='6.33.0';
    this.responsibility='Import product master from OCR/image preview, validate duplicates, auto product code by category';
  }

  async nextCodeByCategory(categoryId){
    const prefix=categoryId?`MH${String(categoryId).padStart(2,'0')}`:'MH';
    const [rows]=await pool.query(
      `SELECT product_code FROM products WHERE product_code LIKE ? ORDER BY product_code DESC LIMIT 1`,
      [prefix+'%']
    );
    let next=1;
    if(rows.length){
      const m=String(rows[0].product_code||'').match(/(\d+)$/);
      if(m) next=Number(m[1])+1;
    }
    return prefix+String(next).padStart(4,'0');
  }

  async preview(rows){
    const result=[];
    for(const row of rows||[]){
      const name=norm(row.name||row.product_name);
      const errors=[];
      const warnings=[];
      if(!name) errors.push('Thiếu tên mặt hàng');

      const [dup]=name?await pool.query(
        `SELECT id,product_code,name FROM products WHERE del_flg=0 AND LOWER(name)=LOWER(?) LIMIT 1`,
        [name]
      ):[[]];

      if(dup.length) warnings.push('Mặt hàng đã tồn tại');

      result.push({
        ...row,
        name,
        unit:row.unit||'kg',
        category_id:row.category_id||null,
        sale_price:safeMoney(row.sale_price||row.price),
        cost_price:safeMoney(row.cost_price),
        inventory_mode:row.inventory_mode||'STOCK',
        allow_negative_stock:row.allow_negative_stock?1:0,
        duplicate:dup[0]||null,
        status:errors.length?'ERROR':(warnings.length?'WARN':'OK'),
        errors,
        warnings,
        selected:!errors.length&&!dup.length
      });
    }
    return result;
  }

  async save(rows,user){
    const saved=[];
    const skipped=[];
    for(const row of rows||[]){
      const name=norm(row.name||row.product_name);
      if(!name){skipped.push({row,reason:'Thiếu tên mặt hàng'});continue;}

      const [dup]=await pool.query(`SELECT id FROM products WHERE del_flg=0 AND LOWER(name)=LOWER(?) LIMIT 1`,[name]);
      if(dup.length && !row.allow_update_existing){
        skipped.push({row,reason:'Mặt hàng đã tồn tại'});
        continue;
      }

      const code=row.product_code||await this.nextCodeByCategory(row.category_id);
      if(dup.length && row.allow_update_existing){
        await pool.query(
          `UPDATE products SET unit=?,category_id=?,sale_price=?,cost_price=?,inventory_mode=?,allow_negative_stock=? WHERE id=?`,
          [row.unit||'kg',row.category_id||null,safeMoney(row.sale_price),safeMoney(row.cost_price),row.inventory_mode||'STOCK',row.allow_negative_stock?1:0,dup[0].id]
        );
        saved.push({name,action:'UPDATED'});
      }else{
        await pool.query(
          `INSERT INTO products(product_code,name,unit,category_id,sale_price,cost_price,inventory_mode,allow_negative_stock,is_active,del_flg)
           VALUES(?,?,?,?,?,?,?,?,1,0)`,
          [code,name,row.unit||'kg',row.category_id||null,safeMoney(row.sale_price),safeMoney(row.cost_price),row.inventory_mode||'STOCK',row.allow_negative_stock?1:0]
        );
        saved.push({name,product_code:code,action:'INSERTED'});
      }
    }
    return {message:'Đã lưu import mặt hàng',saved,skipped};
  }
}
module.exports=new ProductImageImportAgent();
