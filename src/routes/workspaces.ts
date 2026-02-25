import { Hono } from 'hono';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  WorkspaceCreateSchema,
  WorkspaceUpdateSchema,
  WorkspaceMemberAddSchema,
  WorkspaceJoinSchema,
  WorkspaceBindGroupSchema,
  WorkspaceInviteCreateSchema,
} from '../schemas.js';
import type { AuthUser, Workspace, WorkspaceRole } from '../types.js';
import { GROUPS_DIR, DATA_DIR } from '../config.js';
import {
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
  deleteWorkspace,
  addWorkspaceMember,
  removeWorkspaceMember,
  getWorkspaceMembers,
  getWorkspaceMemberRole,
  createWorkspaceInvite,
  getWorkspaceInvite,
  markInviteAsUsed,
  listWorkspaceInvites,
  listWorkspaceTasks,
  getRegisteredGroup,
  setRegisteredGroup,
  ensureChatExists,
  getUserById,
} from '../db.js';
import { logger } from '../logger.js';
import { workspaceManager } from '../workspace-queue.js';
import { hasHostExecutionPermission } from '../web-context.js';

const workspaceRoutes = new Hono<{ Variables: Variables }>();

// --- Helper functions ---

function requireWorkspaceRole(
  workspaceId: number,
  userId: string,
  minRole: WorkspaceRole
): boolean {
  const role = getWorkspaceMemberRole(workspaceId, userId);
  if (!role) return false;

  const roleLevel: Record<WorkspaceRole, number> = {
    viewer: 0,
    member: 1,
    admin: 2,
    owner: 3,
  };

  return roleLevel[role] >= roleLevel[minRole];
}

function generateInviteCode(): string {
  return `WS-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
}

// --- Routes ---

// GET /api/workspaces - 列出用户的工作区
workspaceRoutes.get('/', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const workspaces = listWorkspaces(user.id);

  // 附加成员数量和角色信息
  const enriched = workspaces.map((ws) => {
    const members = getWorkspaceMembers(ws.id);
    const myRole = members.find((m) => m.user_id === user.id)?.role;
    return {
      ...ws,
      member_count: members.length,
      my_role: myRole,
    };
  });

  return c.json({ workspaces: enriched });
});

// POST /api/workspaces - 创建工作区
workspaceRoutes.post('/', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));

  const validation = WorkspaceCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body', details: validation.error }, 400);
  }

  const { name, execution_mode = 'container', max_parallel_tasks = 3 } = validation.data;

  // 检查 host 模式权限
  if (execution_mode === 'host' && !hasHostExecutionPermission(user)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403
    );
  }

  const now = new Date().toISOString();
  const folder = `workspace-${crypto.randomUUID()}`;

  // 创建工作区记录
  const workspaceId = createWorkspace({
    folder,
    name,
    owner_user_id: user.id,
    execution_mode,
    max_parallel_tasks,
    created_at: now,
  });

  // 创建工作目录
  const workspaceDir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(workspaceDir, { recursive: true });

  // 初始化记忆文件
  const claudeMdPath = path.join(workspaceDir, 'CLAUDE.md');
  fs.writeFileSync(
    claudeMdPath,
    `# Workspace: ${name}\n\n这是一个多人共享工作区。\n\n## 成员\n- @${user.username} (Owner)\n\n## 项目背景\n[待补充]\n`,
    'utf-8'
  );

  // 创建会话目录
  const sessionDir = path.join(DATA_DIR, 'sessions', folder, '.claude');
  fs.mkdirSync(sessionDir, { recursive: true });

  // 创建 IPC 目录
  const ipcDir = path.join(DATA_DIR, 'ipc', folder);
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });

  // 添加创建者为 owner
  addWorkspaceMember(workspaceId, user.id, 'owner');

  // 生成初始邀请码（24 小时有效，无限使用次数）
  const inviteCode = generateInviteCode();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  createWorkspaceInvite({
    workspace_id: workspaceId,
    code: inviteCode,
    created_by_user_id: user.id,
    expires_at: expiresAt,
    max_uses: 0,
    use_count: 0,
  });

  logger.info(
    { workspaceId, folder, userId: user.id, name },
    'Workspace created'
  );

  const workspace = getWorkspace(workspaceId)!;
  return c.json({
    workspace: {
      ...workspace,
      invite_code: inviteCode,
      my_role: 'owner',
      member_count: 1,
    },
  }, 201);
});

