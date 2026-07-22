const express = require('express');
const argon2 = require('argon2');
const { prisma } = require('../db');
const { cleanText, validPassword, validUsername } = require('../utils/validation');
const { setFlash } = require('../middleware/auth');
const { MemoryRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const loginIpLimiter = new MemoryRateLimiter({ windowMs: 60_000, max: 10, blockMs: 10 * 60_000 });
const dummyHashPromise = argon2.hash('DummyPassword123!', { type: argon2.argon2id });

router.get('/register', (req, res) => res.render('auth/register', { title: '회원가입' }));

router.post('/register', async (req, res, next) => {
  try {
    const username = cleanText(req.body.username, 24);
    const nickname = cleanText(req.body.nickname, 30);
    const password = req.body.password;
    if (!validUsername(username) || nickname.length < 2 || !validPassword(password)) {
      setFlash(req, 'error', '아이디는 영문/숫자/_ 4~24자, 닉네임은 2자 이상, 비밀번호는 11자 이상이며 영문·숫자·특수문자를 포함해야 합니다.');
      return res.redirect('/register');
    }
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const user = await prisma.user.create({ data: { username, nickname, passwordHash } });
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.userId = user.id;
      req.session.roleSnapshot = user.role;
      setFlash(req, 'success', '가입을 환영합니다. 시작 포인트 10,000P가 지급되었습니다.');
      res.redirect('/');
    });
  } catch (error) {
    if (error.code === 'P2002') {
      setFlash(req, 'error', '이미 사용 중인 아이디입니다.');
      return res.redirect('/register');
    }
    next(error);
  }
});

router.get('/login', (req, res) => res.render('auth/login', { title: '로그인' }));

router.post('/login', loginIpLimiter.middleware(), async (req, res, next) => {
  const failure = () => {
    setFlash(req, 'error', '아이디 또는 비밀번호가 올바르지 않습니다.');
    res.redirect('/login');
  };
  try {
    const username = cleanText(req.body.username, 24);
    const password = String(req.body.password || '');
    const user = validUsername(username) ? await prisma.user.findUnique({ where: { username } }) : null;
    const hash = user?.passwordHash || await dummyHashPromise;
    const verified = await argon2.verify(hash, password).catch(() => false);
    const now = new Date();
    if (!user || !verified || (user.loginLockedUntil && user.loginLockedUntil > now)) {
      if (user && (!user.loginLockedUntil || user.loginLockedUntil <= now)) {
        const failures = user.failedLoginAttempts + 1;
        await prisma.user.update({
          where: { id: user.id },
          data: failures >= 5
            ? { failedLoginAttempts: 0, loginLockedUntil: new Date(Date.now() + 10 * 60_000) }
            : { failedLoginAttempts: failures, loginLockedUntil: null },
        });
      }
      return failure();
    }
    if (user.dormantUntil && user.dormantUntil > now) {
      setFlash(req, 'error', '현재 이용이 제한된 계정입니다. 제한 만료 후 다시 시도해 주세요.');
      return res.redirect('/login');
    }
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, loginLockedUntil: null } });
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.userId = user.id;
      req.session.roleSnapshot = user.role;
      res.redirect('/');
    });
  } catch (error) {
    next(error);
  }
});

router.post('/logout', (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('tiny.sid');
    res.redirect('/');
  });
});

module.exports = { router, loginIpLimiter };
