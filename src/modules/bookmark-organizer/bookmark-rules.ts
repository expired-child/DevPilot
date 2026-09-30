/**
 * 分类规则模型：用户保存的规则优先级最高，其次是内置的高辨识度工具规则，
 * 原文件夹名称只作为弱线索。规则匹配只看标题、URL 主机/路径与所在文件夹名。
 */

import type { BookmarkEnvironment, BookmarkPurpose } from './bookmark-classifier';

export type UserRuleKind = 'host' | 'pathPrefix' | 'titleKeyword' | 'folder';

export interface UserRule {
  id: string;
  kind: UserRuleKind;
  /** host：规范化主机名（可带子域基名）；pathPrefix：以「/」开头的路径前缀；titleKeyword/folder：关键词。 */
  pattern: string;
  /** pathPrefix 规则必须绑定创建时的域名，避免同一路径影响其他网站。 */
  host?: string;
  purpose: BookmarkPurpose;
  project?: string;
  environment?: BookmarkEnvironment;
  enabled: boolean;
  createdAt: number;
}

export interface BookmarkOverride {
  bookmarkId: string;
  /** 与书签 URL 指纹绑定：URL 或节点身份变化后覆盖失效，回到待确认。 */
  urlFingerprint: string;
  purpose: BookmarkPurpose;
  project?: string;
  environment?: BookmarkEnvironment;
  /** 用户显式选择的目标路径；设置后优先于分类建议。 */
  targetPath?: string;
  /** “不要自动移动”：该条永远不进入自动/批量移动。 */
  noAutoMove?: boolean;
  updatedAt: number;
}

export type RuleSource = 'user' | 'builtin' | 'folder';

export interface RuleSignal {
  source: RuleSource;
  kind: UserRuleKind;
  pattern: string;
  purpose: BookmarkPurpose | undefined;
  environment: BookmarkEnvironment | undefined;
  project: string | undefined;
  /** user=4、strong=3、medium=2、weak=1；只取最高层，同层冲突才标 conflict。 */
  strength: number;
  ruleId?: string;
  evidence: string;
}

export const PURPOSE_LABELS: Record<Exclude<BookmarkPurpose, 'unknown'>, string> = {
  business: '业务系统',
  devops: '研发运维',
  monitoring: '监控日志',
  design: '设计文档',
  ai: 'AI 工具',
  network: '网络账号',
};

/** 用户规则按主机名匹配：规范化后整段或子域边界匹配，不做任意字符串包含。 */
export const normalizeHost = (host: string): string =>
  host.trim().toLocaleLowerCase().replace(/\.+$/, '').replace(/^www\./, '');

export const hostMatchesPattern = (host: string, pattern: string): boolean => {
  const normalizedHost = normalizeHost(host);
  const normalizedPattern = normalizeHost(pattern);
  if (normalizedPattern.length === 0) return false;
  return normalizedHost === normalizedPattern || normalizedHost.endsWith(`.${normalizedPattern}`);
};

export const pathMatchesPrefix = (pathname: string, prefix: string): boolean => {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const normalizedPrefix = prefix.startsWith('/') ? prefix : `/${prefix}`;
  const trimmed = normalizedPrefix.replace(/\/+$/, '');
  if (trimmed.length === 0) return true;
  return normalizedPath === trimmed || normalizedPath.startsWith(`${trimmed}/`);
};

/**
 * 内置高辨识度规则：只收录产品名或平台名，避免泛化关键词误判。
 * host 规则为强信号（certain），titleKeyword 为中信号（certain），folder 为弱信号（review）。
 */
interface BuiltinRule {
  kind: UserRuleKind;
  pattern: string;
  purpose: BookmarkPurpose;
  strength: 2 | 3;
}

