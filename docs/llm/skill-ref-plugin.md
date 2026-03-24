# skill-ref 플러그인 설계문서

## 목적

`~/.claude/skills/`와 `~/.claude/agents/` 디렉토리의 스킬·에이전트 파일을 실시간 감시하여, 노드 간 참조 관계를 브라우저에서 인터랙티브 force-directed graph로 시각화하는 Claude Code 플러그인을 구현하라. 완료 조건: 스킬/에이전트 `.md` 파일이 추가·삭제·수정되면 3초 이내에 브라우저 그래프가 자동 업데이트된다.

## 스코프

### 범위 내 (In-Scope)
- `~/.claude/skills/` 및 `~/.claude/agents/` 디렉토리의 `.md` 파일 감시 및 파싱
- 파일 간 참조 관계를 D3.js force-directed graph로 시각화
- WebSocket을 통한 실시간 diff 업데이트
- MCP tool 2개 제공: `scan_graph`, `open_viewer`
- 슬래시 커맨드 `/skill-ref` 제공

### 범위 밖 (Out-of-Scope)
- 플러그인 마켓플레이스 디렉토리 스캔 (향후 확장 예정, 이 단계에서 구현하지 마라)
- `.md` 이외 파일 형식 파싱
- 그래프 데이터의 디스크 영속화 (매 시작 시 풀스캔으로 재구성)
- 브라우저 외 UI (Electron, CLI TUI)
- 그래프 편집 기능 (읽기 전용 시각화만 제공)

### NEVER 규칙
1. NEVER: `express`, `fastify`, `koa` HTTP 프레임워크를 도입하지 마라. `http.createServer` + `ws`만 사용하라.
2. NEVER: D3.js를 npm install하지 마라. CDN `<script>` 태그만 사용하라.
3. NEVER: MCP transport를 SSE로 변경하지 마라. stdio transport만 사용하라.
4. NEVER: `fs.watch` 대신 `chokidar`이나 다른 파일 감시 라이브러리를 도입하지 마라.
5. NEVER: 포트 7890~7899 범위 밖의 포트를 사용하지 마라.
6. NEVER: `~` 또는 홈 디렉토리를 하드코딩하지 마라. `os.homedir()`만 사용하라.

### ALWAYS 규칙
1. ALWAYS: 파일 읽기 실패 시 null을 반환하고 나머지 파일 처리를 계속하라. 단일 파일 실패로 전체 스캔을 중단하지 마라.
2. ALWAYS: WebSocket 메시지는 `{ type: 'full' | 'diff', data: GraphData | GraphDiff }` 형식을 사용하라.
3. ALWAYS: 경로의 `~`는 `os.homedir()`로 resolve하라.
4. ALWAYS: `static/index.html`은 외부 파일 참조 없이 self-contained로 유지하라 (D3 CDN 제외).

## 아키텍처

```
skill-ref/                          ← 플러그인 루트
├── .claude-plugin/
│   └── plugin.json                 ← 플러그인 매니페스트
├── .mcp.json                       ← MCP 서버 등록
├── commands/
│   └── skill-ref.md                ← /skill-ref 슬래시 커맨드
├── server/
│   ├── index.ts                    ← MCP 서버 엔트리 (stdio transport)
│   ├── watcher.ts                  ← fs.watch 기반 디렉토리 감시
│   ├── parser.ts                   ← .md 파일 파싱 → 노드/엣지 추출
│   ├── graph.ts                    ← 그래프 데이터 구조 관리
│   ├── web-server.ts               ← HTTP + WebSocket 서버
│   └── static/
│       └── index.html              ← D3.js force-directed graph (self-contained)
├── package.json
├── tsconfig.json
└── docs/
```

## 파일 변경 목록

