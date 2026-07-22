const express = require('express');
const { prisma } = require('../db');
const { requireAdmin, setFlash } = require('../middleware/auth');
const { cleanText, positiveInt } = require('../utils/validation');

const router = express.Router();
router.use('/admin', requireAdmin);

async function audit(adminId, action, targetType, targetId, detail = '') {
  return prisma.adminAudit.create({ data: { adminId, action, targetType, targetId, detail: cleanText(detail, 300) } });
}

router.get('/admin', async (req, res, next) => {
  try {
    const [users, products, reports, transfers, messages, directMessages, audits, counts] = await Promise.all([
      prisma.user.findMany({ select: { id: true, username: true, nickname: true, role: true, balance: true, dormantUntil: true, createdAt: true, _count: { select: { userReportsReceived: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.product.findMany({ include: { owner: { select: { nickname: true } }, _count: { select: { reports: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.report.findMany({ include: { reporter: { select: { nickname: true } }, product: { select: { name: true } }, targetUser: { select: { nickname: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.transfer.findMany({ include: { sender: { select: { nickname: true } }, receiver: { select: { nickname: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.globalMessage.findMany({ include: { sender: { select: { nickname: true } } }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.directMessage.findMany({ include: { sender: { select: { nickname: true } }, conversation: { include: { userA: { select: { nickname: true } }, userB: { select: { nickname: true } } } } }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.adminAudit.findMany({ include: { admin: { select: { nickname: true } } }, orderBy: { createdAt: 'desc' }, take: 50 }),
      Promise.all([prisma.user.count(), prisma.product.count(), prisma.report.count(), prisma.transfer.count()]),
    ]);
    res.render('admin/dashboard', { title: '관리자 센터', users, products, reports, transfers, messages, directMessages, audits, stats: { users: counts[0], products: counts[1], reports: counts[2], transfers: counts[3] } });
  } catch (error) { next(error); }
});

router.post('/admin/users/:id/suspend', async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id, 1, Number.MAX_SAFE_INTEGER) || -1;
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target || target.role === 'ADMIN') return res.status(400).render('error', { title: '처리 불가', message: '해당 사용자는 정지할 수 없습니다.' });
    const dormantUntil = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    await prisma.$transaction([
      prisma.user.update({ where: { id }, data: { dormantUntil } }),
      prisma.adminAudit.create({ data: { adminId: req.user.id, action: 'SUSPEND_30_DAYS', targetType: 'USER', targetId: id, detail: cleanText(req.body.reason, 300) } }),
    ]);
    setFlash(req, 'success', '사용자를 30일 정지했습니다.');
    res.redirect('/admin');
  } catch (error) { next(error); }
});

router.post('/admin/users/:id/activate', async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id, 1, Number.MAX_SAFE_INTEGER) || -1;
    await prisma.$transaction([
      prisma.user.update({ where: { id }, data: { dormantUntil: null } }),
      prisma.adminAudit.create({ data: { adminId: req.user.id, action: 'ACTIVATE', targetType: 'USER', targetId: id } }),
    ]);
    setFlash(req, 'success', '사용자 제한을 해제했습니다.');
    res.redirect('/admin');
  } catch (error) { next(error); }
});

router.post('/admin/products/:id/status', async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id, 1, Number.MAX_SAFE_INTEGER) || -1;
    const status = ['ACTIVE', 'BLOCKED'].includes(req.body.status) ? req.body.status : null;
    if (!status) return res.status(400).render('error', { title: '잘못된 요청', message: '허용되지 않은 상태값입니다.' });
    await prisma.$transaction([
      prisma.product.update({ where: { id }, data: { status } }),
      prisma.adminAudit.create({ data: { adminId: req.user.id, action: `PRODUCT_${status}`, targetType: 'PRODUCT', targetId: id } }),
    ]);
    setFlash(req, 'success', '상품 상태를 변경했습니다.');
    res.redirect('/admin');
  } catch (error) { next(error); }
});

router.post('/admin/reports/:id/delete', async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id, 1, Number.MAX_SAFE_INTEGER) || -1;
    await prisma.$transaction([
      prisma.report.delete({ where: { id } }),
      prisma.adminAudit.create({ data: { adminId: req.user.id, action: 'REPORT_DISMISSED', targetType: 'REPORT', targetId: id } }),
    ]);
    setFlash(req, 'success', '신고를 검토 완료 처리했습니다.');
    res.redirect('/admin');
  } catch (error) { next(error); }
});

router.post('/admin/messages/:id/delete', async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id, 1, Number.MAX_SAFE_INTEGER) || -1;
    await prisma.$transaction([
      prisma.globalMessage.delete({ where: { id } }),
      prisma.adminAudit.create({ data: { adminId: req.user.id, action: 'MESSAGE_DELETED', targetType: 'GLOBAL_MESSAGE', targetId: id } }),
    ]);
    setFlash(req, 'success', '전체 채팅 메시지를 삭제했습니다.');
    res.redirect('/admin');
  } catch (error) { next(error); }
});

router.post('/admin/direct-messages/:id/delete', async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id, 1, Number.MAX_SAFE_INTEGER) || -1;
    await prisma.$transaction([
      prisma.directMessage.delete({ where: { id } }),
      prisma.adminAudit.create({ data: { adminId: req.user.id, action: 'MESSAGE_DELETED', targetType: 'DIRECT_MESSAGE', targetId: id } }),
    ]);
    setFlash(req, 'success', '1:1 채팅 메시지를 삭제했습니다.');
    res.redirect('/admin');
  } catch (error) { next(error); }
});

module.exports = { router, audit };
