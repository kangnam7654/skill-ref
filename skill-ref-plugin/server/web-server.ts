import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { WorkflowData } from './graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface WebServer {
  port: number;
  broadcastFull(data: WorkflowData): void;
  close(): Promise<void>;
}

function tryListen(
  server: http.Server,
  port: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

export async function startWebServer(
  port: number,
  getData: () => WorkflowData,
): Promise<WebServer> {
  const htmlPath = path.join(__dirname, 'static', 'index.html');

  const httpServer = http.createServer(async (_req, res) => {
    try {
      const html = await readFile(htmlPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  });

  let actualPort = port;
  let bound = false;
  for (let p = port; p <= port + 9; p++) {
    try {
      await tryListen(httpServer, p);
      actualPort = p;
      bound = true;
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }
  }

  if (!bound) {
    throw new Error(`All ports ${port}-${port + 9} are in use`);
  }

  const wss = new WebSocketServer({ server: httpServer });
  const clients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'full', data: getData() }));
    ws.on('close', () => clients.delete(ws));
  });

  function sendAll(msg: string) {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  return {
    port: actualPort,
    broadcastFull(data: WorkflowData) {
      sendAll(JSON.stringify({ type: 'full', data }));
    },
    close() {
      return new Promise((resolve) => {
        for (const ws of clients) ws.close();
        clients.clear();
        wss.close(() => {
          httpServer.close(() => resolve());
        });
      });
    },
  };
}
