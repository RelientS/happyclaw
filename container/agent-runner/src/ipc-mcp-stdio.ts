/**
 * Stdio MCP Server for HappyClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = process.env.HAPPYCLAW_WORKSPACE_IPC || '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.HAPPYCLAW_CHAT_JID!;
const groupFolder = process.env.HAPPYCLAW_GROUP_FOLDER!;
const _isHome = process.env.HAPPYCLAW_IS_HOME === '1';
const isAdminHome = process.env.HAPPYCLAW_IS_ADMIN_HOME === '1';
// Effective permission: cross-group operations require admin home
const hasCrossGroupAccess = isAdminHome;

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'happyclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  { text: z.string().describe('The message text to send') },
  async (args) => {
    const data = {
      type: 'message',
      chatJid,
      text: args.text,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Admin home only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00.000Z".` }],
          isError: true,
        };
      }
    }

    // Only admin home can schedule tasks for other groups
    const targetJid = hasCrossGroupAccess && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From admin home: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = hasCrossGroupAccess
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain: hasCrossGroupAccess,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain: hasCrossGroupAccess,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain: hasCrossGroupAccess,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new group so the agent can respond to messages there. Admin home only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
  {
    jid: z.string().describe('The chat JID (e.g., "feishu:oc_xxxx")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
  },
  async (args) => {
    if (!hasCrossGroupAccess) {
      return {
        content: [{ type: 'text' as const, text: 'Only the admin home container can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// --- Sub-Agent tools ---

const AGENTS_DIR = path.join(IPC_DIR, 'agents');

server.tool(
  'spawn_agent',
  `Spawn a sub-agent to work on a task in parallel. The sub-agent runs independently with its own context and can access the same workspace files.

Use this when you identify tasks that can be parallelized. For example:
- "Implement the login page" + "Implement the API endpoints" → spawn both in parallel
- "Research library X" + "Research library Y" → spawn both, compare results when done

The sub-agent will execute autonomously and its result will be injected back into your conversation when it completes. You can continue working on other things while sub-agents run.

Limitations:
- Sub-agents share the same workspace files (coordinate to avoid conflicts)
- Sub-agents cannot spawn their own sub-agents
- Results are delivered asynchronously — use list_agents to check status`,
  {
    name: z.string().describe('Short descriptive name for the agent (e.g., "前端开发", "API调试")'),
    prompt: z.string().describe('The task prompt for the sub-agent. Be specific and self-contained.'),
  },
  async (args) => {
    const agentId = `agt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.mkdirSync(AGENTS_DIR, { recursive: true });

    const data = {
      type: 'spawn_agent',
      agentId,
      name: args.name,
      prompt: args.prompt,
      chatJid,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(AGENTS_DIR, data);

    return {
      content: [{
        type: 'text' as const,
        text: `Sub-agent "${args.name}" spawned (ID: ${agentId}). It will run independently and results will be injected into your conversation when complete. Use list_agents to check status.`,
      }],
    };
  },
);

server.tool(
  'message_agent',
  `Send a message to a running sub-agent. Use this to relay information from other agents, provide additional instructions, or send follow-up context.`,
  {
    agent_id: z.string().describe('The sub-agent ID (e.g., "agt-xxx")'),
    message: z.string().describe('The message to send to the sub-agent'),
  },
  async (args) => {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });

    const data = {
      type: 'message_agent',
      agentId: args.agent_id,
      message: args.message,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(AGENTS_DIR, data);

    return {
      content: [{
        type: 'text' as const,
        text: `Message sent to agent ${args.agent_id}.`,
      }],
    };
  },
);

server.tool(
  'list_agents',
  `List all sub-agents and their current status. Shows running, completed, and errored agents.`,
  {},
  async () => {
    const statusFile = path.join(AGENTS_DIR, 'status.json');
    try {
      if (!fs.existsSync(statusFile)) {
        return { content: [{ type: 'text' as const, text: 'No sub-agents found.' }] };
      }

      const agents = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
      if (!Array.isArray(agents) || agents.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No sub-agents found.' }] };
      }

      const formatted = agents.map(
        (a: { id: string; name: string; status: string; result_summary?: string; created_at: string }) => {
          const statusIcon = a.status === 'running' ? '🔄' : a.status === 'completed' ? '✅' : '❌';
          let line = `${statusIcon} [${a.id}] ${a.name} — ${a.status}`;
          if (a.result_summary) {
            line += `\n   Result: ${a.result_summary.slice(0, 200)}`;
          }
          return line;
        },
      ).join('\n');

      return {
        content: [{ type: 'text' as const, text: `Sub-agents:\n${formatted}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading agent status: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

// --- Skill installation tool ---

server.tool(
  'install_skill',
  `Install a skill from the skills registry (skills.sh). The skill will be available in future conversations.
Example packages: "anthropic/memory", "anthropic/think", "owner/repo", "owner/repo@skill-name".`,
  {
    package: z.string().describe('The skill package to install, format: owner/repo or owner/repo@skill'),
  },
  async (args) => {
    const pkg = args.package.trim();
    if (!/^[\w\-]+\/[\w\-.]+(?:[@#][\w\-.\/]+)?$/.test(pkg)) {
      return {
        content: [{ type: 'text' as const, text: `Invalid package format: "${pkg}". Expected format: owner/repo or owner/repo@skill` }],
        isError: true,
      };
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const resultFileName = `install_skill_result_${requestId}.json`;
    const resultFilePath = path.join(TASKS_DIR, resultFileName);

    // Write IPC request
    const data = {
      type: 'install_skill',
      package: pkg,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    // Poll for result file (timeout 120s)
    const timeout = 120_000;
    const pollInterval = 500;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      try {
        if (fs.existsSync(resultFilePath)) {
          const raw = fs.readFileSync(resultFilePath, 'utf-8');
          fs.unlinkSync(resultFilePath);
          const result = JSON.parse(raw);

          if (result.success) {
            const installed = (result.installed || []).join(', ') || pkg;
            return {
              content: [{ type: 'text' as const, text: `Skill installed successfully: ${installed}\n\nNote: The skill will be available in the next conversation (new container/process).` }],
            };
          } else {
            return {
              content: [{ type: 'text' as const, text: `Failed to install skill "${pkg}": ${result.error || 'Unknown error'}` }],
              isError: true,
            };
          }
        }
      } catch {
        // ignore read errors, retry
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return {
      content: [{ type: 'text' as const, text: `Timeout waiting for skill installation result (${timeout / 1000}s). The installation may still be in progress.` }],
      isError: true,
    };
  },
);

server.tool(
  'uninstall_skill',
  `Uninstall a user-level skill by its ID. Project-level skills cannot be uninstalled.
Use the skills panel in the UI to find the skill ID (directory name, e.g. "memory", "think").`,
  {
    skill_id: z.string().describe('The skill ID to uninstall (the directory name, e.g. "memory", "think")'),
  },
  async (args) => {
    const skillId = args.skill_id.trim();
    if (!skillId || !/^[\w\-]+$/.test(skillId)) {
      return {
        content: [{ type: 'text' as const, text: `Invalid skill ID: "${skillId}". Must be alphanumeric with hyphens/underscores.` }],
        isError: true,
      };
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const resultFileName = `uninstall_skill_result_${requestId}.json`;
    const resultFilePath = path.join(TASKS_DIR, resultFileName);

    const data = {
      type: 'uninstall_skill',
      skillId,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    // Poll for result file (timeout 30s — uninstall is fast)
    const timeout = 30_000;
    const pollInterval = 500;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      try {
        if (fs.existsSync(resultFilePath)) {
          const raw = fs.readFileSync(resultFilePath, 'utf-8');
          fs.unlinkSync(resultFilePath);
          const result = JSON.parse(raw);

          if (result.success) {
            return {
              content: [{ type: 'text' as const, text: `Skill "${skillId}" uninstalled successfully.` }],
            };
          } else {
            return {
              content: [{ type: 'text' as const, text: `Failed to uninstall skill "${skillId}": ${result.error || 'Unknown error'}` }],
              isError: true,
            };
          }
        }
      } catch {
        // ignore read errors, retry
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return {
      content: [{ type: 'text' as const, text: `Timeout waiting for skill uninstall result.` }],
      isError: true,
    };
  },
);

// --- Memory tools ---

const WORKSPACE_GROUP = process.env.HAPPYCLAW_WORKSPACE_GROUP || '/workspace/group';
const WORKSPACE_GLOBAL = process.env.HAPPYCLAW_WORKSPACE_GLOBAL || '/workspace/global';
const WORKSPACE_MEMORY = process.env.HAPPYCLAW_WORKSPACE_MEMORY || '/workspace/memory';
const MEMORY_EXTENSIONS = new Set(['.md', '.txt']);
const MEMORY_SUBDIRS = new Set(['memory', 'conversations']);
const MEMORY_SKIP_DIRS = new Set(['logs', '.claude', 'node_modules', '.git']);
const MAX_MEMORY_FILE_SIZE = 512 * 1024; // 512KB per file
const MAX_MEMORY_APPEND_SIZE = 16 * 1024; // 16KB per append
const MEMORY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function collectMemoryFiles(baseDir: string, out: string[], maxDepth: number, depth = 0): void {
  if (depth > maxDepth || !fs.existsSync(baseDir)) return;
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(baseDir, entry.name);
      if (entry.isDirectory()) {
        if (MEMORY_SKIP_DIRS.has(entry.name)) continue;
        if (depth === 0 || MEMORY_SUBDIRS.has(entry.name)) {
          collectMemoryFiles(fullPath, out, maxDepth, depth + 1);
        }
      } else if (entry.isFile()) {
        if (entry.name === 'CLAUDE.md' || MEMORY_EXTENSIONS.has(path.extname(entry.name))) {
          out.push(fullPath);
        }
      }
    }
  } catch { /* skip unreadable */ }
}

