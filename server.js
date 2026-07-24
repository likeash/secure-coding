const http = require('http');
const { Server } = require('socket.io');
const { createApp } = require('./app');
const { prisma } = require('./src/db');
const { registerChatSockets } = require('./src/realtime/chat');

const port = Number(process.env.PORT) || 8418;
const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost');
const app = createApp();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
// Share the exact same session middleware instance (secret + store) used by
// Express so a socket's handshake session matches its HTTP session cookie.
io.engine.use(app.get('sessionMiddleware'));
registerChatSockets(io);
const server = httpServer.listen(port, host, () => {
  console.log(`Tiny Market: http://${host}:${port}`);
});

async function shutdown() {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
