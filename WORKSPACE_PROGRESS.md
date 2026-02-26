# Shared Workspace 功能实施进度

## 已完成 (Phase 1-2)

### ✅ Phase 1: 数据模型完善

**数据库 Schema v18 Migration**
- ✅ `workspaces` 表：存储工作区元信息
  - id, folder, name, owner_user_id, execution_mode, max_parallel_tasks, created_at
- ✅ `workspace_members` 表：工作区成员关系
  - id, workspace_id, user_id, role (owner/admin/member/viewer), joined_at
- ✅ `workspace_tasks` 表：任务队列
  - id, workspace_id, requested_by_user_id, message, task_type, status, priority, queue_position, started_at, completed_at, result, created_at
- ✅ `workspace_invites` 表：邀请码系统
  - id, workspace_id, code, created_by_user_id, expires_at, used_at, used_by_user_id
- ✅ `registered_groups` 表新增字段
  - workspace_id: 绑定到的工作区 ID
  - is_shared_workspace: 标记是否为共享工作区入口

**TypeScript 类型定义**
- ✅ 新增类型：Workspace, WorkspaceMember, WorkspaceTask, WorkspaceInvite
- ✅ 新增枚举：WorkspaceRole, TaskType, WorkspaceTaskStatus
- ✅ WebSocket 消息类型扩展：workspace.task.*, workspace.queue.updated

**数据库 CRUD 函数**
- ✅ 工作区管理：createWorkspace, getWorkspace, listWorkspaces, updateWorkspace, deleteWorkspace
- ✅ 成员管理：addWorkspaceMember, removeWorkspaceMember, getWorkspaceMembers, getWorkspaceMemberRole
- ✅ 任务管理：createWorkspaceTask, getWorkspaceTask, listWorkspaceTasks, updateWorkspaceTask
- ✅ 邀请管理：createWorkspaceInvite, getWorkspaceInvite, markInviteAsUsed, listWorkspaceInvites

### ✅ Phase 2: 核心逻辑实现（部分）

**任务分类器 (`src/task-classifier.ts`)**
- ✅ 基于规则的分类逻辑
  - quick: 快速查询 (<5s，如天气、时间、翻译、简单计算)
  - simple: 简单任务 (基本分析)
  - complex: 复杂任务 (代码编辑、文件操作、深入分析)
  - background: 后台任务 (定时、监控)
- ✅ 置信度评分机制
- ⏳ AI 分类接口（预留，暂未实现）

**工作区队列管理器 (`src/workspace-queue.ts`)**
- ✅ `WorkspaceQueue` 类
  - 任务队列管理（addTask, processQueue, executeTask）
  - 智能调度（快速任务立即执行，不占队列位）
  - 并发控制（max_parallel_tasks 限制）
  - 事件发射（task.created, task.started, task.completed, queue.updated）
  - 任务停止功能（stopTask）
- ✅ `WorkspaceManager` 类
  - 全局队列管理
  - 事件转发到 WebSocket
  - 单例模式（workspaceManager）

---

## 待完成 (Phase 3-5)

### ✅ Phase 3: API 路由 (优先级 P0)

**创建 `src/routes/workspaces.ts`**

基础 CRUD:
- ✅ `POST /api/workspaces` - 创建工作区
- ✅ `GET /api/workspaces` - 列出用户的工作区
- ✅ `GET /api/workspaces/:id` - 工作区详情
- ✅ `PATCH /api/workspaces/:id` - 更新工作区设置
- ✅ `DELETE /api/workspaces/:id` - 删除工作区

成员管理:
- ✅ `GET /api/workspaces/:id/members` - 列出成员
- ✅ `POST /api/workspaces/:id/members` - 添加成员（需权限）
- ✅ `DELETE /api/workspaces/:id/members/:userId` - 移除成员

邀请系统:
- ✅ `POST /api/workspaces/:id/invites` - 生成邀请码
- ✅ `POST /api/workspaces/join` - 使用邀请码加入
- ✅ `GET /api/workspaces/:id/invites` - 列出邀请码

任务管理:
- ✅ `GET /api/workspaces/:id/tasks` - 任务列表（running/queued/completed）
- ✅ `GET /api/workspaces/:id/dashboard` - 任务看板数据
- ✅ `POST /api/workspaces/:id/tasks/:taskId/stop` - 停止任务

群组绑定:
- ✅ `POST /api/workspaces/:id/bind-group` - 绑定飞书/Telegram 群组到工作区

**Zod Schemas**
- ✅ WorkspaceCreateSchema
- ✅ WorkspaceUpdateSchema
- ✅ WorkspaceMemberAddSchema
- ✅ WorkspaceJoinSchema
- ✅ WorkspaceBindGroupSchema
- ✅ WorkspaceInviteCreateSchema

### ✅ Phase 4: WebSocket 实时同步 (优先级 P1)

**修改 `src/web.ts`**
- ✅ 实现 `broadcastToWorkspace(workspaceId, event)` 函数
- ✅ WebSocket 订阅机制（基于工作区成员权限过滤）
- ✅ 集成 workspaceManager 事件到 WebSocket 广播

**事件流**:
```
workspaceManager.on('workspace.task.created') → broadcastToWorkspace() → 所有订阅该工作区的 WS 客户端
workspaceManager.on('workspace.task.started') → ...
workspaceManager.on('workspace.task.progress') → ...
workspaceManager.on('workspace.task.completed') → ...
workspaceManager.on('workspace.queue.updated') → ...
```

