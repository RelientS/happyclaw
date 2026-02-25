import { EventEmitter } from 'events';
import crypto from 'crypto';
import type { Workspace, WorkspaceTask, TaskType } from './types.js';
import {
  getWorkspace,
  createWorkspaceTask,
  updateWorkspaceTask,
  getWorkspaceTask,
  listWorkspaceTasks,
  getUserById,
} from './db.js';
import { classifyTaskSync } from './task-classifier.js';
import { logger } from './logger.js';

interface TaskExecutionContext {
  task: WorkspaceTask;
  abortController: AbortController;
  startTime: number;
}

/**
 * WorkspaceQueue 类 - 管理单个工作区的任务队列
 *
 * 职责：
 * - 任务分类和调度
 * - 并发控制（max_parallel_tasks）
 * - 任务状态管理
 * - 事件发射（task.created, task.started, task.progress, task.completed）
 */
export class WorkspaceQueue extends EventEmitter {
  private workspace: Workspace;
  private runningTasks: Map<number, TaskExecutionContext> = new Map();
  private processingQueue = false;

  constructor(workspace: Workspace) {
    super();
    this.workspace = workspace;
  }

  /**
   * 添加新任务到队列
   *
   * @param userId - 发起任务的用户 ID
   * @param message - 用户消息内容
   * @returns 创建的任务对象
   */
  async addTask(userId: string, message: string): Promise<WorkspaceTask> {
    // 1. 智能分类任务类型
    const taskType = classifyTaskSync(message);

    // 2. 创建任务记录
    const taskId = createWorkspaceTask({
      workspace_id: this.workspace.id,
      requested_by_user_id: userId,
      message,
      task_type: taskType,
      status: 'queued',
      priority: 0,
      queue_position: null,
      started_at: null,
      completed_at: null,
      result: null,
    });

    const task = getWorkspaceTask(taskId)!;

    logger.info(
      {
        workspaceId: this.workspace.id,
        taskId,
        userId,
        taskType,
        messagePreview: message.slice(0, 100),
      },
      'Workspace task created'
    );

    // 3. 发射任务创建事件
    this.emit('task.created', task);

    // 4. 触发队列处理
    this.processQueue().catch((err) => {
      logger.error({ err, workspaceId: this.workspace.id }, 'Queue processing error');
    });

    return task;
  }

  /**
   * 处理队列中的下一个任务
   */
  private async processQueue(): Promise<void> {
    // 防止并发调用
    if (this.processingQueue) return;
    this.processingQueue = true;

    try {
      while (true) {
        // 1. 检查并发限制
        if (this.runningTasks.size >= this.workspace.max_parallel_tasks) {
          logger.debug(
            { workspaceId: this.workspace.id, running: this.runningTasks.size },
            'Workspace queue at max capacity, waiting'
          );
          break;
        }

        // 2. 获取下一个待处理任务（按优先级 + ID 排序）
        const queuedTasks = listWorkspaceTasks(this.workspace.id, 'queued');
        if (queuedTasks.length === 0) {
          // 队列为空
          break;
        }

        // 更新队列位置
        queuedTasks.forEach((task, index) => {
          if (task.queue_position !== index + 1) {
            updateWorkspaceTask(task.id, { queue_position: index + 1 });
          }
        });

        const nextTask = queuedTasks[0];

        // 3. 根据任务类型调度
        switch (nextTask.task_type) {
          case 'quick':
            // 快速任务：立即执行，不占用主队列位
            await this.executeQuickTask(nextTask);
            break;

          case 'simple':
          case 'complex':
          case 'background':
            // 占用队列位执行
            await this.executeTask(nextTask);
            break;
        }

        // 发射队列更新事件
        this.emit('queue.updated', this.getQueueStatus());
      }
    } finally {
      this.processingQueue = false;
    }
  }

  /**
   * 执行快速任务（不占用队列位）
   */
  private async executeQuickTask(task: WorkspaceTask): Promise<void> {
    logger.info({ taskId: task.id, workspaceId: this.workspace.id }, 'Executing quick task');

    // 更新状态为运行中
    updateWorkspaceTask(task.id, {
      status: 'running',
      started_at: new Date().toISOString(),
    });
    this.emit('task.started', getWorkspaceTask(task.id)!);

    // TODO: 实际执行逻辑（调用 container-runner 或 host agent）
    // 暂时模拟快速完成
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 更新状态为已完成
    updateWorkspaceTask(task.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      result: JSON.stringify({ text: '[Quick task result]' }),
    });

    const completedTask = getWorkspaceTask(task.id)!;
    this.emit('task.completed', completedTask);

