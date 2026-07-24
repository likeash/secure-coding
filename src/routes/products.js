const express = require('express');
const crypto = require('crypto');
const { constants: fsConstants } = require('fs');
const fs = require('fs/promises');
const path = require('path');
const { prisma } = require('../db');
const { requireAuth, setFlash } = require('../middleware/auth');
const { validImageFile, cleanupTemporaryFiles } = require('../middleware/upload');
const { CATEGORIES, SORTS, cleanText, validCategory, getSort, positiveInt } = require('../utils/validation');
const { MemoryRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const imageRoot = path.resolve(__dirname, '../../storage/product-images');
const searchLimiter = new MemoryRateLimiter({ windowMs: 60_000, max: 20 });

async function hiddenOwnerIds(userId) {
  if (!userId) return [];
  const blocks = await prisma.userBlock.findMany({ where: { blockerId: userId }, select: { blockedId: true } });
  return blocks.map((row) => row.blockedId);
}

async function persistImages(files, productId) {
  const written = [];
  try {
    for (const file of files || []) {
      if (!await validImageFile(file.path, file.mimetype)) throw Object.assign(new Error('INVALID_IMAGE'), { status: 400 });
      const ext = path.extname(file.originalname).toLowerCase();
      const storageName = `${crypto.randomUUID()}${ext}`;
      await fs.copyFile(file.path, path.join(imageRoot, storageName), fsConstants.COPYFILE_EXCL);
      written.push(storageName);
      await fs.unlink(file.path);
      await prisma.productImage.create({ data: { storageName, originalName: cleanText(file.originalname, 120), mimeType: file.mimetype, size: file.size, productId } });
    }
  } catch (error) {
    await Promise.all(written.map((name) => fs.unlink(path.join(imageRoot, name)).catch(() => {})));
    throw error;
  } finally {
    await cleanupTemporaryFiles(files);
  }
}

router.get('/', searchLimiter.middleware(), async (req, res, next) => {
  try {
    const q = cleanText(req.query.q, 60);
    const category = validCategory(req.query.category) ? req.query.category : '';
    const sort = Object.hasOwn(SORTS, req.query.sort) ? req.query.sort : 'newest';
    const page = positiveInt(req.query.page, 1, 100000) || 1;
    const blockedProducts = req.user ? await prisma.productBlock.findMany({ where: { userId: req.user.id }, select: { productId: true } }) : [];
    const where = {
      status: 'ACTIVE',
      ...(q ? { OR: [{ name: { contains: q } }, { description: { contains: q } }] } : {}),
      ...(category ? { category } : {}),
      ownerId: { notIn: await hiddenOwnerIds(req.user?.id) },
      id: { notIn: blockedProducts.map((row) => row.productId) },
    };
    const [products, count] = await Promise.all([
      prisma.product.findMany({ where, include: { owner: { select: { nickname: true } }, images: { take: 1 } }, orderBy: getSort(sort), skip: (page - 1) * 20, take: 20 }),
      prisma.product.count({ where }),
    ]);
    res.render('products/index', { title: '둘러보기', products, categories: CATEGORIES, filters: { q, category, sort, page }, pages: Math.max(1, Math.ceil(count / 20)) });
  } catch (error) { next(error); }
});

router.get('/products/new', requireAuth, (req, res) => res.render('products/form', { title: '상품 등록', product: null, categories: CATEGORIES, action: '/products' }));

router.post('/products', requireAuth, async (req, res, next) => {
  let product;
  try {
    const name = cleanText(req.body.name, 80);
    const description = cleanText(req.body.description, 3000);
    const price = positiveInt(req.body.price, 0, 100_000_000);
    const category = req.body.category;
    if (name.length < 2 || description.length < 5 || price === null || !validCategory(category)) {
      setFlash(req, 'error', '상품명, 설명, 가격, 카테고리를 올바르게 입력해 주세요.');
      return res.redirect('/products/new');
    }
    product = await prisma.product.create({ data: { name, description, price, category, ownerId: req.user.id } });
    await persistImages(req.files, product.id);
    setFlash(req, 'success', '상품이 등록되었습니다.');
    res.redirect(`/products/${product.id}`);
  } catch (error) {
    if (product) await prisma.product.delete({ where: { id: product.id } }).catch(() => {});
    if (error.status === 400) {
      setFlash(req, 'error', '파일 내용이 올바른 이미지 형식이 아닙니다.');
      return res.redirect('/products/new');
    }
    next(error);
  }
});

router.get('/products/mine', requireAuth, async (req, res, next) => {
  try {
    const products = await prisma.product.findMany({ where: { ownerId: req.user.id, status: { not: 'DELETED' } }, include: { images: { take: 1 }, _count: { select: { reports: true } } }, orderBy: { createdAt: 'desc' } });
    res.render('products/mine', { title: '내 상품 관리', products });
  } catch (error) { next(error); }
});

const HIDDEN_STATUSES = ['BLOCKED', 'DELETED'];

router.get('/products/:id', async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    const product = id && await prisma.product.findUnique({ where: { id }, include: { owner: { select: { id: true, nickname: true, bio: true, dormantUntil: true } }, buyer: { select: { id: true, nickname: true } }, images: true, _count: { select: { reports: true } } } });
    const privileged = product && req.user && (req.user.id === product.ownerId || req.user.role === 'ADMIN');
    if (!product || (HIDDEN_STATUSES.includes(product.status) && !privileged)) return res.status(404).render('error', { title: '상품 없음', message: '상품을 찾을 수 없습니다.' });
    if (req.user) {
      const blocked = await prisma.productBlock.findUnique({ where: { userId_productId: { userId: req.user.id, productId: product.id } } });
      if (blocked && !privileged) return res.status(404).render('error', { title: '상품 없음', message: '상품을 찾을 수 없습니다.' });
    }
    res.render('products/detail', { title: product.name, product, canManage: Boolean(privileged) });
  } catch (error) { next(error); }
});

