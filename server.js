const { createApp } = require('./app');
const { prisma } = require('./src/db');

const port = Number(process.env.PORT) || 8418;
const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost');
const server = createApp().listen(port, host, () => {
  console.log(`Tiny Market listening on http://${host}:${port}`);
});

async function shutdown() {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
