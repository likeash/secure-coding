const express = require('express');
const { prisma } = require('../db');
const { requireAuth, setFlash } = require('../middleware/auth');
const { cleanText, positiveInt } = require('../utils/validation');
const { MemoryRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const global10s = new MemoryRateLimiter({ windowMs: 10_000, max: 10 });
const global60s = new MemoryRateLimiter({ windowMs: 60_000, max: 30 });

async function blockedBetween(userId, otherId) {
  return prisma.userBlock.findFirst({ where: { OR: [{ blockerId: userId, blockedId: otherId }, { blockerId: otherId, blockedId: userId }] } });
}

router.get('/chat/global', requireAuth, async (req, res, next) => {
  try {
    const blocked = await prisma.userBlock.findMany({ where: { blockerId: req.user.id }, select: { blockedId: true } });
    const messages = await prisma.globalMessage.findMany({ where: { senderId: { notIn: blocked.map((x) => x.blockedId) } }, include: { sender: { select: { id: true, nickname: true } } }, orderBy: { createdAt: 'desc' }, take: 100 });
    res.render('chat/global', { title: '전체 채팅', messages: messages.reverse() });
  } catch (error) { next(error); }
});

router.post('/chat/global', requireAuth, async (req, res, next) => {
  try {
    if (!global10s.check(`10:${req.user.id}`) || !global60s.check(`60:${req.user.id}`)) return res.status(429).render('error', { title: '메시지 제한', message: '메시지 전송 한도를 초과했습니다. 초과 메시지는 저장되지 않았습니다.' });
    const body = cleanText(req.body.body, 1000);
    if (!body) {
      setFlash(req, 'error', '메시지를 입력해 주세요.');
      return res.redirect('/chat/global');
    }
    await prisma.globalMessage.create({ data: { body, senderId: req.user.id } });
    res.redirect('/chat/global');
  } catch (error) { next(error); }
});

router.get('/chat', requireAuth, async (req, res, next) => {
  try {
    const conversations = await prisma.directConversation.findMany({ where: { OR: [{ userAId: req.user.id }, { userBId: req.user.id }] }, include: { userA: { select: { id: true, nickname: true } }, userB: { select: { id: true, nickname: true } }, messages: { orderBy: { createdAt: 'desc' }, take: 1 } }, orderBy: { updatedAt: 'desc' } });
    res.render('chat/list', { title: '1:1 채팅', conversations });
  } catch (error) { next(error); }
});

router.post('/chat/start/:userId', requireAuth, async (req, res, next) => {
  try {
    const otherId = positiveInt(req.params.userId, 1, Number.MAX_SAFE_INTEGER);
    if (!otherId || otherId === req.user.id || !await prisma.user.findUnique({ where: { id: otherId } })) return res.status(400).render('error', { title: '잘못된 요청', message: '대화 상대를 확인해 주세요.' });
    if (await blockedBetween(req.user.id, otherId)) return res.status(403).render('error', { title: '채팅 불가', message: '차단 관계에서는 대화를 시작할 수 없습니다.' });
    const [userAId, userBId] = [req.user.id, otherId].sort((a, b) => a - b);
    const conversation = await prisma.directConversation.upsert({ where: { userAId_userBId: { userAId, userBId } }, create: { userAId, userBId }, update: {} });
    res.redirect(`/chat/${conversation.id}`);
  } catch (error) { next(error); }
});

async function ownConversation(id, userId) {
  return prisma.directConversation.findFirst({ where: { id, OR: [{ userAId: userId }, { userBId: userId }] }, include: { userA: { select: { id: true, nickname: true } }, userB: { select: { id: true, nickname: true } }, messages: { include: { sender: { select: { id: true, nickname: true } } }, orderBy: { createdAt: 'asc' }, take: 200 } } });
}

router.get('/chat/:id', requireAuth, async (req, res, next) => {
  try {
    const conversation = await ownConversation(positiveInt(req.params.id, 1, Number.MAX_SAFE_INTEGER) || -1, req.user.id);
    if (!conversation) return res.status(403).render('error', { title: '접근 거부', message: '이 채팅방의 참여자가 아닙니다.' });
    const other = conversation.userAId === req.user.id ? conversation.userB : conversation.userA;
    if (await blockedBetween(req.user.id, other.id)) return res.status(403).render('error', { title: '채팅 불가', message: '차단 관계에서는 대화를 볼 수 없습니다.' });
    res.render('chat/detail', { title: `${other.nickname}님과의 채팅`, conversation, other });
  } catch (error) { next(error); }
});

router.post('/chat/:id/messages', requireAuth, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id, 1, Number.MAX_SAFE_INTEGER) || -1;
    const conversation = await ownConversation(id, req.user.id);
    if (!conversation) return res.status(403).render('error', { title: '접근 거부', message: '이 채팅방의 참여자가 아닙니다.' });
    const otherId = conversation.userAId === req.user.id ? conversation.userBId : conversation.userAId;
    if (await blockedBetween(req.user.id, otherId)) return res.status(403).render('error', { title: '채팅 불가', message: '차단 관계에서는 메시지를 보낼 수 없습니다.' });
    const body = cleanText(req.body.body, 1000);
    if (!body) return res.redirect(`/chat/${id}`);
    await prisma.$transaction([
      prisma.directMessage.create({ data: { body, senderId: req.user.id, conversationId: id } }),
      prisma.directConversation.update({ where: { id }, data: { updatedAt: new Date() } }),
    ]);
    res.redirect(`/chat/${id}`);
  } catch (error) { next(error); }
});

module.exports = { router, global10s, global60s, ownConversation };
