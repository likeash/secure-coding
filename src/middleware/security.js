const crypto = require('crypto');

function csrfToken(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function csrfProtect(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const supplied = String(req.body?._csrf || req.get('x-csrf-token') || '');
  const expected = String(req.session?.csrfToken || '');
  const valid = supplied.length === expected.length && supplied.length > 0
    && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) return res.status(403).render('error', { title: '요청 거부', message: '유효하지 않거나 만료된 요청입니다.' });
  next();
}

function noCache(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

module.exports = { csrfToken, csrfProtect, noCache };
