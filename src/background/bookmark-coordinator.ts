/**
 * 书签整理后台协调器：所有书签写入命令在这里按接收顺序串行执行。
 * 批次日志先于任何书签写入落盘；每完成一项就持久化一次，
 * 浏览器中断后可凭日志对照真实书签树恢复（reconcile）。
 */

import {
  BOOKMARK_COMMANDS,
  isBookmarkCommand,
  type BookmarkCommand,
  type BookmarkCommandResult,
  type OrganizeApplyPlan,
} from '../shared/messaging/bookmark-commands';
import { ARCHIVE_ROOT_PATH, buildOrganizePreview, emptyFolderCandidates } from '../modules/bookmark-organizer/bookmark-plan';
import { generateAiPreview, loadDeepSeekKey, saveDeepSeekKey, recommendBookmarkFolder,
  type BookmarkRecommendation } from '../modules/bookmark-organizer/bookmark-ai';
import { isExtensionPageSender } from './clipboard-coordinator';
import {
  createOrganizerId,
  recordActivity,
  unfinishedBatch,
  type BatchItemLog,
  type OrganizerRepository,
  type OrganizerState,
  type OrganizeBatch,
} from '../modules/bookmark-organizer/bookmark-organizer-repository';
import { classifyBookmark, suggestedTargetPath } from '../modules/bookmark-organizer/bookmark-classifier';
import {
  createBookmarkSnapshot,
  childrenOf,
  getNode,
  isBookmarkNode,
  listFoldersInSubtree,
  splitTargetPath,
  urlFingerprint,
  type BookmarkSnapshot,
} from '../modules/bookmark-organizer/bookmark-tree';

export class BookmarkOrganizeCoordinator {
  private tail: Promise<unknown> = Promise.resolve();
  private importing = false;
  private readonly placements = new Map<string, { cancelled: boolean }>();
  private readonly ownedCreates = new Set<string>();

  constructor(private readonly storage: OrganizerRepository) {}

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 导入书签期间抑制自动归档；onImportEnded 后由页面决定是否重新扫描。 */
  setImporting(value: boolean): void {
    this.importing = value;
    if (value) for (const job of this.placements.values()) job.cancelled = true;
  }

  cancelBookmarkPlacement(bookmarkId: string): void {
    const job = this.placements.get(bookmarkId);
    if (job) job.cancelled = true;
  }

