const pool=require('../config/db');
const { parseLunarText } = require('../utils/lunarDate');
function solarDateParts(dateText){
  const m=String(dateText||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(m)return {day:Number(m[3]),month:Number(m[2]),year:Number(m[1])};
  const d=dateText?new Date(dateText):new Date();
  return {day:d.getDate(),month:d.getMonth()+1,year:d.getFullYear()};
}

class DebtMonthlyInstallmentAgent{
  constructor(){this.version='6.51.4';this.responsibility='Configure effective daily debt installment amount by customer and lunar/solar date for POS billing';}

  normalizeCalendarType(calendarType){
    return String(calendarType||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
  }

  async getCustomerBillingCalendarType(customerId){
    if(!customerId) return 'SOLAR';
    try{
      const [rows]=await pool.query(`SELECT billing_calendar_type FROM customers WHERE id=? LIMIT 1`,[customerId]);
      return this.normalizeCalendarType(rows[0]?.billing_calendar_type||'SOLAR');
    }catch(e){
      return 'SOLAR';
    }
  }

  resolvePeriod(data={}){
    const safeCalendarType=this.normalizeCalendarType(data.calendar_type||data.calendarType);
    if(safeCalendarType==='LUNAR'){
      const lunar=parseLunarText(data.lunar_date_text||data.lunarDateText);
      if(lunar)return {day:lunar.day,month:lunar.month,year:lunar.year,calendar_type:safeCalendarType};
    }
    const day=Number(data.day||data.installment_day);
    const month=Number(data.month||data.installment_month);
    const year=Number(data.year||data.installment_year);
    if(month&&year)return {day:day||1,month,year,calendar_type:safeCalendarType};
    const solar=solarDateParts(data.config_date||data.date||data.payment_date||data.order_date);
    return {day:solar.day,month:solar.month,year:solar.year,calendar_type:safeCalendarType};
  }

  // S8.2d: a daily-contribution configuration is effective FROM its configured
  // date and remains effective until a newer configuration replaces it — it is
  // NOT scoped to the exact (month, year) it was entered under. The previous
  // exact-month-match query made a May config invisible to a June bill, even
  // though nothing newer had been configured since. This resolves the latest
  // ACTIVE row at or before the requested (year, month, day), regardless of
  // which month/year it was originally configured under.
  async getActiveInstallment(customerId,month,year,calendarType='SOLAR',day=31){
    if(!customerId)return {installment_amount:0};
    const safeCalendarType=this.normalizeCalendarType(calendarType);
    const safeDay=Math.max(1,Math.min(31,Number(day||31)));
    const safeMonth=Number(month);
    const safeYear=Number(year);
    const [rows]=await pool.query(
      `SELECT * FROM debt_monthly_installments
       WHERE customer_id=?
         AND calendar_type=?
         AND status='ACTIVE'
         AND (
           installment_year<?
           OR (installment_year=? AND installment_month<?)
           OR (installment_year=? AND installment_month=? AND COALESCE(installment_day,1)<=?)
         )
       ORDER BY installment_year DESC, installment_month DESC, COALESCE(installment_day,1) DESC, id DESC
       LIMIT 1`,
      [customerId,safeCalendarType,safeYear,safeYear,safeMonth,safeYear,safeMonth,safeDay]
    );
    return rows[0]||{customer_id:customerId,installment_day:safeDay,installment_month:safeMonth,installment_year:safeYear,calendar_type:safeCalendarType,installment_amount:0,status:'ACTIVE'};
  }

  async activeByDate(customerId,dateText,calendarType='SOLAR',lunarDateText=''){
    const period=this.resolvePeriod({config_date:dateText,date:dateText,calendar_type:calendarType,lunar_date_text:lunarDateText});
    return this.getActiveInstallment(customerId,period.month,period.year,period.calendar_type,period.day);
  }

  async list(month,year,calendarType=''){
    const params=[];
    let where='WHERE 1=1';
    if(month){where+=' AND d.installment_month=?';params.push(Number(month));}
    if(year){where+=' AND d.installment_year=?';params.push(Number(year));}
    if(calendarType){where+=' AND d.calendar_type=?';params.push(this.normalizeCalendarType(calendarType));}
    const [rows]=await pool.query(
      `SELECT d.*,c.name customer_name,c.phone,
              COALESCE(pm.period_paid_amount,0) AS paid_amount,
              COALESCE(pm.period_paid_amount,0) AS monthly_paid_amount
       FROM debt_monthly_installments d
       JOIN customers c ON c.id=d.customer_id
       LEFT JOIN (
         SELECT p.customer_id,
                CASE WHEN o.calendar_type='LUNAR' THEN 'LUNAR' ELSE 'SOLAR' END AS calendar_type,
                CASE
                  WHEN o.calendar_type='LUNAR' AND o.lunar_date_text LIKE '%/%/%'
                    THEN CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(o.lunar_date_text,'/',2),'/',-1) AS UNSIGNED)
                  ELSE MONTH(p.payment_date)
                END AS installment_month,
                CASE
                  WHEN o.calendar_type='LUNAR' AND o.lunar_date_text LIKE '%/%/%'
                    THEN CAST(SUBSTRING_INDEX(o.lunar_date_text,'/',-1) AS UNSIGNED)
                  ELSE YEAR(p.payment_date)
                END AS installment_year,
                SUM(COALESCE(p.installment_amount,0)) AS period_paid_amount
         FROM payments p
         LEFT JOIN orders o ON o.id=p.order_id
         WHERE COALESCE(p.installment_amount,0)>0
         GROUP BY p.customer_id,calendar_type,installment_month,installment_year
       ) pm ON pm.customer_id=d.customer_id
           AND pm.calendar_type=d.calendar_type
           AND pm.installment_month=d.installment_month
           AND pm.installment_year=d.installment_year
       ${where}
       ORDER BY FIELD(d.status,'ACTIVE','INACTIVE'),d.installment_year DESC,d.installment_month DESC,COALESCE(d.installment_day,1) ASC,c.name ASC`,
      params
    );
    return rows;
  }

  async saveDailyInstallment(data={}){
    const customerId=data.customer_id||data.customerId;
    if(!customerId)throw new Error('Thiếu khách hàng');
    const period=this.resolvePeriod(data);
    if(!period.month||!period.year)throw new Error('Thiếu ngày/tháng/năm');
    const installmentAmount=Number(data.installment_amount??data.amount??0);
    const rawStatus=String(data.status||'').toUpperCase();
    const status=rawStatus==='INACTIVE'||data.active===false||data.is_active===false?'INACTIVE':'ACTIVE';
    await pool.query(
      `INSERT INTO debt_monthly_installments(customer_id,installment_day,installment_month,installment_year,calendar_type,config_date,lunar_date_text,installment_amount,status)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE config_date=VALUES(config_date),lunar_date_text=VALUES(lunar_date_text),installment_amount=VALUES(installment_amount),status=VALUES(status)`,
      [customerId,period.day||1,period.month,period.year,period.calendar_type,data.config_date||null,data.lunar_date_text||null,installmentAmount,status]
    );
    const [rows]=await pool.query(
      `SELECT d.*,c.name customer_name,c.phone
       FROM debt_monthly_installments d JOIN customers c ON c.id=d.customer_id
       WHERE d.customer_id=? AND d.installment_day=? AND d.installment_month=? AND d.installment_year=? AND d.calendar_type=? LIMIT 1`,
      [customerId,period.day||1,period.month,period.year,period.calendar_type]
    );
    return {message:'Đã lưu cấu hình góp nợ theo ngày',period,item:rows[0]||null};
  }

  async upsertCustomerInstallment(customerId,month,year,amount,status='ACTIVE',calendarType='SOLAR',meta={}){
    return this.saveDailyInstallment({customer_id:customerId,month,year,installment_day:meta.installment_day||meta.day||1,calendar_type:calendarType,installment_amount:amount,status,config_date:meta.config_date,lunar_date_text:meta.lunar_date_text});
  }

  async applyMonthlyInstallments(payloadOrMonth,yearArg,customerInstallmentsArg,calendarTypeArg='SOLAR'){
    const payload=typeof payloadOrMonth==='object'&&payloadOrMonth!==null
      ? payloadOrMonth
      : {month:payloadOrMonth,year:yearArg,customerInstallments:customerInstallmentsArg,calendar_type:calendarTypeArg};
    if(payload.customer_id||payload.customerId)return this.saveDailyInstallment(payload);
    const customerInstallments=payload.customerInstallments||payload.items||[];
    if(!Array.isArray(customerInstallments)||!customerInstallments.length)throw new Error('Chưa chọn khách hàng');
    const period=this.resolvePeriod(payload);
    const results=[];
    for(const row of customerInstallments){
      results.push(await this.saveDailyInstallment({...payload,customer_id:row.customer_id||row.customerId,installment_amount:row.installment_amount??row.amount,status:row.status||payload.status,active:row.active??payload.active,day:period.day,month:period.month,year:period.year,calendar_type:period.calendar_type}));
    }
    return {message:'Đã áp dụng cấu hình góp nợ theo ngày',count:results.length,period,items:results};
  }

  async updateMonthlyInstallment(id,data={}){
    if(!id)throw new Error('Thiếu ID kế hoạch góp nợ');
    const fields=[]; const params=[];
    if(data.installment_amount!==undefined||data.amount!==undefined){fields.push('installment_amount=?');params.push(Number(data.installment_amount??data.amount??0));}
    if(data.status!==undefined||data.active!==undefined||data.is_active!==undefined){
      const rawStatus=String(data.status||'').toUpperCase();
    const status=rawStatus==='INACTIVE'||data.active===false||data.is_active===false?'INACTIVE':'ACTIVE';
      fields.push('status=?');params.push(status);
    }
    if(!fields.length){fields.push('updated_at=CURRENT_TIMESTAMP');}
    params.push(id);
    await pool.query(`UPDATE debt_monthly_installments SET ${fields.join(', ')} WHERE id=?`,params);
    const [rows]=await pool.query(`SELECT * FROM debt_monthly_installments WHERE id=? LIMIT 1`,[id]);
    return rows[0]||{id};
  }

  async softDeleteMonthlyInstallment(id){
    if(!id)throw new Error('Thiếu ID cấu hình góp nợ');
    try{
      const [used]=await pool.query(`SELECT COUNT(*) cnt FROM payments WHERE monthly_installment_id=?`,[id]);
      if(Number(used[0]?.cnt||0)>0){
        throw new Error('Cấu hình này đã phát sinh bill/thu tiền, không được xóa. Hãy tạo cấu hình mới từ ngày áp dụng mới.');
      }
    }catch(e){
      if(e.message && e.message.includes('không được xóa')) throw e;
      // Ignore when the optional monthly_installment_id column is not migrated yet.
    }
    await pool.query(`UPDATE debt_monthly_installments SET status='INACTIVE' WHERE id=?`,[id]);
    return {message:'Đã xóa mềm cấu hình góp nợ theo ngày',id,status:'INACTIVE'};
  }


  installmentPaidExpr(){
    // Actual installment paid for statistics.
    // Preferred source: payments.installment_amount.
    // Fallback: derive from payment amount when old data saved installment_amount=0
    // but order has current_bill_amount + installment_amount.
    return `CASE
      WHEN COALESCE(p.installment_amount,0)>0 THEN COALESCE(p.installment_amount,0)
      ELSE LEAST(
        COALESCE(o.installment_amount,0),
        GREATEST(
          COALESCE(p.amount,0) - COALESCE(
            NULLIF(p.current_bill_amount,0),
            NULLIF(o.current_bill_amount,0),
            GREATEST(COALESCE(o.total_amount,0)-COALESCE(o.installment_amount,0),0),
            0
          ),
          0
        )
      )
    END`;
  }

  async stats(query={}){
    // V6.51 FINAL:
    // Thống kê "tổng tiền góp nợ" = tổng góp nợ đã phát sinh giao dịch thu tiền.
    // Rule nghiệp vụ:
    // - Bill có góp nợ nhưng CHƯA có payment => KHÔNG cộng.
    // - Bill có góp nợ và ĐÃ có ít nhất 1 payment => CỘNG TOÀN BỘ o.installment_amount.
    // - Không cần bill PAID; PARTIAL/UNPAID có phát sinh payment vẫn được cộng.
    // - Không lấy payments.installment_amount để tránh thiếu dữ liệu cũ.
    // - Không SUM trực tiếp khi join payments để tránh 1 bill nhiều payment bị cộng trùng.
    const customerId=Number(query.customer_id||0)||null;
    const calendarType=query.calendar_type
      ? this.normalizeCalendarType(query.calendar_type)
      : await this.getCustomerBillingCalendarType(customerId);

    const period=this.resolvePeriod({
      config_date:query.date||query.config_date||query.payment_date||query.order_date,
      date:query.date||query.config_date||query.payment_date||query.order_date,
      calendar_type:calendarType,
      lunar_date_text:query.lunar_date_text||''
    });

    const params=[];
    let customerWhere='';
    if(customerId){
      customerWhere=' AND o.customer_id=?';
      params.push(customerId);
    }

    const hasPaymentWhere = `EXISTS (SELECT 1 FROM payments p WHERE p.order_id=o.id)`;

    if(calendarType==='LUNAR'){
      const lunarDayExpr="CASE WHEN o.lunar_date_text LIKE '%/%/%' THEN CAST(SUBSTRING_INDEX(o.lunar_date_text,'/',1) AS UNSIGNED) ELSE DAY(o.order_date) END";
      const lunarMonthExpr="CASE WHEN o.lunar_date_text LIKE '%/%/%' THEN CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(o.lunar_date_text,'/',2),'/',-1) AS UNSIGNED) ELSE MONTH(o.order_date) END";
      const lunarYearExpr="CASE WHEN o.lunar_date_text LIKE '%/%/%' THEN CAST(SUBSTRING_INDEX(o.lunar_date_text,'/',-1) AS UNSIGNED) ELSE YEAR(o.order_date) END";
      const baseWhere=`o.status<>'CANCELLED'
        AND COALESCE(o.installment_amount,0)>0
        AND COALESCE(o.calendar_type,'SOLAR')='LUNAR'
        AND ${hasPaymentWhere}
        ${customerWhere}`;

      const [dayRows]=await pool.query(
        `SELECT COALESCE(SUM(o.installment_amount),0) total
         FROM orders o
         WHERE ${baseWhere}
           AND ${lunarDayExpr}=? AND ${lunarMonthExpr}=? AND ${lunarYearExpr}=?`,
        [...params,period.day,period.month,period.year]
      );

      const [monthRows]=await pool.query(
        `SELECT COALESCE(SUM(o.installment_amount),0) total
         FROM orders o
         WHERE ${baseWhere}
           AND ${lunarMonthExpr}=? AND ${lunarYearExpr}=?`,
        [...params,period.month,period.year]
      );

      const [yearRows]=await pool.query(
        `SELECT COALESCE(SUM(o.installment_amount),0) total
         FROM orders o
         WHERE ${baseWhere}
           AND ${lunarYearExpr}=?`,
        [...params,period.year]
      );

      return {
        calendar_type:calendarType,
        source:'orders.installment_amount + EXISTS(payments)',
        stat_type:'BILLED_INSTALLMENT_WITH_PAYMENT',
        note:'Chỉ cộng góp nợ của bill đã phát sinh ít nhất 1 giao dịch thu tiền; không cần bill đã trả đủ',
        period,
        day_total:dayRows[0].total,
        month_total:monthRows[0].total,
        year_total:yearRows[0].total
      };
    }

    const dateText=query.date||query.config_date||query.order_date||new Date().toISOString().slice(0,10);
    const baseWhere=`o.status<>'CANCELLED'
      AND COALESCE(o.installment_amount,0)>0
      AND COALESCE(o.calendar_type,'SOLAR')='SOLAR'
      AND ${hasPaymentWhere}
      ${customerWhere}`;

    const [dayRows]=await pool.query(
      `SELECT COALESCE(SUM(o.installment_amount),0) total
       FROM orders o
       WHERE ${baseWhere} AND DATE(o.order_date)=?`,
      [...params,dateText]
    );

    const [monthRows]=await pool.query(
      `SELECT COALESCE(SUM(o.installment_amount),0) total
       FROM orders o
       WHERE ${baseWhere} AND MONTH(o.order_date)=? AND YEAR(o.order_date)=?`,
      [...params,period.month,period.year]
    );

    const [yearRows]=await pool.query(
      `SELECT COALESCE(SUM(o.installment_amount),0) total
       FROM orders o
       WHERE ${baseWhere} AND YEAR(o.order_date)=?`,
      [...params,period.year]
    );

    return {
      calendar_type:calendarType,
      source:'orders.installment_amount + EXISTS(payments)',
      stat_type:'BILLED_INSTALLMENT_WITH_PAYMENT',
      note:'Chỉ cộng góp nợ của bill đã phát sinh ít nhất 1 giao dịch thu tiền; không cần bill đã trả đủ',
      period,
      day_total:dayRows[0].total,
      month_total:monthRows[0].total,
      year_total:yearRows[0].total
    };
  }

  async statsRange(query={}){
    // V6.51 FINAL:
    // Range stats lấy từ orders.installment_amount nhưng chỉ khi bill đã có giao dịch payment.
    // Dùng EXISTS(payments) để:
    // - bill chưa phát sinh giao dịch không bị cộng;
    // - bill có nhiều payment không bị cộng trùng.
    const customerId=Number(query.customer_id||0)||null;
    const calendarType=query.calendar_type
      ? this.normalizeCalendarType(query.calendar_type)
      : await this.getCustomerBillingCalendarType(customerId);
    const fromDate=String(query.from_date||query.start_date||'').slice(0,10);
    const toDate=String(query.to_date||query.end_date||'').slice(0,10);
    if(!fromDate||!toDate) throw new Error('Chọn từ ngày đến ngày');

    const hasPaymentWhere = `EXISTS (SELECT 1 FROM payments p WHERE p.order_id=o.id)`;

    if(calendarType==='LUNAR'){
      const fromPeriod=this.resolvePeriod({date:fromDate,calendar_type:'LUNAR',lunar_date_text:query.from_lunar_date_text||query.lunar_from||''});
      const toPeriod=this.resolvePeriod({date:toDate,calendar_type:'LUNAR',lunar_date_text:query.to_lunar_date_text||query.lunar_to||''});
      const fromKey=fromPeriod.year*10000+fromPeriod.month*100+fromPeriod.day;
      const toKey=toPeriod.year*10000+toPeriod.month*100+toPeriod.day;
      const lunarDayExpr="CASE WHEN o.lunar_date_text LIKE '%/%/%' THEN CAST(SUBSTRING_INDEX(o.lunar_date_text,'/',1) AS UNSIGNED) ELSE DAY(o.order_date) END";
      const lunarMonthExpr="CASE WHEN o.lunar_date_text LIKE '%/%/%' THEN CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(o.lunar_date_text,'/',2),'/',-1) AS UNSIGNED) ELSE MONTH(o.order_date) END";
      const lunarYearExpr="CASE WHEN o.lunar_date_text LIKE '%/%/%' THEN CAST(SUBSTRING_INDEX(o.lunar_date_text,'/',-1) AS UNSIGNED) ELSE YEAR(o.order_date) END";
      const lunarKeyExpr=`(${lunarYearExpr}*10000+${lunarMonthExpr}*100+${lunarDayExpr})`;

      const params=[Math.min(fromKey,toKey),Math.max(fromKey,toKey)];
      let customerWhere='';
      if(customerId){
        customerWhere=' AND o.customer_id=?';
        params.push(customerId);
      }

      const [rows]=await pool.query(
        `SELECT ${lunarYearExpr} lunar_year,
                ${lunarMonthExpr} lunar_month,
                ${lunarDayExpr} lunar_day,
                COUNT(*) payment_count,
                COUNT(*) bill_count,
                COALESCE(SUM(o.installment_amount),0) installment_total,
                0 cash_total,
                0 bank_total
         FROM orders o
         WHERE o.status<>'CANCELLED'
           AND COALESCE(o.installment_amount,0)>0
           AND COALESCE(o.calendar_type,'SOLAR')='LUNAR'
           AND ${hasPaymentWhere}
           AND ${lunarKeyExpr} BETWEEN ? AND ? ${customerWhere}
         GROUP BY lunar_year,lunar_month,lunar_day
         ORDER BY lunar_year ASC,lunar_month ASC,lunar_day ASC`,
        params
      );

      const normalized=rows.map(r=>({
        ...r,
        payment_date:`${String(r.lunar_day).padStart(2,'0')}/${String(r.lunar_month).padStart(2,'0')}/${r.lunar_year} ÂL`
      }));
      const total=normalized.reduce((sum,row)=>sum+Number(row.installment_total||0),0);
      return {
        from_date:fromDate,
        to_date:toDate,
        calendar_type:'LUNAR',
        source:'orders.installment_amount + EXISTS(payments)',
        stat_type:'BILLED_INSTALLMENT_WITH_PAYMENT',
        note:'Chỉ cộng góp nợ của bill đã phát sinh ít nhất 1 giao dịch thu tiền; không cần bill đã trả đủ',
        from_period:fromPeriod,
        to_period:toPeriod,
        customer_id:customerId,
        total,
        rows:normalized
      };
    }

    const params=[fromDate,toDate];
    let customerWhere='';
    if(customerId){
      customerWhere=' AND o.customer_id=?';
      params.push(customerId);
    }

    const [rows]=await pool.query(
      `SELECT DATE(o.order_date) payment_date,
              COUNT(*) payment_count,
              COUNT(*) bill_count,
              COALESCE(SUM(o.installment_amount),0) installment_total,
              0 cash_total,
              0 bank_total
       FROM orders o
       WHERE o.status<>'CANCELLED'
         AND COALESCE(o.installment_amount,0)>0
         AND COALESCE(o.calendar_type,'SOLAR')='SOLAR'
         AND ${hasPaymentWhere}
         AND DATE(o.order_date) BETWEEN ? AND ? ${customerWhere}
       GROUP BY DATE(o.order_date)
       ORDER BY DATE(o.order_date) ASC`,
      params
    );

    const total=rows.reduce((sum,row)=>sum+Number(row.installment_total||0),0);
    return {
      from_date:fromDate,
      to_date:toDate,
      calendar_type:'SOLAR',
      source:'orders.installment_amount + EXISTS(payments)',
      stat_type:'BILLED_INSTALLMENT_WITH_PAYMENT',
      note:'Chỉ cộng góp nợ của bill đã phát sinh ít nhất 1 giao dịch thu tiền; không cần bill đã trả đủ',
      customer_id:customerId,
      total,
      rows
    };
  }


}
module.exports=new DebtMonthlyInstallmentAgent();