| 파일 | 동작 | 내용 |
|------|------|------|
| `.claude-plugin/plugin.json` | 생성 | name, version, description, keywords |
| `.mcp.json` | 생성 | MCP 서버 등록 (stdio transport, `npx tsx` 실행) |
| `commands/skill-ref.md` | 생성 | `/skill-ref` 커맨드 — 브라우저 열기 안내 + MCP tool 호출 |
| `server/index.ts` | 생성 | MCP 서버 메인. `scan_graph`, `open_viewer` 두 tool 등록 |
| `server/watcher.ts` | 생성 | `fs.watch` 재귀 감시. debounce 300ms. 변경 시 콜백 호출 |
| `server/parser.ts` | 생성 | `.md` 파일 읽기 → frontmatter 파싱 → 참조 추출 |
| `server/graph.ts` | 생성 | 노드/엣지 데이터 구조. diff 계산 (added/removed/modified) |
| `server/web-server.ts` | 생성 | express 없이 `http.createServer` + `ws` WebSocket. static 파일 서빙 |
| `server/static/index.html` | 생성 | D3.js v7 force simulation. WebSocket 수신. 인터랙티브 그래프 |
| `package.json` | 생성 | dependencies: `@modelcontextprotocol/sdk`, `ws`, `tsx`, `typescript` |
| `tsconfig.json` | 생성 | ES2022, NodeNext, strict |

## 구현 순서

### 1단계: 프로젝트 스캐폴딩
- 대상: `package.json`, `tsconfig.json`, `.claude-plugin/plugin.json`, `.mcp.json`
- `npm install` 로 의존성 설치

### 2단계: parser.ts — .md 파일 파싱
- 함수: `parseFile(filePath: string): Promise<ParsedNode | null>` (파일 읽기 실패 시 null)
- 함수: `extractReferences(content: string, knownNames: Set<string>): string[]`
- 타입 판별: 파일 경로에 `/skills/`가 포함되면 `type: 'skill'`, `/agents/`가 포함되면 `type: 'agent'`
- `id` 생성 규칙: `{type}:{name}` (예: `skill:doc-loop`, `agent:planner`)
- SKILL.md: `gray-matter`로 frontmatter 파싱 → `name`, `description` 추출. `name` 없으면 디렉토리명 사용
- 에이전트 .md: `gray-matter`로 frontmatter 파싱 → `description` 추출. `name`은 파일명에서 `.md` 제거
- 참조 추출: 본문 + frontmatter description에서 `knownNames` set에 존재하는 이름을 정규식 `\b{name}\b` (word boundary)로 매칭. 자기 자신은 제외
- 에러 처리: 파일 읽기 실패 시 `null` 반환, 호출측에서 skip

### 3단계: watcher.ts — 디렉토리 감시
- 함수: `createWatcher(dirs: string[], onChange: (events: FileEvent[]) => void): Watcher`
- 각 dir에 대해 `fs.watch(dir, { recursive: true })` 호출
- 이벤트 수신 시: 파일명이 `.md`로 끝나는 경우만 처리, 나머지 무시
- `FileEvent.type` 판별: `fs.existsSync(filePath)` → false면 `'unlink'`, true면 `'change'` (add와 change를 구분하지 않음 — 어차피 graph.ts에서 diff로 처리)
- 300ms debounce: `setTimeout` + pending events 배열. 300ms 내 추가 이벤트 발생 시 타이머 리셋, 300ms 무변경 시 `onChange(pendingEvents)` 호출 후 배열 초기화
- `close()`: 모든 `fs.FSWatcher` 인스턴스에 `.close()` 호출
- 에러 처리: 감시 대상 디렉토리가 존재하지 않으면 `fs.mkdirSync(dir, { recursive: true })` 후 감시 시작

