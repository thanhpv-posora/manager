const pool=require('../config/db');

class AILearningAgent{
  constructor(){
    this.version='6.31.0';
    this.responsibility='Shared AI learning memory for every business module';
  }

  async log(data,user){
    await pool.query(
      `INSERT INTO ai_learning_logs(agent_name,module_name,action_name,input_text,output_text,feedback_text,confidence,created_by)
       VALUES(?,?,?,?,?,?,?,?)`,
      [
        data.agent_name||'UnknownAgent',
        data.module_name||'general',
        data.action_name||'unknown',
        data.input_text||'',
        data.output_text||'',
        data.feedback_text||'',
        data.confidence||null,
        user?.id||null
      ]
    );
    return {message:'Đã ghi learning log'};
  }

  async list(query={}){
    const params=[];
    let where='WHERE 1=1';
    if(query.agent_name){where+=' AND agent_name=?';params.push(query.agent_name)}
    if(query.module_name){where+=' AND module_name=?';params.push(query.module_name)}
    const [rows]=await pool.query(`SELECT * FROM ai_learning_logs ${where} ORDER BY id DESC LIMIT 200`,params);
    return rows;
  }
}
module.exports=new AILearningAgent();
