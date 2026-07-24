const express = require('express');
const argon2 = require('argon2');
const { prisma } = require('../db');
const { requireAuth, setFlash } = require('../middleware/auth');
const { cleanText, validPassword, positiveInt } = require('../utils/validation');

const router = express.Router();

router.get('/users/:id', async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id, 1, Number.MAX_SAFE_INTEGER) || -1;
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true, nickname: true, bio: true, createdAt: true, dormantUntil: true, products: { where: { status: 'ACTIVE' }, select: { id: true, name: true, price: true }, orderBy: { createdAt: 'desc' }, take: 20 } } });
    if (!user) return res.status(404).render('error', { title: '사용자 없음', message: '사용자를 찾을 수 없습니다.' });
    res.render('profile', { title: `${user.nickname}의 프로필`, profile: user });
  } catch (error) { next(error); }
});

router.get('/mypage', requireAuth, async (req, res, next) => {
  try {
    const transfers = await prisma.transfer.findMany({ where: { OR: [{ senderId: req.user.id }, { receiverId: req.user.id }] }, include: { sender: { select: { nickname: true } }, receiver: { select: { nickname: true } }, product: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 30 });
    res.render('mypage', { title: '마이페이지', transfers });
  } catch (error) { next(error); }
});

router.post('/mypage/profile', requireAuth, async (req, res, next) => {
  try {
    const nickname = cleanText(req.body.nickname, 30);
    const bio = cleanText(req.body.bio, 500);
    if (nickname.length < 2) {
      setFlash(req, 'error', '닉네임은 2자 이상이어야 합니다.');
      return res.redirect('/mypage');
    }
    await prisma.user.update({ where: { id: req.user.id }, data: { nickname, bio } });
    setFlash(req, 'success', '프로필을 업데이트했습니다.');
    res.redirect('/mypage');
  } catch (error) {
    if (error.code === 'P2002') {
      setFlash(req, 'error', '이미 사용 중인 닉네임입니다.');
      return res.redirect('/mypage');
    }
    next(error);
  }
});

router.post('/mypage/password', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const currentOk = await argon2.verify(user.passwordHash, String(req.body.currentPassword || '')).catch(() => false);
    if (!currentOk || !validPassword(req.body.newPassword) || req.body.newPassword !== req.body.confirmPassword) {
      setFlash(req, 'error', '현재 비밀번호 또는 새 비밀번호 조건을 확인해 주세요.');
      return res.redirect('/mypage');
    }
    const passwordHash = await argon2.hash(req.body.newPassword, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash } });
    const userId = req.user.id;
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.userId = userId;
      req.session.roleSnapshot = req.user.role;
      setFlash(req, 'success', '비밀번호를 변경하고 세션을 갱신했습니다.');
      res.redirect('/mypage');
    });
  } catch (error) { next(error); }
});

router.post('/users/:id/block', requireAuth, async (req, res, next) => {
  try {
    const blockedId = positiveInt(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!blockedId || blockedId === req.user.id) return res.status(400).render('error', { title: '잘못된 요청', message: '자기 자신은 차단할 수 없습니다.' });
    const target = await prisma.user.findUnique({ where: { id: blockedId } });
    if (!target) return res.sendStatus(404);
    await prisma.userBlock.upsert({ where: { blockerId_blockedId: { blockerId: req.user.id, blockedId } }, create: { blockerId: req.user.id, blockedId }, update: {} });
    setFlash(req, 'success', '사용자를 차단했습니다. 상품과 메시지가 숨겨집니다.');
    res.redirect(req.get('referer') || '/');
  } catch (error) { next(error); }
});

router.post('/products/:id/block', requireAuth, async (req, res, next) => {
  try {
    const productId = positiveInt(req.params.id, 1, Number.MAX_SAFE_INTEGER) || -1;
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) return res.sendStatus(404);
    await prisma.productBlock.upsert({ where: { userId_productId: { userId: req.user.id, productId } }, create: { userId: req.user.id, productId }, update: {} });
    setFlash(req, 'success', '이 상품을 내 목록에서 숨겼습니다.');
    res.redirect('/');
  } catch (error) { next(error); }
});

router.post('/reports/product/:id', requireAuth, async (req, res, next) => {
  try {
    const productId = positiveInt(req.params.id, 1, Number.MAX_SAFE_INTEGER) || -1;
    const reason = cleanText(req.body.reason, 500);
    if (reason.length < 5) {
      setFlash(req, 'error', '신고 사유를 5자 이상 작성해 주세요.');
      return res.redirect(`/products/${productId}`);
    }
    await prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id: productId } });
      if (!product || product.ownerId === req.user.id) throw Object.assign(new Error('INVALID_TARGET'), { publicCode: 'INVALID_TARGET' });
      await tx.report.create({ data: { reporterId: req.user.id, productId, reason } });
      const count = await tx.report.count({ where: { productId } });
      if (count >= 3) await tx.product.update({ where: { id: productId }, data: { status: 'BLOCKED' } });
    });
    setFlash(req, 'success', '신고가 접수되었습니다.');
    res.redirect('/');
  } catch (error) {
    if (error.code === 'P2002') setFlash(req, 'error', '이미 신고한 상품입니다.');
    else if (error.publicCode) setFlash(req, 'error', '신고할 수 없는 대상입니다.');
    else return next(error);
    res.redirect('/');
  }
});

router.post('/reports/user/:id', requireAuth, async (req, res, next) => {
  const targetUserId = positiveInt(req.params.id, 1, Number.MAX_SAFE_INTEGER) || -1;
  try {
    const reason = cleanText(req.body.reason, 500);
    if (reason.length < 5 || targetUserId === req.user.id) throw Object.assign(new Error('INVALID_TARGET'), { publicCode: 'INVALID_TARGET' });
    await prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id: targetUserId } });
      if (!target || target.role === 'ADMIN') throw Object.assign(new Error('INVALID_TARGET'), { publicCode: 'INVALID_TARGET' });
      await tx.report.create({ data: { reporterId: req.user.id, targetUserId, reason } });
      const count = await tx.report.count({ where: { targetUserId } });
      if (count >= 10) await tx.user.update({ where: { id: targetUserId }, data: { dormantUntil: new Date(Date.now() + 30 * 24 * 60 * 60_000) } });
    });
    setFlash(req, 'success', '사용자 신고가 접수되었습니다.');
  } catch (error) {
    if (error.code === 'P2002') setFlash(req, 'error', '이미 신고한 사용자입니다.');
    else if (error.publicCode) setFlash(req, 'error', '신고할 수 없는 대상입니다.');
    else return next(error);
  }
  res.redirect(`/users/${targetUserId}`);
});

module.exports = { router };
