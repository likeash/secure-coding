require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const connectSqlite3 = require('connect-sqlite3');
const helmet = require('helmet');
const multer = require('multer');
const { attachUser, requireAuth } = require('./src/middleware/auth');
const { csrfToken, csrfProtect } = require('./src/middleware/security');
const { upload } = require('./src/middleware/upload');
const { router: authRouter } = require('./src/routes/auth');
const { router: productsRouter } = require('./src/routes/products');
const { router: accountRouter } = require('./src/routes/account');
const { router: chatRouter } = require('./src/routes/chat');
const { router: adminRouter } = require('./src/routes/admin');

function createApp() {
  const app = express();
  const SQLiteStore = connectSqlite3(session);
  const production = process.env.NODE_ENV === 'production';
  if (production) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:'], styleSrc: ["'self'"], scriptSrc: ["'self'"], connectSrc: ["'self'"] } }, crossOriginResourcePolicy: { policy: 'same-origin' } }));
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: production ? '1d' : 0 }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  const sessionMiddleware = session({
    name: 'tiny.sid',
    secret: process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex'),
    store: new SQLiteStore({ db: process.env.SESSION_DB || 'sessions.sqlite', dir: path.join(__dirname, 'prisma') }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: production, maxAge: 30 * 60_000 },
  });
  app.use(sessionMiddleware);
  // Exposed so server.js can wire the exact same session instance (secret + store)
  // into Socket.IO's handshake pipeline via io.engine.use(...).
  app.set('sessionMiddleware', sessionMiddleware);
  app.use(attachUser);
  app.use(csrfToken);
  app.post('/products', requireAuth, upload.array('images', 5));
  app.use(csrfProtect);
  app.use(authRouter, productsRouter, accountRouter, chatRouter, adminRouter);
  app.use((req, res) => res.status(404).render('error', { title: '페이지 없음', message: '요청한 페이지를 찾을 수 없습니다.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? '이미지는 파일당 5MB 이하여야 합니다.' : '이미지는 최대 5개까지 업로드할 수 있습니다.';
      return res.status(400).render('error', { title: '업로드 실패', message });
    }
    if (error.status === 400) return res.status(400).render('error', { title: '잘못된 요청', message: '요청 내용을 확인해 주세요.' });
    if (process.env.NODE_ENV !== 'test') console.error(`[${new Date().toISOString()}] request failed`, error.name, error.code || '');
    res.status(500).render('error', { title: '오류', message: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
  });
  return app;
}

module.exports = { createApp };
