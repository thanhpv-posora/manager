class ProductMatchingAgent {
  constructor(){
    this.version='6.18.0';
    this.responsibility='Strict product matching for import/OCR, prevent dangerous fuzzy match such as Bo suon -> Bo pho';
  }
}
module.exports = new ProductMatchingAgent();
