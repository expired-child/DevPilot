import { CloseIcon } from './icons';

export type AppModule = 'forms' | 'bookmarks';

interface Props {
  active: AppModule;
  onSelect(module: AppModule): void;
  onClose?(): void;
  closeLabel?: string;
}

const MODULES: Array<{ id: AppModule; label: string }> = [
  { id: 'forms', label: '表单剪贴板' },
  { id: 'bookmarks', label: '书签搜索' },
];

/** 顶层页共用应用框架：品牌、模块切换与关闭侧栏。 */
export function AppHeader({ active, onSelect, onClose, closeLabel = '关闭侧栏' }: Props) {
  return (
    <header className="app-header">
      <div className="app-brand">
        <span className="brand-mark" aria-hidden="true">D</span>
        <div className="app-brand-text">
          <h1>DevPilot</h1>
          <p>开发者效率工具</p>
        </div>
      </div>
      {onClose && (
        <button
          type="button"
          className="icon-button app-close"
          onClick={onClose}
          aria-label={closeLabel}
          title={closeLabel}
        >
          <CloseIcon />
        </button>
      )}
      <nav className="module-nav" aria-label="功能模块">
        {MODULES.map((module) => (
          <button
            key={module.id}
            type="button"
            className="module-nav-item"
            aria-current={active === module.id ? 'page' : undefined}
            onClick={() => {
              if (active !== module.id) onSelect(module.id);
            }}
          >
            {module.label}
          </button>
        ))}
      </nav>
    </header>
  );
}