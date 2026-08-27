# CReadits Search

노래 제목에서 시작해 동명 곡 후보, 작사·작곡 크레딧, 크리에이터의 최근 작업과 주요 협업 관계를 탐색하고 사용자별 수집 데이터를 누적 분석하는 사내 리서치 도구입니다.

## 동작 방식

- 검색 시 Credits.fm을 우선 조회하고 MusicBrainz를 보조 소스로 사용합니다. `CREDITS_FM_API_KEY`가 설정되면 서버 요청에 `x-api-key` 헤더를 적용해 상향된 호출 한도를 사용합니다.
- 사용자는 Supabase 이메일 계정으로 로그인합니다.
- 곡을 선택하면 기본 크레딧을 먼저 표시하고, 인물별 300~500곡 카탈로그·협업 분석은 별도 요청으로 진행합니다.
- 분석이 끝난 곡과 크레딧은 사용자의 Supabase 수집함에 자동 저장됩니다. 같은 곡을 다시 분석하면 중복 생성하지 않고 최신 데이터로 갱신합니다.
- 완성된 인물 프로필은 사용자별 `creator_profiles`에 30일간 캐시됩니다. 다음 검색에서는 저장 결과를 먼저 표시하고, 만료된 결과만 화면 뒤에서 다시 분석합니다.
- `내 수집 분석`에서는 작곡/작사 참여 횟수, 작사·작곡 동시 참여, 최근 3개월, 아티스트/앨범/장르, 공동작업 조합과 반복 등장 인물을 계산합니다.
- 곡 API 응답은 서버 메모리에서 20분간 재사용하며, 완성 인물 프로필은 Supabase에 영속 저장합니다.

## Supabase 설정

1. Supabase에서 프로젝트를 생성합니다.
2. SQL Editor에서 `supabase/schema.sql`을 한 번 실행합니다.
3. Project Settings의 API 항목에서 Project URL과 publishable/anon key를 확인합니다.
4. `.env` 또는 Render 환경변수에 아래 값을 등록합니다.

```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your_publishable_anon_key
```

anon 키는 브라우저 공개용 키이며 실제 데이터 접근은 `schema.sql`의 Row Level Security가 사용자별로 제한합니다. `service_role` 키는 이 프로젝트에 넣지 않습니다.

## 로컬 실행

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

프로덕션 확인:

```bash
pnpm check
pnpm test
pnpm build
pnpm start
```

기본 주소는 `http://localhost:3000`, 상태 확인 경로는 `/api/health`입니다.

## 새 음악 API 연결

로컬 키는 Git에서 제외된 `.env`의 `CREDITS_FM_API_KEY`에 두고, 배포할 때는 Render 서버 환경변수에 같은 이름으로 등록합니다. 브라우저 코드나 GitHub에는 실제 키를 넣지 않습니다.

## 비전공 사용자에게 전달하기

GitHub 저장소 자체가 아니라 Render가 발급한 `https://creator-signal.onrender.com` 형태의 주소 하나만 전달합니다. 사용자는 주소를 열고 이메일/비밀번호로 로그인하면 되며 설치나 터미널 실행은 필요하지 않습니다. GitHub의 `main` 브랜치에 새 커밋을 푸시하면 Render가 자동으로 다시 배포합니다.