// GET /api/workspaces/:id - 工作区详情
workspaceRoutes.get('/:id', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const workspaceId = parseInt(c.req.param('id'), 10);

  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  // 检查成员资格
  const myRole = getWorkspaceMemberRole(workspaceId, user.id);
  if (!myRole) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const members = getWorkspaceMembers(workspaceId);

  return c.json({
    workspace: {
      ...workspace,
      my_role: myRole,
      members,
    },
  });
});

// PATCH /api/workspaces/:id - 更新工作区设置
workspaceRoutes.patch('/:id', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const workspaceId = parseInt(c.req.param('id'), 10);

  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  // 需要 admin 或 owner 权限
  if (!requireWorkspaceRole(workspaceId, user.id, 'admin')) {
    return c.json({ error: 'Insufficient permissions' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const validation = WorkspaceUpdateSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body', details: validation.error }, 400);
  }

  updateWorkspace(workspaceId, validation.data);

  logger.info({ workspaceId, userId: user.id, updates: validation.data }, 'Workspace updated');

  return c.json({ success: true });
});

// DELETE /api/workspaces/:id - 删除工作区
workspaceRoutes.delete('/:id', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const workspaceId = parseInt(c.req.param('id'), 10);

  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  // 仅 owner 可删除
  if (!requireWorkspaceRole(workspaceId, user.id, 'owner')) {
    return c.json({ error: 'Only owner can delete workspace' }, 403);
  }

  // 清理文件系统
  const workspaceDir = path.join(GROUPS_DIR, workspace.folder);
  fs.rmSync(workspaceDir, { recursive: true, force: true });

  const sessionDir = path.join(DATA_DIR, 'sessions', workspace.folder);
  fs.rmSync(sessionDir, { recursive: true, force: true });

  const ipcDir = path.join(DATA_DIR, 'ipc', workspace.folder);
  fs.rmSync(ipcDir, { recursive: true, force: true });

  // 删除数据库记录
  deleteWorkspace(workspaceId);

  logger.info({ workspaceId, folder: workspace.folder, userId: user.id }, 'Workspace deleted');

  return c.json({ success: true });
});

// --- Member Management ---

// GET /api/workspaces/:id/members - 列出成员
workspaceRoutes.get('/:id/members', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const workspaceId = parseInt(c.req.param('id'), 10);

  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  if (!getWorkspaceMemberRole(workspaceId, user.id)) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const members = getWorkspaceMembers(workspaceId);
  return c.json({ members });
});