### 4단계: graph.ts — 그래프 데이터 관리
- 함수: `buildGraph(skillsDir: string, agentsDir: string): Promise<GraphData>`
- 함수: `diffGraph(prev: GraphData, next: GraphData): GraphDiff`
- `GraphData`: `{ nodes: Node[], edges: Edge[], timestamp: number }`
- `Node`: `{ id: string, name: string, type: 'skill' | 'agent', description: string, filePath: string }`
- `Edge`: `{ source: string, target: string, label?: string }`
- `GraphDiff`: `{ addedNodes: Node[], removedNodes: string[], addedEdges: Edge[], removedEdges: Edge[], updatedNodes: Node[] }`
- `buildGraph` 흐름: 디렉토리 glob → 각 `.md`에 `parseFile` 호출 → null 필터링 → `knownNames` set 구성 → 2nd pass로 `extractReferences` → Node/Edge 조립
- `diffGraph`: 이전/현재 GraphData의 node id set, edge key(`${source}->${target}`) set을 비교하여 added/removed/updated 산출

### 5단계: web-server.ts — HTTP + WebSocket 서버
- 함수: `startWebServer(port: number, getGraph: () => GraphData): Promise<WebServer>`
- HTTP: `http.createServer` → GET `/` 요청 시 `server/static/index.html` 읽어서 `text/html` 응답
- WebSocket: `new WebSocketServer({ server: httpServer })` 로 HTTP 서버에 attach
- 클라이언트 연결(`connection`) 시: `ws.send(JSON.stringify({ type: 'full', data: getGraph() }))`
- 외부에서 `broadcast(diff)` 호출 시: 모든 연결된 클라이언트에 `JSON.stringify({ type: 'diff', data: diff })` 전송
- 포트 탐색: `startWebServer(7890, ...)` 시도, `EADDRINUSE` 에러 시 7891~7899 순차 시도. 10개 모두 실패 시 에러 throw
- `close()`: WebSocket 클라이언트 전원 종료 → HTTP 서버 close

### 6단계: index.ts — MCP 서버 메인
- MCP stdio transport 사용: `new Server()` + `new StdioServerTransport()` → `server.connect(transport)`
- Tool 등록: `server.setRequestHandler(ListToolsRequestSchema, ...)` 와 `server.setRequestHandler(CallToolRequestSchema, ...)`
- Tool 1: `scan_graph` — 입력 없음, 현재 `GraphData`를 JSON string으로 반환
- Tool 2: `open_viewer` — 입력 없음. OS 판별: `process.platform === 'darwin'` → `open`, `'linux'` → `xdg-open`, `'win32'` → `start`. `child_process.exec('{cmd} http://localhost:{PORT}')` 실행 후 `{ url: string, message: string }` 반환
- 서버 시작 시: watcher 생성 → 초기 `buildGraph` → `startWebServer` → watcher onChange 콜백 등록
- watcher 콜백: `buildGraph` 재실행 → `diffGraph(prev, next)` → `webServer.broadcast(diff)` → prev = next 갱신
- 에러 처리: watcher/web-server 시작 실패 시 stderr에 에러 출력, MCP 서버는 계속 동작 (scan_graph는 사용 가능)

### 7단계: static/index.html — 인터랙티브 그래프 UI
- D3.js v7 CDN: `<script src="https://d3js.org/d3.v7.min.js"></script>`
- SVG: `width: 100vw`, `height: 100vh`, 배경 `#0a0a0f`
- Force simulation 파라미터:
  - `forceLink().id(d => d.id).distance(120)`
  - `forceManyBody().strength(-300)`
  - `forceCenter(width / 2, height / 2)`
  - `forceCollide().radius(d => nodeRadius(d) + 4)`
- 노드 색상: 스킬 `#4A90D9`, 에이전트 `#27AE60`
- 노드 크기: `radius = Math.max(8, Math.min(24, 6 + degree * 3))` (최소 8px, 최대 24px)
- 노드 라벨: 노드 아래 `text-anchor: middle`, fill `#e0e0e0`, font-size `11px`
- 엣지: SVG `<marker>` 화살표 (id="arrowhead", viewBox="0 0 10 10", refX=20, markerWidth=6, markerHeight=6), stroke `#555`, stroke-width `1.5`
- 인터랙션:
  - 드래그: `d3.drag()` — dragstart 시 `simulation.alphaTarget(0.3).restart()`, dragend 시 `alphaTarget(0)`
  - 줌/팬: `d3.zoom().scaleExtent([0.3, 5])` → SVG `<g>` transform
  - 호버: 연결된 노드/엣지 opacity 1.0, 비연결 opacity 0.15. transition 200ms
  - 클릭: 우측 패널(width 320px, 배경 `#1a1a2e`)에 `name`, `type`, `description`, `filePath`, `references[]` 표시
