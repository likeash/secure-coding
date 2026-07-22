const { createApp } = require('./app');
const { prisma } = require('./src/db');

const port = Number(process.env.PORT) || 8418;
const server = createApp().listen(port, 'localhost', () => {
  console.log(`Tiny Market: http://localhost:${port}`);
});

async function shutdown() {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
