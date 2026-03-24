# skill-ref 플러그인 설계문서 v2 — 워크플로우 시각화

## 목적

`~/.claude/skills/`의 SKILL.md 파일에서 실행 워크플로우(번호 매겨진 단계, 호출되는 에이전트/스킬, 루프백 조건)를 파싱하여, 계층적 플로우차트로 브라우저에 시각화하는 Claude Code 플러그인을 구현하라. 완료 조건: 스킬 `.md` 파일이 추가·삭제·수정되면 3초 이내에 브라우저 플로우차트가 자동 업데이트된다.

## v1 대비 변경사항

| 항목 | v1 (참조 그래프) | v2 (워크플로우) |
|------|-----------------|----------------|
| 데이터 모델 | `Node + Edge` (flat, 65노드 289엣지) | `WorkflowTree` (계층, 부모-자식 + 실행 순서) |
| 파싱 | word-boundary 이름 매칭 | `## #N` 헤더 + 에이전트/스킬 호출 추출 |
| 시각화 | D3 force-directed (물리 시뮬레이션) | D3 tree layout (위→아래 플로우차트) |
| 진입점 | 모든 노드 동등 | 스킬 = 워크플로우 루트, 에이전트 = 단계 내 실행자 |
| 변경 파일 | parser.ts, graph.ts, index.html | parser.ts, graph.ts, index.html (3개 파일만 변경) |
| 유지 파일 | — | watcher.ts, web-server.ts, index.ts (변경 없음) |

## 스코프

### 범위 내 (In-Scope)
- `~/.claude/skills/*/SKILL.md` 파일에서 워크플로우 단계 파싱
- `~/.claude/agents/*.md` 파일에서 에이전트 메타데이터 파싱
- 스킬 워크플로우를 계층적 플로우차트로 시각화 (위→아래)
- 스킬 간 호출 관계 (auto-dev → idea-forge → ...)를 중첩 트리로 표현
- 루프백(FAIL → 이전 단계 복귀) 화살표 표시
- WebSocket을 통한 실시간 업데이트
- 스킬 선택 드롭다운: 특정 스킬 워크플로우만 보기

### 범위 밖 (Out-of-Scope)
- v1의 참조 그래프 뷰 (제거)
- 플러그인 마켓플레이스 디렉토리 스캔
- 워크플로우 편집 기능
- 에이전트 단독 뷰 (에이전트는 스킬 워크플로우 내에서만 표시)

### NEVER 규칙
1. NEVER: `express`, `fastify`, `koa` HTTP 프레임워크를 도입하지 마라. `http.createServer` + `ws`만 사용하라.
2. NEVER: D3.js를 npm install하지 마라. CDN `<script>` 태그만 사용하라.
3. NEVER: MCP transport를 SSE로 변경하지 마라. stdio transport만 사용하라.
4. NEVER: `fs.watch` 대신 `chokidar`이나 다른 파일 감시 라이브러리를 도입하지 마라.
5. NEVER: 포트 7890~7899 범위 밖의 포트를 사용하지 마라.
6. NEVER: `~` 또는 홈 디렉토리를 하드코딩하지 마라. `os.homedir()`만 사용하라.
7. NEVER: force-directed layout을 사용하지 마라. tree layout만 사용하라.

### ALWAYS 규칙
1. ALWAYS: 파일 읽기 실패 시 null을 반환하고 나머지 파일 처리를 계속하라.
2. ALWAYS: WebSocket 메시지는 `{ type: 'full', data: WorkflowData }` 형식을 사용하라.
3. ALWAYS: 경로의 `~`는 `os.homedir()`로 resolve하라.
4. ALWAYS: `static/index.html`은 외부 파일 참조 없이 self-contained로 유지하라 (D3 CDN 제외).

## 워크플로우 파싱 규칙

### SKILL.md 단계 헤더 패턴
모든 SKILL.md는 `## #N 단계제목` 형식의 번호 매겨진 단계를 사용한다.

파싱 정규식: `/^##\s+#(\d+(?:~#?\d+)?)\s+(.+)$/gm`
- 매칭 예: `## #1 Input Classification`, `## #10~#16 Architecture Loop`
- 캡처 그룹 1: 단계 번호 (`1`, `10~16`)
- 캡처 그룹 2: 단계 제목 (`Input Classification`)

