const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function ensureDirectory(target) {
  fs.mkdirSync(path.resolve(target), { recursive: true });
}

function ensureSqliteFile(databaseUrl) {
  if (!databaseUrl?.startsWith('file:')) throw new Error('Render startup requires a SQLite DATABASE_URL beginning with file:.');
  const configuredPath = databaseUrl.slice('file:'.length);
  const databasePath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(__dirname, '../prisma', configuredPath);
  ensureDirectory(path.dirname(databasePath));
  if (!fs.existsSync(databasePath)) fs.writeFileSync(databasePath, '', { flag: 'wx' });
}

function runNode(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

ensureSqliteFile(process.env.DATABASE_URL);
ensureDirectory(process.env.SESSION_DIR || path.resolve(__dirname, '../prisma'));
ensureDirectory(process.env.UPLOAD_DIR || path.resolve(__dirname, '../storage/product-images'));

const prismaRoot = path.dirname(require.resolve('prisma/package.json'));
runNode(path.join(prismaRoot, 'build/index.js'), ['migrate', 'deploy']);
runNode(path.resolve(__dirname, '../prisma/seed.js'));
require('../server');
