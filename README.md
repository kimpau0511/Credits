# Creator Signal

노래 제목에서 시작해 동명 곡 후보, 작사·작곡 크레딧, 크리에이터의 최근 작업과 주요 협업 관계를 탐색하는 사내 리서치 도구입니다.

## 동작 방식

- 검색 시 Credits.fm을 우선 조회하고 MusicBrainz를 보조 소스로 사용합니다. `CREDITS_FM_API_KEY`가 설정되면 서버 요청에 `x-api-key` 헤더를 적용해 상향된 호출 한도를 사용합니다.
- 현재 두 API 모두 키 없이 조회합니다.
- 검색 결과를 데이터베이스, 파일 또는 브라우저 저장소에 저장하지 않습니다.
- 동일 요청은 서버 메모리에서 20분간만 캐시되며 서버를 재시작하면 초기화됩니다.

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

로컬 키는 Git에서 제외된 `.env`의 `CREDITS_FM_API_KEY`에 두고, 배포할 때는 Render 등 배포 서비스의 서버 환경변수에 같은 이름으로 등록합니다. 브라우저 코드나 GitHub에는 실제 키를 넣지 않습니다.