const BUILTIN_RULES: BuiltinRule[] = [
  // 代码与任务平台
  { kind: 'host', pattern: 'github.com', purpose: 'devops', strength: 3 },
  { kind: 'host', pattern: 'githubusercontent.com', purpose: 'devops', strength: 3 },
  { kind: 'host', pattern: 'gitlab.com', purpose: 'devops', strength: 3 },
  { kind: 'host', pattern: 'gitee.com', purpose: 'devops', strength: 3 },
  { kind: 'host', pattern: 'atlassian.net', purpose: 'devops', strength: 3 },
  { kind: 'host', pattern: 'tapd.cn', purpose: 'devops', strength: 3 },
  { kind: 'host', pattern: 'coding.net', purpose: 'devops', strength: 3 },
  { kind: 'titleKeyword', pattern: 'jira', purpose: 'devops', strength: 2 },
  { kind: 'titleKeyword', pattern: '禅道', purpose: 'devops', strength: 2 },
  { kind: 'titleKeyword', pattern: 'tapd', purpose: 'devops', strength: 2 },
  // 配置中心
  { kind: 'titleKeyword', pattern: '配置中心', purpose: 'devops', strength: 2 },
  { kind: 'titleKeyword', pattern: 'nacos', purpose: 'devops', strength: 2 },
  // 链路追踪
  { kind: 'titleKeyword', pattern: 'skywalking', purpose: 'monitoring', strength: 2 },
  { kind: 'titleKeyword', pattern: 'zipkin', purpose: 'monitoring', strength: 2 },
  { kind: 'titleKeyword', pattern: 'jaeger', purpose: 'monitoring', strength: 2 },
  { kind: 'titleKeyword', pattern: '链路追踪', purpose: 'monitoring', strength: 2 },
  // 构建与质量平台
  { kind: 'titleKeyword', pattern: 'jenkins', purpose: 'devops', strength: 2 },
  { kind: 'titleKeyword', pattern: 'sonarqube', purpose: 'devops', strength: 2 },
  { kind: 'titleKeyword', pattern: 'sonar', purpose: 'devops', strength: 2 },
  { kind: 'titleKeyword', pattern: '持续集成', purpose: 'devops', strength: 2 },
  { kind: 'titleKeyword', pattern: '流水线', purpose: 'devops', strength: 2 },
  // 原型与设计
  { kind: 'host', pattern: 'figma.com', purpose: 'design', strength: 3 },
  { kind: 'host', pattern: 'mastergo.com', purpose: 'design', strength: 3 },
  { kind: 'host', pattern: 'lanhuapp.com', purpose: 'design', strength: 3 },
  { kind: 'host', pattern: 'js.design', purpose: 'design', strength: 3 },
  { kind: 'titleKeyword', pattern: 'figma', purpose: 'design', strength: 2 },
  { kind: 'titleKeyword', pattern: '蓝湖', purpose: 'design', strength: 2 },
  { kind: 'titleKeyword', pattern: '墨刀', purpose: 'design', strength: 2 },
  { kind: 'titleKeyword', pattern: 'axure', purpose: 'design', strength: 2 },
  { kind: 'titleKeyword', pattern: '即时设计', purpose: 'design', strength: 2 },
  { kind: 'titleKeyword', pattern: '原型', purpose: 'design', strength: 2 },
  // 监控日志
  { kind: 'titleKeyword', pattern: 'grafana', purpose: 'monitoring', strength: 2 },
  { kind: 'titleKeyword', pattern: 'kibana', purpose: 'monitoring', strength: 2 },
  { kind: 'titleKeyword', pattern: 'prometheus', purpose: 'monitoring', strength: 2 },
  { kind: 'titleKeyword', pattern: 'zabbix', purpose: 'monitoring', strength: 2 },
  { kind: 'titleKeyword', pattern: 'sentry', purpose: 'monitoring', strength: 2 },
  { kind: 'titleKeyword', pattern: '监控平台', purpose: 'monitoring', strength: 2 },
  { kind: 'titleKeyword', pattern: '日志平台', purpose: 'monitoring', strength: 2 },
  // AI 工具
  { kind: 'host', pattern: 'chatgpt.com', purpose: 'ai', strength: 3 },
  { kind: 'host', pattern: 'openai.com', purpose: 'ai', strength: 3 },
  { kind: 'host', pattern: 'claude.ai', purpose: 'ai', strength: 3 },
  { kind: 'host', pattern: 'anthropic.com', purpose: 'ai', strength: 3 },
  { kind: 'host', pattern: 'gemini.google.com', purpose: 'ai', strength: 3 },
  { kind: 'host', pattern: 'perplexity.ai', purpose: 'ai', strength: 3 },
  { kind: 'host', pattern: 'huggingface.co', purpose: 'ai', strength: 3 },
  { kind: 'host', pattern: 'chatglm.cn', purpose: 'ai', strength: 3 },
  { kind: 'host', pattern: 'moonshot.cn', purpose: 'ai', strength: 3 },
  { kind: 'host', pattern: 'deepseek.com', purpose: 'ai', strength: 3 },
  { kind: 'host', pattern: 'midjourney.com', purpose: 'ai', strength: 3 },
  { kind: 'titleKeyword', pattern: 'chatgpt', purpose: 'ai', strength: 2 },
  { kind: 'titleKeyword', pattern: 'deepseek', purpose: 'ai', strength: 2 },
  { kind: 'titleKeyword', pattern: '通义千问', purpose: 'ai', strength: 2 },
  { kind: 'titleKeyword', pattern: '文心一言', purpose: 'ai', strength: 2 },
  { kind: 'titleKeyword', pattern: 'hugging face', purpose: 'ai', strength: 2 },
  // 网络账号
  { kind: 'titleKeyword', pattern: 'vpn', purpose: 'network', strength: 2 },
  { kind: 'titleKeyword', pattern: '路由器', purpose: 'network', strength: 2 },
  { kind: 'titleKeyword', pattern: 'openwrt', purpose: 'network', strength: 2 },
  { kind: 'titleKeyword', pattern: '光猫', purpose: 'network', strength: 2 },
  { kind: 'titleKeyword', pattern: 'clash', purpose: 'network', strength: 2 },
];