    logger.info({ taskId: task.id }, 'Quick task completed');
  }

  /**
   * 执行常规任务（占用队列位）
   */
  private async executeTask(task: WorkspaceTask): Promise<void> {
    const abortController = new AbortController();
    const context: TaskExecutionContext = {
      task,
      abortController,
      startTime: Date.now(),
    };

    this.runningTasks.set(task.id, context);

    logger.info(
      {
        taskId: task.id,
        workspaceId: this.workspace.id,
        taskType: task.task_type,
        running: this.runningTasks.size,
      },
      'Executing workspace task'
    );

    // 更新状态为运行中
    updateWorkspaceTask(task.id, {
      status: 'running',
      started_at: new Date().toISOString(),
      queue_position: null,
    });
    this.emit('task.started', getWorkspaceTask(task.id)!);

    try {
      // TODO: 实际执行逻辑
      // 1. 启动 Agent（容器或宿主机）
      // 2. 监听流式事件（通过 this.emit('task.progress', ...)）
      // 3. 等待完成
      //
      // 暂时模拟执行
      const executionTimeMs = task.task_type === 'complex' ? 5000 : 2000;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, executionTimeMs);
        abortController.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Task aborted'));
        });
      });

      // 更新状态为已完成
      updateWorkspaceTask(task.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        result: JSON.stringify({ text: '[Task result]', duration_ms: Date.now() - context.startTime }),
      });

      const completedTask = getWorkspaceTask(task.id)!;
      this.emit('task.completed', completedTask);

      logger.info({ taskId: task.id, durationMs: Date.now() - context.startTime }, 'Task completed');
    } catch (err) {
      // 更新状态为失败
      updateWorkspaceTask(task.id, {
        status: 'failed',
        completed_at: new Date().toISOString(),
        result: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      });

      const failedTask = getWorkspaceTask(task.id)!;
      this.emit('task.completed', failedTask);

      logger.error({ taskId: task.id, err }, 'Task failed');
    } finally {
      this.runningTasks.delete(task.id);

      // 继续处理队列
      this.processQueue().catch((err) => {
        logger.error({ err }, 'Queue processing error after task completion');
      });
    }
  }

  /**
   * 停止指定任务
   */
  async stopTask(taskId: number): Promise<boolean> {
    const context = this.runningTasks.get(taskId);
    if (!context) {
      logger.warn({ taskId }, 'Task not running, cannot stop');
      return false;
    }

    logger.info({ taskId }, 'Stopping workspace task');
    context.abortController.abort();
    return true;
  }

  /**
   * 获取队列状态
   */
  getQueueStatus(): WorkspaceTask[] {
    return listWorkspaceTasks(this.workspace.id, 'queued');
  }

  /**
   * 获取运行中的任务
   */
  getRunningTasks(): WorkspaceTask[] {
    return listWorkspaceTasks(this.workspace.id, 'running');
  }

  /**
   * 关闭队列（停止所有任务）
   */
  async shutdown(): Promise<void> {
    logger.info({ workspaceId: this.workspace.id }, 'Shutting down workspace queue');

    // 停止所有运行中的任务
    const stopPromises = Array.from(this.runningTasks.keys()).map((taskId) =>
      this.stopTask(taskId)
    );
    await Promise.allSettled(stopPromises);

    this.removeAllListeners();
  }
}

/**
 * WorkspaceManager 类 - 管理所有工作区的队列
 *
 * 职责：
 * - 工作区队列的创建和销毁
 * - 路由任务到对应的工作区队列
 * - 全局事件转发
 */
export class WorkspaceManager extends EventEmitter {
  private queues = new Map<number, WorkspaceQueue>();

  /**
   * 添加任务到工作区队列
   *
   * @param workspaceId - 工作区 ID
   * @param userId - 发起任务的用户 ID
   * @param message - 用户消息内容
   * @returns 创建的任务对象
   */
  async addTask(
    workspaceId: number,
    userId: string,
    message: string
  ): Promise<WorkspaceTask> {
    const queue = this.getOrCreateQueue(workspaceId);
    const task = await queue.addTask(userId, message);

    // 转发所有队列事件到全局事件
    return task;
  }

  /**
   * 获取或创建工作区队列
   */
  private getOrCreateQueue(workspaceId: number): WorkspaceQueue {
    let queue = this.queues.get(workspaceId);
    if (!queue) {
      const workspace = getWorkspace(workspaceId);
      if (!workspace) {
        throw new Error(`Workspace ${workspaceId} not found`);
      }

      queue = new WorkspaceQueue(workspace);

      // 转发队列事件到全局
      queue.on('task.created', (task) => {
        this.emit('workspace.task.created', { workspaceId, task });
      });
      queue.on('task.started', (task) => {
        this.emit('workspace.task.started', { workspaceId, task });
      });
      queue.on('task.progress', (event) => {
        this.emit('workspace.task.progress', { workspaceId, event });
      });
      queue.on('task.completed', (task) => {
        this.emit('workspace.task.completed', { workspaceId, task });
      });
      queue.on('queue.updated', (queue) => {
        this.emit('workspace.queue.updated', { workspaceId, queue });
      });

      this.queues.set(workspaceId, queue);

      logger.info({ workspaceId }, 'Workspace queue created');
    }
    return queue;
  }

  /**
   * 获取工作区队列状态
   */
  getQueueStatus(workspaceId: number): {
    running: WorkspaceTask[];
    queued: WorkspaceTask[];
  } | null {
    const queue = this.queues.get(workspaceId);
    if (!queue) return null;

    return {
      running: queue.getRunningTasks(),
      queued: queue.getQueueStatus(),
    };
  }

  /**
   * 停止工作区的特定任务
   */
  async stopTask(workspaceId: number, taskId: number): Promise<boolean> {
    const queue = this.queues.get(workspaceId);
    if (!queue) return false;
    return queue.stopTask(taskId);
  }

  /**
   * 关闭所有工作区队列
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down all workspace queues');
    const shutdownPromises = Array.from(this.queues.values()).map((queue) => queue.shutdown());
    await Promise.allSettled(shutdownPromises);
    this.queues.clear();
    this.removeAllListeners();
  }
}

// 全局单例
export const workspaceManager = new WorkspaceManager();
