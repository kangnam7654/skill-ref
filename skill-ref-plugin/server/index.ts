import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { buildWorkflowData, type WorkflowData } from './graph.js';
import { createWatcher } from './watcher.js';
import { startWebServer, type WebServer } from './web-server.js';

const homeDir = os.homedir();
const skillsDir = path.join(homeDir, '.claude', 'skills');
const agentsDir = path.join(homeDir, '.claude', 'agents');

let currentData: WorkflowData = { skills: [], agents: [], trees: [], timestamp: 0 };
let webServer: WebServer | null = null;

async function rebuildAndBroadcast() {
  currentData = await buildWorkflowData(skillsDir, agentsDir);
  if (webServer) webServer.broadcastFull(currentData);
}

async function main() {
  // Build initial workflow data
  currentData = await buildWorkflowData(skillsDir, agentsDir);

  // Start web server
  try {
    webServer = await startWebServer(7890, () => currentData);
    process.stderr.write(`[skill-ref] Viewer at http://localhost:${webServer.port}\n`);
  } catch (err) {
    process.stderr.write(`[skill-ref] Web server failed: ${err}\n`);
  }

  // Start watcher
  const watcher = createWatcher([skillsDir, agentsDir], () => {
    rebuildAndBroadcast().catch((err) => {
      process.stderr.write(`[skill-ref] Rebuild error: ${err}\n`);
    });
  });

  // MCP Server
  const server = new Server(
    { name: 'skill-ref', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'scan_graph',
        description:
          'Returns the current skill workflow data as JSON. Contains skill workflows with steps, agent metadata, and expanded workflow trees.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'open_viewer',
        description:
          'Opens the interactive workflow viewer in the default browser.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;

    if (name === 'scan_graph') {
      return {
        content: [{ type: 'text', text: JSON.stringify(currentData, null, 2) }],
      };
    }

    if (name === 'open_viewer') {
      const port = webServer?.port;
      if (!port) {
        return {
          content: [{ type: 'text', text: 'Web server is not running. Could not open viewer.' }],
          isError: true,
        };
      }

      const url = `http://localhost:${port}`;
      const platform = process.platform;
      const cmd = platform === 'darwin' ? 'open' : platform === 'linux' ? 'xdg-open' : 'start';

      try {
        await new Promise<void>((resolve, reject) => {
          exec(`${cmd} ${url}`, (err) => (err ? reject(err) : resolve()));
        });
      } catch {
        // Command failed — still return URL
      }

      return {
        content: [
          {
            type: 'text',
            text: `Viewer opened at ${url}. If the browser did not open, navigate to ${url} manually.`,
          },
        ],
      };
    }

    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Cleanup on exit
  process.on('SIGINT', async () => {
    watcher.close();
    if (webServer) await webServer.close();
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`[skill-ref] Fatal: ${err}\n`);
  process.exit(1);
});