/** 原文件夹名称弱线索：只命中这一项不自动移动。 */
const FOLDER_PURPOSE_HINTS: Array<{ pattern: string; purpose: BookmarkPurpose }> = [
  { pattern: '业务', purpose: 'business' },
  { pattern: '后台', purpose: 'business' },
  { pattern: '工作台', purpose: 'business' },
  { pattern: 'oa', purpose: 'business' },
  { pattern: 'crm', purpose: 'business' },
  { pattern: 'erp', purpose: 'business' },
  { pattern: '开发', purpose: 'devops' },
  { pattern: '研发', purpose: 'devops' },
  { pattern: '运维', purpose: 'devops' },
  { pattern: '工具', purpose: 'devops' },
  { pattern: '监控', purpose: 'monitoring' },
  { pattern: '日志', purpose: 'monitoring' },
  { pattern: '设计', purpose: 'design' },
  { pattern: '原型', purpose: 'design' },
  { pattern: 'ai', purpose: 'ai' },
  { pattern: '网络', purpose: 'network' },
  { pattern: '账号', purpose: 'network' },
];

const FOLDER_ENVIRONMENT_HINTS: Array<{ pattern: string; environment: BookmarkEnvironment }> = [
  { pattern: '生产', environment: 'prod' },
  { pattern: '正式', environment: 'prod' },
  { pattern: 'prod', environment: 'prod' },
  { pattern: '预发', environment: 'pre' },
  { pattern: 'staging', environment: 'pre' },
  { pattern: 'uat', environment: 'pre' },
  { pattern: '演示', environment: 'demo' },
  { pattern: 'demo', environment: 'demo' },
  { pattern: '测试', environment: 'test' },
  { pattern: 'test', environment: 'test' },
];

/** 标题环境词：与 URL 环境暗示不同时产生 conflict。 */
export const TITLE_ENVIRONMENT_WORDS: Array<{ pattern: string; environment: BookmarkEnvironment }> = [
  { pattern: '生产', environment: 'prod' },
  { pattern: '正式环境', environment: 'prod' },
  { pattern: 'prod', environment: 'prod' },
  { pattern: '预发', environment: 'pre' },
  { pattern: 'staging', environment: 'pre' },
  { pattern: 'uat', environment: 'pre' },
  { pattern: '演示', environment: 'demo' },
  { pattern: 'demo', environment: 'demo' },
  { pattern: '测试', environment: 'test' },
  { pattern: 'test', environment: 'test' },
];

/** URL 主机首段环境词。 */
export const HOST_ENVIRONMENT_WORDS = new Set([
  'prod', 'production', 'pre', 'prepub', 'staging', 'stg', 'uat', 'demo', 'test', 'qa', 'dev', 'sit',
]);

const ENVIRONMENT_BY_HOST_WORD: Record<string, BookmarkEnvironment> = {
  prod: 'prod', production: 'prod',
  pre: 'pre', prepub: 'pre', staging: 'pre', stg: 'pre', uat: 'pre',
  demo: 'demo',
  test: 'test', qa: 'test', dev: 'test', sit: 'test',
};

const foldText = (text: string): string => text.normalize('NFKC').toLocaleLowerCase();

export const normalizeUrlParts = (url: string): { scheme: string; host: string; pathname: string } | null => {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  return { scheme: parsed.protocol.replace(/:$/, '').toLocaleLowerCase(), host: parsed.hostname, pathname: parsed.pathname };
};

export interface RuleInputContext {
  title: string;
  url: string;
  /** 当前文件夹链的显示名，从书签栏根（不含）到父文件夹；直属书签栏为 []。 */
  folderNames: string[];
}

