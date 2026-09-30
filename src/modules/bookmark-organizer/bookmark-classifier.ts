/**
 * 分类引擎：输入书签上下文、用户规则与单条覆盖，输出 purpose/project/environment、
 * 判定（certain | review | conflict）与可解释理由。只解析标题与 URL，不访问页面正文。
 */

import {
  collectRuleSignals,
  detectEnvironmentSignals,
  normalizeUrlParts,
  PURPOSE_LABELS,
  type BookmarkOverride,
  type RuleInputContext,
  type RuleSignal,
  type UserRule,
} from './bookmark-rules';

export type BookmarkPurpose =
  | 'business' | 'devops' | 'monitoring' | 'design' | 'ai' | 'network' | 'unknown';

export type BookmarkEnvironment = 'prod' | 'pre' | 'demo' | 'test' | 'unknown';

export type ClassificationVerdict = 'certain' | 'review' | 'conflict';

export interface Classification {
  purpose: BookmarkPurpose;
  project: string;
  environment: BookmarkEnvironment;
  verdict: ClassificationVerdict;
  reason: string;
  /** 命中的最高层证据；用于界面展示。 */
  evidence: string[];
  /** 最高层证据是否来自用户保存的规则（自动归档的前置条件之一）。 */
  matchedUserRule: boolean;
  /** 用户明确标记“不要自动移动”。 */
  noAutoMove: boolean;
}

/** 信号层级：用户规则 4 > 内置域名 3 > 内置标题关键词 2 > 原文件夹弱线索 1。 */

const purposeLabel = (purpose: BookmarkPurpose): string =>
  purpose === 'unknown' ? '待确认' : PURPOSE_LABELS[purpose];

const environmentLabel = (environment: BookmarkEnvironment): string | null =>
  environment === 'unknown' ? null : environment;

/** 分类建议的目标路径：purpose 目录 + 可选项目子目录；purpose 未知时无目标。 */
export const suggestedTargetPath = (classification: Pick<Classification, 'purpose' | 'project'>): string | null => {
  if (classification.purpose === 'unknown') return null;
  const label = PURPOSE_LABELS[classification.purpose];
  const project = classification.project && classification.project !== 'general' ? classification.project : '';
  return project ? `${label}/${project}` : label;
};