**实现细节**:
- `broadcastToWorkspace()` 函数通过 `getWorkspaceMembers()` 获取成员列表，使用 `safeBroadcast()` 过滤权限
- 在 `startWebServer()` 中注册 5 个 workspaceManager 事件监听器
- WsMessageOut 类型已扩展以支持工作区事件

### ✅ Phase 5: 消息路由增强 (优先级 P0)

**修改 `src/index.ts`**

在现有消息处理逻辑中添加：
```typescript
async function processWorkspaceMessage(
  chatJid: string,
  workspaceId: number,
  messages: NewMessage[]
): Promise<void> {
  // 1. 权限检查（是否为工作区成员）
  const memberRole = getWorkspaceMemberRole(workspaceId, senderId);
  if (!memberRole || memberRole === 'viewer') {
    await sendMessage(chatJid, '@{user} 你没有在此工作区发起任务的权限');
    return;
  }

  // 2. 创建任务并进入队列
  const task = await workspaceManager.addTask(workspaceId, senderId, messageContent);

  // 3. 发送排队通知
  await sendMessage(chatJid, `@${username} 收到，任务已加入队列 [#${task.id}]`);
}
```

**实现细节**:
- ✅ 在 startMessageLoop() 中添加 workspace 检查（`group.is_shared_workspace && group.workspace_id`）
- ✅ 实现 processWorkspaceMessage() 函数处理工作区消息
- ✅ 权限检查：viewer 和非成员无法发起任务
- ✅ 智能反馈：显示任务类型（quick/simple/complex）和队列状态
- ✅ 消息路由：workspace 消息跳过正常容器执行流程，直接进入任务队列

### ✅ Phase 6: 权限检查与安全 (优先级 P2)

**权限中间件 (`src/routes/workspaces.ts`)**
```typescript
function requireWorkspaceRole(userId: string, workspaceId: number, minRole: WorkspaceRole): boolean {
  const role = getWorkspaceMemberRole(workspaceId, userId);
  if (!role) return false;
  const roleLevel = { viewer: 0, member: 1, admin: 2, owner: 3 };
  return roleLevel[role] >= roleLevel[minRole];
}
```

**数据隔离**:
- ✅ workspace_tasks 只显示本工作区任务（listWorkspaceTasks 过滤）
- ✅ 权限检查在所有 workspace API 端点实施
- ✅ IM 消息路由权限检查（viewer 无法发起任务）
- ✅ SQL 注入防护（prepared statements 已就绪）
- ✅ WebSocket 消息仅广播给工作区成员（broadcastToWorkspace 过滤）

---

## 实际执行集成 (未来优化)

当前 `WorkspaceQueue.executeTask()` 是模拟实现。实际集成需要：

1. **复用现有 container-runner 逻辑**
   ```typescript
   import { runContainerAgent, runHostAgent } from './container-runner.js';

   async executeTask(task: WorkspaceTask) {
     const workspace = getWorkspace(task.workspace_id)!;

     const input: ContainerInput = {
       prompt: task.message,
       sessionId: getSession(workspace.folder) || null,
       groupFolder: workspace.folder,
       chatJid: `workspace:${workspace.id}`,
       isHome: false,
       isAdminHome: false,
     };

     const output = workspace.execution_mode === 'host'
       ? await runHostAgent(input, ...)
       : await runContainerAgent(input, ...);

     // 处理 output，更新任务结果
   }
   ```

2. **流式事件转发**
   ```typescript
   onStreamEvent: (event) => {
     this.emit('task.progress', { taskId: task.id, event });
   }
   ```

3. **IPC 消息路由**
   - 工作区任务的 IPC 消息应路由到对应的群组 JID
   - `send_message` MCP 工具需要支持工作区上下文

---

## 测试计划

### 单元测试
- [ ] 任务分类器准确率测试
- [ ] 队列调度逻辑测试（并发限制、优先级）
- [ ] 权限检查逻辑测试

### 集成测试
- [ ] 创建工作区 → 邀请成员 → 发送消息 → 任务执行 → 结果返回
- [ ] 多人同时发消息（并发控制测试）
- [ ] 快速任务与慢任务混合场景

### 压力测试
- [ ] 100 个任务排队场景
- [ ] 10 人同时发消息

---

## 下一步行动

1. **完成 API 路由 (Phase 3)** - 优先级最高
   - 创建 `src/routes/workspaces.ts`
   - 添加 Zod schemas 到 `src/schemas.ts`
   - 在 `src/web.ts` 中挂载路由

2. **WebSocket 集成 (Phase 4)**
   - 实现 `broadcastToWorkspace()` 函数
   - 订阅/取消订阅机制

3. **消息路由增强 (Phase 5)**
   - 修改 `src/index.ts` 添加工作区判断逻辑

4. **前端界面 (未在后端 PRD 范围)**
   - 工作区列表页面
   - 任务看板组件
   - 实时更新 UI

---

## Commit 历史

- **58b0a8b**: 功能: Shared Workspace Phase 1-2 数据模型与任务队列
  - 数据库 schema v17→v18 迁移
  - TypeScript 类型定义
  - 任务分类器（task-classifier.ts）
  - 工作区队列管理器（workspace-queue.ts）
  - 数据库 CRUD 函数

---

## 参考资料

- PRD: `~/clawd/PRD-HappyClaw-SharedWorkspace.md`
- 现有架构: `CLAUDE.md`
- 市场调研: `~/clawd/market-research-shared-workspace.md`
