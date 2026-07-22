require('dotenv').config();
const argon2 = require('argon2');
const { PrismaClient } = require('@prisma/client');
const { validPassword, validUsername } = require('../src/utils/validation');

const prisma = new PrismaClient();

async function main() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!validUsername(username) || !validPassword(password)) {
    console.log('ADMIN_USERNAME/ADMIN_PASSWORD가 없거나 정책에 맞지 않아 관리자 생성을 건너뜁니다.');
    return;
  }
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  await prisma.user.upsert({
    where: { username },
    create: { username, nickname: '관리자', passwordHash, role: 'ADMIN', balance: 100000 },
    update: { passwordHash, role: 'ADMIN' },
  });
  console.log(`관리자 계정 '${username}'을 준비했습니다.`);
}

main().finally(() => prisma.$disconnect());
