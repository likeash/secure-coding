const fs = require('fs');
const path = require('path');

const prismaDir = path.resolve(__dirname, '../prisma');
for (const name of ['test.db', 'test.db-journal', 'test-sessions.sqlite', 'test-sessions.sqlite-shm', 'test-sessions.sqlite-wal']) {
  const target = path.join(prismaDir, name);
  if (!target.startsWith(`${prismaDir}${path.sep}`)) throw new Error('Unsafe test database path');
  fs.rmSync(target, { force: true });
}
fs.writeFileSync(path.join(prismaDir, 'test.db'), '');
