const fileLogger = require('../services/fileLogger.service');

function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  const requestId = req.requestId || req.headers['x-request-id'];
  fileLogger.logError('EXPRESS_ERROR', {
    request_id: requestId,
    method: req.method,
    url: req.originalUrl,
    status,
    body: req.body,
    query: req.query,
    error: err
  });
  console.error('[ERROR]', err);
  res.status(status).json({
    success: false,
    message: err.message || 'Lỗi hệ thống',
    request_id: requestId || undefined
  });
}
module.exports = { errorHandler };
