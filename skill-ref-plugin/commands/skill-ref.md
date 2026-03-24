---
name: skill-ref
description: Open the interactive skill/agent reference graph viewer in your browser. Shows real-time relationships between all skills and agents in your Claude Code setup.
---

# /skill-ref

Opens the interactive reference graph viewer.

When the user runs `/skill-ref`, call the `open_viewer` MCP tool from the `skill-ref` MCP server. This will open a browser window at `http://localhost:7890` (or the next available port up to 7899) showing a force-directed graph of all skills and agents.

The graph updates in real-time as skills and agents are created, modified, or deleted.

If the browser does not open automatically, instruct the user to navigate to the URL manually.

To get the raw graph data as JSON without opening a browser, use the `scan_graph` MCP tool instead.
