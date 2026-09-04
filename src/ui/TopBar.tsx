import { useRef } from 'react';
import { useEditor } from '../state/store';
import { formatTime } from './format';
import { useOpenFile } from './useOpenFile';

export function TopBar() {
  const asset = useEditor((s) => s.asset);
  const setAsset = useEditor((s) => s.setAsset);
  const exporting = useEditor((s) => s.exportJob.active);
  const openFile = useOpenFile();
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <header className="topbar">
      <div className="brand">
        <img className="brand-mark" src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={22} height={22} />
        <span className="brand-name">MediaBox</span>
      </div>
      {asset && (
        <div className="asset-info">
          <span className={`badge badge-${asset.kind}`}>{asset.kind}</span>
          <span className="asset-name" title={asset.name}>
            {asset.name}
          </span>
          <span className="asset-dims">
            {asset.width}×{asset.height}
            {asset.kind === 'video' && ` · ${formatTime(asset.duration)}`}
          </span>
        </div>
      )}
      <div className="topbar-actions">
        <input
          ref={inputRef}
          type="file"
          accept="image/*,video/*,.mkv,.mov,.mp4,.webm"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void openFile(file);
            e.target.value = '';
          }}
        />
        <button className="btn" onClick={() => inputRef.current?.click()} disabled={exporting}>
          Open
        </button>
        {asset && (
          <button className="btn btn-ghost" onClick={() => setAsset(null)} disabled={exporting}>
            Close
          </button>
        )}
      </div>
    </header>
  );
}
