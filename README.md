# Gajae

GJC CLI 세션을 데스크톱에서 다루는 Electron 앱입니다. 채팅, transcript 동기화, steer, 취소, 모델 전환을 GJC와 같은 세션 위에서 돌립니다.

터미널 `gjc`와 같은 세션 파일을 봅니다. 앱은 별도 SDK connection입니다.

## 필요 조건

- macOS arm64
- Node.js 24+
- [GJC](https://github.com/gajae-code) CLI (`gjc`)

실행 파일 탐색 순서:

1. 앱 설정의 GJC 경로
2. `GJC_BIN`
3. `~/.bun/bin/gjc`
4. `~/.local/bin/gjc`
5. `/opt/homebrew/bin/gjc`
6. `/usr/local/bin/gjc`

기본 모델 프리셋은 `GOAT` (`codex-lb/gpt-5.6-sol:medium`). `~/.gjc/agent/models.yml`에 있으면 그걸 씁니다.

## 실행

```bash
npm install
npm test
npm run dev          # Vite
npm run dev:desktop  # Electron + Vite
```

패키징:

```bash
npm run package:mac
```

결과는 `release/Gajae-darwin-arm64/Gajae.app`입니다. `/Applications/Gajae.app`으로 복사해서 쓰면 됩니다.

## 사용

입력창에 요청을 쓰고 Enter. 파일·이미지는 경로로 넘기고, 이미지는 GJC가 `read`로 엽니다.

### 작업 중

| 동작 | 결과 |
|---|---|
| 내용 + Enter | 현재 turn에 steer 대기 |
| 빈 Enter | 현재 turn을 끊고 대기 steer를 즉시 실행 |
| `/queue …` | 이번 turn 다음 후속 작업 |
| Esc 또는 중지 | 현재 turn + owned 백그라운드/서브에이전트 중단. 세션은 유지 |

첫 Enter는 끊지 않습니다. 두 번째 빈 Enter가 실행입니다. `/steer`를 붙일 필요는 없습니다.

### 모델 / effort

- `/model` — 프리셋 목록
- `/model GOAT` — 바로 전환. `gajae-code/GOAT`, 유일한 prefix도 됩니다. 없으면 채팅으로 보내지 않고 오류만 냅니다.
- `Shift+Tab` — effort 순환

### 단축키

| 키 | 동작 |
|---|---|
| `⌘T` | 새 세션 |
| `⌘1`–`⌘9` | 세션 선택 |
| Esc | 현재 작업 중단 |
| `Shift+Tab` | effort |

### 세션 삭제

목록에서만 숨기지 않습니다. 살아 있으면 `session.close`로 프로세스를 끈 뒤 `session.delete`로 transcript/상태 파일을 지웁니다. 클릭한 세션만 대상입니다.

## GJC 런타임

데스크톱 Esc/중지는 이 요청을 보냅니다.

```ts
turn.abort {
  mode: "terminal",
  scope: "owned",
  operator: true,
}
confirm: true
idempotencyKey: "gajae-abort-<uuid>"
```

앱과 터미널 GJC는 다른 SDK connection입니다. stock GJC의 terminal owned abort는 **요청 connection == turn owner**일 때만 통합니다. 데스크톱은 owner가 아니라 no-effect가 됩니다.

그걸 위해 GJC 쪽에 넣은 패치:

1. CLI `control_request`에 `idempotencyKey` 전달
2. `turn.abort` `operator: true` — 다른 connection이 owned 작업을 끊을 수 있음. `confirm: true` 필수
3. 일반 `turn.abort {}`를 세션 범위로 — 요청 connection이 owner가 아니어도 현재 turn을 끊음 (빈 Enter flush)

패치 위치 (`gajae-code`):

- `packages/coding-agent/src/sdk/cli/session-cli.ts`
- `packages/coding-agent/src/sdk/host/control/dispatch.ts`
- `packages/coding-agent/src/sdk/host/control/operations.ts`
- `packages/coding-agent/src/sdk/host/session-runtime.ts`
- `packages/coding-agent/src/sdk/bus/index.ts`

실행 중인 구형 `gjc`/`gjc --resume`는 hot reload되지 않습니다. 세션 호스트를 다시 띄워야 합니다. 전역 설치본을 직접 고치면 패키지 재설치 때 사라집니다.

구형 CLI가 `operator`를 모르면 부분 취소를 성공으로 치지 않습니다.

## 하지 않는 것

- 취소에 `SIGINT` / 프로세스 kill
- 취소 fallback으로 `turn.abort_and_prompt` (제어 문장이 실제 user message가 됨)
- abort 응답만으로 `idle` / `작업 취소됨` 강제 표시
- 세션 삭제를 목록 hide로 처리

## 개발

```bash
npm run lint
npm test
npm run verify
```

Electron 메인: `electron/`
렌더러: `src/`
IPC 계약: `shared/`
