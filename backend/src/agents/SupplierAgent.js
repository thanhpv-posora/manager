const pool = require('../config/db');
const { nextCode } = require('../utils/code');
const PrintService = require('../services/PrintService');
const SoftDeleteAgent = require('./SoftDeleteAgent');

function safeCalcExpression(expr) {
  const s = String(expr ?? '').trim();
  if (!s) return 0;
  if (!/^[0-9+\-*/().\s]+$/.test(s)) return Number(s) || 0;
  try {
    const v = Function(`"use strict"; return (${s})`)();
    return Number.isFinite(Number(v)) ? Number(v) : 0;
  } catch {
    return Number(s) || 0;
  }
}

const n=v=>Number(v||0);
const normalizeCalendarType=v=>String(v||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';

class SupplierAgent {
  constructor(){
    this.version='6.41.0';
    this.responsibility='Supplier CRUD, cattle lot settlement, deduction mode, gender split price, rib conversion, supplier payment, print';
  }

  calc(body) {
    const rawWeight = body.raw_weight_expr ? safeCalcExpression(body.raw_weight_expr) : n(body.raw_weight);
    const boneWeight = body.bone_weight_expr ? safeCalcExpression(body.bone_weight_expr) : n(body.bone_weight);

    const totalAnimals = n(body.total_animals);
    const femaleAnimals = n(body.female_animals);
    const maleAnimals = Math.max(0, n(body.male_animals) || (totalAnimals - femaleAnimals));
    const deductMode = body.deduct_mode || 'PER_ANIMAL';
    const deductKgPerAnimal = n(body.deduct_kg_per_animal);

    const manualDeductWeight = body.deducted_weight_expr
      ? safeCalcExpression(body.deducted_weight_expr)
      : n(body.deducted_weight);

    const deductedWeight = deductMode === 'TOTAL_KG'
      ? manualDeductWeight
      : totalAnimals * deductKgPerAnimal;

    const damageWeight = n(body.damage_weight);
    const fatWeight = n(body.fat_weight);
    const otherDeductWeight = n(body.other_deduct_weight);

    const ribToMeatWeight = boneWeight / 2;
    const totalWeight = rawWeight + ribToMeatWeight - deductedWeight - damageWeight - fatWeight - otherDeductWeight;

    const malePrice = n(body.male_price || body.purchase_price);
    const femalePrice = n(body.female_price || body.purchase_price);
    const purchasePrice = n(body.purchase_price || malePrice);

    const maleRatio = totalAnimals > 0 ? maleAnimals / totalAnimals : 1;
    const femaleRatio = totalAnimals > 0 ? femaleAnimals / totalAnimals : 0;
    const maleWeight = totalWeight * maleRatio;
    const femaleWeight = totalWeight * femaleRatio;

    const totalCost = maleWeight * malePrice + femaleWeight * femalePrice;

    return {
      rawWeight,
      boneWeight,
      ribToMeatWeight,
      deductedWeight,
      damageWeight,
      fatWeight,
      otherDeductWeight,
      totalAnimals,
      maleAnimals,
      femaleAnimals,
      deductMode,
      deductKgPerAnimal,
      malePrice,
      femalePrice,
      purchasePrice,
      maleWeight,
      femaleWeight,
      totalWeight,
      totalCost
    };
  }

  async suppliers() {
    const [rows]=await pool.query(`SELECT * FROM suppliers WHERE is_active=1 AND del_flg=0 ORDER BY name`);
    return rows;
  }

  async addSupplier(data) {
    if (!data.name) throw new Error('Thiếu tên nhà cung cấp');
    const code=data.supplier_code||('NCC'+Date.now());
    await pool.query(`INSERT INTO suppliers(supplier_code,name,phone,address,note,billing_calendar_type,is_active,del_flg) VALUES(?,?,?,?,?,?,1,0)`, [code,data.name,data.phone||'',data.address||'',data.note||'',normalizeCalendarType(data.billing_calendar_type)]);
    return {message:'Đã tạo nhà cung cấp', supplier_code:code};
  }

  async updateSupplier(id,data) {
    if (!data.name) throw new Error('Thiếu tên nhà cung cấp');
    await pool.query(`UPDATE suppliers SET name=?,phone=?,address=?,note=?,billing_calendar_type=?,is_active=? WHERE id=? AND del_flg=0`, [data.name,data.phone||'',data.address||'',data.note||'',normalizeCalendarType(data.billing_calendar_type),data.is_active?1:0,id]);
    return {message:'Đã sửa nhà cung cấp'};
  }

  async removeSupplier(id, reason, userId) {
    return SoftDeleteAgent.softDelete('supplier', id, reason, userId);
  }

  async lots() {
    const [rows]=await pool.query(
      `SELECT l.*,s.name supplier_name,s.billing_calendar_type supplier_billing_calendar_type,
       COALESCE(SUM(CASE WHEN sp.type='PAYMENT' THEN sp.amount ELSE 0 END),0) paid_amount,
       COALESCE(SUM(CASE WHEN sp.type='ADVANCE' THEN sp.amount ELSE 0 END),0) advance_amount
       FROM purchase_lots l LEFT JOIN suppliers s ON s.id=l.supplier_id
       LEFT JOIN supplier_payments sp ON sp.lot_id=l.id
       WHERE l.del_flg=0
       GROUP BY l.id ORDER BY l.purchase_date DESC,l.id DESC`
    );
    return rows.map(r=>({...r, remaining_amount:Math.max(0,n(r.total_cost)-n(r.paid_amount)-n(r.advance_amount))}));
  }

  async getLot(id) {
    const [rows]=await pool.query(
      `SELECT l.*,s.name supplier_name,s.phone supplier_phone,s.address supplier_address,s.billing_calendar_type supplier_billing_calendar_type,
       COALESCE(SUM(CASE WHEN sp.type='PAYMENT' THEN sp.amount ELSE 0 END),0) paid_amount,
       COALESCE(SUM(CASE WHEN sp.type='ADVANCE' THEN sp.amount ELSE 0 END),0) advance_amount
       FROM purchase_lots l LEFT JOIN suppliers s ON s.id=l.supplier_id
       LEFT JOIN supplier_payments sp ON sp.lot_id=l.id
       WHERE l.id=? AND l.del_flg=0 GROUP BY l.id`,
      [id]
    );
    if (!rows.length) throw new Error('Không tìm thấy lô');
    const lot=rows[0];
    lot.remaining_amount=Math.max(0,n(lot.total_cost)-n(lot.paid_amount)-n(lot.advance_amount));
    return lot;
  }

  async createLot(data, user) {
    const c=this.calc(data);
    if(!data.supplier_id) throw new Error('Vui lòng chọn nhà cung cấp trước khi lưu lô nhập.');
    if(c.rawWeight<=0) throw new Error('Tổng kg thịt xô phải lớn hơn 0. Không thể lưu lô nhập trống.');
    if(c.totalAnimals<=0) throw new Error('Tổng số con phải lớn hơn 0.');
    if(c.totalWeight<=0) throw new Error('Kg tính tiền phải lớn hơn 0. Vui lòng kiểm tra lại số kg trừ.');
    const conn=await pool.getConnection();
    try {
      await conn.beginTransaction();
      const code=await nextCode(conn,'purchase_lots','lot_code','LOT');
      let calendarType=normalizeCalendarType(data.calendar_type||data.billing_calendar_type);
      if(data.supplier_id && !data.calendar_type && !data.billing_calendar_type){
        const [sr]=await conn.query(`SELECT billing_calendar_type FROM suppliers WHERE id=? LIMIT 1`,[data.supplier_id]);
        calendarType=normalizeCalendarType(sr[0]?.billing_calendar_type);
      }
      const lunarDateText=calendarType==='LUNAR' ? String(data.lunar_date_text||'') : '';
      await conn.query(
        `INSERT INTO purchase_lots(
          lot_code,lot_name,supplier_id,purchase_date,calendar_type,lunar_date_text,
          raw_weight,bone_weight,deducted_weight,total_weight,purchase_price,total_cost,
          raw_weight_expr,bone_weight_expr,deducted_weight_expr,
          damage_weight,fat_weight,other_deduct_weight,deduct_note,
          total_animals,male_animals,female_animals,deduct_mode,deduct_kg_per_animal,
          male_price,female_price,male_weight,female_weight,
          status,note,created_by,del_flg
        )
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'OPEN',?,?,0)`,
        [
          code,data.lot_name||code,data.supplier_id||null,data.purchase_date,calendarType,lunarDateText,
          c.rawWeight,c.boneWeight,c.deductedWeight,c.totalWeight,c.purchasePrice,c.totalCost,
          data.raw_weight_expr||String(c.rawWeight),
          data.bone_weight_expr||String(c.boneWeight),
          c.deductMode==='TOTAL_KG' ? (data.deducted_weight_expr||String(c.deductedWeight)) : '',
          c.damageWeight,c.fatWeight,c.otherDeductWeight,data.deduct_note||'',
          c.totalAnimals,c.maleAnimals,c.femaleAnimals,c.deductMode,c.deductKgPerAnimal,
          c.malePrice,c.femalePrice,c.maleWeight,c.femaleWeight,
          data.note||'',user.id
        ]
      );
      await conn.commit();
      return {message:'Đã nhập lô', lot_code:code, total_weight:c.totalWeight, total_cost:c.totalCost};
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

  async payLot(id, data, user) {
    await pool.query(
      `INSERT INTO supplier_payments(lot_id,payment_date,amount,type,payment_method,note,created_by) VALUES(?,?,?,?,?,?,?)`,
      [id,data.payment_date,data.amount,data.type||'PAYMENT',data.payment_method||'CASH',data.note||'',user.id]
    );
    return {message:data.type==='ADVANCE'?'Đã ghi nhận tiền ứng':'Đã ghi nhận trả tiền nhà cung cấp'};
  }

  async printLot(id) {
    return PrintService.lotHtml(await this.getLot(id));
  }
}
module.exports = new SupplierAgent();
