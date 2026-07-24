const { prisma } = require('../db');

async function attachUser(req, res, next) {
  try {
    req.user = null;
    if (req.session.userId) {
      req.user = await prisma.user.findUnique({ where: { id: req.session.userId }, select: { id: true, username: true, nickname: true, bio: true, role: true, balance: true, dormantUntil: true } });
      if (!req.user) delete req.session.userId;
      else if (req.session.roleSnapshot !== undefined && req.session.roleSnapshot !== req.user.role) {
        const user = req.user;
        return req.session.regenerate((error) => {
          if (error) return next(error);
          req.session.userId = user.id;
          req.session.roleSnapshot = user.role;
          res.locals.currentUser = user;
          res.locals.flash = null;
          next();
        });
      } else if (req.session.roleSnapshot === undefined) req.session.roleSnapshot = req.user.role;
    }
    res.locals.currentUser = req.user;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    next();
  } catch (error) {
    next(error);
  }
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.dormantUntil && req.user.dormantUntil > new Date()) {
    return res.status(403).render('error', { title: '휴면 계정', message: `이 계정은 ${req.user.dormantUntil.toLocaleString('ko-KR')}까지 이용할 수 없습니다.` });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(404).render('error', { title: '페이지 없음', message: '요청한 페이지를 찾을 수 없습니다.' });
  }
  next();
}

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

module.exports = { attachUser, requireAuth, requireAdmin, setFlash };
