# Tiny Market

Node.js, Express, EJS, Prisma, SQLite로 만든 소형 중고거래 플랫폼입니다. 기본 포트는 `8418`입니다.

## 실행

```powershell
Copy-Item .env.example .env
# .env의 SESSION_SECRET(32자 이상 랜덤값), ADMIN_USERNAME, ADMIN_PASSWORD를 변경
pnpm install
pnpm prisma:generate
pnpm db:migrate
pnpm db:seed
pnpm start
```

브라우저에서 `http://localhost:8418`을 엽니다. 운영 환경에서는 HTTPS reverse proxy 뒤에서 `NODE_ENV=production`으로 실행해야 secure 세션 쿠키가 적용됩니다.

## Render 배포

GitHub 저장소에 push한 뒤 Render Dashboard에서 **New > Blueprint**를 선택하고 저장소를 연결합니다.

- 무료 테스트: 기본 `render.yaml`을 사용합니다. Render 무료 웹 서비스의 파일 시스템은 임시이므로 재배포, 재시작 또는 15분 유휴 종료 후 SQLite 데이터·세션·업로드 이미지가 사라집니다.
- 영구 저장: Blueprint Path를 `render.persistent.yaml`로 지정합니다. 유료 `starter` 웹 서비스와 1GB persistent disk를 사용하며 SQLite, 세션, 업로드를 `/var/data`에 저장합니다.

관련 Render 공식 문서: [Blueprint 설정](https://render.com/docs/blueprint-spec), [웹 서비스 포트 바인딩](https://render.com/docs/web-services), [Persistent Disk](https://render.com/docs/disks), [무료 서비스 제한](https://render.com/docs/free)

Blueprint 생성 화면에서 다음 비밀 환경변수를 입력해야 합니다.

```text
ADMIN_USERNAME=admin
ADMIN_PASSWORD=11자 이상이며 영문, 숫자, 특수문자를 포함한 비밀번호
```

`SESSION_SECRET`은 Render가 자동 생성합니다. 시작 시 `scripts/render-start.js`가 SQLite 파일과 저장 폴더를 준비하고 `prisma migrate deploy`, 관리자 seed를 실행한 다음 서버를 시작합니다. 이미 존재하는 관리자의 비밀번호는 재배포 시 덮어쓰지 않습니다.

Render가 제공하는 `PORT`를 사용하고 production에서는 `0.0.0.0`에 바인딩합니다. 상태 확인 경로는 `/health`입니다.

## 구현 범위

- 가입, 로그인/로그아웃, 공개 프로필, 소개/닉네임/비밀번호 변경
- 상품 등록(사진 최대 5개), 목록/상세, 검색, 카테고리, 정렬, 소유 상품 수정/삭제
- 전체 채팅, 참여자 전용 1:1 채팅, 사용자/상품 개인 차단
- 상품/사용자 중복 방지 신고, 3회 상품 자동 차단, 10회 사용자 30일 휴면
- 포인트 송금과 거래 내역
- 사용자/상품/신고/전체·1:1 채팅/송금/감사 로그 관리자 센터

## 주요 보안 흐름

- `src/routes/auth.js`: Argon2id 해시, 11자 및 문자/숫자/특수문자 정책, 계정당 5회 실패 후 10분 잠금, IP당 1분 10회 초과 시 10분 제한, 통일된 로그인 실패 문구, 로그인 세션 재발급.
- `app.js`: SQLite 세션 저장, 30분 rolling 만료, `httpOnly`, `sameSite=lax`, production `secure`, Helmet CSP, CSRF, 일반화된 오류 응답.
- `src/routes/products.js`: Prisma 안전 API만 사용, 정렬/카테고리 allow-list, 20개 pagination, 검색 IP rate limit, owner/admin ACL, 차단 상품 비공개 접근 통제.
- `src/middleware/upload.js`: 확장자+Content-Type allow-list, 파일당 5MB/5개 제한. `persistImages`가 magic bytes를 다시 검사하고 웹 루트 밖에 UUID 파일명으로 저장. `/images/:id`는 DB 접근 통제 후 전송.
- `src/routes/chat.js`: 세션 사용자가 대화 참여자인지 GET/POST마다 검사하고 발신자 ID를 세션에서 결정. 전체 채팅은 10초/10개와 1분/30개 제한.
- `src/routes/account.js`: 신고자는 세션에서 결정하고 DB unique constraint로 중복 차단. 자동 제재는 서버 트랜잭션 안에서 count 후 수행. 송금은 1~100000 정수 검증 후 조건부 차감·증가·내역을 한 트랜잭션에서 처리.
- `src/routes/admin.js`: `/admin` 하위 UI와 모든 POST에 `requireAdmin`; 중요 변경은 `AdminAudit`에 기록.
- `views/**/*.ejs`: 사용자 데이터는 `<%= %>`로 이스케이프. `<%- %>`는 정적 partial include에만 사용.

## 테스트

```powershell
pnpm test
```

별도 `prisma/test.db`를 초기화한 뒤 Node 내장 test runner의 17개 테스트가 비밀번호/allow-list/이미지 magic bytes/rate limit/쿠키/CSRF/Argon2id/Stored XSS/상품 ACL/송금 원자성/신고 임계치/채팅방 ACL/관리자 권한·권한 변경 세션 갱신을 검사합니다.

### 수동 점검 체크리스트

- HTTPS 프록시의 production 환경에서 `Secure` 쿠키가 실제 전송되는지 확인
- 5회 틀린 로그인 후 올바른 비밀번호도 10분 동안 같은 실패 응답인지 확인
- 같은 IP에서 로그인 11번째 및 검색 21번째 요청이 429인지 확인
- 5MB 초과, 6개, 확장자 위장, magic bytes 위조 파일이 거부되는지 확인
- 서로 다른 계정 3개/10개로 상품/사용자를 신고해 자동 제재 확인
- 전체 채팅 10초/10개 및 1분/30개 초과 메시지가 DB에 저장되지 않는지 확인
- 타인 상품 수정/삭제 URL, 타인 채팅방 GET/POST, 일반 사용자의 관리자 POST가 403인지 확인
- 송금 중 프로세스를 강제 종료하는 장애 주입은 SQLite 원자성으로 전부 rollback되는지 확인

## 운영 한계

- rate limit은 단일 프로세스 메모리 기반이므로 재시작 시 초기화되고 다중 인스턴스에서 공유되지 않습니다. 운영에서는 Redis 기반 limiter가 필요합니다.
- 이미지가 로컬 파일 시스템에 있어 수평 확장과 백업에 불리합니다. 운영에서는 악성코드 검사, 이미지 재인코딩, 격리된 object storage/CDN이 필요합니다.
- SQLite는 작은 단일 서버용입니다. 동시 쓰기가 많으면 PostgreSQL 등의 서버 DB와 더 강한 격리/재시도 정책이 필요합니다.
- 실시간 WebSocket 대신 새로고침 기반 채팅입니다. 요구된 소통/저장은 동작하지만 실시간 UX에는 Socket.IO와 분산 pub/sub가 필요합니다.
- 이메일/휴대전화 검증, 비밀번호 재설정, MFA, 감사 로그 외부 보관, 개인정보 삭제/보존 정책은 포함하지 않았습니다.
