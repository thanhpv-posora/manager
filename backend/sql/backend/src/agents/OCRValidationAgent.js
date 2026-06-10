class OCRValidationAgent {
  constructor(){
    this.version='6.18.0';
    this.responsibility='Strict OCR validation: block ambiguous expressions like 23+12.1, protect decimals, require manual confirmation';
  }
}
module.exports = new OCRValidationAgent();
