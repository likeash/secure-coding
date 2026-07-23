process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const argon2 = require('argon2');
const { createApp } = require('../app');
const { prisma } = require('../src/db');
const { validPassword, validCategory, getSort, positiveInt } = require('../src/utils/validation');
const { validImageMagic } = require('../src/middleware/upload');
const { MemoryRateLimiter } = require('../src/middleware/rateLimit');
const { ensureSessionSecret } = require('../scripts/render-start');

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

test('Render startup creates and reuses a strong session secret when the configured value is missing or weak', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-session-secret-'));
  try {
    const firstEnv = { SESSION_SECRET: 'too-short' };
    assert.equal(ensureSessionSecret(directory, firstEnv), 'generated');
    assert.ok(firstEnv.SESSION_SECRET.length >= 32);
    assert.equal(fs.readFileSync(path.join(directory, '.session-secret'), 'utf8'), firstEnv.SESSION_SECRET);

    const secondEnv = {};
    assert.equal(ensureSessionSecret(directory, secondEnv), 'file');
    assert.equal(secondEnv.SESSION_SECRET, firstEnv.SESSION_SECRET);

    const configuredEnv = { SESSION_SECRET: 'configured-session-secret-at-least-32-characters' };
    assert.equal(ensureSessionSecret(directory, configuredEnv), 'environment');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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

test('transfer rejects non-positive/excess amount and commits valid transfer consistently', async () => {
  const sender = request.agent(app);
  const receiver = request.agent(app);
  await register(sender, 'sender11');
  await register(receiver, 'receiver1');
  let page = await sender.get('/mypage');
  await sender.post('/transfers').type('form').send({ _csrf: csrf(page.text), recipient: 'receiver1', amount: -10 }).expect(302);
  page = await sender.get('/mypage');
  await sender.post('/transfers').type('form').send({ _csrf: csrf(page.text), recipient: 'receiver1', amount: 10001 }).expect(302);
  assert.equal(await prisma.transfer.count({ where: { sender: { username: 'sender11' } } }), 0);
  page = await sender.get('/mypage');
  await sender.post('/transfers').type('form').send({ _csrf: csrf(page.text), recipient: 'receiver1', amount: 1200, memo: '테스트' }).expect(302);
  const [a, b, transfers] = await Promise.all([
    prisma.user.findUnique({ where: { username: 'sender11' } }),
    prisma.user.findUnique({ where: { username: 'receiver1' } }),
    prisma.transfer.count({ where: { sender: { username: 'sender11' } } }),
  ]);
  assert.equal(a.balance, 8800);
  assert.equal(b.balance, 11200);
  assert.equal(transfers, 1);
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
