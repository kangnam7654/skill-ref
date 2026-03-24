import { readFile } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';

export interface Callee {
  name: string;
  type: 'skill' | 'agent' | 'logic';
}

export interface Loopback {
  targetStep: string;
  condition: string;
}

export interface WorkflowStep {
  stepNumber: string;
  name: string;
  callees: Callee[];
  loopbacks: Loopback[];
}

export interface SkillWorkflow {
  name: string;
  description: string;
  filePath: string;
  steps: WorkflowStep[];
}

export interface AgentMeta {
  name: string;
  description: string;
  filePath: string;
}

// Matches multiple patterns:
// "## #1 Title", "## Phase 1: Title (#1~#9)", "## Step 1: Title (#10~#16)"
// "### Phase 1: Title", "### 1단계: Title", "### Step 1: Title"
const STEP_HEADER_RE = /^#{2,3}\s+(?:#(\d+(?:[~\-]#?\d+)?)\s+(.+)|(?:Phase|Step)\s+(\d+)\s*:\s*(.+)|(\d+)단계\s*:\s*(.+))$/gm;
const LOOPBACK_RE = /(?:FAIL|REJECT|REVISION|loopback|복귀|재시도|→\s*#).*?#(\d+)/gi;
const SKILL_CALL_RE = /Skill\(\s*["']([^"']+)["']\s*\)/g;
const AGENT_CALL_RE = /Agent\(\s*[^)]*subagent_type\s*=\s*["']([^"']+)["']/g;

export async function parseSkillWorkflow(filePath: string): Promise<SkillWorkflow | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const { data: frontmatter, content } = matter(raw);

    const name = (frontmatter.name as string) || path.basename(path.dirname(filePath));
    const description = (frontmatter.description as string) || '';

    const steps = parseSteps(content);

    return { name, description, filePath, steps };
  } catch {
    process.stderr.write(`[skill-ref] Failed to parse skill: ${filePath}\n`);
    return null;
  }
}

export async function parseAgentMeta(filePath: string): Promise<AgentMeta | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const { data: frontmatter } = matter(raw);

    const name = path.basename(filePath, '.md');
    const description = (frontmatter.description as string) || '';

    return { name, description, filePath };
  } catch {
    process.stderr.write(`[skill-ref] Failed to parse agent: ${filePath}\n`);
    return null;
  }
}

function parseSteps(content: string): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  const headers: { stepNumber: string; name: string; index: number }[] = [];

  let match: RegExpExecArray | null;
  const re = new RegExp(STEP_HEADER_RE.source, STEP_HEADER_RE.flags);
  while ((match = re.exec(content)) !== null) {
    let stepNumber: string;
    let name: string;

    if (match[1]) {
      // Pattern: "## #1 Title"
      stepNumber = `#${match[1]}`;
      name = match[2].trim();
    } else if (match[3]) {
      // Pattern: "## Phase 1: Title (#1~#9)" or "## Step 1: Title"
      stepNumber = `#${match[3]}`;
      name = match[4].trim();
      const rangeMatch = name.match(/\(#(\d+(?:[~\-]#?\d+)?)\)\s*$/);
      if (rangeMatch) {
        stepNumber = `#${rangeMatch[1]}`;
        name = name.replace(/\s*\(#\d+(?:[~\-]#?\d+)?\)\s*$/, '').trim();
      }
    } else if (match[5]) {
      // Pattern: "### 1단계: Title"
      stepNumber = `#${match[5]}`;
      name = match[6].trim();
    } else {
      continue;
    }

    headers.push({ stepNumber, name, index: match.index });
  }

  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].index;
    const end = i + 1 < headers.length ? headers[i + 1].index : content.length;
    const body = content.slice(start, end);

    steps.push({
      stepNumber: headers[i].stepNumber,
      name: headers[i].name,
      callees: [],
      loopbacks: extractLoopbacks(body),
    });
  }

  return steps;
}

export function extractCallees(
  stepContent: string,
  knownSkills: Set<string>,
  knownAgents: Set<string>,
): Callee[] {
  const found = new Map<string, Callee>();

  // 1st: Skill("xxx") pattern
  let m: RegExpExecArray | null;
  const skillRe = new RegExp(SKILL_CALL_RE.source, SKILL_CALL_RE.flags);
  while ((m = skillRe.exec(stepContent)) !== null) {
    const name = m[1];
    if (!found.has(name)) found.set(name, { name, type: 'skill' });
  }

  // 2nd: Agent(subagent_type="xxx") pattern
  const agentRe = new RegExp(AGENT_CALL_RE.source, AGENT_CALL_RE.flags);
  while ((m = agentRe.exec(stepContent)) !== null) {
    const name = m[1];
    if (!found.has(name)) found.set(name, { name, type: 'agent' });
  }

  // 3rd: known-names word boundary match
  for (const name of knownSkills) {
    if (found.has(name)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(stepContent)) {
      found.set(name, { name, type: 'skill' });
    }
  }

  for (const name of knownAgents) {
    if (found.has(name)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(stepContent)) {
      found.set(name, { name, type: 'agent' });
    }
  }

  return Array.from(found.values());
}

export function extractLoopbacks(stepContent: string): Loopback[] {
  const results: Loopback[] = [];
  const re = new RegExp(LOOPBACK_RE.source, LOOPBACK_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(stepContent)) !== null) {
    const line = stepContent.slice(
      Math.max(0, stepContent.lastIndexOf('\n', m.index) + 1),
      stepContent.indexOf('\n', m.index + m[0].length),
    );
    results.push({
      targetStep: `#${m[1]}`,
      condition: line.trim().slice(0, 80),
    });
  }
  return results;
}