router.post('/products/:id/purchase', requireAuth, async (req, res, next) => {
  const id = positiveInt(req.params.id, 1, Number.MAX_SAFE_INTEGER) || -1;
  try {
    await prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id } });
      if (!product || product.status !== 'ACTIVE') throw Object.assign(new Error('NOT_AVAILABLE'), { publicCode: 'NOT_AVAILABLE' });
      if (product.ownerId === req.user.id) throw Object.assign(new Error('SELF_PURCHASE'), { publicCode: 'SELF_PURCHASE' });
      const buyer = await tx.user.findUnique({ where: { id: req.user.id } });
      if (!buyer || buyer.balance < product.price) throw Object.assign(new Error('INSUFFICIENT'), { publicCode: 'INSUFFICIENT' });
      const claim = await tx.product.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'SOLD', buyerId: req.user.id, soldAt: new Date() } });
      if (claim.count !== 1) throw Object.assign(new Error('NOT_AVAILABLE'), { publicCode: 'NOT_AVAILABLE' });
      const debit = await tx.user.updateMany({ where: { id: req.user.id, balance: { gte: product.price } }, data: { balance: { decrement: product.price } } });
      if (debit.count !== 1) throw Object.assign(new Error('INSUFFICIENT'), { publicCode: 'INSUFFICIENT' });
      await tx.user.update({ where: { id: product.ownerId }, data: { balance: { increment: product.price } } });
      await tx.transfer.create({ data: { senderId: req.user.id, receiverId: product.ownerId, amount: product.price, productId: product.id, memo: cleanText(`상품 구매: ${product.name}`, 100), status: 'COMPLETED' } });
    });
    setFlash(req, 'success', '구매가 완료되었습니다.');
    res.redirect(`/products/${id}`);
  } catch (error) {
    if (error.publicCode) {
      const message = { NOT_AVAILABLE: '이미 판매되었거나 구매할 수 없는 상품입니다.', SELF_PURCHASE: '본인 상품은 구매할 수 없습니다.', INSUFFICIENT: '잔액이 부족합니다.' }[error.publicCode] || '구매를 처리할 수 없습니다.';
      setFlash(req, 'error', message);
      return res.redirect(`/products/${id}`);
    }
    if (error.code === 'P2002') {
      setFlash(req, 'error', '이미 판매된 상품입니다.');
      return res.redirect(`/products/${id}`);
    }
    next(error);
  }
});

router.get('/products/:id/edit', requireAuth, async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: positiveInt(req.params.id, 1, Number.MAX_SAFE_INTEGER) || -1 } });
    if (!product || (product.ownerId !== req.user.id && req.user.role !== 'ADMIN')) return res.status(403).render('error', { title: '접근 거부', message: '이 상품을 수정할 권한이 없습니다.' });
    res.render('products/form', { title: '상품 수정', product, categories: CATEGORIES, action: `/products/${product.id}/edit` });
  } catch (error) { next(error); }
});

router.post('/products/:id/edit', requireAuth, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id, 1, Number.MAX_SAFE_INTEGER) || -1;
    const product = await prisma.product.findUnique({ where: { id } });
    if (!product || (product.ownerId !== req.user.id && req.user.role !== 'ADMIN')) return res.status(403).render('error', { title: '접근 거부', message: '이 상품을 수정할 권한이 없습니다.' });
    const name = cleanText(req.body.name, 80);
    const description = cleanText(req.body.description, 3000);
    const price = positiveInt(req.body.price, 0, 100_000_000);
    if (name.length < 2 || description.length < 5 || price === null || !validCategory(req.body.category)) {
      setFlash(req, 'error', '입력값을 확인해 주세요.');
      return res.redirect(`/products/${id}/edit`);
    }
    await prisma.product.update({ where: { id }, data: { name, description, price, category: req.body.category } });
    setFlash(req, 'success', '상품이 수정되었습니다.');
    res.redirect(`/products/${id}`);
  } catch (error) { next(error); }
});

router.post('/products/:id/delete', requireAuth, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id, 1, Number.MAX_SAFE_INTEGER) || -1;
    const product = await prisma.product.findUnique({ where: { id } });
    if (!product || (product.ownerId !== req.user.id && req.user.role !== 'ADMIN')) return res.status(403).render('error', { title: '접근 거부', message: '이 상품을 삭제할 권한이 없습니다.' });
    await prisma.product.update({ where: { id }, data: { status: 'DELETED' } });
    setFlash(req, 'success', '상품이 삭제 처리되었습니다.');
    res.redirect('/products/mine');
  } catch (error) { next(error); }
});

router.get('/images/:id', async (req, res, next) => {
  try {
    const image = await prisma.productImage.findUnique({ where: { id: positiveInt(req.params.id, 1, Number.MAX_SAFE_INTEGER) || -1 }, include: { product: true } });
    const privileged = image && req.user && (req.user.id === image.product.ownerId || req.user.role === 'ADMIN');
    if (!image || (HIDDEN_STATUSES.includes(image.product.status) && !privileged)) return res.sendStatus(404);
    res.type(image.mimeType).set('X-Content-Type-Options', 'nosniff').sendFile(path.join(imageRoot, image.storageName));
  } catch (error) { next(error); }
});

module.exports = { router, searchLimiter, persistImages };
