import { useEffect, useRef, useState } from 'react';

import { exportBook, scanActiveBook, type BookTarget } from '../../modules/book-clip/export';
import { AppHeader, type AppModule } from '../components/AppHeader';

export function BookClipPage({ onSelect }: { onSelect(module: AppModule): void }) {
  const [target, setTarget] = useState<BookTarget>();
  const [selected, setSelected] = useState<number[]>([]);
  const [title, setTitle] = useState('');
  const [format, setFormat] = useState<'md' | 'zip'>('zip');
  const [restore, setRestore] = useState(true);
  const [operation, setOperation] = useState<'scan' | 'export' | null>(null);
  const busy = operation !== null;
  const [stopping, setStopping] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const job = useRef<AbortController | null>(null);
  useEffect(() => () => job.current?.abort(), []);

  async function scan(): Promise<void> {
    setOperation('scan');
    setError('');
    setStatus('正在扫描当前页…');
    setTarget(undefined);
    try {
      const next = await scanActiveBook();
      setTarget(next);
      setSelected(next.scan.chapters.map((_, index) => index));
      setTitle(next.scan.chapters.length > 1 ? `${new URL(next.scan.url).hostname} · 在线教程` : next.scan.title);
      setStatus(next.scan.chapters.length ? `识别到 ${next.scan.chapters.length} 篇。` : '未识别到课程章节。请展开网页中的课程目录后重新扫描。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '扫描失败');
      setStatus('');
    } finally {
      setOperation(null);
    }
  }

  async function start(onlyCurrent: boolean): Promise<void> {
    if (!target || job.current) return;
    const controller = new AbortController();
    job.current = controller;
    setOperation('export');
    setError('');
    setStatus('正在提取正文…');
    try {
      const message = await exportBook({
        target, title, format, restore, signal: controller.signal, onProgress: setStatus,
        chapters: onlyCurrent ? undefined : target.scan.chapters.filter((_, index) => selected.includes(index)),
      });
      setStatus(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导出失败');
      setStatus('');
    } finally {
      job.current = null;
      setOperation(null);
      setStopping(false);
    }
  }

  return <>
    <AppHeader active="book-clip" onSelect={onSelect} disabled={busy} />
    <section className="input-section book-clip-panel" aria-label="网页成书">
      <h2>网页成书</h2>
      <p className="meta">将当前可阅读的文章保存为 Markdown，或把选中的教程章节和图片一起导出为 ZIP。</p>
      <button type="button" className="primary-button" disabled={busy} onClick={() => void scan()}>扫描当前网页</button>
      {target && <>
        <p><strong>{target.scan.title}</strong></p>
        <p className="host" dir="ltr">{new URL(target.scan.url).hostname}</p>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void start(true)}>仅导出当前页 Markdown</button>
        <fieldset className="book-clip-options" disabled={busy}>
          <legend>选章导出</legend>
          <label className="field-label">书名<input value={title} onChange={event => setTitle(event.target.value)} /></label>
          <label className="field-label">导出格式<select value={format} onChange={event => setFormat(event.target.value === 'md' ? 'md' : 'zip')}>
            <option value="zip">ZIP（分章 Markdown 和图片）</option><option value="md">合并为一个 Markdown</option>
          </select></label>
          {target.scan.chapters.length > 1 && <div className="button-row">
            <button type="button" className="small-button" onClick={() => setSelected(target.scan.chapters.map((_, index) => index))}>全选</button>
            <button type="button" className="small-button" onClick={() => setSelected([])}>取消全选</button>
          </div>}
          <div className="book-clip-chapters">
            {target.scan.chapters.map((chapter, index) => <label key={index}>
              <input type="checkbox" checked={selected.includes(index)} onChange={event => {
                const checked = event.target.checked;
                setSelected(previous => checked ? [...previous, index] : previous.filter(item => item !== index));
              }} /> {chapter.title}
            </label>)}
          </div>
          <label><input type="checkbox" checked={restore} onChange={event => setRestore(event.target.checked)} /> 导出后返回原章节</label>
          <button type="button" className="primary-button" disabled={!selected.length} onClick={() => void start(false)}>导出所选章节</button>
        </fieldset>
      </>}
      {operation === 'export' && <button type="button" className="small-button" disabled={stopping} onClick={() => {
        job.current?.abort();
        setStopping(true);
      }}>{stopping ? '正在停止…' : '停止并保存已采集内容'}</button>}
      {status && <p role="status" className="meta">{status}</p>}
      {error && <p role="alert" className="inline-error">{error}</p>}
    </section>
  </>;
}
