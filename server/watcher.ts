import fs from 'node:fs';
import path from 'node:path';

export interface FileEvent {
  type: 'change' | 'unlink';
  filePath: string;
}

export interface Watcher {
  close(): void;
}

export function createWatcher(
  dirs: string[],
  onChange: (events: FileEvent[]) => void,
): Watcher {
  const watchers: fs.FSWatcher[] = [];
  let pendingEvents: FileEvent[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const watcher = fs.watch(dir, { recursive: true }, (_eventType, filename) => {
      if (!filename || !filename.endsWith('.md')) return;

      const filePath = path.join(dir, filename);
      const type: FileEvent['type'] = fs.existsSync(filePath) ? 'change' : 'unlink';

      pendingEvents.push({ type, filePath });

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const events = pendingEvents;
        pendingEvents = [];
        debounceTimer = null;
        onChange(events);
      }, 300);
    });

    watchers.push(watcher);
  }

  return {
    close() {
      if (debounceTimer) clearTimeout(debounceTimer);
      for (const w of watchers) w.close();
    },
  };
}