### 에이전트/스킬 호출 추출
각 단계의 본문에서 호출 대상을 추출한다:

1. **에이전트 호출**: `Agent(subagent_type="xxx")` 또는 본문에서 known agent 이름이 명시적으로 호출되는 패턴
2. **스킬 호출**: `Skill("xxx")` 패턴 또는 "xxx 스킬을 트리거" 같은 명시적 호출 패턴
3. **known-names 매칭**: 단계 본문에서 known skill/agent name을 `\b{name}\b`로 매칭 (자기 자신 제외)

### 루프백 추출
단계 본문에서 루프백 조건을 추출한다:

정규식: `/(?:FAIL|REJECT|loopback|복귀|재시도).*?#(\d+)/gi`
- 캡처: 복귀 대상 단계 번호

### 스킬 계층 구조
스킬이 다른 스킬을 호출하면 중첩 트리로 표현한다:
```
auto-dev
├── idea-forge (스킬 호출 → 확장)
│   ├── #1 Input Classification → (logic)
│   ├── #2 Brainstorming → ceo (agent)
│   ├── #5 Market Research → researcher (agent)
│   └── ...
├── design-loop (스킬 호출 → 확장)
│   ├── architecture-loop (스킬 호출 → 확장)
│   │   ├── #10 Tech Stack → cto (agent)
│   │   └── ...
│   └── ...
└── ...
```

## 파일 변경 목록

| 파일 | 동작 | 내용 |
|------|------|------|
| `server/parser.ts` | **전체 재작성** | 워크플로우 단계 파싱, 에이전트/스킬 호출 추출, 루프백 추출 |
| `server/graph.ts` | **전체 재작성** | WorkflowData 트리 구조 빌드, 스킬 간 중첩 해결 |
| `server/static/index.html` | **전체 재작성** | D3 tree layout 플로우차트, 스킬 선택, 확장/축소 |
| `server/watcher.ts` | 변경 없음 | — |
| `server/web-server.ts` | 변경 없음 | — |
| `server/index.ts` | 미세 수정 | `GraphData` → `WorkflowData` 타입 교체, `broadcast`는 항상 full 전송 |

## 구현 순서

### 1단계: parser.ts 재작성

- 함수: `parseSkillWorkflow(filePath: string): Promise<SkillWorkflow | null>`
  - `gray-matter`로 frontmatter 파싱 → `name`, `description` 추출
  - 본문에서 `## #N ...` 패턴으로 단계 분할
  - 각 단계에서 호출 대상(agent/skill) 추출
  - 각 단계에서 루프백 조건 추출
  - 반환: `SkillWorkflow` 또는 파싱 실패 시 `null`

- 함수: `parseAgentMeta(filePath: string): Promise<AgentMeta | null>`
  - `gray-matter`로 frontmatter 파싱 → `name`, `description` 추출
  - 에이전트는 워크플로우가 없으므로 메타데이터만 반환

- 함수: `extractCallees(stepContent: string, knownSkills: Set<string>, knownAgents: Set<string>): Callee[]`
  - 1순위: `Skill("xxx")` 패턴 매칭 → `{ name: "xxx", type: "skill" }`
  - 2순위: `Agent(subagent_type="xxx")` 패턴 매칭 → `{ name: "xxx", type: "agent" }`
  - 3순위: known-names `\b{name}\b` 매칭 → type은 set 소속으로 판별
  - 자기 자신(현재 스킬 이름) 제외
  - 중복 제거

- 함수: `extractLoopbacks(stepContent: string): Loopback[]`
  - 정규식으로 `FAIL/REJECT/loopback → #N` 패턴 추출
  - 반환: `{ targetStep: string, condition: string }`

### 2단계: graph.ts 재작성

- 함수: `buildWorkflowData(skillsDir: string, agentsDir: string): Promise<WorkflowData>`
  - 1st pass: 모든 SKILL.md 파싱 → `SkillWorkflow[]`
  - 2nd pass: 모든 agent .md 파싱 → `AgentMeta[]`
  - known names set 구성 (skills + agents)
  - 3rd pass: 각 단계의 callee를 known names로 재매칭 (1st pass에서는 known names 미완성)
  - 스킬 간 호출 관계 해결: 단계에서 다른 스킬을 호출하면 해당 스킬의 워크플로우를 `children`으로 중첩
  - 순환 참조 방지: 이미 확장된 스킬 set 관리, 재귀 중 중복 발견 시 확장하지 않고 참조만 표시

