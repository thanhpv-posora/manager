class ImportSafetyAgent {
  constructor(){
    this.version='6.17.0';
    this.responsibility='Protect import/OCR quantity parsing, preserve decimals like 25.1, warn suspicious rows before applying bill';
  }
}
module.exports = new ImportSafetyAgent();