  handle(command: BookmarkCommand): Promise<BookmarkCommandResult> {
    // AI 只读生成不占用写队列；完成后校验修订号，避免覆盖另一窗口的新规则。
    if (command.type === BOOKMARK_COMMANDS.aiPreview) return this.aiPreview(command.scopeFolderId, command.expectedRevision);
    if (command.type === BOOKMARK_COMMANDS.recommendPage) return this.recommendPage(command.title, command.url);
    return this.enqueue(async (): Promise<BookmarkCommandResult> => {
      try {
        switch (command.type) {
          case BOOKMARK_COMMANDS.aiStatus:
            return { ok: true, aiConfigured: Boolean(await loadDeepSeekKey()) };
          case BOOKMARK_COMMANDS.saveAiKey:
            await saveDeepSeekKey(command.apiKey);
            if (!command.apiKey.trim()) {
              for (const job of this.placements.values()) job.cancelled = true;
              const state = await this.storage.load();
              state.settings.aiAutoPlaceEnabled = false;
              await this.storage.save(state);
            }
            return { ok: true, aiConfigured: Boolean(command.apiKey.trim()) };
          case BOOKMARK_COMMANDS.applyBatch:
            return { ok: true, batch: await this.applyBatch(command.plan) };
          case BOOKMARK_COMMANDS.undoBatch:
            return { ok: true, batch: await this.undoBatch(command.batchId) };
          case BOOKMARK_COMMANDS.retryBatch:
            return { ok: true, batch: await this.retryBatch(command.batchId) };
          case BOOKMARK_COMMANDS.reconcileBatch:
            return { ok: true, batch: await this.reconcileBatch(command.batchId) };
          case BOOKMARK_COMMANDS.saveRules: {
            const state = await this.storage.load();
            if (state.classificationRevision !== command.expectedRevision) {
              throw new Error('分类规则已被其他窗口更新，请重新扫描后重试。');
            }
            state.rules = command.rules;
            state.classificationRevision += 1;
            await this.storage.save(state);
            return { ok: true };
          }
          case BOOKMARK_COMMANDS.saveOverrides: {
            const state = await this.storage.load();
            if (state.classificationRevision !== command.expectedRevision) {
              throw new Error('分类规则已被其他窗口更新，请重新扫描后重试。');
            }
            state.overrides = command.overrides;
            state.classificationRevision += 1;
            await this.storage.save(state);
            return { ok: true };
          }
          case BOOKMARK_COMMANDS.saveSettings: {
            const state = await this.storage.load();
            if (command.settings.aiAutoPlaceEnabled && !await loadDeepSeekKey()) {
              throw new Error('请先保存 DeepSeek 官方 API Key，再开启新书签 AI 智能放置。');
            }
            state.settings = { ...state.settings, ...command.settings };
            if (command.settings.aiAutoPlaceEnabled === false) {
              for (const job of this.placements.values()) job.cancelled = true;
            }
            await this.storage.save(state);
            return { ok: true };
          }
          case BOOKMARK_COMMANDS.savePageBookmark:
            await this.savePageBookmark(command.title, command.url, command.targetPath);
            return { ok: true };
          default:
            return { ok: false, error: '未知命令' };
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  private async recommendation(
    title: string, url: string, fromRelativePath: string, state: OrganizerState,
    snapshot: BookmarkSnapshot, bookmarkId = 'new-bookmark',
  ): Promise<BookmarkRecommendation> {
    const classification = classifyBookmark({ title, url, folderNames: fromRelativePath.split('/').filter(Boolean) }, state.rules);
    if (classification.matchedUserRule) {
      return { targetPath: suggestedTargetPath(classification), certain: classification.verdict === 'certain',
        reason: classification.reason, source: 'rule' };
    }
    const folders = snapshot.barRootIds.flatMap((id) => listFoldersInSubtree(snapshot, id))
      .filter((node) => node.modifiable).map((node) => node.selfRelativePath!).filter(Boolean);
    return recommendBookmarkFolder(await loadDeepSeekKey(), { bookmarkId, title, url, fromRelativePath }, folders);
  }

  private async recommendPage(title: string, url: string): Promise<BookmarkCommandResult> {
    try {
      const state = await this.storage.load();
      const snapshot = createBookmarkSnapshot(await chrome.bookmarks.getTree());
      const recommendation = await this.recommendation(title, url, '', state, snapshot);
      if ((await this.storage.load()).classificationRevision !== state.classificationRevision) {
        throw new Error('推荐期间分类规则已变化，请重新获取推荐。');
      }
      return { ok: true, recommendation };
    } catch (cause) { return { ok: false, error: cause instanceof Error ? cause.message : '无法生成 AI 推荐，请重试。' }; }
  }

  private async aiPreview(scopeFolderId: string | null, expectedRevision: number): Promise<BookmarkCommandResult> {
    try {
      const state = await this.storage.load();
      if (state.classificationRevision !== expectedRevision) throw new Error('分类规则已变化，请重新扫描后生成 AI 预览。');
      const tree = await chrome.bookmarks.getTree();
      const preview = buildOrganizePreview(tree, { rules: state.rules, overrides: state.overrides, scopeFolderId });
      const snapshot = createBookmarkSnapshot(tree);
      const folders = snapshot.barRootIds.flatMap((id) => listFoldersInSubtree(snapshot, id))
        .filter((node) => node.modifiable).map((node) => node.selfRelativePath!).filter(Boolean);
      const protectedIds = new Set(preview.items.filter((item) =>
        state.overrides[item.bookmarkId]?.urlFingerprint === item.urlFingerprint).map((item) => item.bookmarkId));
      const result = await generateAiPreview(preview, await loadDeepSeekKey(), protectedIds, folders);
      if ((await this.storage.load()).classificationRevision !== expectedRevision) {
        throw new Error('生成期间分类规则已变化，请重新扫描后重试。');
      }
      return { ok: true, preview: result };
    } catch (cause) { return { ok: false, error: cause instanceof Error ? cause.message : 'AI 整理失败，请重试。' }; }
  }

  /** 确保目标路径存在：按「父 ID + 标题」复用现有文件夹，缺失才创建。 */
  private async ensureTargetFolder(
    barRootId: string,
    targetPath: string,
    createdFolders: Array<{ id: string; path: string }>,
    onCreated?: () => Promise<void>,
  ): Promise<string> {
    const segments = splitTargetPath(targetPath);
    if (!segments) throw new Error(`目标路径无效：${targetPath}`);
    let parentId = barRootId;
    let walked = '';
    for (const segment of segments) {
      walked = walked ? `${walked}/${segment}` : segment;
      const children = await chrome.bookmarks.getChildren(parentId);
      const existing = children.find((child) => !child.url && child.title === segment && !child.unmodifiable);
      if (existing) {
        parentId = existing.id;
        continue;
      }
      const created = await chrome.bookmarks.create({ parentId, title: segment });
      createdFolders.push({ id: created.id, path: walked });
      await onCreated?.();
      parentId = created.id;
    }
    return parentId;
  }

  private failItem(item: BatchItemLog, reason: string): void {
    item.status = 'failed';
    item.reason = reason;
  }

  /** 对账旧日志时按目标路径定位文件夹，不把其他位置的外部移动误认成本批次。 */
  private findTargetFolder(snapshot: BookmarkSnapshot, barRootId: string | null, targetPath: string): string | null {
    const segments = splitTargetPath(targetPath);
    if (!barRootId || !segments) return null;
    let parentId = barRootId;
    for (const segment of segments) {
      const folder = childrenOf(snapshot, parentId).find((child) =>
        !isBookmarkNode(child) && child.modifiable && child.title === segment);
      if (!folder) return null;
      parentId = folder.id;
    }
    return parentId;
  }

  /** 单条移动的执行前校验 + 移动；返回失败原因，null 表示成功。新建目录记入 createdFolders。 */
  private async moveItem(
    item: BatchItemLog,
    snapshot: BookmarkSnapshot,
    createdFolders: Array<{ id: string; path: string }>,
    persistIntent?: () => Promise<void>,
    shouldContinue?: () => boolean,
  ): Promise<string | null> {
    const node = getNode(snapshot, item.bookmarkId);
    if (!node) return '书签已不存在';
    if (!isBookmarkNode(node)) return '目标条目已不是书签';
    if (node.barRootId === null) return '书签已不在书签栏内';
    if (!node.modifiable) return '书签所在位置不可修改';
    if (urlFingerprint(node.url!) !== item.urlFingerprint) return '网址已变化，预览过期';
    if (node.title !== item.originalTitle) return '标题已变化，预览过期';
    if (node.parentId !== item.originalParentId) return '书签已被移动到其他位置';
    let targetFolderId: string;
    try {
      targetFolderId = await this.ensureTargetFolder(node.barRootId, item.targetPath, createdFolders, persistIntent);
      item.targetFolderId = targetFolderId;
      // 先持久化目标 ID，再移动；中断后 pending 项可以与真实树对账。
      await persistIntent?.();
      if (shouldContinue) {
        const live = getNode(createBookmarkSnapshot(await chrome.bookmarks.getTree()), item.bookmarkId);
        if (!shouldContinue() || !live || !live.modifiable || live.parentId !== item.originalParentId ||
          live.title !== item.originalTitle || urlFingerprint(live.url ?? '') !== item.urlFingerprint) {
          return '书签已被编辑、移动或删除，停止自动放置';
        }
      }
      await chrome.bookmarks.move(item.bookmarkId, { parentId: targetFolderId });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    item.status = 'applied';
    return null;
  }

  private async loadStateAndCheckNoPending(): Promise<OrganizerState> {
    const state = await this.storage.load();
    const pending = unfinishedBatch(state);
    if (pending) {
      throw new Error(`已有未完成的整理批次（${new Date(pending.startedAt).toLocaleString()}），请先在整理页对账或撤销后再开始新批次。`);
    }
    return state;
  }

  /** 从真实树核对计划：失效条目标记 skipped 并写明原因，不直接应用过期计划。 */
  private verifyPlan(plan: OrganizeApplyPlan, snapshot: BookmarkSnapshot): BatchItemLog[] {
    const items: BatchItemLog[] = [];
    for (const move of plan.items) {
      const node = getNode(snapshot, move.bookmarkId);
      const base: BatchItemLog = {
        bookmarkId: move.bookmarkId,
        urlFingerprint: move.urlFingerprint,
        title: move.title,
        url: node?.url ?? '',
        originalParentId: node?.parentId ?? move.originalParentId,
        originalIndex: node?.index ?? 0,
        originalTitle: move.title,
        targetPath: move.targetPath,
        status: 'pending',
      };
      let skipReason: string | null = null;
      if (!node) skipReason = '书签已不存在';
      else if (!isBookmarkNode(node)) skipReason = '目标条目已不是书签';
      else if (!node.modifiable) skipReason = '书签所在位置不可修改';
      else if (node.barRootId === null) skipReason = '书签已不在书签栏内';
      else if (urlFingerprint(node.url!) !== move.urlFingerprint) skipReason = '网址已变化，预览过期';
      else if (node.title !== move.title) skipReason = '标题已变化，预览过期';
      else if (node.parentId !== move.originalParentId) skipReason = '书签已被移动到其他位置';
      if (skipReason) {
        base.status = 'skipped';
        base.reason = skipReason;
      }
      items.push(base);
    }
    return items;
  }

  private async applyBatch(plan: OrganizeApplyPlan, shouldContinue?: () => boolean): Promise<OrganizeBatch> {
    if (plan.items.length === 0 && plan.archives.length === 0 && !plan.cleanupEmptyFolders) {
      throw new Error('没有选择要移动的书签。');
    }
    const state = await this.loadStateAndCheckNoPending();
    if (state.classificationRevision !== plan.classificationRevision) {
      throw new Error('分类规则已变化，请重新扫描后再应用。');
    }
    const snapshot = createBookmarkSnapshot(await chrome.bookmarks.getTree());
    const items = this.verifyPlan(plan, snapshot);
    const executable = items.filter((item) => item.status === 'pending');
    const plannedArchives = plan.cleanupEmptyFolders
      ? emptyFolderCandidates(snapshot, plan.scopeFolderId ?? null, executable)
      : plan.archives;
    if (executable.length === 0 && plannedArchives.length === 0) {
      throw new Error('所选书签在预览后已全部变化，请重新扫描。');
    }

    // 日志先于任何写入落盘：中途失败也能对账或撤销。
    const batch: OrganizeBatch = {
      id: createOrganizerId('batch'),
      startedAt: Date.now(),
      status: 'running',
      items,
      createdFolders: [],
      undoReport: [],
      cleanupEmptyFolders: plan.cleanupEmptyFolders,
      plannedArchives: plannedArchives.map((archive) => ({ ...archive })),
      archivedFolders: [],
    };
    state.batches.push(batch);
    await this.storage.save(state);

    await this.executeBatchMoves(batch, snapshot, state, shouldContinue);
    await this.executeArchives(batch, state);
    this.finalizeBatch(batch);
    await this.storage.save(recordActivity(state, {
      kind: 'apply',
      at: Date.now(),
      title: '整理批次',
      detail: this.batchSummary(batch),
    }));
    return batch;
  }

  private async executeBatchMoves(
    batch: OrganizeBatch,
    snapshot: BookmarkSnapshot,
    state: OrganizerState,
    shouldContinue?: () => boolean,
  ): Promise<void> {
    for (const item of batch.items) {
      if (item.status !== 'pending') continue;
      const failure = await this.moveItem(item, snapshot, batch.createdFolders, () => this.storage.save(state), shouldContinue);
      if (failure) this.failItem(item, failure);
      await this.storage.save(state);
    }
  }

  private async executeArchives(batch: OrganizeBatch, state: OrganizerState): Promise<void> {
    if (batch.plannedArchives.length === 0) return;
    let snapshot = createBookmarkSnapshot(await chrome.bookmarks.getTree());
    // 实际生效的目标路径：归档文件夹绝不能是任何目标文件夹的祖先。
    const protectedPrefixes = new Set<string>(batch.cleanupEmptyFolders ? [] : [ARCHIVE_ROOT_PATH, ARCHIVE_ROOT_PATH.split('/')[0]]);
    for (const item of batch.items) {
      if (item.status !== 'applied') continue;
      const segments = item.targetPath.split('/');
      for (let i = 1; i <= segments.length; i += 1) protectedPrefixes.add(segments.slice(0, i).join('/'));
    }

    for (const planned of batch.plannedArchives) {
      if (batch.cleanupEmptyFolders) snapshot = createBookmarkSnapshot(await chrome.bookmarks.getTree());
      let log = batch.archivedFolders.find((entry) => entry.folderId === planned.folderId);
      if (log && log.status !== 'pending') continue;
      if (!log) {
        log = { ...planned, ...(batch.cleanupEmptyFolders ? { mode: 'delete' as const } : {}), status: 'pending' };
        batch.archivedFolders.push(log);
      }
      const node = getNode(snapshot, planned.folderId);
      const barRootId = node?.barRootId ?? null;
      if (!node && log.mode === 'delete' && log.deletionStarted) {
        log.status = 'applied'; // 删除成功后尚未保存完成日志便中断。
      } else if (!node || isBookmarkNode(node) || !node.modifiable || barRootId === null) {
        log.status = 'skipped';
        log.reason = '文件夹已不存在或不可修改';
      } else if (snapshot.barRootIds.includes(node.id)) {
        log.status = 'skipped';
        log.reason = '不能归档书签栏根目录';
      } else if (node.selfRelativePath !== null && protectedPrefixes.has(node.selfRelativePath)) {
        log.status = 'skipped';
        log.reason = '文件夹是目标位置的祖先，保留原位';
      } else if (log.archiveFolderId && node.parentId === log.archiveFolderId) {
        // 上次执行可能在 move 成功后、完成日志保存前中断。
        log.status = 'applied';
      } else if (node.parentId !== planned.originalParentId || node.title !== planned.title) {
        log.status = 'skipped';
        log.reason = '文件夹在预览后已变化，保留原位';
      } else if ((await chrome.bookmarks.getChildren(node.id)).length > 0) {
        log.status = 'skipped';
        log.reason = '文件夹仍有内容，保留原位';
      } else {
        try {
          if (log.mode === 'delete') {
            log.deletionStarted = true;
            await this.storage.save(state);
            // remove 会拒绝非空目录；并发新增内容时不使用 removeTree。
            await chrome.bookmarks.remove(node.id);
          } else {
            const archiveFolderId = await this.ensureTargetFolder(
              barRootId, ARCHIVE_ROOT_PATH, batch.createdFolders, () => this.storage.save(state));
            log.archiveFolderId = archiveFolderId;
            await this.storage.save(state);
            await chrome.bookmarks.move(node.id, { parentId: archiveFolderId });
          }
          log.status = 'applied';
        } catch (error) {
          log.status = 'failed';
          log.reason = error instanceof Error ? error.message : String(error);
        }
      }
      await this.storage.save(state);
    }
  }

  private finalizeBatch(batch: OrganizeBatch): void {
    const applied = batch.items.filter((item) => item.status === 'applied').length;
    const skipped = batch.items.filter((item) => item.status === 'skipped').length;
    const failed = batch.items.filter((item) => item.status === 'failed').length;
    const archivesApplied = batch.archivedFolders.filter((entry) => entry.status === 'applied').length;
    const archivesSkipped = batch.archivedFolders.filter((entry) => entry.status === 'skipped').length;
    const archivesFailed = batch.archivedFolders.filter((entry) => entry.status === 'failed').length;
    const succeeded = applied + archivesApplied;
    const notClean = failed + archivesFailed + skipped + archivesSkipped > 0;
    // 全部成功才算 applied；有任何跳过/失败都按对账结果列为 partial；一无所成是 failed。
    batch.outcome = succeeded === 0 ? 'failed' : notClean ? 'partial' : 'applied';
    batch.status = 'completed';
    batch.finishedAt = Date.now();
  }

  private batchSummary(batch: OrganizeBatch): string {
    const applied = batch.items.filter((item) => item.status === 'applied').length;
    const skipped = batch.items.filter((item) => item.status === 'skipped').length;
    const failed = batch.items.filter((item) => item.status === 'failed').length;
    const archived = batch.archivedFolders.filter((entry) => entry.status === 'applied').length;
    return `移动 ${applied} · 跳过 ${skipped} · 失败 ${failed}${archived ? ` · ${batch.cleanupEmptyFolders ? '删除' : '存档'}空目录 ${archived}` : ''}`;
  }

  /** 撤销：先还原存档文件夹，再逆序移回书签，最后删除本批次新建且仍为空的文件夹。 */
  private async undoBatch(batchId: string): Promise<OrganizeBatch> {
    const state = await this.storage.load();
    const batch = state.batches.find((entry) => entry.id === batchId);
    if (!batch) throw new Error('找不到该批次的操作日志。');
    if (batch.status === 'running') throw new Error('批次尚未完成，请先对账再撤销。');
    if (batch.status === 'undone') throw new Error('该批次已经撤销过。');

    let snapshot = createBookmarkSnapshot(await chrome.bookmarks.getTree());
    batch.undoReport = [];
    const restoredIds = new Map<string, string>();

    // 1) 已存档的旧文件夹移回原父文件夹（仍需为空，且原父文件夹仍可写）。
    for (const archive of [...batch.archivedFolders].reverse()) {
      if (archive.status !== 'applied') continue;
      if (archive.mode === 'delete') {
        const parentId = restoredIds.get(archive.originalParentId) ?? archive.originalParentId;
        const parent = getNode(snapshot, parentId);
        if (!parent || !parent.modifiable) {
          batch.undoReport.push({ kind: 'archive', id: archive.folderId, reason: '原父文件夹已不存在或不可修改' });
          continue;
        }
        try {
          const previous = archive.restoredFolderId ? getNode(snapshot, archive.restoredFolderId) : null;
          if (previous && (previous.parentId !== parentId || previous.title !== archive.title || !previous.modifiable)) {
            throw new Error('恢复的文件夹已被修改，请保留当前内容并手动处理');
          }
          const siblings = await chrome.bookmarks.getChildren(parentId);
          const folderId = previous?.id ?? (await chrome.bookmarks.create({ parentId, title: archive.title,
            index: Math.min(archive.originalIndex, siblings.length) })).id;
          archive.restoredFolderId = folderId;
          restoredIds.set(archive.folderId, folderId);
          await this.storage.save(state);
          snapshot = createBookmarkSnapshot(await chrome.bookmarks.getTree());
        } catch (cause) {
          batch.undoReport.push({ kind: 'archive', id: archive.folderId, reason: cause instanceof Error ? cause.message : '恢复空目录失败' });
        }
        continue;
      }
      const node = getNode(snapshot, archive.folderId);
      if (!node) {
        batch.undoReport.push({ kind: 'archive', id: archive.folderId, reason: '文件夹已不存在' });
        continue;
      }
      if (node.parentId !== archive.archiveFolderId) {
        batch.undoReport.push({ kind: 'archive', id: archive.folderId, reason: '文件夹已被移动到其他位置' });
        continue;
      }
      if ((await chrome.bookmarks.getChildren(archive.folderId)).length > 0) {
        batch.undoReport.push({ kind: 'archive', id: archive.folderId, reason: '文件夹已非空，保留在存档位置' });
        continue;
      }
      const originalParent = getNode(snapshot, archive.originalParentId);
      if (!originalParent || !originalParent.modifiable) {
        batch.undoReport.push({ kind: 'archive', id: archive.folderId, reason: '原父文件夹已不存在或不可修改' });
        continue;
      }
      const siblings = await chrome.bookmarks.getChildren(archive.originalParentId);
      await chrome.bookmarks.move(archive.folderId, {
        parentId: archive.originalParentId,
        index: Math.min(archive.originalIndex, siblings.length),
      });
      snapshot.nodes[archive.folderId].parentId = archive.originalParentId;
    }

    // 2) 逆序把已成功条目移回原父文件夹，并尽量恢复原顺序。
    const appliedItems = batch.items.filter((item) => item.status === 'applied');
    const byParent = new Map<string, BatchItemLog[]>();
    for (const item of appliedItems) {
      const bucket = byParent.get(item.originalParentId) ?? [];
      bucket.push(item);
      byParent.set(item.originalParentId, bucket);
    }
    for (const [originalParentId, group] of byParent) {
      const parentId = restoredIds.get(originalParentId) ?? originalParentId;
      group.sort((left, right) => left.originalIndex - right.originalIndex);
      const originalParent = getNode(snapshot, parentId);
      if (!originalParent || !originalParent.modifiable) {
        for (const item of group) {
          batch.undoReport.push({ kind: 'item', id: item.bookmarkId, reason: '原文件夹已不存在或不可修改' });
        }
        continue;
      }
      for (const item of group) {
        const node = getNode(snapshot, item.bookmarkId);
        if (!node) {
          batch.undoReport.push({ kind: 'item', id: item.bookmarkId, reason: '书签已不存在' });
          continue;
        }
        if (urlFingerprint(node.url ?? '') !== item.urlFingerprint) {
          batch.undoReport.push({ kind: 'item', id: item.bookmarkId, reason: '网址已变化，跳过撤销' });
          continue;
        }
        if (item.targetFolderId && node.parentId !== item.targetFolderId) {
          batch.undoReport.push({ kind: 'item', id: item.bookmarkId, reason: '已被移动到其他位置，不覆盖新改动' });
          continue;
        }
        const siblings = await chrome.bookmarks.getChildren(parentId);
        try {
          await chrome.bookmarks.move(item.bookmarkId, {
            parentId,
            index: Math.min(item.originalIndex, siblings.length),
          });
          snapshot.nodes[item.bookmarkId].parentId = parentId;
        } catch (error) {
          batch.undoReport.push({
            kind: 'item', id: item.bookmarkId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // 3) 删除本批次新建且确认仍为空的文件夹（含存档目录）。
    for (const folder of [...batch.createdFolders].reverse()) {
      const node = getNode(snapshot, folder.id);
      if (!node) continue;
      if ((await chrome.bookmarks.getChildren(folder.id)).length > 0) {
        batch.undoReport.push({ kind: 'folder', id: folder.id, reason: `「${folder.path}」已非空，保留` });
        continue;
      }
      if (!node.modifiable) {
        batch.undoReport.push({ kind: 'folder', id: folder.id, reason: `「${folder.path}」不可修改，保留` });
        continue;
      }
      try {
        await chrome.bookmarks.remove(folder.id);
        delete snapshot.nodes[folder.id];
      } catch {
        batch.undoReport.push({ kind: 'folder', id: folder.id, reason: `「${folder.path}」删除失败，保留` });
      }
    }

    batch.status = 'undone';
    batch.undoneAt = Date.now();
    await this.storage.save(recordActivity(state, {
      kind: 'undo',
      at: Date.now(),
      title: '撤销整理批次',
      detail: batch.undoReport.length === 0 ? '全部恢复原位置' : `${batch.undoReport.length} 项跳过，详见批次详情`,
    }));
    return batch;
  }

  /** 重试批次中失败的条目：重新核对前置条件后再次移动。 */
  private async retryBatch(batchId: string): Promise<OrganizeBatch> {
    const state = await this.storage.load();
    const batch = state.batches.find((entry) => entry.id === batchId);
    if (!batch) throw new Error('找不到该批次的操作日志。');
    if (batch.status === 'running') throw new Error('批次尚未完成，请先对账。');
    if (batch.status === 'undone') throw new Error('已撤销的批次不能重试。');
    const failed = batch.items.filter((item) => item.status === 'failed');
    const retryFolders = batch.cleanupEmptyFolders ? batch.archivedFolders.filter((folder) =>
      folder.status === 'failed' || (failed.length > 0 && folder.status === 'skipped' && folder.reason?.includes('仍有内容'))) : [];
    if (failed.length === 0 && retryFolders.length === 0) throw new Error('没有可重试的失败条目。');

    batch.status = 'running';
    for (const item of failed) { item.status = 'pending'; item.reason = undefined; }
    for (const folder of retryFolders) { folder.status = 'pending'; folder.reason = undefined; }
    await this.storage.save(state);

    const snapshot = createBookmarkSnapshot(await chrome.bookmarks.getTree());
    for (const item of failed) {
      item.status = 'pending';
      item.reason = undefined;
      const failure = await this.moveItem(item, snapshot, batch.createdFolders, () => this.storage.save(state));
      if (failure) this.failItem(item, failure);
      await this.storage.save(state);
    }
    await this.executeArchives(batch, state);
    this.finalizeBatch(batch);
    await this.storage.save(state);
    return batch;
  }

  /**
   * 后台中断后的恢复：对照真实书签树结算仍为 pending 的条目——
   * 已在目标位置的标记成功，前置条件仍成立的补完移动，其余跳过。
   */
  private async reconcileBatch(batchId: string): Promise<OrganizeBatch> {
    const state = await this.storage.load();
    const batch = state.batches.find((entry) => entry.id === batchId);
    if (!batch) throw new Error('找不到该批次的操作日志。');
    if (batch.status !== 'running') throw new Error('该批次不需要对账。');

    const snapshot = createBookmarkSnapshot(await chrome.bookmarks.getTree());
    for (const item of batch.items) {
      if (item.status !== 'pending') continue;
      const node = getNode(snapshot, item.bookmarkId);
      if (!node || !isBookmarkNode(node)) {
        item.status = 'skipped';
        item.reason = '书签已不存在';
        continue;
      }
      const targetFolderId = item.targetFolderId ?? this.findTargetFolder(snapshot, node.barRootId, item.targetPath);
      if (targetFolderId && node.parentId === targetFolderId &&
        urlFingerprint(node.url!) === item.urlFingerprint && node.title === item.originalTitle) {
        item.targetFolderId = targetFolderId;
        item.status = 'applied';
        await this.storage.save(state);
        continue;
      }
      const failure = await this.moveItem(item, snapshot, batch.createdFolders, () => this.storage.save(state));
      if (failure) {
        item.status = 'skipped';
        item.reason = failure;
      }
      await this.storage.save(state);
    }
    // 中断前未执行完的归档步骤补齐。
    await this.executeArchives(batch, state);
    this.finalizeBatch(batch);
    await this.storage.save(state);
    return batch;
  }

  /** 手动“保存当前页到推荐文件夹”：目标路径可由用户在保存前修改。 */
  private async savePageBookmark(title: string, url: string, targetPath: string): Promise<void> {
    const snapshot = createBookmarkSnapshot(await chrome.bookmarks.getTree());
    const barRootId = snapshot.barRootIds[0];
    if (!barRootId) throw new Error('未找到可写入的书签栏。');
    const folderId = await this.ensureTargetFolder(barRootId, targetPath, []);
    const created = await chrome.bookmarks.create({ parentId: folderId, title, url });
    this.ownedCreates.add(created.id);
    const state = await this.storage.load();
    await this.storage.save(recordActivity(state, {
      kind: 'manual-save',
      at: Date.now(),
      title,
      detail: `保存到 ${targetPath}`,
    }));
  }

  /** 新收藏：规则优先，开启 AI 后补充主题推荐；网络不占用写队列，应用前复核状态。 */
  async handleBookmarkCreated(bookmarkId: string): Promise<void> {
    if (this.ownedCreates.delete(bookmarkId)) return;
    const job = { cancelled: false };
    this.cancelBookmarkPlacement(bookmarkId);
    this.placements.set(bookmarkId, job);
    try { await this.autoMoveCreated(bookmarkId, job); }
    catch (cause) {
      if (!job.cancelled) await this.enqueue(async () => {
        const state = await this.storage.load();
        await this.storage.save(recordActivity(state, { kind: 'auto-place-skip', at: Date.now(),
          title: '新书签未自动放置', detail: cause instanceof Error ? cause.message : 'AI 推荐失败，保留原位置' }));
      }).catch(() => {});
    } finally { if (this.placements.get(bookmarkId) === job) this.placements.delete(bookmarkId); }
  }

  private async autoMoveCreated(bookmarkId: string, job: { cancelled: boolean }): Promise<void> {
    const state = await this.storage.load();
    if ((!state.settings.autoArchiveEnabled && !state.settings.aiAutoPlaceEnabled) || this.importing || job.cancelled) return;
    if (unfinishedBatch(state)) return;
    const snapshot = createBookmarkSnapshot(await chrome.bookmarks.getTree());
    const node = getNode(snapshot, bookmarkId);
    if (!node || !isBookmarkNode(node) || !node.modifiable || node.barRootId === null) return;

    const folderNames: string[] = [];
    let parent = node.parentId ? getNode(snapshot, node.parentId) : null;
    while (parent && parent.id !== node.barRootId) {
      folderNames.unshift(parent.title);
      parent = parent.parentId ? getNode(snapshot, parent.parentId) : null;
    }
    const override = state.overrides[bookmarkId];
    const classification = classifyBookmark(
      { title: node.title, url: node.url!, folderNames },
      state.rules,
      override?.urlFingerprint === urlFingerprint(node.url!) ? override : undefined,
    );
    if (classification.noAutoMove || (override?.urlFingerprint === urlFingerprint(node.url!))) return;
    let recommendation: BookmarkRecommendation;
    if (classification.matchedUserRule) {
      recommendation = { targetPath: suggestedTargetPath(classification), certain: classification.verdict === 'certain', reason: classification.reason, source: 'rule' };
    } else if (state.settings.aiAutoPlaceEnabled) {
      if (!/^https?:/.test(node.url!)) return;
      recommendation = await this.recommendation(node.title || node.url!, node.url!, node.relativeFolderPath ?? '', state, snapshot, node.id);
    } else return;
    const target = recommendation.targetPath;
    if (!recommendation.certain || !target) {
      if (state.settings.aiAutoPlaceEnabled && !job.cancelled) await this.enqueue(async () => {
        const current = await this.storage.load();
        await this.storage.save(recordActivity(current, { kind: 'auto-place-skip', at: Date.now(), title: node.title || node.url!,
          detail: `建议需确认，保留原位置：${recommendation.reason}` }));
      });
      return;
    }
    if (!target || target === node.relativeFolderPath) return;
    await this.enqueue(async () => {
      const current = await this.storage.load();
      if (job.cancelled || this.importing || unfinishedBatch(current) || current.classificationRevision !== state.classificationRevision ||
        (!current.settings.aiAutoPlaceEnabled && !(recommendation.source === 'rule' && current.settings.autoArchiveEnabled))) return;
      const live = getNode(createBookmarkSnapshot(await chrome.bookmarks.getTree()), bookmarkId);
      if (!live || live.parentId !== node.parentId || live.title !== node.title || live.url !== node.url || !live.modifiable) return;
      const batch = await this.applyBatch({ classificationRevision: current.classificationRevision, archives: [], items: [{
        bookmarkId, title: node.title, urlFingerprint: urlFingerprint(node.url!), originalParentId: node.parentId!, targetPath: target,
      }] }, () => !job.cancelled && !this.importing);
      if (batch.items[0]?.status !== 'applied') {
        for (const folder of [...batch.createdFolders].reverse()) {
          try { if ((await chrome.bookmarks.getChildren(folder.id)).length === 0) await chrome.bookmarks.remove(folder.id); }
          catch { /* 用户已向目录添加内容时保留。 */ }
        }
      }
      const latest = await this.storage.load();
      await this.storage.save(recordActivity(latest, { kind: batch.items[0]?.status === 'applied' ? 'auto-move' : 'auto-place-skip',
        at: Date.now(), title: node.title || node.url!, detail: batch.items[0]?.status === 'applied'
          ? `${recommendation.source === 'AI' ? 'AI 智能放置' : '用户规则'}：${node.relativeFolderPath || '书签栏'} → ${target}`
          : batch.items[0]?.reason ?? '未移动，保留原位置' }));
    });
  }
}

/** 侧栏/弹窗等扩展自身页面才允许书签写命令；内容脚本的消息一律拒绝。 */
export const registerBookmarkCommands = (coordinator: BookmarkOrganizeCoordinator): void => {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const type = (message as { type?: unknown } | null | undefined)?.type;
    if (typeof type !== 'string' || !(Object.values(BOOKMARK_COMMANDS) as string[]).includes(type)) {
      return false;
    }
    if (!isBookmarkCommand(message)) {
      sendResponse({ ok: false, error: '书签命令参数不完整。' });
      return false;
    }
    if (!isExtensionPageSender(sender)) {
      sendResponse({ ok: false, error: '书签整理写入只能由扩展页面发起。' });
      return false;
    }
    void coordinator.handle(message).then(sendResponse);
    return true;
  });
};

/** 原生收藏框会先创建书签，再更新名称/位置；等内容稳定后处理，手动移动取消。 */
export const NEW_BOOKMARK_SETTLE_MS = 1500;
export const registerBookmarkAutoOrganize = (coordinator: BookmarkOrganizeCoordinator): (() => void) => {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, object>();
  let importing = false;
  const cancel = (id: string): void => {
    clearTimeout(timers.get(id));
    timers.delete(id);
    pending.delete(id);
    coordinator.cancelBookmarkPlacement(id);
  };
  const schedule = (id: string): void => {
    clearTimeout(timers.get(id));
    const ticket = {};
    pending.set(id, ticket);
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      void coordinator.handleBookmarkCreated(id).finally(() => {
        if (pending.get(id) === ticket) pending.delete(id);
      });
    }, NEW_BOOKMARK_SETTLE_MS));
  };
  const created = (id: string, node?: chrome.bookmarks.BookmarkTreeNode): void => {
    if (!importing && (!node || node.url)) schedule(id);
  };
  const changed = (id: string): void => {
    if (!pending.has(id) || importing) return;
    coordinator.cancelBookmarkPlacement(id);
    schedule(id);
  };
  const began = (): void => {
    importing = true;
    for (const id of pending.keys()) cancel(id);
    coordinator.setImporting(true);
  };
  const ended = (): void => { importing = false; coordinator.setImporting(false); };
  const reordered = (_id: string, info: { childIds: string[] }): void => { for (const id of info.childIds) cancel(id); };
  const api = chrome.bookmarks;
  api?.onCreated?.addListener(created);
  api?.onChanged?.addListener(changed);
  api?.onMoved?.addListener(cancel);
  api?.onRemoved?.addListener(cancel);
  api?.onChildrenReordered?.addListener(reordered);
  api?.onImportBegan?.addListener(began);
  api?.onImportEnded?.addListener(ended);
  return () => {
    for (const id of pending.keys()) cancel(id);
    api?.onCreated?.removeListener?.(created);
    api?.onChanged?.removeListener?.(changed);
    api?.onMoved?.removeListener?.(cancel);
    api?.onRemoved?.removeListener?.(cancel);
    api?.onChildrenReordered?.removeListener?.(reordered);
    api?.onImportBegan?.removeListener?.(began);
    api?.onImportEnded?.removeListener?.(ended);
  };
};
