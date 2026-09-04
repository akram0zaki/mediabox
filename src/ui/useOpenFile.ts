import { useCallback } from 'react';
import { loadAsset } from '../media/loadAsset';
import { useEditor } from '../state/store';

export function useOpenFile() {
  const setAsset = useEditor((s) => s.setAsset);
  const setLoading = useEditor((s) => s.setLoading);
  return useCallback(
    async (file: File) => {
      setLoading(true);
      try {
        const asset = await loadAsset(file);
        setAsset(asset);
        setLoading(false);
      } catch (err) {
        setLoading(false, err instanceof Error ? err.message : String(err));
      }
    },
    [setAsset, setLoading],
  );
}
