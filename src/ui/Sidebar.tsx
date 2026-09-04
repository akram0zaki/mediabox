import { useEditor, type PanelId } from '../state/store';
import { AdjustPanel } from './panels/AdjustPanel';
import { ExportPanel } from './panels/ExportPanel';
import { FaceMaskPanel } from './panels/FaceMaskPanel';
import { TransformPanel } from './panels/TransformPanel';

const TABS: { id: PanelId; label: string }[] = [
  { id: 'faces', label: 'Faces' },
  { id: 'transform', label: 'Transform' },
  { id: 'adjust', label: 'Filters' },
  { id: 'export', label: 'Export' },
];

export function Sidebar() {
  const panel = useEditor((s) => s.panel);
  const setPanel = useEditor((s) => s.setPanel);
  return (
    <aside className="sidebar">
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={panel === t.id}
            className={panel === t.id ? 'is-active' : ''}
            onClick={() => setPanel(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="panel-scroll">
        {panel === 'faces' && <FaceMaskPanel />}
        {panel === 'transform' && <TransformPanel />}
        {panel === 'adjust' && <AdjustPanel />}
        {panel === 'export' && <ExportPanel />}
      </div>
    </aside>
  );
}
