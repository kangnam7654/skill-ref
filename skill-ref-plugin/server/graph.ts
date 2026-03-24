import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import {
  parseSkillWorkflow,
  parseAgentMeta,
  extractCallees,
  type SkillWorkflow,
  type AgentMeta,
  type Callee,
} from './parser.js';

export interface WorkflowTreeNode {
  id: string;
  type: 'skill-root' | 'step' | 'agent-leaf';
  name: string;
  stepNumber?: string;
  description?: string;
  callees?: Callee[];
  loopbacks?: { targetStep: string; condition: string }[];
  children?: WorkflowTreeNode[];
}

export interface WorkflowData {
  skills: SkillWorkflow[];
  agents: AgentMeta[];
  trees: WorkflowTreeNode[];
  timestamp: number;
}

function collectFiles(dir: string, type: 'skill' | 'agent'): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];

  if (type === 'skill') {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith('-workspace')) continue;
      const skillFile = path.join(dir, entry.name, 'SKILL.md');
      if (fs.existsSync(skillFile)) files.push(skillFile);
    }
  } else {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(path.join(dir, entry.name));
      }
    }
  }
  return files;
}

export async function buildWorkflowData(
  skillsDir: string,
  agentsDir: string,
): Promise<WorkflowData> {
  const skillFiles = collectFiles(skillsDir, 'skill');
  const agentFiles = collectFiles(agentsDir, 'agent');

  // 1st pass: parse all skills and agents
  const skills: SkillWorkflow[] = [];
  for (const f of skillFiles) {
    const sw = await parseSkillWorkflow(f);
    if (sw) skills.push(sw);
  }

  const agents: AgentMeta[] = [];
  for (const f of agentFiles) {
    const am = await parseAgentMeta(f);
    if (am) agents.push(am);
  }

  const knownSkills = new Set(skills.map((s) => s.name));
  const knownAgents = new Set(agents.map((a) => a.name));

  // 2nd pass: extract callees for each step using known names
  for (const skill of skills) {
    for (const step of skill.steps) {
      try {
        const raw = await readFile(skill.filePath, 'utf-8');
        const { content } = matter(raw);

        // Find step body
        const headerRe = new RegExp(
          `^##\\s+${step.stepNumber.replace('#', '#')}\\b.*$`,
          'm',
        );
        const headerMatch = headerRe.exec(content);
        if (headerMatch) {
          const start = headerMatch.index;
          const nextHeader = content.indexOf('\n## ', start + 1);
          const body = content.slice(start, nextHeader > 0 ? nextHeader : undefined);

          const callees = extractCallees(body, knownSkills, knownAgents);
          step.callees = callees.filter((c) => c.name !== skill.name);
        }
      } catch {
        // keep empty callees
      }
    }
  }

  // Determine which skills are called by other skills (sub-skills)
  const calledSkillNames = new Set<string>();
  for (const skill of skills) {
    for (const step of skill.steps) {
      for (const c of step.callees) {
        if (c.type === 'skill') calledSkillNames.add(c.name);
      }
    }
  }

  // Build skill lookup
  const skillMap = new Map(skills.map((s) => [s.name, s]));

  // Build workflow trees
  function buildTree(skill: SkillWorkflow, expanded: Set<string>): WorkflowTreeNode {
    const children: WorkflowTreeNode[] = [];

    for (const step of skill.steps) {
      const stepNode: WorkflowTreeNode = {
        id: `skill:${skill.name}:${step.stepNumber}`,
        type: 'step',
        name: step.name,
        stepNumber: step.stepNumber,
        callees: step.callees,
        loopbacks: step.loopbacks,
        children: [],
      };

      // Add callee children
      for (const callee of step.callees) {
        if (callee.type === 'skill' && skillMap.has(callee.name) && !expanded.has(callee.name)) {
          // Expand sub-skill as nested tree
          const subSkill = skillMap.get(callee.name)!;
          expanded.add(callee.name);
          const subTree = buildTree(subSkill, expanded);
          stepNode.children!.push(subTree);
        } else if (callee.type === 'agent') {
          stepNode.children!.push({
            id: `agent:${callee.name}:in:${skill.name}:${step.stepNumber}`,
            type: 'agent-leaf',
            name: callee.name,
          });
        }
      }

      if (stepNode.children!.length === 0 && step.callees.length === 0) {
        // Logic-only step, mark it
        stepNode.callees = [{ name: 'logic', type: 'logic' }];
      }

      children.push(stepNode);
    }

    return {
      id: `skill:${skill.name}`,
      type: 'skill-root',
      name: skill.name,
      description: skill.description,
      children,
    };
  }

  // Root skills = skills not called by other skills
  const rootSkillNames = skills
    .filter((s) => !calledSkillNames.has(s.name))
    .map((s) => s.name);

  // Also include skills that have workflows but are called (for standalone view)
  const trees: WorkflowTreeNode[] = [];

  // Build root trees (with full expansion)
  for (const name of rootSkillNames) {
    const skill = skillMap.get(name)!;
    if (skill.steps.length === 0) continue;
    trees.push(buildTree(skill, new Set([name])));
  }

  // Build standalone trees for sub-skills (without expansion of their own children)
  for (const name of calledSkillNames) {
    const skill = skillMap.get(name);
    if (!skill || skill.steps.length === 0) continue;
    trees.push(buildTree(skill, new Set([name])));
  }

  return { skills, agents, trees, timestamp: Date.now() };
}