export const classifyBookmark = (
  context: RuleInputContext,
  rules: UserRule[],
  override?: BookmarkOverride,
): Classification => {
  const evidence: string[] = [];

  // 优先级 1：用户单条覆盖（调用方负责核对 URL 指纹）。
  if (override) {
    const parts: string[] = [];
    if (override.purpose !== 'unknown') parts.push(`用途「${purposeLabel(override.purpose)}」`);
    if (override.project && override.project !== 'general') parts.push(`项目「${override.project}」`);
    if (override.environment && override.environment !== 'unknown') parts.push(`环境「${override.environment}」`);
    if (override.noAutoMove) parts.push('已标记不自动移动');
    if (override.targetPath) parts.push(`目标「${override.targetPath}」`);
    return {
      purpose: override.purpose,
      project: override.project ?? 'general',
      environment: override.environment ?? 'unknown',
      verdict: 'certain',
      reason: `手动分类：${parts.join('、') || '保持现状'}`,
      evidence: ['用户手动修正，优先于所有规则'],
      matchedUserRule: false,
      noAutoMove: override.noAutoMove ?? false,
    };
  }

  const urlParts = normalizeUrlParts(context.url);
  if (urlParts === null) {
    return {
      purpose: 'unknown', project: 'general', environment: 'unknown',
      verdict: 'review',
      reason: '网址无法解析，需要人工确认',
      evidence: [`原始网址：${context.url || '（空）'}`],
      matchedUserRule: false,
      noAutoMove: false,
    };
  }
  if (urlParts.scheme !== 'http' && urlParts.scheme !== 'https') {
    return {
      purpose: 'unknown', project: 'general', environment: 'unknown',
      verdict: 'review',
      reason: `非 http(s) 网址（${urlParts.scheme}）默认待确认`,
      evidence: [`网址协议：${urlParts.scheme}`],
      matchedUserRule: false,
      noAutoMove: false,
    };
  }

  const signals = collectRuleSignals(context, rules);
  const resolved = resolveEnvironment(context, signals, evidence);
  const environment = resolved.environment;

  // 只在最高信号层仲裁：同层出现不同用途即冲突；只剩弱线索时不自动移动。
  const purposeSignals = signals.filter((signal) => signal.purpose !== undefined);
  if (purposeSignals.length === 0) {
    return {
      purpose: 'unknown', project: 'general', environment,
      verdict: resolved.conflict ? 'conflict' : 'review',
      reason: resolved.conflict ? '环境信号冲突，需要人工确认' : '没有命中任何分类规则，需要人工确认',
      evidence,
      matchedUserRule: false,
      noAutoMove: false,
    };
  }

  const bestByPurpose = new Map<BookmarkPurpose, RuleSignal>();
  for (const signal of purposeSignals) {
    const purpose = signal.purpose as Exclude<BookmarkPurpose, 'unknown'>;
    const current = bestByPurpose.get(purpose);
    if (!current || signal.strength > current.strength) bestByPurpose.set(purpose, signal);
  }
  const topStrength = Math.max(...[...bestByPurpose.values()].map((signal) => signal.strength));
  const topSignals = [...bestByPurpose.values()].filter((signal) => signal.strength === topStrength);

  if (topSignals.length > 1) {
    const detail = topSignals.map((signal) => signal.evidence).join('；');
    return {
      purpose: 'unknown', project: 'general', environment,
      verdict: 'conflict',
      reason: `同层级规则给出不同用途，需要人工裁决`,
      evidence: [...evidence, detail],
      matchedUserRule: topSignals.some((signal) => signal.source === 'user'),
      noAutoMove: false,
    };
  }

  const winner = topSignals[0];
  const purpose = winner.purpose as Exclude<BookmarkPurpose, 'unknown'>;
  const project = winner.project ?? 'general';
  evidence.unshift(winner.evidence);

  let verdict: ClassificationVerdict = topStrength >= 2 ? 'certain' : 'review';
  if (resolved.conflict) verdict = 'conflict';
  const prefix = resolved.conflict
    ? `${winner.evidence}；但环境信号冲突，需要人工确认`
    : verdict === 'review' ? `仅有弱线索（${winner.evidence}），不自动移动` : winner.evidence;
  return {
    purpose, project, environment,
    verdict,
    reason: prefix + environmentSuffix(environment),
    evidence,
    matchedUserRule: winner.source === 'user',
    noAutoMove: false,
  };
};

const environmentSuffix = (environment: BookmarkEnvironment): string =>
  environmentLabel(environment) ? ` · 环境 ${environment}` : '';

const resolveEnvironment = (
  context: RuleInputContext,
  signals: RuleSignal[],
  evidence: string[],
): { environment: BookmarkEnvironment; conflict: boolean } => {
  const { fromTitle, fromUrl } = detectEnvironmentSignals(context);
  const fromFolder = signals.find((signal) => signal.environment !== undefined)?.environment;
  const conflict = fromTitle !== undefined && fromUrl !== undefined && fromTitle !== fromUrl;
  if (conflict) {
    evidence.push(`环境冲突：标题提示 ${fromTitle}，网址提示 ${fromUrl}`);
  }
  const chosen = fromTitle ?? fromUrl ?? fromFolder;
  if (chosen) {
    evidence.push(`环境 ${chosen}${fromTitle === chosen ? '（标题）' : fromUrl === chosen ? '（网址）' : '（文件夹）'}`);
  }
  return { environment: chosen ?? 'unknown', conflict };
};

export const describeClassification = (classification: Classification): string =>
  `${purposeLabel(classification.purpose)} · ${describeVerdict(classification.verdict)} · ${classification.reason}`;

export const describeVerdict = (verdict: ClassificationVerdict): string =>
  verdict === 'certain' ? '确定' : verdict === 'conflict' ? '冲突' : '待确认';

export type { RuleInputContext, UserRule, BookmarkOverride };
