# 보안 검토 보고서 — Tiny Second-hand Shopping Platform

- 대상: 저장소 전체 코드 (README/기존 보고서의 서술이 아닌 실제 소스 기준)
- 방법: `app.js`/`server.js`, `src/middleware/*`, `src/routes/*`, `src/utils/validation.js`, `prisma/schema.prisma`, `views/**/*.ejs`, `tests/security.test.js` 등 전체 파일을 직접 읽고 라우트별 데이터 흐름(요청 → 검증 → Prisma 호출 → 렌더링)을 추적.
- 원칙: 코드에서 직접 확인된 사실만 기술. 확인하지 못한 항목은 "검증 불가"로 표시. 이번 단계에서는 코드를 수정하지 않음.

---

## 1. 요약

전체적으로 요구사항에 명시된 보안 통제(ORM 파라미터화 쿼리, Argon2id 해시, 계정/IP 이중 잠금, 세션 회전, CSRF, 파일 매직바이트 검증, 정렬/카테고리 allow-list, 검색·채팅 rate limit, 신고 중복 방지 및 임계치, 송금 원자적 트랜잭션, 관리자 ACL, EJS 이스케이프)이 실제 코드에 구현되어 있고, 확인 결과 요구사항과 대체로 일치합니다. `tests/security.test.js`에 각 항목에 대응하는 자동화 테스트가 존재하나, 본 검토는 테스트 결과를 신뢰하지 않고 라우트 코드를 직접 추적하여 별도로 검증했습니다.

**즉시 악용 가능한(Critical/High) 취약점은 발견하지 못했습니다.** 아래 "발견 사항"은 모두 방어심층(defense-in-depth) 수준의 개선 권고이며, 별도 표시가 없는 한 확인된 우회 경로(working exploit)는 아닙니다.

---

## 2. 요구사항별 점검 결과

