const CustomerAgent=require('./CustomerAgent');
const ProductAgent=require('./ProductAgent');
const OrderAgent=require('./OrderAgent');
const PaymentAgent=require('./PaymentAgent');
const SupplierAgent=require('./SupplierAgent');
const ReportAgent=require('./ReportAgent');
const SoftDeleteAgent=require('./SoftDeleteAgent');
const PriceMatrixAgent=require('./PriceMatrixAgent');
const VoiceBillAgent=require('./VoiceBillAgent');
const SettingsAgent=require('./SettingsAgent');
const OrderImportAgent=require('./OrderImportAgent');
const ImportSafetyAgent=require('./ImportSafetyAgent');
const OCRValidationAgent=require('./OCRValidationAgent');
const ProductMatchingAgent=require('./ProductMatchingAgent');
const DebtInstallmentAgent=require('./DebtInstallmentAgent');
const BusinessPortalAgent=require('./BusinessPortalAgent');
const HandwritingBillAgent=require('./HandwritingBillAgent');
const UserPermissionAgent=require('./UserPermissionAgent');
const UserCustomerMappingAgent=require('./UserCustomerMappingAgent');
const SponsorVideoAgent=require('./SponsorVideoAgent');
const AILearningAgent=require('./AILearningAgent');
const ProductionCheckAgent=require('./ProductionCheckAgent');
const SchemaMigrationAgent=require('./SchemaMigrationAgent');
const AutoMigrationAgent=require('./AutoMigrationAgent');
const ProductImageImportAgent=require('./ProductImageImportAgent');
const OCRProviderAgent=require('./OCRProviderAgent');
const UserPreferenceAgent=require('./UserPreferenceAgent');
const SystemReviewAgent={version:'6.24.0',responsibility:'Review system modules and production gaps'};

const agents={
  CustomerAgent,
  ProductAgent,
  OrderAgent,
  PaymentAgent,
  SupplierAgent,
  ReportAgent,
  SoftDeleteAgent,
  PriceMatrixAgent,
  VoiceBillAgent,
  SettingsAgent,
  OrderImportAgent,
  ImportSafetyAgent,
  OCRValidationAgent,
  ProductMatchingAgent,
  DebtInstallmentAgent,
  BusinessPortalAgent,
  HandwritingBillAgent,
  UserPermissionAgent,
  UserCustomerMappingAgent,
  SponsorVideoAgent,
  AILearningAgent,
  ProductionCheckAgent,
  SchemaMigrationAgent,
  AutoMigrationAgent,
  ProductImageImportAgent,
  OCRProviderAgent,
  UserPreferenceAgent,
  SystemReviewAgent
};

function listAgents(){
  return Object.entries(agents).map(([name,agent])=>({
    name,
    status:'ACTIVE',
    version:agent.version||'6.17.0',
    responsibility:agent.responsibility||'Business logic agent'
  }));
}
module.exports={agents,listAgents};
