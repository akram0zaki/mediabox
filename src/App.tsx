import { useEffect } from 'react';
import './core/operations'; // registers built-in operations
import { onFaceCount } from './core/operations';
import { faceDetection } from './faces/detector';
import { useEditor } from './state/store';
import { installDevtools } from './devtools';
import { ConsentBanner } from './ui/ConsentBanner';
import { Dropzone } from './ui/Dropzone';
import { Preview } from './ui/Preview';
import { Sidebar } from './ui/Sidebar';
import { Timeline } from './ui/Timeline';
import { TopBar } from './ui/TopBar';

installDevtools();

export default function App() {
  const asset = useEditor((s) => s.asset);
  const setFacesInFrame = useEditor((s) => s.setFacesInFrame);

  // Warm up the default on-device detector as soon as the app opens.
  useEffect(() => {
    faceDetection.load(useEditor.getState().faceMask.detection.engine).catch(() => undefined);
  }, []);

  useEffect(() => onFaceCount((n, mode) => mode === 'preview' && setFacesInFrame(n)), [setFacesInFrame]);

  // Keyboard: Space toggles playback; holding C shows the original (unmasked) frame.
  useEffect(() => {
    const isTyping = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      return !!target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && (target as HTMLInputElement).type !== 'range';
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const s = useEditor.getState();
      if (!s.asset || s.exportJob.active) return;
      if (e.code === 'Space' && s.asset.kind === 'video') {
        e.preventDefault();
        s.setPlaying(!s.playing);
      } else if (e.code === 'KeyC' && !e.repeat && !e.metaKey && !e.ctrlKey) {
        s.setCompare(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'KeyC') useEditor.getState().setCompare(false);
    };
    const onBlur = () => useEditor.getState().setCompare(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  return (
    <div className="app">
      <TopBar />
      {asset ? (
        <>
          <main className="workspace">
            <Preview />
            <Sidebar />
          </main>
          {asset.kind === 'video' && <Timeline />}
        </>
      ) : (
        <Dropzone />
      )}
      <ConsentBanner />
    </div>
  );
}
