const jwt = require('jsonwebtoken');

function auth(roles = []) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Chưa đăng nhập' });
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      req.user = payload;
      if (roles.length && !roles.includes(payload.role)) return res.status(403).json({ message: 'Không có quyền' });
      next();
    } catch (e) {
      return res.status(401).json({ message: 'Token không hợp lệ' });
    }
  };
}

module.exports = { auth };