- `WorkflowData` 구조:
  ```
  {
    skills: SkillWorkflow[],     // 모든 스킬 목록 (flat)
    agents: AgentMeta[],         // 모든 에이전트 메타데이터
    trees: WorkflowTree[],       // 루트 스킬별 확장된 트리
    timestamp: number
  }
  ```

- 루트 스킬 판별: 다른 스킬에서 호출되지 않는 스킬 = 루트. 다른 스킬에서 호출되는 스킬 = 서브 (트리에서 중첩)

### 3단계: index.html 재작성

- D3.js v7 CDN: `<script src="https://d3js.org/d3.v7.min.js"></script>`
- 배경: `#0a0a0f`
- **레이아웃**: `d3.tree()` — 위→아래 (top-to-bottom)
  - `nodeSize([220, 80])`: 노드 간 수평 220px, 수직 80px
  - SVG `<g>` 전체를 줌/팬 가능

- **노드 스타일**:
  - 스킬 노드 (워크플로우 있음): 둥근 사각형 `rx=8`, fill `#1a1a2e`, stroke `#4A90D9`, 너비 200px, 높이 48px
  - 에이전트 노드: 원형, fill `#27AE60`, radius 20px
  - 로직 노드 (에이전트/스킬 호출 없는 단계): 다이아몬드, fill `#F39C12`, 20x20px
  - 노드 내부 텍스트: 단계 번호 + 이름 (예: "#1 Input Classification"), fill `#e0e0e0`, font-size `11px`
  - 호출 대상 이름: 노드 아래에 작은 텍스트, fill `#888`, font-size `9px`

- **엣지 스타일**:
  - 순차 흐름: 실선, stroke `#555`, stroke-width `1.5`, `d3.linkVertical()` 곡선
  - 루프백: 점선 `stroke-dasharray: 4,3`, stroke `#e74c3c`, 우측으로 우회하는 곡선 path
  - 화살표 마커: 순차(id="arrow-flow", fill `#555`), 루프백(id="arrow-loop", fill `#e74c3c`)

- **스킬 선택 드롭다운**:
  - `<select>` 상단 좌측 고정 (position fixed, top 16px, left 16px)
  - 옵션: "All Root Workflows" + 각 루트 스킬 이름
  - 선택 시 해당 스킬의 트리만 표시, "All"이면 모든 루트 트리를 좌우로 나열

- **확장/축소**:
  - 스킬 노드(자식 스킬을 호출하는 단계) 클릭 시 하위 트리 토글
  - 축소 시: 스킬 노드에 `+` 아이콘 표시, 하위 노드 숨김
  - 확장 시: 하위 트리 fade-in(300ms), 레이아웃 재계산 (transition 500ms)

- **호버**: 해당 노드와 직접 연결된 엣지/노드 하이라이트 (opacity 1.0 vs 0.15, transition 200ms)

- **클릭 상세 패널**:
  - 우측 패널(width 320px, 배경 `#1a1a2e`)
  - 표시 항목: 단계 번호, 이름, 호출 대상 목록, 루프백 조건, 스킬 설명

- **검색**: `<input>` 상단 중앙. name 대상 case-insensitive substring 매칭. 매칭 노드 하이라이트 + 엔터 시 포커스

- **레전드**: 좌하단 고정. 스킬 사각형(`#4A90D9`) + "Skill", 에이전트 원(`#27AE60`) + "Agent", 다이아몬드(`#F39C12`) + "Logic", 실선 "Flow", 점선(`#e74c3c`) "Loopback"

- **WebSocket**: `type: 'full'` 수신 시 전체 트리 재렌더링

- **반응형**: `window.resize` → SVG 크기 + tree layout 재계산

### 4단계: index.ts 미세 수정
- `import { buildGraph, diffGraph, type GraphData }` → `import { buildWorkflowData, type WorkflowData }`
- `currentGraph: GraphData` → `currentData: WorkflowData`
- `scan_graph` tool: `WorkflowData` JSON 반환 (기존과 동일 패턴)
- watcher 콜백: `buildWorkflowData` 재실행 → 항상 full 전송 (diff 미사용 — 트리 구조 diff는 복잡하므로 full replace)
- `web-server.ts`의 `broadcast` 호출: `{ type: 'full', data: currentData }`

