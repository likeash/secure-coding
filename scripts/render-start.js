const fs = require('fs');
const crypto = require('crypto');
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

function ensureSessionSecret(sessionDirectory, env = process.env) {
  if (env.SESSION_SECRET && env.SESSION_SECRET.length >= 32) return 'environment';

  const directory = path.resolve(sessionDirectory);
  const secretPath = path.join(directory, '.session-secret');
  ensureDirectory(directory);

  if (fs.existsSync(secretPath)) {
    const storedSecret = fs.readFileSync(secretPath, 'utf8').trim();
    if (storedSecret.length >= 32) {
      env.SESSION_SECRET = storedSecret;
      return 'file';
    }
  }

  const generatedSecret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretPath, generatedSecret, { encoding: 'utf8', mode: 0o600 });
  env.SESSION_SECRET = generatedSecret;
  return 'generated';
}

function runNode(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function main() {
  const sessionDirectory = process.env.SESSION_DIR || path.resolve(__dirname, '../prisma');
  ensureSqliteFile(process.env.DATABASE_URL);
  ensureDirectory(sessionDirectory);
  ensureDirectory(process.env.UPLOAD_DIR || path.resolve(__dirname, '../storage/product-images'));
  const secretSource = ensureSessionSecret(sessionDirectory);
  if (secretSource !== 'environment') {
    console.warn(`SESSION_SECRET was loaded from secure local storage (${secretSource}); configure a 32+ character Render secret for portable sessions.`);
  }

  const prismaRoot = path.dirname(require.resolve('prisma/package.json'));
  runNode(path.join(prismaRoot, 'build/index.js'), ['migrate', 'deploy']);
  runNode(path.resolve(__dirname, '../prisma/seed.js'));
  require('../server');
}

if (require.main === module) main();

module.exports = { ensureSessionSecret, main };
