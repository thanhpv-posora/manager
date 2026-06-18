const crypto = require('crypto');
const fileLogger = require('../services/fileLogger.service');

function requestFileLogger(req, res, next) {
  const start = Date.now();
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  res.on('finish', () => {
    const ms = Date.now() - start;
    const isApi = String(req.originalUrl || '').startsWith('/api/');
    if (!isApi) return;
    const payload = {
      request_id: requestId,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration_ms: ms,
      ip: req.ip,
      user_agent: req.headers['user-agent'],
      body: req.method === 'GET' ? undefined : req.body,
      query: req.query
    };
    const category = req.originalUrl.includes('/api/ai') ? 'ai' : 'system';
    if (res.statusCode >= 500) fileLogger.error('errors', 'HTTP_5XX', payload);
    else if (res.statusCode >= 400) fileLogger.warn(category, 'HTTP_4XX', payload);
    else fileLogger.info(category, 'HTTP_OK', payload);
  });
  next();
}

module.exports = { requestFileLogger };