## 함수/API 시그니처

```typescript
// parser.ts
interface Callee {
  name: string;
  type: 'skill' | 'agent' | 'logic';
}

interface Loopback {
  targetStep: string;  // "#5" 또는 "#27"
  condition: string;   // "FAIL", "REJECT", "BM_REVISION" 등 원문 그대로
}

interface WorkflowStep {
  stepNumber: string;    // "#1", "#10~#16"
  name: string;          // "Input Classification"
  callees: Callee[];     // 이 단계에서 호출하는 에이전트/스킬 목록
  loopbacks: Loopback[]; // 이 단계의 루프백 조건 목록
}

interface SkillWorkflow {
  name: string;
  description: string;
  filePath: string;
  steps: WorkflowStep[];
}

interface AgentMeta {
  name: string;
  description: string;
  filePath: string;
}

function parseSkillWorkflow(filePath: string): Promise<SkillWorkflow | null>;
function parseAgentMeta(filePath: string): Promise<AgentMeta | null>;
function extractCallees(stepContent: string, knownSkills: Set<string>, knownAgents: Set<string>): Callee[];
function extractLoopbacks(stepContent: string): Loopback[];

// graph.ts
interface WorkflowTreeNode {
  id: string;                      // "skill:auto-dev:#1" 또는 "skill:auto-dev"
  type: 'skill-root' | 'step' | 'agent-leaf';
  name: string;
  stepNumber?: string;
  description?: string;
  callees?: Callee[];
  loopbacks?: Loopback[];
  children?: WorkflowTreeNode[];   // 하위 단계 또는 확장된 서브 스킬
}

interface WorkflowData {
  skills: SkillWorkflow[];
  agents: AgentMeta[];
  trees: WorkflowTreeNode[];       // 루트 스킬별 확장 트리
  timestamp: number;
}

function buildWorkflowData(skillsDir: string, agentsDir: string): Promise<WorkflowData>;

// web-server.ts — 변경 없음. broadcast 시그니처 유지 (내부 data 타입만 변경)
// index.ts — WorkflowData 타입 사용. diff 대신 full replace.
```

## 에러 처리

| 상황 | 처리 |
|------|------|
| SKILL.md에 `## #N` 패턴 없음 (워크플로우 없는 스킬) | steps를 빈 배열로 설정. 루트 노드만 표시 |
| 단계에서 호출 대상을 찾지 못함 | callees 빈 배열. type을 'logic'으로 표시 |
| 순환 참조 (A→B→A) | 이미 확장된 스킬 set 관리, 순환 감지 시 확장 중단 + 노드에 "↻" 표시 |
| `.md` 파일 읽기 실패 | null 반환, skip |
| frontmatter 파싱 실패 | name을 디렉토리명/파일명에서 추출 |

## 제약 조건

1. 변경 대상: `parser.ts`, `graph.ts`, `static/index.html`, `index.ts` 4개 파일만 수정
2. `watcher.ts`, `web-server.ts`는 변경하지 마라
3. diff 대신 full replace: 트리 변경 시 `{ type: 'full', data: WorkflowData }` 전송
4. D3.js tree layout 사용: `d3.tree().nodeSize([220, 80])`
5. 노드 크기: 스킬 200x48px, 에이전트 r=20, 로직 20x20
6. WebSocket 메시지 형식: `{ type: 'full', data: WorkflowData }`

## 의사결정

- **D3 tree layout** 채택. 워크플로우의 계층적 특성에 적합.
  - 기각: force-directed — 워크플로우 순서/계층 표현 불가, 289엣지로 스파게티
  - 기각: dagre — 추가 의존성 필요. D3 tree로 충분
- **full replace** 채택 (diff 미사용). 트리 구조의 diff 계산은 복잡하나 성능 이점 미미 (~60노드).
  - 기각: tree diff — 구현 복잡도 대비 성능 이점 없음
- **스킬 중심 시각화** 채택. 에이전트는 스킬 워크플로우 내에서만 표시.
  - 기각: 에이전트+스킬 동등 표시 — 289엣지 스파게티 재발
