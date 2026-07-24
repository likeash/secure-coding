# Tiny Market

Node.js, Express, EJS, Prisma, SQLite로 만든 소형 중고거래 플랫폼입니다. 로컬 기본 포트는 `8418`입니다.

## 주요 기능

- 회원가입, 로그인/로그아웃, 공개 프로필, 마이페이지, 닉네임·소개·비밀번호 변경
- 상품 등록과 이미지 업로드, 목록·상세·검색·카테고리·정렬, 소유 상품 관리
- Socket.IO 기반 전체 채팅과 참여자 전용 1:1 실시간 채팅
- 사용자·상품 차단 및 중복 방지 신고
- 상품 신고 3회 시 자동 차단, 사용자 신고 10회 시 30일 휴면
- 가상 포인트 송금, 상품 구매, 거래 내역
- 사용자·상품·신고·채팅·송금·감사 로그를 관리하는 관리자 센터

## 기술 스택

- Node.js 20 이상
- Express 5, EJS
- Prisma 6, SQLite
- express-session, connect-sqlite3
- Socket.IO
- Argon2id, Helmet, Multer
- pnpm

## 로컬 실행

### 1. 환경변수 준비

```powershell
Copy-Item .env.example .env
```

`.env`에서 다음 값을 변경합니다.

- `SESSION_SECRET`: 32자 이상의 예측하기 어려운 임의 문자열
- `ADMIN_USERNAME`: 관리자 아이디
- `ADMIN_PASSWORD`: 11자 이상이며 영문·숫자·특수문자를 포함한 관리자 비밀번호

실제 `.env` 파일과 운영 비밀값은 Git에 커밋하지 마세요.

### 2. 설치 및 데이터베이스 준비

```powershell
pnpm install
pnpm prisma:generate
pnpm db:deploy
pnpm db:seed
```

### 3. 서버 실행

```powershell
pnpm start
```

브라우저에서 `http://localhost:8418`을 엽니다.

## 주요 보안 통제

- `src/routes/auth.js`: Argon2id 해시, 비밀번호 복잡도 정책, 계정·IP 로그인 제한, 통일된 실패 문구, 로그인 시 세션 재발급
- `app.js`: SQLite 세션 저장, 30분 rolling 만료, `httpOnly`, `sameSite=lax`, production `secure`, Helmet CSP, CSRF, 일반화된 오류 응답
- `src/routes/products.js`: Prisma 안전 API, 정렬·카테고리 allow-list, 페이지당 20개 제한, 검색 rate limit, 소유자·관리자 ACL
- `src/middleware/upload.js`: 확장자와 MIME allow-list, 파일당 5MB·최대 5개, 디스크 임시 저장, magic byte 검사, UUID 파일명, 실패 시 임시 파일 정리
- `src/routes/chat.js`, `src/realtime/chat.js`: 세션 기반 발신자 결정, 대화 참여 권한 재검사, 전체 채팅 메시지 제한
- `src/routes/account.js`: DB unique constraint 기반 중복 신고 방지, 서버 트랜잭션 기반 자동 제재·송금·구매
- `src/routes/admin.js`: `/admin` 전체에 `requireAdmin` 적용, 비관리자에게 일반 404 반환, 중요 변경 감사 로그 기록
- `views/**/*.ejs`: 사용자 데이터는 `<%= %>`로 문맥에 맞게 이스케이프

## 테스트

```powershell
pnpm test
```

테스트용 SQLite 데이터베이스를 초기화한 뒤 Node 내장 test runner로 인증, 세션, CSRF, XSS, 이미지 검증·정리, 상품 ACL, 구매·송금 원자성, 신고와 자동 제재, 관리자 권한, 실시간 채팅 권한 및 rate limit을 검증합니다.

현재 전체 자동 테스트는 29개입니다.

## 운영 시 주의사항

- SQLite는 단일 인스턴스와 적은 동시 쓰기에 적합합니다. 다중 인스턴스 또는 높은 동시성 환경에는 적합하지 않습니다.
- 업로드 이미지는 웹 루트 밖 로컬 디스크에 저장되지만, 운영에서는 악성코드 검사, 이미지 재인코딩과 별도 저장소가 추가로 필요합니다.
- 이메일·휴대전화 검증, 비밀번호 재설정, MFA, 외부 감사 로그 보관과 개인정보 보존·삭제 정책은 포함하지 않았습니다.