// POST /api/workspaces/:id/members - 添加成员
workspaceRoutes.post('/:id/members', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const workspaceId = parseInt(c.req.param('id'), 10);

  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  // 需要 admin 权限
  if (!requireWorkspaceRole(workspaceId, user.id, 'admin')) {
    return c.json({ error: 'Insufficient permissions' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const validation = WorkspaceMemberAddSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body', details: validation.error }, 400);
  }

  const { user_id, role = 'member' } = validation.data;

  // 检查目标用户存在
  const targetUser = getUserById(user_id);
  if (!targetUser || targetUser.status !== 'active') {
    return c.json({ error: 'User not found or inactive' }, 404);
  }

  // 检查是否已经是成员
  if (getWorkspaceMemberRole(workspaceId, user_id)) {
    return c.json({ error: 'User is already a member' }, 409);
  }

  addWorkspaceMember(workspaceId, user_id, role);

  logger.info(
    { workspaceId, targetUserId: user_id, role, addedBy: user.id },
    'Workspace member added'
  );

  const members = getWorkspaceMembers(workspaceId);
  return c.json({ success: true, members });
});

// DELETE /api/workspaces/:id/members/:userId - 移除成员
workspaceRoutes.delete('/:id/members/:userId', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const workspaceId = parseInt(c.req.param('id'), 10);
  const targetUserId = c.req.param('userId');

  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  // 自己离开 or admin 移除他人
  const isSelfRemoval = targetUserId === user.id;
  if (!isSelfRemoval && !requireWorkspaceRole(workspaceId, user.id, 'admin')) {
    return c.json({ error: 'Insufficient permissions' }, 403);
  }

  const targetRole = getWorkspaceMemberRole(workspaceId, targetUserId);
  if (!targetRole) {
    return c.json({ error: 'User is not a member' }, 404);
  }

  // Owner 不能被移除
  if (targetRole === 'owner') {
    return c.json({ error: 'Cannot remove the owner' }, 400);
  }

  removeWorkspaceMember(workspaceId, targetUserId);

  logger.info(
    { workspaceId, targetUserId, removedBy: user.id, isSelfRemoval },
    'Workspace member removed'
  );

  const members = getWorkspaceMembers(workspaceId);
  return c.json({ success: true, members });
});

// --- Invite Management ---

// POST /api/workspaces/:id/invites - 生成邀请码
workspaceRoutes.post('/:id/invites', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const workspaceId = parseInt(c.req.param('id'), 10);

  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  // 需要 admin 权限
  if (!requireWorkspaceRole(workspaceId, user.id, 'admin')) {
    return c.json({ error: 'Insufficient permissions' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const validation = WorkspaceInviteCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body', details: validation.error }, 400);
  }

  const { expires_in_hours = 24, max_uses = 0 } = validation.data;

  const code = generateInviteCode();
  const expiresAt = new Date(Date.now() + expires_in_hours * 60 * 60 * 1000).toISOString();

  createWorkspaceInvite({
    workspace_id: workspaceId,
    code,
    created_by_user_id: user.id,
    expires_at: expiresAt,
    max_uses,
    use_count: 0,
  });

  logger.info({ workspaceId, code, expiresInHours: expires_in_hours }, 'Workspace invite created');

  return c.json({
    invite_code: code,
    expires_at: expiresAt,
    // 可选：生成 Web URL
    url: `${c.req.url.split('/api/')[0]}/workspaces/join?code=${code}`,
  });
});

// GET /api/workspaces/:id/invites - 列出邀请码
workspaceRoutes.get('/:id/invites', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const workspaceId = parseInt(c.req.param('id'), 10);

  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  // 需要 admin 权限
  if (!requireWorkspaceRole(workspaceId, user.id, 'admin')) {
    return c.json({ error: 'Insufficient permissions' }, 403);
  }

  const invites = listWorkspaceInvites(workspaceId);
  return c.json({ invites });
});

// POST /api/workspaces/join - 使用邀请码加入工作区
workspaceRoutes.post('/join', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));

  const validation = WorkspaceJoinSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body', details: validation.error }, 400);
  }

  const { invite_code } = validation.data;

  const invite = getWorkspaceInvite(invite_code);
  if (!invite) {
    return c.json({ error: 'Invalid or expired invite code' }, 404);
  }

  // 检查是否已用完（max_uses > 0 表示有使用次数限制）
  if (invite.max_uses > 0 && invite.use_count >= invite.max_uses) {
    return c.json({ error: 'Invite code has reached its maximum usage limit' }, 400);
  }

  // 检查是否过期
  if (new Date(invite.expires_at) < new Date()) {
    return c.json({ error: 'Invite code expired' }, 400);
  }

  // 检查是否已经是成员
  if (getWorkspaceMemberRole(invite.workspace_id, user.id)) {
    return c.json({ error: 'You are already a member of this workspace' }, 409);
  }

  // 添加成员
  addWorkspaceMember(invite.workspace_id, user.id, 'member');

  // 标记邀请码为已使用
  markInviteAsUsed(invite_code, user.id);

  logger.info(
    { workspaceId: invite.workspace_id, userId: user.id, inviteCode: invite_code },
    'User joined workspace via invite'
  );

  const workspace = getWorkspace(invite.workspace_id)!;
  return c.json({ success: true, workspace });
});

