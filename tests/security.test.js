process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const argon2 = require('argon2');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const { createApp } = require('../app');
const { prisma } = require('../src/db');
const { validPassword, validCategory, getSort, positiveInt } = require('../src/utils/validation');
const { validImageMagic } = require('../src/middleware/upload');
const { MemoryRateLimiter } = require('../src/middleware/rateLimit');
const { registerChatSockets } = require('../src/realtime/chat');

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout waiting for: ${label}`)), ms)),
  ]);
}

const app = createApp();

function csrf(html) {
  const match = html.match(/name="_csrf" value="([a-f0-9]+)"/);
  assert.ok(match, 'CSRF token should be rendered');
  return match[1];
}

async function register(agent, username, nickname = username) {
  const page = await agent.get('/register').expect(200);
  return agent.post('/register').type('form').send({ _csrf: csrf(page.text), username, nickname, password: 'ValidPass123!' });
}

test.before(async () => {
  await prisma.adminAudit.deleteMany();
  await prisma.transfer.deleteMany();
  await prisma.report.deleteMany();
  await prisma.productBlock.deleteMany();
  await prisma.userBlock.deleteMany();
  await prisma.directMessage.deleteMany();
  await prisma.directConversation.deleteMany();
  await prisma.globalMessage.deleteMany();
  await prisma.productImage.deleteMany();
  await prisma.product.deleteMany();
  await prisma.user.deleteMany();
});

test.after(async () => prisma.$disconnect());

test('password, allow-list and amount validators reject unsafe values', () => {
  assert.equal(validPassword('short1!'), false);
  assert.equal(validPassword('longpassword!'), false);
  assert.equal(validPassword('ValidPass123!'), true);
  assert.equal(validCategory('디지털'), true);
  assert.equal(validCategory('DROP TABLE'), false);
  assert.deepEqual(getSort('not-allowed'), { createdAt: 'desc' });
  assert.equal(positiveInt('-10', 1, 100000), null);
  assert.equal(positiveInt('1.5', 1, 100000), null);
});

test('image validation checks content signature, not only MIME', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.equal(validImageMagic(png, 'image/png'), true);
  assert.equal(validImageMagic(Buffer.from('not an image'), 'image/png'), false);
});

test('memory limiter blocks after configured threshold and expires', () => {
  const limiter = new MemoryRateLimiter({ windowMs: 1000, max: 2, blockMs: 5000 });
  assert.equal(limiter.check('ip', 0), true);
  assert.equal(limiter.check('ip', 1), true);
  assert.equal(limiter.check('ip', 2), false);
  assert.equal(limiter.check('ip', 4000), false);
  assert.equal(limiter.check('ip', 5003), true);
});

test('session cookie is HttpOnly and SameSite=Lax; POST without CSRF is denied', async () => {
  const page = await request(app).get('/login').expect(200);
  const cookie = page.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  await request(app).post('/login').type('form').send({ username: 'none', password: 'none' }).expect(403);
});

test('registration hashes password with Argon2id and duplicate username is rejected', async () => {
  const first = request.agent(app);
  await register(first, 'seller1', '<script>alert(1)</script>').then((res) => assert.equal(res.status, 302));
  const stored = await prisma.user.findUnique({ where: { username: 'seller1' } });
  assert.notEqual(stored.passwordHash, 'ValidPass123!');
  assert.match(stored.passwordHash, /^\$argon2id\$/);
  assert.equal(await argon2.verify(stored.passwordHash, 'ValidPass123!'), true);
  const duplicate = request.agent(app);
  const response = await register(duplicate, 'seller1');
  assert.equal(response.status, 302);
  const page = await duplicate.get('/register');
  assert.match(page.text, /이미 사용 중인 아이디/);
  const profile = await first.get(`/users/${stored.id}`).expect(200);
  assert.doesNotMatch(profile.text, /<script>alert\(1\)<\/script>/);
  assert.match(profile.text, /&lt;script&gt;/);
});

test('registration rejects a duplicate nickname with a generic message and does not create the account', async () => {
  const first = request.agent(app);
  await register(first, 'nickowner1', '중복테스트닉네임').then((res) => assert.equal(res.status, 302));
  const second = request.agent(app);
  const response = await register(second, 'nickowner2', '중복테스트닉네임');
  assert.equal(response.status, 302);
  const page = await second.get('/register');
  assert.match(page.text, /이미 사용 중인 닉네임입니다/);
  assert.equal(await prisma.user.count({ where: { username: 'nickowner2' } }), 0);
});

test('profile update rejects a nickname already used by another account', async () => {
  const first = request.agent(app);
  const second = request.agent(app);
  await register(first, 'nickowner3', '별도닉네임A');
  await register(second, 'nickowner4', '별도닉네임B');
  const page = await second.get('/mypage');
  await second.post('/mypage/profile').type('form').send({ _csrf: csrf(page.text), nickname: '별도닉네임A', bio: '' }).expect(302);
  const afterPage = await second.get('/mypage');
  assert.match(afterPage.text, /이미 사용 중인 닉네임입니다/);
  const stillOriginal = await prisma.user.findUnique({ where: { username: 'nickowner4' } });
  assert.equal(stillOriginal.nickname, '별도닉네임B');
});

test('concurrent registration with the same nickname lets only one request succeed', async () => {
  const a = request.agent(app);
  const b = request.agent(app);
  const [pageA, pageB] = await Promise.all([a.get('/register'), b.get('/register')]);
  await Promise.all([
    a.post('/register').type('form').send({ _csrf: csrf(pageA.text), username: 'racenick1', nickname: '경쟁닉네임', password: 'ValidPass123!' }),
    b.post('/register').type('form').send({ _csrf: csrf(pageB.text), username: 'racenick2', nickname: '경쟁닉네임', password: 'ValidPass123!' }),
  ]);
  assert.equal(await prisma.user.count({ where: { nickname: '경쟁닉네임' } }), 1);
});

test('product ACL prevents another user from editing or deleting by ID tampering', async () => {
  const seller = request.agent(app);
  const stranger = request.agent(app);
  await register(seller, 'seller2');
  await register(stranger, 'stranger1');
  const form = await seller.get('/products/new').expect(200);
  await seller.post('/products').field('_csrf', csrf(form.text)).field('name', '테스트 상품').field('price', '500').field('category', '생활').field('description', '안전한 테스트 상품 설명').expect(302);
  const product = await prisma.product.findFirst({ where: { owner: { username: 'seller2' } } });
  const strangerPage = await stranger.get('/mypage');
  await stranger.post(`/products/${product.id}/edit`).type('form').send({ _csrf: csrf(strangerPage.text), name: '탈취 수정', price: 1, category: '기타', description: '권한 없는 수정 시도' }).expect(403);
  await stranger.post(`/products/${product.id}/delete`).type('form').send({ _csrf: csrf(strangerPage.text) }).expect(403);
});

async function createProduct(agent, { name, price, category = '생활', description = '테스트 상품 설명입니다.' }) {
  const form = await agent.get('/products/new').expect(200);
  await agent.post('/products').field('_csrf', csrf(form.text)).field('name', name).field('price', String(price)).field('category', category).field('description', description).expect(302);
  return prisma.product.findFirst({ where: { name } });
}

test('product purchase debits the buyer, credits the seller, and marks the product sold atomically', async () => {
  const seller = request.agent(app);
  const buyer = request.agent(app);
  await register(seller, 'pseller1');
  await register(buyer, 'pbuyer1');
  const product = await createProduct(seller, { name: '구매상품A', price: 3000 });
  const page = await buyer.get(`/products/${product.id}`).expect(200);
  await buyer.post(`/products/${product.id}/purchase`).type('form').send({ _csrf: csrf(page.text) }).expect(302);
  const [updatedProduct, sellerUser, buyerUser, transfer] = await Promise.all([
    prisma.product.findUnique({ where: { id: product.id } }),
    prisma.user.findUnique({ where: { username: 'pseller1' } }),
    prisma.user.findUnique({ where: { username: 'pbuyer1' } }),
    prisma.transfer.findUnique({ where: { productId: product.id } }),
  ]);
  assert.equal(updatedProduct.status, 'SOLD');
  assert.ok(updatedProduct.soldAt);
  assert.equal(updatedProduct.buyerId, buyerUser.id);
  assert.equal(sellerUser.balance, 13000);
  assert.equal(buyerUser.balance, 7000);
  assert.equal(transfer.amount, 3000);
  assert.equal(transfer.senderId, buyerUser.id);
  assert.equal(transfer.receiverId, sellerUser.id);
  assert.equal(transfer.status, 'COMPLETED');
});

test('purchase rejects insufficient balance, self-purchase, a missing product, and a blocked product without changing any state', async () => {
  const seller = request.agent(app);
  const buyer = request.agent(app);
  await register(seller, 'pseller2');
  await register(buyer, 'pbuyer2');
  const product = await createProduct(seller, { name: '고가상품', price: 50000 });

  let page = await buyer.get(`/products/${product.id}`).expect(200);
  await buyer.post(`/products/${product.id}/purchase`).type('form').send({ _csrf: csrf(page.text) }).expect(302);
  let unchanged = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(unchanged.status, 'ACTIVE');

  page = await seller.get(`/products/${product.id}`).expect(200);
  await seller.post(`/products/${product.id}/purchase`).type('form').send({ _csrf: csrf(page.text) }).expect(302);
  unchanged = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(unchanged.status, 'ACTIVE');

  page = await buyer.get('/mypage').expect(200);
  await buyer.post('/products/99999999/purchase').type('form').send({ _csrf: csrf(page.text) }).expect(302);

  await prisma.product.update({ where: { id: product.id }, data: { status: 'BLOCKED' } });
  page = await buyer.get('/mypage').expect(200);
  await buyer.post(`/products/${product.id}/purchase`).type('form').send({ _csrf: csrf(page.text) }).expect(302);
  unchanged = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(unchanged.status, 'BLOCKED');
  assert.equal(await prisma.transfer.count({ where: { productId: product.id } }), 0);
});

test('two concurrent purchase requests for the same product allow exactly one to succeed', async () => {
  const seller = request.agent(app);
  const buyerA = request.agent(app);
  const buyerB = request.agent(app);
  await register(seller, 'raceseller1');
  await register(buyerA, 'racebuyerA');
  await register(buyerB, 'racebuyerB');
  const product = await createProduct(seller, { name: '동시구매상품', price: 1000 });
  const [pageA, pageB] = await Promise.all([buyerA.get(`/products/${product.id}`), buyerB.get(`/products/${product.id}`)]);
  await Promise.all([
    buyerA.post(`/products/${product.id}/purchase`).type('form').send({ _csrf: csrf(pageA.text) }),
    buyerB.post(`/products/${product.id}/purchase`).type('form').send({ _csrf: csrf(pageB.text) }),
  ]);
  assert.equal(await prisma.transfer.count({ where: { productId: product.id } }), 1);
  const finalProduct = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(finalProduct.status, 'SOLD');
});

test('resubmitting the same purchase request after success does not create a duplicate transfer', async () => {
  const seller = request.agent(app);
  const buyer = request.agent(app);
  await register(seller, 'repeatseller1');
  await register(buyer, 'repeatbuyer1');
  const product = await createProduct(seller, { name: '반복결제상품', price: 1000 });
  const page = await buyer.get(`/products/${product.id}`).expect(200);
  const token = csrf(page.text);
  await buyer.post(`/products/${product.id}/purchase`).type('form').send({ _csrf: token }).expect(302);
  await buyer.post(`/products/${product.id}/purchase`).type('form').send({ _csrf: token }).expect(302);
  assert.equal(await prisma.transfer.count({ where: { productId: product.id } }), 1);
});

test('direct chat room checks session participant on read and write', async () => {
  const users = await Promise.all(['chatuser1', 'chatuser2', 'intruder1'].map((username) => prisma.user.create({ data: { username, nickname: username, passwordHash: 'test-only' } })));
  const room = await prisma.directConversation.create({ data: { userAId: users[0].id, userBId: users[1].id } });
  const intruder = request.agent(app);
  const page = await intruder.get('/login');
  const hash = await argon2.hash('ValidPass123!', { type: argon2.argon2id });
  await prisma.user.update({ where: { id: users[2].id }, data: { passwordHash: hash } });
  await intruder.post('/login').type('form').send({ _csrf: csrf(page.text), username: 'intruder1', password: 'ValidPass123!' }).expect(302);
  await intruder.get(`/chat/${room.id}`).expect(403);
  const my = await intruder.get('/mypage');
  await intruder.post(`/chat/${room.id}/messages`).type('form').send({ _csrf: csrf(my.text), body: 'forged' }).expect(403);
  assert.equal(await prisma.directMessage.count({ where: { conversationId: room.id } }), 0);
});

test('direct chat header links to the real other participant, resolved server-side', async () => {
  const userA = request.agent(app);
  const userB = request.agent(app);
  await register(userA, 'chatprofileA');
  await register(userB, 'chatprofileB');
  const bUser = await prisma.user.findUnique({ where: { username: 'chatprofileB' } });
  const startPage = await userA.get('/mypage');
  const startRes = await userA.post(`/chat/start/${bUser.id}`).type('form').send({ _csrf: csrf(startPage.text) }).expect(302);
  const detail = await userA.get(startRes.headers.location).expect(200);
  assert.match(detail.text, new RegExp(`href="/users/${bUser.id}"`));
});

test('non-admin cannot open admin UI or invoke admin POST', async () => {
  const user = request.agent(app);
  await register(user, 'normaluser');
  await user.get('/admin').expect(403);
  const page = await user.get('/mypage');
  const target = await prisma.user.findUnique({ where: { username: 'seller1' } });
  await user.post(`/admin/users/${target.id}/suspend`).type('form').send({ _csrf: csrf(page.text), reason: 'forged' }).expect(403);
});

test('five failed passwords lock the account for ten minutes with a uniform response', async () => {
  const user = request.agent(app);
  await register(user, 'lockuser1');
  await user.post('/logout').type('form').send({ _csrf: csrf((await user.get('/mypage')).text) }).expect(302);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const page = await user.get('/login');
    await user.post('/login').type('form').send({ _csrf: csrf(page.text), username: 'lockuser1', password: 'WrongPassword1!' }).expect(302);
  }
  const locked = await prisma.user.findUnique({ where: { username: 'lockuser1' } });
  assert.ok(locked.loginLockedUntil > new Date(Date.now() + 9 * 60_000));
  const page = await user.get('/login');
  const correctButLocked = await user.post('/login').type('form').send({ _csrf: csrf(page.text), username: 'lockuser1', password: 'ValidPass123!' }).expect(302);
  assert.equal(correctButLocked.headers.location, '/login');
  const failedPage = await user.get('/login');
  assert.match(failedPage.text, /아이디 또는 비밀번호가 올바르지 않습니다/);
  await user.get('/mypage').expect(302);
});

test('disguised, oversized, and excessive image uploads are rejected', async () => {
  const seller = request.agent(app);
  await register(seller, 'imageseller');
  let form = await seller.get('/products/new');
  await seller.post('/products').field('_csrf', csrf(form.text)).field('name', '위장 파일').field('price', '100').field('category', '기타').field('description', '위장된 이미지 파일 테스트').attach('images', Buffer.from('not-a-png-file'), { filename: 'fake.png', contentType: 'image/png' }).expect(302);
  assert.equal(await prisma.product.count({ where: { name: '위장 파일' } }), 0);
  form = await seller.get('/products/new');
  await seller.post('/products').field('_csrf', csrf(form.text)).field('name', '대용량').field('price', '100').field('category', '기타').field('description', '대용량 파일 테스트 상품').attach('images', Buffer.alloc(5 * 1024 * 1024 + 1), { filename: 'large.png', contentType: 'image/png' }).expect(400);
  form = await seller.get('/products/new');
  const six = seller.post('/products').field('_csrf', csrf(form.text)).field('name', '파일 여섯개').field('price', '100').field('category', '기타').field('description', '파일 개수 제한 테스트 상품');
  for (let i = 0; i < 6; i += 1) six.attach('images', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), { filename: `${i}.png`, contentType: 'image/png' });
  await six.expect(400);
});

test('three product reports block it; duplicate report does not increase count', async () => {
  const owner = await prisma.user.create({ data: { username: 'reportedowner', nickname: '신고대상판매자', passwordHash: 'not-used' } });
  const product = await prisma.product.create({ data: { ownerId: owner.id, name: '신고 대상 상품', description: '자동 차단 임계치 테스트', price: 10, category: '기타' } });
  const reporters = [];
  for (let i = 0; i < 3; i += 1) {
    const agent = request.agent(app);
    await register(agent, `preporter${i}`);
    reporters.push(agent);
  }
  for (const agent of reporters) {
    const page = await agent.get('/mypage');
    await agent.post(`/reports/product/${product.id}`).type('form').send({ _csrf: csrf(page.text), reason: '명백한 불량 상품 신고 사유' }).expect(302);
  }
  let updated = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(updated.status, 'BLOCKED');
  const page = await reporters[0].get('/mypage');
  await reporters[0].post(`/reports/product/${product.id}`).type('form').send({ _csrf: csrf(page.text), reason: '중복 신고 시도입니다' }).expect(302);
  assert.equal(await prisma.report.count({ where: { productId: product.id } }), 3);
  updated = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(updated.status, 'BLOCKED');
});

test('ten distinct user reports create a 30-day dormancy server-side', async () => {
  const target = await prisma.user.create({ data: { username: 'reporteduser', nickname: '신고대상', passwordHash: 'not-used' } });
  for (let i = 0; i < 10; i += 1) {
    const agent = request.agent(app);
    await register(agent, `ureporter${i}`);
    const page = await agent.get('/mypage');
    await agent.post(`/reports/user/${target.id}`).type('form').send({ _csrf: csrf(page.text), reason: '악성 사용자 행위에 대한 신고' }).expect(302);
  }
  const updated = await prisma.user.findUnique({ where: { id: target.id } });
  const remaining = updated.dormantUntil.getTime() - Date.now();
  assert.ok(remaining > 29 * 24 * 60 * 60_000 && remaining <= 30 * 24 * 60 * 60_000);
});

test('global chat stores only first ten messages within ten seconds', async () => {
  const chatter = request.agent(app);
  await register(chatter, 'fastchatter');
  const page = await chatter.get('/chat/global');
  const token = csrf(page.text);
  for (let i = 0; i < 10; i += 1) await chatter.post('/chat/global').type('form').send({ _csrf: token, body: `message ${i}` }).expect(302);
  await chatter.post('/chat/global').type('form').send({ _csrf: token, body: 'blocked message' }).expect(429);
  const user = await prisma.user.findUnique({ where: { username: 'fastchatter' } });
  assert.equal(await prisma.globalMessage.count({ where: { senderId: user.id } }), 10);
});

test('search rejects the twenty-first request from one IP within a minute', async () => {
  for (let i = 0; i < 20; i += 1) await request(app).get(`/?q=safe${i}&sort=invalid`).expect(200);
  await request(app).get('/?q=too-many').expect(429);
});

test('authorized admin can render dashboard and delete a direct message with an audit record', async () => {
  const passwordHash = await argon2.hash('ValidPass123!', { type: argon2.argon2id });
  const admin = await prisma.user.create({ data: { username: 'testadmin', nickname: '테스트관리자', passwordHash, role: 'ADMIN' } });
  const participants = await prisma.user.findMany({ where: { username: { in: ['chatuser1', 'chatuser2'] } }, orderBy: { username: 'asc' } });
  const room = await prisma.directConversation.findFirst({ where: { userAId: participants[0].id, userBId: participants[1].id } });
  const message = await prisma.directMessage.create({ data: { body: '관리자 삭제 대상', senderId: participants[0].id, conversationId: room.id } });
  const agent = request.agent(app);
  let page = await agent.get('/login');
  await agent.post('/login').type('form').send({ _csrf: csrf(page.text), username: admin.username, password: 'ValidPass123!' }).expect(302);
  page = await agent.get('/admin').expect(200);
  assert.match(page.text, /1:1 채팅 관리/);
  await agent.post(`/admin/direct-messages/${message.id}/delete`).type('form').send({ _csrf: csrf(page.text) }).expect(302);
  assert.equal(await prisma.directMessage.findUnique({ where: { id: message.id } }), null);
  assert.equal(await prisma.adminAudit.count({ where: { adminId: admin.id, targetType: 'DIRECT_MESSAGE', targetId: message.id } }), 1);
});

test('a role change regenerates the existing session ID before applying new privileges', async () => {
  const agent = request.agent(app);
  const registration = await register(agent, 'rolechange1');
  const oldCookie = registration.headers['set-cookie'][0].split(';')[0];
  await prisma.user.update({ where: { username: 'rolechange1' }, data: { role: 'ADMIN' } });
  const dashboard = await agent.get('/admin').expect(200);
  const newCookie = dashboard.headers['set-cookie'][0].split(';')[0];
  assert.notEqual(newCookie, oldCookie);
});

test('socket.io direct chat requires auth, re-checks participancy per event, and ignores a spoofed senderId', async () => {
  const httpServer = http.createServer(app);
  const io = new Server(httpServer);
  io.engine.use(app.get('sessionMiddleware'));
  registerChatSockets(io);
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const base = `http://127.0.0.1:${httpServer.address().port}`;

  async function registerRaw(username, nickname = username) {
    const page = await request(httpServer).get('/register').expect(200);
    const getCookie = page.headers['set-cookie'][0].split(';')[0];
    const token = csrf(page.text);
    const res = await request(httpServer).post('/register').set('Cookie', getCookie).type('form')
      .send({ _csrf: token, username, nickname, password: 'ValidPass123!' }).expect(302);
    return (res.headers['set-cookie'] && res.headers['set-cookie'][0].split(';')[0]) || getCookie;
  }

  const sockets = [];
  try {
    const aliceCookie = await registerRaw('socketalice1');
    const bobCookie = await registerRaw('socketbob1');
    const carolCookie = await registerRaw('socketcarol1');
    const [aliceUser, bobUser] = await Promise.all([
      prisma.user.findUnique({ where: { username: 'socketalice1' } }),
      prisma.user.findUnique({ where: { username: 'socketbob1' } }),
    ]);

    const startPage = await request(httpServer).get('/mypage').set('Cookie', aliceCookie).expect(200);
    const startRes = await request(httpServer).post(`/chat/start/${bobUser.id}`).set('Cookie', aliceCookie).type('form')
      .send({ _csrf: csrf(startPage.text) }).expect(302);
    const roomId = Number(startRes.headers.location.split('/').pop());

    // An unauthenticated socket connection must be rejected.
    const anon = ioClient(base, { forceNew: true, reconnection: false });
    sockets.push(anon);
    const anonError = await withTimeout(new Promise((resolve) => anon.on('connect_error', resolve)), 5000, 'anonymous connect_error');
    assert.ok(anonError);

    function connectAs(cookie) {
      const socket = ioClient(base, { forceNew: true, reconnection: false, extraHeaders: { Cookie: cookie } });
      sockets.push(socket);
      return withTimeout(new Promise((resolve, reject) => {
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', reject);
      }), 5000, 'authenticated connect');
    }

    const [aliceSocket, bobSocket, carolSocket] = await Promise.all([
      connectAs(aliceCookie), connectAs(bobCookie), connectAs(carolCookie),
    ]);

    function emitAck(socket, event, payload) {
      return withTimeout(new Promise((resolve) => socket.emit(event, payload, resolve)), 5000, `${event} ack`);
    }

    // Carol is not a participant: join and send must both be rejected, and nothing is persisted.
    const carolJoin = await emitAck(carolSocket, 'chat:join', { conversationId: roomId });
    assert.equal(carolJoin.ok, false);
    const carolSend = await emitAck(carolSocket, 'chat:message', { conversationId: roomId, body: 'intruder message' });
    assert.equal(carolSend.ok, false);
    assert.equal(await prisma.directMessage.count({ where: { conversationId: roomId, body: 'intruder message' } }), 0);

    // Alice and Bob are legitimate participants.
    assert.equal((await emitAck(aliceSocket, 'chat:join', { conversationId: roomId })).ok, true);
    assert.equal((await emitAck(bobSocket, 'chat:join', { conversationId: roomId })).ok, true);

    const bobReceived = withTimeout(new Promise((resolve) => bobSocket.once('chat:message', resolve)), 5000, 'bob receives message');
    const xssBody = '<script>alert(1)</script>';
    const sendAck = await emitAck(aliceSocket, 'chat:message', { conversationId: roomId, body: xssBody, senderId: 999999 });
    assert.equal(sendAck.ok, true);
    const received = await bobReceived;

    assert.equal(received.sender.id, aliceUser.id);
    assert.notEqual(received.sender.id, 999999);
    assert.equal(received.body, xssBody);

    const stored = await prisma.directMessage.findFirst({ where: { conversationId: roomId, body: xssBody } });
    assert.equal(stored.senderId, aliceUser.id);
    assert.equal(await prisma.directMessage.count({ where: { conversationId: roomId } }), 1);
  } finally {
    sockets.forEach((socket) => socket.close());
    io.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('socket.io global chat delivers messages in real time, ignores a spoofed senderId, and hides them from users who blocked the sender', async () => {
  const httpServer = http.createServer(app);
  const io = new Server(httpServer);
  io.engine.use(app.get('sessionMiddleware'));
  registerChatSockets(io);
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const base = `http://127.0.0.1:${httpServer.address().port}`;

  async function registerRaw(username, nickname = username) {
    const page = await request(httpServer).get('/register').expect(200);
    const getCookie = page.headers['set-cookie'][0].split(';')[0];
    const token = csrf(page.text);
    const res = await request(httpServer).post('/register').set('Cookie', getCookie).type('form')
      .send({ _csrf: token, username, nickname, password: 'ValidPass123!' }).expect(302);
    return (res.headers['set-cookie'] && res.headers['set-cookie'][0].split(';')[0]) || getCookie;
  }

  const sockets = [];
  try {
    const aliceCookie = await registerRaw('globalalice1');
    const bobCookie = await registerRaw('globalbob1');
    const carolCookie = await registerRaw('globalcarol1');
    const [aliceUser, carolUser] = await Promise.all([
      prisma.user.findUnique({ where: { username: 'globalalice1' } }),
      prisma.user.findUnique({ where: { username: 'globalcarol1' } }),
    ]);
    // Carol has blocked Alice, so Carol must not receive Alice's live broadcasts.
    await prisma.userBlock.create({ data: { blockerId: carolUser.id, blockedId: aliceUser.id } });

    function connectAs(cookie) {
      const socket = ioClient(base, { forceNew: true, reconnection: false, extraHeaders: { Cookie: cookie } });
      sockets.push(socket);
      return withTimeout(new Promise((resolve, reject) => {
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', reject);
      }), 5000, 'authenticated connect');
    }

    function emitAck(socket, event, payload) {
      return withTimeout(new Promise((resolve) => socket.emit(event, payload, resolve)), 5000, `${event} ack`);
    }

    const [aliceSocket, bobSocket, carolSocket] = await Promise.all([
      connectAs(aliceCookie), connectAs(bobCookie), connectAs(carolCookie),
    ]);

    await Promise.all([
      emitAck(aliceSocket, 'globalChat:join', {}),
      emitAck(bobSocket, 'globalChat:join', {}),
      emitAck(carolSocket, 'globalChat:join', {}),
    ]);

    const bobReceived = withTimeout(new Promise((resolve) => bobSocket.once('globalChat:message', resolve)), 5000, 'bob receives global message');
    const carolReceivedOrTimeout = new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 1000);
      carolSocket.once('globalChat:message', (message) => { clearTimeout(timer); resolve(message); });
    });

    const body = '전체채팅 실시간 테스트 <script>alert(1)</script>';
    const sendAck = await emitAck(aliceSocket, 'globalChat:message', { body, senderId: 999999 });
    assert.equal(sendAck.ok, true);

    const received = await bobReceived;
    assert.equal(received.sender.id, aliceUser.id);
    assert.notEqual(received.sender.id, 999999);
    assert.equal(received.body, body);

    const carolResult = await carolReceivedOrTimeout;
    assert.equal(carolResult, 'timeout');

    assert.equal(await prisma.globalMessage.count({ where: { senderId: aliceUser.id, body } }), 1);
  } finally {
    sockets.forEach((socket) => socket.close());
    io.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('global chat rate limit is shared between the HTTP route and the socket path', async () => {
  const httpServer = http.createServer(app);
  const io = new Server(httpServer);
  io.engine.use(app.get('sessionMiddleware'));
  registerChatSockets(io);
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const base = `http://127.0.0.1:${httpServer.address().port}`;

  const sockets = [];
  try {
    const page0 = await request(httpServer).get('/register').expect(200);
    const cookie0 = page0.headers['set-cookie'][0].split(';')[0];
    const registerRes = await request(httpServer).post('/register').set('Cookie', cookie0).type('form')
      .send({ _csrf: csrf(page0.text), username: 'ratelimituser1', nickname: 'ratelimituser1', password: 'ValidPass123!' }).expect(302);
    const cookie = (registerRes.headers['set-cookie'] && registerRes.headers['set-cookie'][0].split(';')[0]) || cookie0;

    for (let i = 0; i < 10; i += 1) {
      const page = await request(httpServer).get('/chat/global').set('Cookie', cookie).expect(200);
      await request(httpServer).post('/chat/global').set('Cookie', cookie).type('form').send({ _csrf: csrf(page.text), body: `http message ${i}` }).expect(302);
    }

    const socket = ioClient(base, { forceNew: true, reconnection: false, extraHeaders: { Cookie: cookie } });
    sockets.push(socket);
    await withTimeout(new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    }), 5000, 'connect');

    const ack = await withTimeout(new Promise((resolve) => socket.emit('globalChat:message', { body: 'over the limit' }, resolve)), 5000, 'rate-limited ack');
    assert.equal(ack.ok, false);
    assert.equal(ack.error, 'RATE_LIMITED');

    const user = await prisma.user.findUnique({ where: { username: 'ratelimituser1' } });
    assert.equal(await prisma.globalMessage.count({ where: { senderId: user.id } }), 10);
  } finally {
    sockets.forEach((s) => s.close());
    io.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