/** 汇总所有命中的信号；不做仲裁，仲裁（取最高层、判冲突）交给分类器。 */
export const collectRuleSignals = (context: RuleInputContext, rules: UserRule[]): RuleSignal[] => {
  const signals: RuleSignal[] = [];
  const foldedTitle = foldText(context.title);
  const urlParts = normalizeUrlParts(context.url);
  const host = urlParts ? normalizeHost(urlParts.host) : '';
  const pathname = urlParts?.pathname ?? '';

  for (const rule of rules) {
    if (!rule.enabled) continue;
    let hit = false;
    if (rule.kind === 'host') hit = urlParts !== null && hostMatchesPattern(host, rule.pattern);
    else if (rule.kind === 'pathPrefix') hit = urlParts !== null &&
      typeof rule.host === 'string' && hostMatchesPattern(host, rule.host) &&
      pathMatchesPrefix(pathname, rule.pattern);
    else if (rule.kind === 'titleKeyword') hit = foldedTitle.includes(foldText(rule.pattern));
    else if (rule.kind === 'folder') hit = context.folderNames.some((name) => foldText(name).includes(foldText(rule.pattern)));
    if (!hit) continue;
    signals.push({
      source: 'user',
      kind: rule.kind,
      pattern: rule.pattern,
      purpose: rule.purpose,
      environment: rule.environment,
      project: rule.project,
      strength: 4,
      ruleId: rule.id,
      evidence: `用户规则：${describeRuleKind(rule.kind)}「${rule.pattern}」${rule.kind === 'pathPrefix' ? `（${rule.host}）` : ''}`,
    });
  }

  for (const rule of BUILTIN_RULES) {
    const hit = rule.kind === 'host'
      ? urlParts !== null && hostMatchesPattern(host, rule.pattern)
      : foldedTitle.includes(foldText(rule.pattern));
    if (!hit) continue;
    signals.push({
      source: 'builtin',
      kind: rule.kind,
      pattern: rule.pattern,
      purpose: rule.purpose,
      environment: undefined,
      project: undefined,
      strength: rule.strength,
      evidence: `内置规则：${describeRuleKind(rule.kind)}「${rule.pattern}」`,
    });
  }

  // 原文件夹名称弱线索：命中文件夹名才生效；没有文件夹链（如搜索态）不产生。
  for (const name of context.folderNames) {
    const foldedName = foldText(name);
    if (!foldedName) continue;
    for (const hint of FOLDER_PURPOSE_HINTS) {
      if (!foldedName.includes(foldText(hint.pattern))) continue;
      signals.push({
        source: 'folder',
        kind: 'folder',
        pattern: name,
        purpose: hint.purpose,
        environment: undefined,
        project: undefined,
        strength: 1,
        evidence: `所在文件夹「${name}」提示${hint.purpose}`,
      });
      break;
    }
    for (const hint of FOLDER_ENVIRONMENT_HINTS) {
      if (!foldedName.includes(foldText(hint.pattern))) continue;
      signals.push({
        source: 'folder',
        kind: 'folder',
        pattern: name,
        purpose: undefined,
        environment: hint.environment,
        project: undefined,
        strength: 1,
        evidence: `所在文件夹「${name}」提示环境 ${hint.environment}`,
      });
      break;
    }
  }

  return signals;
};

export const describeRuleKind = (kind: UserRuleKind): string =>
  kind === 'host' ? '域名' : kind === 'pathPrefix' ? '路径前缀' : kind === 'titleKeyword' ? '标题关键词' : '原文件夹';

/** 环境词检测：返回标题与 URL 各自暗示的环境，供分类器判冲突。 */
export const detectEnvironmentSignals = (context: RuleInputContext): { fromTitle: BookmarkEnvironment | undefined; fromUrl: BookmarkEnvironment | undefined } => {
  const foldedTitle = foldText(context.title);
  const urlParts = normalizeUrlParts(context.url);
  let fromTitle: BookmarkEnvironment | undefined;
  for (const word of TITLE_ENVIRONMENT_WORDS) {
    if (foldedTitle.includes(foldText(word.pattern))) {
      fromTitle = word.environment;
      break;
    }
  }
  let fromUrl: BookmarkEnvironment | undefined;
  if (urlParts) {
    const firstLabel = normalizeHost(urlParts.host).split('.')[0];
    if (HOST_ENVIRONMENT_WORDS.has(firstLabel)) fromUrl = ENVIRONMENT_BY_HOST_WORD[firstLabel];
  }
  return { fromTitle, fromUrl };
};