- 검색: `<input>` 상단 고정(position fixed, top 16px, left 50%, transform translateX(-50%)). `name` + `description` 대상 case-insensitive substring 매칭. 매칭 노드 opacity 1.0, 비매칭 0.15. 엔터 시 첫 매칭 노드로 `d3.zoomIdentity.translate().scale(1.5)` 포커스
- 레전드: 좌하단 고정(position fixed, bottom 16px, left 16px). 스킬 원(`#4A90D9`) + "Skill", 에이전트 원(`#27AE60`) + "Agent"
- WebSocket 수신 (`type: 'diff'`):
  - addedNodes: 노드 append → opacity 0 → transition(500ms) → opacity 1
  - removedNodes: transition(300ms) → opacity 0 → remove
  - addedEdges: stroke-dashoffset 애니메이션(500ms)으로 draw-in
  - removedEdges: transition(300ms) → opacity 0 → remove
  - updatedNodes: 기존 노드 데이터 갱신, radius 재계산
  - `type: 'full'`: 전체 그래프 교체, `simulation.nodes()` + `forceLink().links()` 재설정, `simulation.alpha(1).restart()`
- 반응형: `window.addEventListener('resize', ...)` → SVG width/height 재설정 + `forceCenter` 재계산 + `simulation.alpha(0.3).restart()`

### 8단계: commands/skill-ref.md — 슬래시 커맨드
- `/skill-ref` 실행 시 `open_viewer` MCP tool 호출 안내

## 함수/API 시그니처

```typescript
// parser.ts
interface ParsedNode {
  id: string;           // "{type}:{name}" 형식. 예: "skill:doc-loop", "agent:planner"
  name: string;         // frontmatter name (스킬) 또는 파일명에서 .md 제거 (에이전트)
  type: 'skill' | 'agent';  // 파일 경로에 /skills/ 포함 → skill, /agents/ 포함 → agent
  description: string;  // frontmatter description. 없으면 빈 문자열
  filePath: string;     // 절대 경로
  references: string[]; // 참조하는 다른 노드의 name 목록 (자기 자신 제외)
}
function parseFile(filePath: string): Promise<ParsedNode | null>;  // 파일 읽기 실패 시 null
function extractReferences(content: string, knownNames: Set<string>): string[];  // \b{name}\b word boundary 매칭

// watcher.ts
interface FileEvent {
  type: 'change' | 'unlink';  // add와 change를 구분하지 않음. 존재하면 'change', 미존재면 'unlink'
  filePath: string;
}
interface Watcher {
  close(): void;
}
function createWatcher(
  dirs: string[],
  onChange: (events: FileEvent[]) => void
): Watcher;

// graph.ts
interface Node {
  id: string;
  name: string;
  type: 'skill' | 'agent';
  description: string;
  filePath: string;
}
interface Edge {
  source: string;  // node id
  target: string;  // node id
  label?: string;
}
interface GraphData {
  nodes: Node[];
  edges: Edge[];
  timestamp: number;
}
interface GraphDiff {
  addedNodes: Node[];
  removedNodes: string[];   // node ids
  updatedNodes: Node[];
  addedEdges: Edge[];
  removedEdges: Edge[];     // source/target로 매칭하여 제거할 엣지 목록
}
function buildGraph(skillsDir: string, agentsDir: string): Promise<GraphData>;
function diffGraph(prev: GraphData, next: GraphData): GraphDiff;

// web-server.ts
interface WebServer {
  port: number;
  broadcast(diff: GraphDiff): void;
  close(): Promise<void>;
}
function startWebServer(
  port: number,
  getGraph: () => GraphData
): Promise<WebServer>;

// index.ts — MCP Tools
// scan_graph: {} → GraphData (JSON)
// open_viewer: {} → { url: string, message: string }
```