// --- Task Management ---

// GET /api/workspaces/:id/tasks - 任务列表
workspaceRoutes.get('/:id/tasks', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const workspaceId = parseInt(c.req.param('id'), 10);

  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  if (!getWorkspaceMemberRole(workspaceId, user.id)) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const status = c.req.query('status') as 'queued' | 'running' | 'completed' | 'failed' | undefined;
  const tasks = status
    ? listWorkspaceTasks(workspaceId, status)
    : listWorkspaceTasks(workspaceId);

  return c.json({ tasks });
});

// GET /api/workspaces/:id/dashboard - 任务看板数据
workspaceRoutes.get('/:id/dashboard', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const workspaceId = parseInt(c.req.param('id'), 10);

  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  if (!getWorkspaceMemberRole(workspaceId, user.id)) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const running = listWorkspaceTasks(workspaceId, 'running');
  const queued = listWorkspaceTasks(workspaceId, 'queued');
  const allCompleted = listWorkspaceTasks(workspaceId, 'completed');

  // 统计今日完成的任务
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const completedToday = allCompleted.filter(
    (t) => t.completed_at && new Date(t.completed_at) >= todayStart
  );

  return c.json({
    dashboard: {
      running,
      queued,
      completed_today_count: completedToday.length,
      completed_today: completedToday.slice(0, 20), // 最近 20 条
    },
  });
});

// POST /api/workspaces/:id/tasks/:taskId/stop - 停止任务
workspaceRoutes.post('/:id/tasks/:taskId/stop', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const workspaceId = parseInt(c.req.param('id'), 10);
  const taskId = parseInt(c.req.param('taskId'), 10);

  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  // 需要 member 权限
  if (!requireWorkspaceRole(workspaceId, user.id, 'member')) {
    return c.json({ error: 'Insufficient permissions' }, 403);
  }

  const stopped = await workspaceManager.stopTask(workspaceId, taskId);
  if (!stopped) {
    return c.json({ error: 'Task not running or not found' }, 404);
  }

  logger.info({ workspaceId, taskId, userId: user.id }, 'Task stopped by user');

  return c.json({ success: true });
});

// --- Group Binding ---

// POST /api/workspaces/:id/bind-group - 绑定飞书/Telegram 群组
workspaceRoutes.post('/:id/bind-group', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const workspaceId = parseInt(c.req.param('id'), 10);

  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  // 需要 admin 权限
  if (!requireWorkspaceRole(workspaceId, user.id, 'admin')) {
    return c.json({ error: 'Insufficient permissions' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const validation = WorkspaceBindGroupSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body', details: validation.error }, 400);
  }

  const { group_jid } = validation.data;

  const group = getRegisteredGroup(group_jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  // 检查该群组是否已绑定其他工作区
  if (group.workspace_id && group.workspace_id !== workspaceId) {
    return c.json({ error: 'Group is already bound to another workspace' }, 409);
  }

  // 更新群组绑定
  setRegisteredGroup(group_jid, {
    ...group,
    workspace_id: workspaceId,
    is_shared_workspace: true,
  });

  // 确保 chat 记录存在
  ensureChatExists(group_jid);

  logger.info({ workspaceId, groupJid: group_jid, userId: user.id }, 'Group bound to workspace');

  return c.json({ success: true });
});

export default workspaceRoutes;