### 공통
| 항목 | 상태 | 근거 |
|---|---|---|
| 세션 쿠키 httpOnly/sameSite=lax | ✅ 확인 | [app.js:36](app.js#L36) `cookie: { httpOnly: true, sameSite: 'lax', secure: production, maxAge: 30*60_000 }` |
| production HTTPS에서 secure=true | ✅ 확인 | 위와 동일. `production = NODE_ENV==='production'`로 분기 |
| 오류 응답에 스택 트레이스/내부 경로 미노출 | ✅ 확인 | [app.js:44-53](app.js#L44-L53) 에러 핸들러가 고정된 한국어 메시지만 렌더링, `console.error`는 `NODE_ENV!=='test'`일 때 서버 로그에만 기록 (응답에 포함 안 됨) |
| 하드코딩된 민감정보 없음 | ✅ 확인 | 세션 시크릿은 `process.env.SESSION_SECRET \|\| crypto.randomBytes(48)` ([app.js:31](app.js#L31)); 관리자 계정은 `.env`의 `ADMIN_USERNAME/ADMIN_PASSWORD`로 시드([prisma/seed.js](prisma/seed.js)) — 소스에 실제 비밀값 없음 |

### 로그인/회원가입
| 항목 | 상태 | 근거 |
|---|---|---|
| SQL Injection | ✅ 확인 | 전체 코드에서 `$queryRaw`/`$executeRaw` 미사용(grep 결과 0건), 모든 DB 접근은 Prisma의 `findUnique/create/update/...` 안전 API 사용 |
| 계정당 5회 실패 후 10분 잠금 | ✅ 확인 | [src/routes/auth.js:55-66](src/routes/auth.js#L55-L66) — 5회째 실패 시 `loginLockedUntil = now+10분`, `failedLoginAttempts` 리셋 |
| IP당 1분 10회 초과 시 10분 제한 | ✅ 확인 | [src/routes/auth.js:9](src/routes/auth.js#L9) `MemoryRateLimiter({windowMs:60_000,max:10,blockMs:10*60_000})`, `/login`에 적용([auth.js:43](src/routes/auth.js#L43)) |
| 비밀번호 정책(11자+, 영문/숫자/특수문자) | ✅ 확인 | [src/utils/validation.js:13-20](src/utils/validation.js#L13-L20) |
| 계정 존재 여부 미노출(로그인 실패 통일) | ✅ 확인 | [auth.js:44-53](src/routes/auth.js#L44-L53) — 미존재 사용자도 동일한 `dummyHashPromise`로 argon2 검증을 수행해 타이밍/응답 모두 통일 |
| 세션 고정 방지(로그인/권한변경 시 세션 재발급) | ✅ 확인 | 로그인 성공 시 `req.session.regenerate` ([auth.js:72](src/routes/auth.js#L72)), 가입 시([auth.js:25](src/routes/auth.js#L25)), 비밀번호 변경 시([account.js:50](src/routes/account.js#L50)), 그리고 `attachUser` 미들웨어가 세션의 `roleSnapshot`과 DB의 실제 role을 비교해 불일치 시 자동으로 재발급 ([src/middleware/auth.js:9-19](src/middleware/auth.js#L9-L19)) |
| 30분 무활동 세션 만료 | ✅ 확인 | `cookie.maxAge = 30*60_000` + `rolling: true` ([app.js:35-36](app.js#L35-L36)) → 슬라이딩 만료 |

### 마이페이지
| 항목 | 상태 | 근거 |
|---|---|---|
| 비밀번호 Argon2id 해시, 평문 미저장/미로그 | ✅ 확인 | `argon2.hash(..., {type: argon2.argon2id, memoryCost:19456, timeCost:2, parallelism:1})` (가입: [auth.js:23](src/routes/auth.js#L23), 변경: [account.js:47](src/routes/account.js#L47)); `console.log`/`console.error` grep 결과 비밀번호 필드 로깅 없음 |
| 관리자 페이지 UI + POST API 모두 권한 검사 | ✅ 확인 | [src/routes/admin.js:7](src/routes/admin.js#L7) `router.use('/admin', requireAdmin)`가 `/admin` 하위 GET 대시보드와 모든 POST(`suspend`,`activate`,`products/:id/status`,`reports/:id/delete`,`messages/:id/delete`,`direct-messages/:id/delete`)에 공통 적용됨을 확인 |

### 상품 관리
| 항목 | 상태 | 근거 |
|---|---|---|
| 상품 ID 변조로 타인 상품 수정/삭제 방지 | ✅ 확인 | `/products/:id/edit`, `/products/:id/edit`(POST), `/products/:id/delete` 모두 `product.ownerId !== req.user.id && req.user.role !== 'ADMIN'` 검사 후 403 ([src/routes/products.js:108-143](src/routes/products.js#L108-L143)) |
| 숨겨진(비활성) 상품 접근 통제 | ✅ 확인 | `/products/:id` 및 `/images/:id`에서 `status !== 'ACTIVE'`이면 owner/admin만 조회 가능, 그 외 404 처리([products.js:94-106](src/routes/products.js#L94-L106), [products.js:145-152](src/routes/products.js#L145-L152)) |

### 상품 출력 / 검색 / 채팅 XSS
| 항목 | 상태 | 근거 |
|---|---|---|
| Stored XSS 방지 (EJS `<%= %>` 사용) | ✅ 확인 | 전체 `views/**/*.ejs` grep 결과 `<%- %>`는 정적 `include(...)` 호출에만 사용되고 있고, 사용자 입력(상품명/설명/닉네임/bio/채팅 메시지/신고 사유/검색어 등)은 모두 `<%= %>`로 출력됨을 개별 파일에서 확인 (`products/detail.ejs`, `chat/global.ejs`, `chat/detail.ejs`, `admin/dashboard.ejs`, `products/index.ejs`, `profile.ejs`, `mypage.ejs` 등) |
| 클라이언트에서 innerHTML 대신 textContent | ✅ 확인 (해당 없음) | `public/` 아래 클라이언트 JS 파일이 존재하지 않고, 모든 렌더링이 서버 사이드 EJS로만 이루어짐 → `innerHTML` 사용 자체가 없음(grep 0건) |

### 이미지 업로드
| 항목 | 상태 | 근거 |
|---|---|---|
| 이미지 화이트리스트(확장자+Content-Type 동시 검증) | ✅ 확인 | [src/middleware/upload.js:4-15](src/middleware/upload.js#L4-L15) — `ALLOWED` 맵으로 확장자↔MIME 쌍을 강제 |
| 실제 파일 내용(매직바이트) 재검증 | ✅ 확인 | [upload.js:18-25](src/middleware/upload.js#L18-L25) `validImageMagic`을 `persistImages`에서 디스크 기록 전에 호출 ([products.js:25](src/routes/products.js#L25)) — 확장자/Content-Type을 위장해도 실제 바이트가 다르면 거부 |
| 파일당 5MB, 최대 5개 제한 | ✅ 확인 | [upload.js:10](src/middleware/upload.js#L10) `limits:{fileSize:5*1024*1024, files:5}`, 초과 시 Multer 에러를 app.js 에러 핸들러가 400으로 변환 ([app.js:46-49](app.js#L46-L49)) |
| 웹 루트 밖 저장 + 무작위 파일명 | ✅ 확인 | 저장 경로 `storage/product-images`는 `public/` 밖([products.js:12](src/routes/products.js#L12)), `express.static`은 `public/`만 서빙([app.js:27](app.js#L27)) → 직접 URL 실행 불가. 파일명은 `crypto.randomUUID()+ext` ([products.js:27](src/routes/products.js#L27)). 이미지 응답은 DB의 `productImage.id`로 조회 후 `sendFile`하며 `X-Content-Type-Options: nosniff` 설정 ([products.js:145-151](src/routes/products.js#L145-L151)) |

### 검색
| 항목 | 상태 | 근거 |
|---|---|---|
| XSS | ✅ 확인 | `products/index.ejs`에서 검색어(`filters.q`)는 `<%= %>`로 속성/본문에 출력, 페이지네이션 링크는 `encodeURIComponent` 사용 |
| 정렬/카테고리 allow-list | ✅ 확인 | `getSort`/`validCategory`가 고정된 `SORTS`/`CATEGORIES` 객체·배열만 허용 ([src/utils/validation.js:1-32](src/utils/validation.js#L1-L32)); 라우트에서 `Object.hasOwn(SORTS,...)`, `validCategory(...)`로 화이트리스트 외 값은 기본값(`newest`)/빈 값으로 대체 ([products.js:41-42](src/routes/products.js#L41-L42)) |
| IP당 1분 20회 제한, 페이지당 20개 제한 | ✅ 확인 | `searchLimiter = new MemoryRateLimiter({windowMs:60_000,max:20})` ([products.js:13](src/routes/products.js#L13)), `take:20` ([products.js:53](src/routes/products.js#L53)) |

### 1:1 채팅
| 항목 | 상태 | 근거 |
|---|---|---|
| 타인 채팅방 접근 차단 | ✅ 확인 | `ownConversation()`이 `WHERE id AND (userAId=session.userId OR userBId=session.userId)`로 조회, 실패 시 403 ([src/routes/chat.js:54-66](src/routes/chat.js#L54-L66)) |
| 발신자 위조 방지 | ✅ 확인 | 메시지 생성 시 `senderId: req.user.id`(세션 값)만 사용, 클라이언트 입력 미반영 ([chat.js:78](src/routes/chat.js#L78)) |
| Stored XSS | ✅ 확인 | `chat/detail.ejs`에서 `message.body`, `message.sender.nickname` 모두 `<%= %>` |

### 전체 채팅
| 항목 | 상태 | 근거 |
|---|---|---|
| Stored XSS | ✅ 확인 | `chat/global.ejs`에서 `<%= message.body %>` |
| 도배 방지(10초/10개, 1분/30개, 초과분 미저장) | ✅ 확인 | `global10s`(10s/10), `global60s`(60s/30) 둘 다 통과해야 `prisma.globalMessage.create` 호출, 실패 시 429만 반환하고 DB 기록 없음 ([chat.js:8-9, 23-25, 31](src/routes/chat.js#L8-L31)) |

### 신고
| 항목 | 상태 | 근거 |
|---|---|---|
| 중복 신고 방지(사용자×대상 1회) | ✅ 확인 | `prisma/schema.prisma`의 `@@unique([reporterId, productId])`, `@@unique([reporterId, targetUserId])` ([schema.prisma:136-137](prisma/schema.prisma#L136-L137)) + 라우트에서 `P2002` 캐치 후 통일 메시지 ([account.js:129-134, 149-153](src/routes/account.js#L129-L153)) |
| 3회 이상 신고 시 상품 자동 차단 | ✅ 확인 | 트랜잭션 내 `report.count(...) >= 3` 시 `product.status='BLOCKED'` ([account.js:119-125](src/routes/account.js#L119-L125)) |
| 10회 이상 신고 시 사용자 30일 휴면 | ✅ 확인 | `report.count(...) >= 10` 시 `dormantUntil = now+30일` ([account.js:141-147](src/routes/account.js#L141-L147)); ADMIN 계정은 신고 대상에서 원천 배제([account.js:143](src/routes/account.js#L143)) |
| 클라이언트가 계정 상태/신고 횟수 직접 변경 불가 | ✅ 확인 | `dormantUntil`, 신고 카운트는 오직 서버측 트랜잭션에서만 기록. 수동 정지(`/admin/users/:id/suspend`)는 `requireAdmin` 통과 후에만 가능하고 `AdminAudit`에 `adminId: req.user.id`(세션 값)로 기록됨 ([admin.js:29-42](src/routes/admin.js#L29-L42)) |

### 송금
| 항목 | 상태 | 근거 |
|---|---|---|
| 1~100000 정수 제한, 잔액 초과 거부 | ✅ 확인 | `positiveInt(req.body.amount, 1, 100000)` ([account.js:63](src/routes/account.js#L63)); 잔액 조건부 차감은 `updateMany({where:{id, balance:{gte:amount}}})`로 원자적 가드, `count!==1`이면 `INSUFFICIENT` ([account.js:72-73](src/routes/account.js#L72-L73)) |
| 송금자 위조 방지 | ✅ 확인 | 트랜잭션 전체에서 송금자는 `req.user.id`(세션)만 사용, 수신자는 `recipient` 아이디로 조회한 후 자기 자신/휴면 계정 여부만 검증 ([account.js:69-75](src/routes/account.js#L69-L75)) |
| 차감/증가/내역 저장 단일 트랜잭션 | ✅ 확인 | `prisma.$transaction(async (tx) => {...})` 하나로 묶여 있음 ([account.js:69-76](src/routes/account.js#L69-L76)) |

---

## 3. 발견 사항 (개선 권고, 확인된 악용 경로 아님)

아래 항목들은 스펙 위반이라기보다 방어심층 관점의 권고사항입니다. 별도 표기가 없는 한 **현재 코드 상태에서 실제로 우회 가능한 취약점으로 확인되지는 않았습니다.**

1. **[낮음] `/products` 업로드 처리 순서 — CSRF 검증 이전에 Multer가 파일을 메모리로 파싱**
   - 위치: [app.js:40-41](app.js#L40-L41)
     ```js
     app.post('/products', requireAuth, upload.array('images', 5));
     app.use(csrfProtect);
     ```
   - 근거: multipart 폼은 `express.urlencoded`가 파싱하지 못해 `req.body._csrf`를 채우려면 Multer가 먼저 실행되어야 함. 그 결과 CSRF 토큰 검증보다 파일 업로드(최대 5개×5MB)가 먼저 메모리에 적재됨.
   - 실제 악용 가능성: `requireAuth`가 Multer보다 앞서 있어 미인증 요청은 도달 불가하고, 세션 쿠키가 `SameSite=Lax`라 통상적인 크로스사이트 폼 제출로는 쿠키 자체가 전송되지 않아 실질적인 CSRF 우회로 이어지지는 않음. 다만 유효한 세션을 가진 공격자가 토큰만 다르게 보내는 경우 등 자원 소모(파일 파싱)가 CSRF 거부보다 먼저 일어나는 구조적 여지가 있어 개선을 권고함.

2. **[낮음/설계 확인 필요] 사용자 차단(`UserBlock`)이 목록·채팅에는 적용되나 상세 페이지 직접 접근에는 적용되지 않음**
   - 위치: 검색/목록 필터링은 [products.js:44,49](src/routes/products.js#L44-L49)에서 `hiddenOwnerIds`/`productBlock`으로 처리되지만, `GET /products/:id`([products.js:94-106](src/routes/products.js#L94-L106))와 `GET /users/:id`([account.js:9-16](src/routes/account.js#L9-L16))는 차단 여부를 검사하지 않음. 즉 차단한(또는 차단당한) 상대의 상품/프로필도 URL을 알면 그대로 열람 가능.
   - 판단: "등록된 상품은 누구나 볼 수 있어야 함" 요구사항과 상충하지 않는 설계상 선택으로 보이며, 개인정보 유출이나 권한 상승은 아님. 다만 "악성 유저/상품 차단" 요구를 완전한 접근 차단으로 기대한다면 범위 확인이 필요.

3. **[정보] `/register`, `/mypage/password`에는 별도 rate limit 없음**
   - 위치: [src/routes/auth.js:14](src/routes/auth.js#L14) (`POST /register`), [src/routes/account.js:39](src/routes/account.js#L39) (`POST /mypage/password`)
   - 스펙상 명시적으로 요구된 항목은 아니며(요구사항은 로그인/검색/채팅 한정), 자동화된 대량 가입이나 로그인된 세션 내에서의 현재 비밀번호 반복 시도를 완화하려면 추가 rate limit을 권고.

4. **[검증 불가] 서드파티 의존성의 알려진 취약점(CVE) 여부**
   - `express@5.1.0`, `multer@2.0.2`, `ejs@3.1.10`, `connect-sqlite3@0.9.16`, `helmet@8.1.0`, `argon2@0.44.0` 등의 실시간 보안 권고(GHSA/NVD) 대조는 본 검토의 도구로 수행할 수 없어 **검증 불가**로 표시함. `npm audit`/`pnpm audit` 등 별도 실행을 권고.

5. **[검증 불가] 배포 환경(리버스 프록시, `trust proxy`) 설정과 실제 IP 기반 rate limit의 정합성**
   - [app.js:22](app.js#L22) `if (production) app.set('trust proxy', 1)`는 프록시가 정확히 1홉이라는 가정을 전제로 함. 실제 배포 토폴로지(프록시 단수 여부)는 코드만으로 확인할 수 없어 **검증 불가**.

6. **[정보] 저장소 상태**
   - 현재 작업 디렉터리는 `.git`이 초기화되어 있지 않아(`git status` 실패) 커밋 이력 기반 대조는 수행하지 못했고, 파일 시스템 스냅샷만으로 검토함.

---

## 4. 결론

요구사항에 열거된 보안 통제 항목 전체(공통 4개, 로그인/가입 3개, 마이페이지 2개, 상품관리 1개, 상품출력 1개, 이미지업로드 1개, 검색 3개, 1:1채팅 2개, 전체채팅 2개, 신고 2개, 송금 3개)에 대해 소스 코드 상에서 대응 구현을 확인했으며, 로직 추적 결과 명백히 우회 가능한 결함은 발견되지 않았습니다. 위 3장의 항목 1·2는 운영상 리스크를 낮추기 위한 개선 권고이고, 3장의 항목 4·5는 이 검토의 범위(정적 코드 분석) 밖이라 "검증 불가"로 남겨두었으니 별도 확인이 필요합니다.