## 스캔 대상 규칙

- 스킬 디렉토리: `~/.claude/skills/` 하위에서 `*/SKILL.md` 패턴만 수집. `-workspace` 접미사가 붙은 디렉토리는 제외 (eval 작업 디렉토리)
- 에이전트 디렉토리: `~/.claude/agents/` 하위에서 1depth `.md` 파일만 수집. 모든 하위 디렉토리의 `.md`는 제외 (`references/`, `refs/` 포함)
- 플러그인 디렉토리: `~/.claude/plugins/marketplaces/*/plugins/*/` 하위에서 commands, agents, skills 자동 탐지 (향후 확장, 1단계에서는 미구현)
- `~` 는 런타임에 `os.homedir()`로 resolve

## 에러 처리

| 상황 | 처리 |
|------|------|
| `.md` 파일 읽기 실패 (권한, 삭제 race) | `parseFile` → `null` 반환, 로그 stderr 출력, skip |
| frontmatter 파싱 실패 (잘못된 YAML) | name을 파일명에서 추출, description 빈 문자열 |
| 감시 디렉토리 미존재 | `fs.mkdirSync(dir, { recursive: true })` 후 감시 |
| WebSocket 클라이언트 연결 끊김 | `ws.on('close')` 에서 clients set에서 제거 |
| 포트 7890~7899 모두 사용 중 | stderr에 에러 출력, web-server 미시작, MCP tool은 동작 |
| `open`/`xdg-open` 명령 실패 | tool 응답에 URL 포함 + "브라우저에서 직접 열어주세요" 메시지 |

## 제약 조건

1. MCP 서버는 `@modelcontextprotocol/sdk`의 `Server` + `StdioServerTransport` 사용
2. HTTP/WebSocket 서버는 Node.js 내장 `http` + `ws` 패키지만 사용 (express 불필요)
3. D3.js는 CDN import — 별도 빌드 체인 없음
4. `static/index.html`은 완전 self-contained (외부 의존: D3 CDN만)
5. 포트 충돌 방지: 7890~7899 범위에서 가용 포트 자동 탐색
6. `fs.watch` recursive 옵션 사용 (macOS FSEvents, Linux inotify)
7. `.md` 확장자만 감시 대상
8. frontmatter 파싱에 외부 라이브러리 사용 가능 (`gray-matter`)
9. 참조 추출 정규식: 스킬/에이전트 이름을 known-names set 대조로 매칭 (false positive 최소화)
10. WebSocket 메시지 형식: `{ type: 'full' | 'diff', data: GraphData | GraphDiff }`
11. `${CLAUDE_PLUGIN_ROOT}` 변수를 경로 참조에 사용
12. 모든 파일명은 kebab-case

## 의사결정

- **MCP stdio + 별도 HTTP/WS 서버** 채택. MCP 서버가 HTTP도 직접 서빙하는 구조.
  - 기각: MCP SSE transport로 브라우저 직접 연결 — MCP 프로토콜은 브라우저용이 아님
- **D3.js force-directed** 채택. 노드 수 ~60개로 성능 문제 없음.
  - 기각: Cytoscape.js — 번들 크기 큼, CDN self-contained에 부적합
  - 기각: Mermaid — 정적 렌더링, 실시간 업데이트·인터랙션 불가
- **fs.watch** 채택. Node.js 내장, 추가 의존성 없음.
  - 기각: chokidar — 추가 의존성. `fs.watch` recursive가 macOS/Linux에서 충분
- **gray-matter** 채택. frontmatter 파싱에 가장 널리 쓰이는 라이브러리.
  - 기각: 직접 파싱 — 정규식 edge case 처리 부담
