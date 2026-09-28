import { recommendedCandidate, type CandidateOption } from '../../shared/messaging/tab-messaging';

interface Props {
  candidates: CandidateOption[];
  title: string;
  onSelect(option: CandidateOption): void;
  onRefresh(): void;
  onBack(): void;
}

/** 多表单候选选择页：只展示概要（标题/数量/少量标签），不展示字段值。 */
export function FormCandidatesPage({ candidates, title, onSelect, onRefresh, onBack }: Props) {
  const recommended = recommendedCandidate(candidates);
  return (
    <>
      <header className="page-header">
        <button className="icon-button" onClick={onBack} aria-label="返回表单历史">←</button>
        <div><span className="eyebrow">选择目标</span><h1>{title}</h1></div>
        <button className="icon-button" onClick={onRefresh} aria-label="重新扫描目标页" title="重新扫描目标页">⟳</button>
      </header>

      <section className="history-section">
        <div className="section-heading"><h2>候选表单</h2><span>{candidates.length}</span></div>
        <div className="history-list">
          {candidates.length === 0 ? (
            <div className="empty-list">没有可用的表单，请重新扫描目标页。</div>
          ) : candidates.map((option) => (
            <article className="history-item" key={`${option.frameId}:${option.scopeId}`}>
              <button
                className="history-main history-open"
                onClick={() => onSelect(option)}
                aria-label={`选择表单“${option.title || '未命名表单'}”`}
              >
                <div className="history-name">
                  <strong>{option.title || '未命名表单'}</strong>
                  {option.scopeId === recommended?.scopeId && option.frameId === recommended.frameId && <span className="recommended-badge">推荐</span>}
                </div>
                <div className="meta">
                  {option.fieldCount} 个字段 · {option.focused ? '当前聚焦' : option.dialog ? '弹窗' : '页面表单'}
                  {` · ${option.frameId === 0 ? '主页面' : `子 frame ${option.frameId}`}`}
                  {option.source.host ? ` · ${option.source.host}` : ''}
                </div>
                {option.fieldLabels.length > 0 && <div className="host">{option.fieldLabels.join('、')}</div>}
              </button>
            </article>
          ))}
        </div>
        <p className="copy-hint">推荐项按焦点与弹窗规则标出；候选列表不包含字段值。</p>
      </section>
    </>
  );
}
