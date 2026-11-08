/** 凭据独立保存；状态响应只返回地址和模型，不返回 Key。 */
export const BOOKMARK_AI_CONFIG_KEY = 'bookmarkOrganizer:aiConfig:v2';
export interface BookmarkAiConfig { baseUrl: string; model: string; apiKey: string }
export type PublicAiConfig = Pick<BookmarkAiConfig, 'baseUrl' | 'model'>;

export const normalizeAiEndpoint = (input: string): string => {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('请填写完整的 AI 服务地址。'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('AI 服务须使用 HTTPS；本机服务可使用 HTTP。');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('服务地址不能包含账号密码、查询参数或片段。');
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url.href;
};

export const aiPermissionOrigin = (baseUrl: string): string => {
  const url = new URL(normalizeAiEndpoint(baseUrl));
  return `${url.protocol}//${url.hostname}/*`;
};

export const validateAiConfig = (config: BookmarkAiConfig): BookmarkAiConfig => {
  normalizeAiEndpoint(config.baseUrl);
  const model = config.model.trim();
  if (!model || model.length > 200 || /[\r\n]/.test(model)) throw new Error('请填写有效的模型名称。');
  const apiKey = config.apiKey.trim();
  if (apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new Error('API Key 格式无效。');
  return { baseUrl: config.baseUrl.trim(), model, apiKey };
};

export const loadAiConfig = async (): Promise<BookmarkAiConfig | null> => {
  const value: unknown = (await chrome.storage.local.get(BOOKMARK_AI_CONFIG_KEY))[BOOKMARK_AI_CONFIG_KEY];
  if (!value || typeof value !== 'object') return null;
  const config = value as BookmarkAiConfig;
  if (typeof config.baseUrl !== 'string' || typeof config.model !== 'string' || typeof config.apiKey !== 'string') return null;
  try { return validateAiConfig(config); } catch { return null; }
};

export const saveAiConfig = async (input: PublicAiConfig & { apiKey?: string }): Promise<void> => {
  const old = await loadAiConfig();
  // 更换服务地址时不把旧服务的凭据转交给新服务。
  const sameEndpoint = old && normalizeAiEndpoint(old.baseUrl) === normalizeAiEndpoint(input.baseUrl);
  const config = validateAiConfig({ ...input, apiKey: input.apiKey ?? (sameEndpoint ? old.apiKey : '') });
  if (!await chrome.permissions.contains({ origins: [aiPermissionOrigin(config.baseUrl)] })) {
    throw new Error('尚未授权访问这个 AI 服务，请重新保存并允许访问。');
  }
  await chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.local.set({ [BOOKMARK_AI_CONFIG_KEY]: config });
};