function toRelativePath(filePath: string): string {
  if (filePath === WORKSPACE_GLOBAL || filePath.startsWith(WORKSPACE_GLOBAL + path.sep)) {
    return `[global] ${path.relative(WORKSPACE_GLOBAL, filePath)}`;
  }
  if (filePath === WORKSPACE_MEMORY || filePath.startsWith(WORKSPACE_MEMORY + path.sep)) {
    return `[memory] ${path.relative(WORKSPACE_MEMORY, filePath)}`;
  }
  return path.relative(WORKSPACE_GROUP, filePath);
}

function parseMemoryFileReference(fileRef: string): { pathRef: string; lineFromRef?: number } {
  const trimmed = fileRef.trim();
  const lineRefMatch = trimmed.match(/^(.*?):(\d+)$/);
  if (!lineRefMatch) return { pathRef: trimmed };

  const lineFromRef = Number(lineRefMatch[2]);
  if (!Number.isInteger(lineFromRef) || lineFromRef <= 0) {
    return { pathRef: trimmed };
  }
  return { pathRef: lineRefMatch[1].trim(), lineFromRef };
}

server.tool(
  'memory_append',
  `将**时效性记忆**追加到 memory/YYYY-MM-DD.md（独立记忆目录，不在工作区内）。
仅追加写入，不会覆盖已有内容。

仅用于明确只跟当天/短期有关的信息：今日项目进展、临时技术决策、待办事项、会议要点等。

**重要**：下次对话仍可能用到的信息（用户身份、偏好、常用项目、用户说"记住"的内容）应直接用 Edit 工具编辑 /workspace/global/CLAUDE.md，不要用此工具。`,
  {
    content: z.string().describe('要追加的记忆内容'),
    date: z.string().optional().describe('目标日期，格式 YYYY-MM-DD（默认：今天）'),
  },
  async (args) => {
    const normalizedContent = args.content.replace(/\r\n?/g, '\n').trim();
    if (!normalizedContent) {
      return {
        content: [{ type: 'text' as const, text: '内容不能为空。' }],
        isError: true,
      };
    }

    const appendBytes = Buffer.byteLength(normalizedContent, 'utf-8');
    if (appendBytes > MAX_MEMORY_APPEND_SIZE) {
      return {
        content: [{
          type: 'text' as const,
          text: `内容过大：${appendBytes} 字节（上限 ${MAX_MEMORY_APPEND_SIZE}）。`,
        }],
        isError: true,
      };
    }

    const date = (args.date ?? new Date().toISOString().split('T')[0]).trim();
    if (!MEMORY_DATE_PATTERN.test(date)) {
      return {
        content: [{ type: 'text' as const, text: `日期格式无效："${date}"，请使用 YYYY-MM-DD。` }],
        isError: true,
      };
    }

    const resolvedPath = path.normalize(path.join(WORKSPACE_MEMORY, `${date}.md`));
    const inMemory = resolvedPath === WORKSPACE_MEMORY || resolvedPath.startsWith(WORKSPACE_MEMORY + path.sep);
    if (!inMemory) {
      return {
        content: [{ type: 'text' as const, text: '访问被拒绝：路径超出工作区范围。' }],
        isError: true,
      };
    }

    try {
      fs.mkdirSync(WORKSPACE_MEMORY, { recursive: true });

      const fileExists = fs.existsSync(resolvedPath);
      const currentSize = fileExists ? fs.statSync(resolvedPath).size : 0;
      const separator = currentSize > 0 ? '\n---\n\n' : '';
      const entry = `${separator}### ${new Date().toISOString()}\n${normalizedContent}\n`;
      const nextSize = currentSize + Buffer.byteLength(entry, 'utf-8');

      if (nextSize > MAX_MEMORY_FILE_SIZE) {
        return {
          content: [{
            type: 'text' as const,
            text: `记忆文件将超过 ${MAX_MEMORY_FILE_SIZE} 字节上限，请缩短内容。`,
          }],
          isError: true,
        };
      }

      fs.appendFileSync(resolvedPath, entry, 'utf-8');
      return {
        content: [{ type: 'text' as const, text: `已追加到 memory/${date}.md（${appendBytes} 字节）。` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `追加记忆时出错：${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'memory_search',
  `在工作区的记忆文件中搜索（CLAUDE.md、memory/、conversations/ 及其他 .md/.txt 文件）。
返回文件路径、行号和上下文片段。超过 512KB 的文件会被跳过。
用于回忆过去的决策、偏好、项目上下文或对话历史。`,
  {
    query: z.string().describe('搜索关键词或短语（不区分大小写）'),
    max_results: z.number().optional().default(20).describe('最大结果数（默认 20，上限 50）'),
  },
  async (args) => {
    if (!args.query.trim()) {
      return { content: [{ type: 'text' as const, text: '搜索关键词不能为空。' }], isError: true };
    }
    const maxResults = Math.min(Math.max(args.max_results ?? 20, 1), 50);
    const queryLower = args.query.toLowerCase();

    const files: string[] = [];
    collectMemoryFiles(WORKSPACE_MEMORY, files, 4);
    collectMemoryFiles(WORKSPACE_GROUP, files, 4);
    collectMemoryFiles(WORKSPACE_GLOBAL, files, 4);
    const uniqueFiles = Array.from(new Set(files));

    if (uniqueFiles.length === 0) {
      return { content: [{ type: 'text' as const, text: '未找到记忆文件。' }] };
    }

    const results: string[] = [];
    let skippedLarge = 0;

    for (const filePath of uniqueFiles) {
      if (results.length >= maxResults) break;
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_MEMORY_FILE_SIZE) { skippedLarge++; continue; }
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        let lastEnd = -1; // track last emitted context range to skip overlapping matches
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxResults) break;
          if (lines[i].toLowerCase().includes(queryLower)) {
            const start = Math.max(0, i - 1);
            if (start <= lastEnd) continue; // skip overlapping context
            const end = Math.min(lines.length, i + 2);
            lastEnd = end;
            const snippet = lines.slice(start, end).join('\n');
            results.push(`${toRelativePath(filePath)}:${i + 1}\n${snippet}`);
          }
        }
      } catch { /* skip unreadable */ }
    }

    const skippedNote = skippedLarge > 0 ? `（跳过 ${skippedLarge} 个大文件）` : '';

    if (results.length === 0) {
      return { content: [{ type: 'text' as const, text: `在 ${uniqueFiles.length} 个记忆文件中未找到"${args.query}"的匹配。${skippedNote}` }] };
    }

    return {
      content: [{ type: 'text' as const, text: `找到 ${results.length} 条匹配${skippedNote}：\n\n${results.join('\n---\n')}` }],
    };
  },
);

server.tool(
  'memory_get',
  `读取记忆文件或指定行范围。在 memory_search 之后使用以获取完整上下文。`,
  {
    file: z.string().describe('相对路径，可带 :行号（如 "CLAUDE.md:12"、"[global] CLAUDE.md:8" 或 "[memory] 2026-01-15.md"）'),
    from_line: z.number().optional().describe('起始行号（从 1 开始，默认：1）'),
    lines: z.number().optional().describe('读取行数（默认：全部，上限：200）'),
  },
  async (args) => {
    const { pathRef, lineFromRef } = parseMemoryFileReference(args.file);
    let resolvedPath: string;
    if (pathRef.startsWith('[global] ')) {
      resolvedPath = path.join(WORKSPACE_GLOBAL, pathRef.slice('[global] '.length));
    } else if (pathRef.startsWith('[memory] ')) {
      resolvedPath = path.join(WORKSPACE_MEMORY, pathRef.slice('[memory] '.length));
    } else {
      resolvedPath = path.join(WORKSPACE_GROUP, pathRef);
    }

    // Security: normalize and ensure within allowed directories
    resolvedPath = path.normalize(resolvedPath);
    const inGroup = resolvedPath === WORKSPACE_GROUP || resolvedPath.startsWith(WORKSPACE_GROUP + path.sep);
    const inGlobal = resolvedPath === WORKSPACE_GLOBAL || resolvedPath.startsWith(WORKSPACE_GLOBAL + path.sep);
    const inMemory = resolvedPath === WORKSPACE_MEMORY || resolvedPath.startsWith(WORKSPACE_MEMORY + path.sep);
    if (!inGroup && !inGlobal && !inMemory) {
      return {
        content: [{ type: 'text' as const, text: '访问被拒绝：路径超出工作区范围。' }],
        isError: true,
      };
    }

    if (!fs.existsSync(resolvedPath)) {
      return {
        content: [{ type: 'text' as const, text: `文件未找到：${pathRef}` }],
        isError: true,
      };
    }

    try {
      const content = fs.readFileSync(resolvedPath, 'utf-8');
      const allLines = content.split('\n');
      const fromLine = Math.max((args.from_line ?? lineFromRef ?? 1) - 1, 0);
      const maxLines = Math.min(args.lines ?? allLines.length, 200);
      const slice = allLines.slice(fromLine, fromLine + maxLines);

      const header = `${pathRef}（第 ${fromLine + 1}-${fromLine + slice.length} 行，共 ${allLines.length} 行）`;
      return {
        content: [{ type: 'text' as const, text: `${header}\n\n${slice.join('\n')}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `读取文件时出错：${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
