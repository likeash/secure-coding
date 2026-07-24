const { prisma } = require('../db');
const { cleanText, positiveInt } = require('../utils/validation');
const { global10s, global60s } = require('../routes/chat');

async function participantConversation(id, userId) {
  return prisma.directConversation.findFirst({ where: { id, OR: [{ userAId: userId }, { userBId: userId }] } });
}

async function blockedBetween(userId, otherId) {
  return prisma.userBlock.findFirst({ where: { OR: [{ blockerId: userId, blockedId: otherId }, { blockerId: otherId, blockedId: userId }] } });
}

function roomName(conversationId) {
  return `conversation:${conversationId}`;
}

function userRoom(userId) {
  return `user:${userId}`;
}

const GLOBAL_ROOM = 'global-chat';

function registerChatSockets(io) {
  io.use(async (socket, next) => {
    try {
      const session = socket.request.session;
      const userId = session && session.userId;
      if (!userId) return next(new Error('AUTH_REQUIRED'));
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return next(new Error('AUTH_REQUIRED'));
      if (user.dormantUntil && user.dormantUntil > new Date()) return next(new Error('AUTH_REQUIRED'));
      socket.userId = user.id;
      next();
    } catch (error) {
      next(new Error('AUTH_REQUIRED'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(userRoom(socket.userId));

    socket.on('globalChat:join', (payload, ack) => {
      socket.join(GLOBAL_ROOM);
      if (typeof ack === 'function') ack({ ok: true });
    });

    socket.on('globalChat:message', async (payload, ack) => {
      try {
        if (!global10s.check(`10:${socket.userId}`) || !global60s.check(`60:${socket.userId}`)) {
          return typeof ack === 'function' && ack({ ok: false, error: 'RATE_LIMITED' });
        }
        const body = cleanText(payload?.body, 1000);
        if (!body) return typeof ack === 'function' && ack({ ok: false, error: 'EMPTY' });
        const message = await prisma.globalMessage.create({ data: { body, senderId: socket.userId }, include: { sender: { select: { id: true, nickname: true } } } });
        const blockers = await prisma.userBlock.findMany({ where: { blockedId: socket.userId }, select: { blockerId: true } });
        io.to(GLOBAL_ROOM).except(blockers.map((b) => userRoom(b.blockerId))).emit('globalChat:message', {
          id: message.id,
          body: message.body,
          createdAt: message.createdAt,
          sender: { id: message.sender.id, nickname: message.sender.nickname },
        });
        if (typeof ack === 'function') ack({ ok: true, id: message.id });
      } catch (error) {
        if (typeof ack === 'function') ack({ ok: false, error: 'SERVER_ERROR' });
      }
    });

    socket.on('chat:join', async (payload, ack) => {
      try {
        const id = positiveInt(payload?.conversationId, 1, Number.MAX_SAFE_INTEGER);
        const conversation = id && await participantConversation(id, socket.userId);
        if (!conversation) return typeof ack === 'function' && ack({ ok: false, error: 'FORBIDDEN' });
        const otherId = conversation.userAId === socket.userId ? conversation.userBId : conversation.userAId;
        if (await blockedBetween(socket.userId, otherId)) return typeof ack === 'function' && ack({ ok: false, error: 'BLOCKED' });
        socket.join(roomName(id));
        if (typeof ack === 'function') ack({ ok: true });
      } catch (error) {
        if (typeof ack === 'function') ack({ ok: false, error: 'SERVER_ERROR' });
      }
    });

    socket.on('chat:message', async (payload, ack) => {
      try {
        const id = positiveInt(payload?.conversationId, 1, Number.MAX_SAFE_INTEGER);
        const conversation = id && await participantConversation(id, socket.userId);
        if (!conversation) return typeof ack === 'function' && ack({ ok: false, error: 'FORBIDDEN' });
        const otherId = conversation.userAId === socket.userId ? conversation.userBId : conversation.userAId;
        if (await blockedBetween(socket.userId, otherId)) return typeof ack === 'function' && ack({ ok: false, error: 'BLOCKED' });
        const body = cleanText(payload?.body, 1000);
        if (!body) return typeof ack === 'function' && ack({ ok: false, error: 'EMPTY' });
        const [message] = await prisma.$transaction([
          prisma.directMessage.create({ data: { body, senderId: socket.userId, conversationId: id }, include: { sender: { select: { id: true, nickname: true } } } }),
          prisma.directConversation.update({ where: { id }, data: { updatedAt: new Date() } }),
        ]);
        io.to(roomName(id)).emit('chat:message', {
          id: message.id,
          conversationId: id,
          body: message.body,
          createdAt: message.createdAt,
          sender: { id: message.sender.id, nickname: message.sender.nickname },
        });
        if (typeof ack === 'function') ack({ ok: true, id: message.id });
      } catch (error) {
        if (typeof ack === 'function') ack({ ok: false, error: 'SERVER_ERROR' });
      }
    });
  });
}

module.exports = { registerChatSockets };
