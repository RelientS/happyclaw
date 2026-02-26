import type { TaskType } from './types.js';
import { logger } from './logger.js';

interface ClassificationResult {
  type: TaskType;
  confidence: number;
}

/**
 * 基于规则的任务分类器
 */
function classifyByRules(message: string): ClassificationResult {
  const text = message.toLowerCase().trim();

  // 快速查询模式（高置信度）
  const quickPatterns: Array<{ pattern: RegExp; confidence: number }> = [
    { pattern: /^(天气|时间|日期|今天|明天|现在几点)/, confidence: 1.0 },
    { pattern: /^(什么是|解释一下|帮我查|查一下)/, confidence: 0.95 },
    { pattern: /^(翻译|translate)/, confidence: 0.95 },
    { pattern: /^(计算|算一下|\d+[\+\-\*\/])/, confidence: 0.9 },
  ];

  for (const { pattern, confidence } of quickPatterns) {
    if (pattern.test(text)) {
      return { type: 'quick', confidence };
    }
  }

  // 复杂任务模式
  const complexPatterns: Array<{ pattern: RegExp; confidence: number }> = [
    { pattern: /(创建|新建|生成).*(文件|代码|模块|项目)/, confidence: 0.98 },
    { pattern: /(修改|更新|重构|优化).*(代码|文件|函数)/, confidence: 0.95 },
    { pattern: /(分析|研究|调研).*(完整|详细|深入)/, confidence: 0.9 },
    { pattern: /生成.*(报告|文档|说明)/, confidence: 0.9 },
    { pattern: /(批量|遍历|所有).*(处理|修改|分析)/, confidence: 0.95 },
  ];

  for (const { pattern, confidence } of complexPatterns) {
    if (pattern.test(text)) {
      return { type: 'complex', confidence };
    }
  }

  // 后台任务模式
  const backgroundPatterns: Array<{ pattern: RegExp; confidence: number }> = [
    { pattern: /(每天|每周|每月|定时|周期|自动|持续)/, confidence: 1.0 },
    { pattern: /(监控|追踪|watch|track)/, confidence: 0.9 },
  ];

  for (const { pattern, confidence } of backgroundPatterns) {
    if (pattern.test(text)) {
      return { type: 'background', confidence };
    }
  }

  // 简单分析模式（基于长度和复杂度）
  if (text.length < 50 && !/(创建|修改|重构|分析)/.test(text)) {
    return { type: 'quick', confidence: 0.7 };
  }

  if (text.length > 200 || /(详细|完整|全面)/.test(text)) {
    return { type: 'complex', confidence: 0.7 };
  }

  // 默认：简单任务
  return { type: 'simple', confidence: 0.5 };
}

/**
 * 基于 AI 的任务分类器（可选，使用 Haiku 模型）
 *
 * 注意：此函数需要 Claude API 配置。如果调用失败，会回退到规则分类。
 */
async function classifyByAI(message: string): Promise<TaskType> {
  // TODO: 实现 AI 分类逻辑
  // 1. 调用 Claude API (Haiku 模型)
  // 2. 使用简短的 prompt 让模型分类
  // 3. 解析响应并返回 TaskType

  // 暂时抛出错误，回退到规则分类
  throw new Error('AI classification not implemented yet');
}

/**
 * 智能任务分类器
 *
 * 优先使用规则分类，如果置信度低于 0.9，尝试 AI 分类（如果可用）。
 *
 * @param message - 用户消息内容
 * @returns 任务类型：quick | simple | complex | background
 */
export async function classifyTask(message: string): Promise<TaskType> {
  // Phase 1: 规则分类
  const rulesResult = classifyByRules(message);

  logger.debug(
    { message: message.slice(0, 100), type: rulesResult.type, confidence: rulesResult.confidence },
    'Task classified by rules'
  );

  // 高置信度直接返回
  if (rulesResult.confidence >= 0.9) {
    return rulesResult.type;
  }

  // Phase 2: AI 分类（回退机制）
  try {
    const aiResult = await classifyByAI(message);
    logger.debug({ message: message.slice(0, 100), type: aiResult }, 'Task reclassified by AI');
    return aiResult;
  } catch (err) {
    // AI 分类失败，使用规则分类结果
    logger.debug(
      { err, fallbackType: rulesResult.type },
      'AI classification failed, using rules result'
    );
    return rulesResult.type;
  }
}

/**
 * 同步版本的任务分类器（仅使用规则）
 *
 * 用于不需要异步操作的场景。
 */
export function classifyTaskSync(message: string): TaskType {
  return classifyByRules(message).type;
}
