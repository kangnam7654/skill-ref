import { readFile } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';

export interface ParsedNode {
  id: string;
  name: string;
  type: 'skill' | 'agent';
  description: string;
  filePath: string;
  references: string[];
}

export async function parseFile(filePath: string): Promise<ParsedNode | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const { data: frontmatter, content } = matter(raw);

    const type: 'skill' | 'agent' = filePath.includes('/skills/') ? 'skill' : 'agent';

    let name: string;
    if (type === 'skill') {
      name = (frontmatter.name as string) || path.basename(path.dirname(filePath));
    } else {
      name = path.basename(filePath, '.md');
    }

    const description = (frontmatter.description as string) || '';

    return {
      id: `${type}:${name}`,
      name,
      type,
      description,
      filePath,
      references: [],
    };
  } catch {
    process.stderr.write(`[skill-ref] Failed to parse: ${filePath}\n`);
    return null;
  }
}

export function extractReferences(content: string, knownNames: Set<string>): string[] {
  const refs: string[] = [];
  for (const name of knownNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    if (regex.test(content)) {
      refs.push(name);
    }
  }
  return refs;
}
