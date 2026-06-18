const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@posora.vn';
const fileLogger = require('./fileLogger.service');

let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  nodemailer = null;
}

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

function getMailConfig() {
  const host = env('MAIL_HOST', env('SMTP_HOST', 'mail90168.maychuemail.com'));
  const port = Number(env('MAIL_PORT', env('SMTP_PORT', '465')));
  const secureRaw = env('MAIL_SECURE', env('SMTP_SECURE', 'true'));
  const secure = String(secureRaw).toLowerCase() === 'true' || port === 465;
  const user = env('MAIL_USER', env('SMTP_USER', ''));
  const pass = env('MAIL_PASSWORD', env('SMTP_PASS', ''));
  const from = env('MAIL_FROM', env('SMTP_FROM', user || SUPPORT_EMAIL));
  return { host, port, secure, user, pass, from };
}

function getTransporter() {
  if (!nodemailer) return null;
  const cfg = getMailConfig();
  if (!cfg.host || !cfg.user || !cfg.pass) return null;
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    tls: { rejectUnauthorized: true },
  });
}

function htmlEscape(v) {
  return String(v || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

async function sendMail({ to, subject, text, html, cc, bcc }) {
  const transporter = getTransporter();
  const cfg = getMailConfig();
  if (!transporter) {
    fileLogger.logMail('MAIL_SKIPPED', { to, subject, reason: 'MAIL_HOST/MAIL_USER/MAIL_PASSWORD not configured or nodemailer not installed' });
    console.log('[MAIL_SKIPPED]', { to, subject, reason: 'MAIL_HOST/MAIL_USER/MAIL_PASSWORD not configured or nodemailer not installed' });
    return { sent: false, skipped: true };
  }
  try {
    fileLogger.logMail('MAIL_SEND_START', { to, cc, bcc, subject, from: cfg.from });
    const info = await transporter.sendMail({ from: cfg.from, to, cc, bcc, subject, text, html });
    fileLogger.logMail('MAIL_SEND_OK', { to, subject, messageId: info.messageId });
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    fileLogger.logError('MAIL_SEND_FAILED', { to, subject, error: err });
    throw err;
  }
}

async function verifyMailTransport() {
  const transporter = getTransporter();
  if (!transporter) return { ok: false, message: 'Mail chưa cấu hình MAIL_HOST/MAIL_USER/MAIL_PASSWORD' };
  await transporter.verify();
  return { ok: true, message: 'SMTP ready' };
}

async function sendSupportMail({ subject, text, html }) {
  return sendMail({ to: SUPPORT_EMAIL, subject, text, html });
}

async function sendSms({ phone, message }) {
  // V16: SMS OTP is intentionally disabled. MeatBiz uses email verification/reset via its own mail server.
  fileLogger.logMail('SMS_DISABLED', { phone, reason: 'Phone OTP/SMS is not enabled. Use email verification.' });
  console.log('[SMS_DISABLED]', { phone, message, reason: 'Phone OTP/SMS is not enabled. Use email verification.' });
  return { sent: false, skipped: true, disabled: true };
}

function shell(title, body) {
  return `<div style="margin:0;padding:28px;background:#fff7ed;font-family:Arial,sans-serif;color:#431407">
    <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #fed7aa;border-radius:22px;overflow:hidden;box-shadow:0 18px 50px rgba(154,52,18,.12)">
      <div style="padding:22px 26px;background:linear-gradient(135deg,#7f1d1d,#ea580c);color:#fff">
        <div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;opacity:.85">MeatBiz AI-native ERP</div>
        <h1 style="margin:8px 0 0;font-size:24px;line-height:1.25">${htmlEscape(title)}</h1>
      </div>
      <div style="padding:26px;line-height:1.6;font-size:15px">${body}</div>
      <div style="padding:16px 26px;background:#fff7ed;border-top:1px solid #ffedd5;font-size:12px;color:#9a3412">Email tự động từ MeatBiz. Vui lòng không trả lời trực tiếp email này.</div>
    </div>
  </div>`;
}

function verifyEmailHtml({ fullName, verifyUrl }) {
  return shell('Xác minh email đăng ký MeatBiz', `
    <p>Chào <b>${htmlEscape(fullName)}</b>,</p>
    <p>Bạn vừa đăng ký tài khoản MeatBiz. Vui lòng bấm nút bên dưới để xác minh email.</p>
    <p style="margin:24px 0"><a href="${htmlEscape(verifyUrl)}" style="display:inline-block;background:#ea580c;color:#fff;padding:13px 20px;border-radius:14px;text-decoration:none;font-weight:700">Xác minh email</a></p>
    <p>Link hết hạn sau <b>24 giờ</b>. Sau khi xác minh, MeatBiz sẽ kiểm tra và kích hoạt tài khoản.</p>
    <p style="font-size:13px;color:#9a3412;word-break:break-all">${htmlEscape(verifyUrl)}</p>
  `);
}

function resetPasswordHtml({ fullName, code }) {
  return shell('Mã đặt lại mật khẩu MeatBiz', `
    <p>Chào <b>${htmlEscape(fullName || 'bạn')}</b>,</p>
    <p>Mã đặt lại mật khẩu của bạn là:</p>
    <div style="font-size:30px;letter-spacing:8px;font-weight:800;background:#fff7ed;border:1px dashed #fb923c;border-radius:16px;padding:16px 20px;text-align:center;color:#7f1d1d">${htmlEscape(code)}</div>
    <p>Mã hết hạn sau <b>15 phút</b>. Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này.</p>
  `);
}

function approvedHtml({ fullName, username }) {
  return shell('Tài khoản MeatBiz đã được kích hoạt', `
    <p>Chào <b>${htmlEscape(fullName || username)}</b>,</p>
    <p>Tài khoản MeatBiz của bạn đã được kích hoạt.</p>
    <p><b>Tên đăng nhập:</b> ${htmlEscape(username)}</p>
    <p>Bạn có thể đăng nhập và bắt đầu sử dụng hệ thống.</p>
  `);
}

function registrationHtml(r) {
  const rows = [
    ['Mã đăng ký', r.id || ''],
    ['Họ tên', r.full_name || ''],
    ['Tên đăng nhập', r.username || ''],
    ['Số điện thoại', r.phone || ''],
    ['Email', r.email || ''],
    ['Nhu cầu', r.description || ''],
    ['Link verify email khách', r.verifyUrl || ''],
  ].map(([k, v]) => `<tr><td style="padding:8px 12px;border:1px solid #eee;font-weight:700">${k}</td><td style="padding:8px 12px;border:1px solid #eee">${htmlEscape(v)}</td></tr>`).join('');
  return shell('MeatBiz có đăng ký tài khoản mới', `
    <p>Khách vừa gửi đăng ký. Hệ thống đã gửi email xác minh cho khách.</p>
    <table style="border-collapse:collapse;width:100%">${rows}</table>
    <p>Sau khi khách xác minh email, admin có thể duyệt tài khoản trong màn Đăng ký.</p>
  `);
}

module.exports = {
  SUPPORT_EMAIL,
  getMailConfig,
  verifyMailTransport,
  sendMail,
  sendSupportMail,
  sendSms,
  registrationHtml,
  verifyEmailHtml,
  resetPasswordHtml,
  approvedHtml,
};
