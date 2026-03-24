import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { parseFile, extractReferences, type ParsedNode } from './parser.js';

export interface Node {
  id: string;
  name: string;
  type: 'skill' | 'agent';
  description: string;
  filePath: string;
}

export interface Edge {
  source: string;
  target: string;
  label?: string;
}

export interface GraphData {
  nodes: Node[];
  edges: Edge[];
  timestamp: number;
}

export interface GraphDiff {
  addedNodes: Node[];
  removedNodes: string[];
  updatedNodes: Node[];
  addedEdges: Edge[];
  removedEdges: Edge[];
}

function edgeKey(e: Edge): string {
  return `${e.source}->${e.target}`;
}

async function collectFiles(dir: string, type: 'skill' | 'agent'): Promise<string[]> {
  if (!fs.existsSync(dir)) return [];

  const files: string[] = [];

  if (type === 'skill') {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith('-workspace')) continue;
      const skillFile = path.join(dir, entry.name, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        files.push(skillFile);
      }
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

export async function buildGraph(skillsDir: string, agentsDir: string): Promise<GraphData> {
  const skillFiles = await collectFiles(skillsDir, 'skill');
  const agentFiles = await collectFiles(agentsDir, 'agent');
  const allFiles = [...skillFiles, ...agentFiles];

  // 1st pass: parse all files to get names
  const parsedNodes: ParsedNode[] = [];
  for (const file of allFiles) {
    const node = await parseFile(file);
    if (node) parsedNodes.push(node);
  }

  const knownNames = new Set(parsedNodes.map((n) => n.name));

  // 2nd pass: extract references
  for (const node of parsedNodes) {
    try {
      const raw = await readFile(node.filePath, 'utf-8');
      const { data: frontmatter, content } = matter(raw);
      const fullText = `${frontmatter.description || ''} ${content}`;
      const refs = extractReferences(fullText, knownNames);
      node.references = refs.filter((r) => r !== node.name);
    } catch {
      // keep empty references
    }
  }

  // Build nodes and edges
  const nodes: Node[] = parsedNodes.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    description: p.description,
    filePath: p.filePath,
  }));

  const nodeIdByName = new Map(parsedNodes.map((p) => [p.name, p.id]));
  const edges: Edge[] = [];

  for (const p of parsedNodes) {
    for (const refName of p.references) {
      const targetId = nodeIdByName.get(refName);
      if (targetId) {
        edges.push({ source: p.id, target: targetId });
      }
    }
  }

  return { nodes, edges, timestamp: Date.now() };
}

export function diffGraph(prev: GraphData, next: GraphData): GraphDiff {
  const prevNodeMap = new Map(prev.nodes.map((n) => [n.id, n]));
  const nextNodeMap = new Map(next.nodes.map((n) => [n.id, n]));

  const addedNodes: Node[] = [];
  const removedNodes: string[] = [];
  const updatedNodes: Node[] = [];

  for (const [id, node] of nextNodeMap) {
    if (!prevNodeMap.has(id)) {
      addedNodes.push(node);
    } else {
      const prevNode = prevNodeMap.get(id)!;
      if (prevNode.description !== node.description || prevNode.filePath !== node.filePath) {
        updatedNodes.push(node);
      }
    }
  }

  for (const id of prevNodeMap.keys()) {
    if (!nextNodeMap.has(id)) {
      removedNodes.push(id);
    }
  }

  const prevEdgeSet = new Set(prev.edges.map(edgeKey));
  const nextEdgeSet = new Set(next.edges.map(edgeKey));

  const addedEdges = next.edges.filter((e) => !prevEdgeSet.has(edgeKey(e)));
  const removedEdges = prev.edges.filter((e) => !nextEdgeSet.has(edgeKey(e)));

  return { addedNodes, removedNodes, updatedNodes, addedEdges, removedEdges };
}
