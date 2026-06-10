const fs=require('fs');
const path=require('path');

function fail(msg){ console.error('[CHECK FAILED] '+msg); process.exit(1); }

const registryPath=path.join(__dirname,'../src/agents/AgentRegistry.js');
const orderPath=path.join(__dirname,'../src/agents/OrderAgent.js');

const registry=fs.readFileSync(registryPath,'utf8');
const order=fs.readFileSync(orderPath,'utf8');

if(registry.includes('\\n')) fail('AgentRegistry.js contains literal \\n');
if(order.includes('DebtInstallmentAgent') && !order.includes("require('./DebtInstallmentAgent')")) {
  fail('OrderAgent.js uses DebtInstallmentAgent but does not import it');
}

console.log('Startup check OK');
