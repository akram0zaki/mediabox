import { create } from 'zustand';
import type { MediaAsset, Operation } from '../core/types';
import {
  ADJUST_TYPE,
  FACE_MASK_TYPE,
  TRANSFORM_TYPE,
  defaultAdjust,
  defaultFaceMask,
  defaultTransform,
  type AdjustParams,
  type FaceMaskParams,
  type TransformParams,
} from '../core/operations';
import { releaseAsset } from '../media/loadAsset';
import { newPersonId, setPeople, type Person, type PersonSample } from '../faces/people';
import type { FaceOverride } from '../core/operations/faceMask';

const PEOPLE_KEY = 'mediabox.people.v2';

function loadPeople(): Person[] {
  try {
    const raw = localStorage.getItem(PEOPLE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Person[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistPeople(people: Person[]) {
  setPeople(people);
  try {
    localStorage.setItem(PEOPLE_KEY, JSON.stringify(people));
  } catch (err) {
    console.warn('[store] could not persist people', err);
  }
}

export type PanelId = 'faces' | 'transform' | 'adjust' | 'export';

export interface ExportJob {
  active: boolean;
  progress: number;
  message: string;
  error: string | null;
  done: { name: string; size: number; method: string } | null;
}

interface EditorState {
  asset: MediaAsset | null;
  loading: boolean;
  loadError: string | null;
  panel: PanelId;

  transform: TransformParams;
  adjust: AdjustParams;
  faceMask: FaceMaskParams;
  faceMaskEnabled: boolean;

  // Video playback / trim
  currentTime: number;
  playing: boolean;
  trimStart: number;
  trimEnd: number;

  facesInFrame: number;
  exportJob: ExportJob;
  /** Held down by the user: preview shows the frame without masks or adjustments. */
  compare: boolean;
  /** People whose faces are recognised and kept clear (or exclusively masked). Persisted. */
  people: Person[];
  /** Per-photo manual decisions for individual faces (reset when the asset changes). */
  faceOverrides: Record<string, FaceOverride>;
  /** Small copy of the current source frame (after transform) used for filter preset thumbnails. */
  previewThumb: HTMLCanvasElement | null;

  setAsset(asset: MediaAsset | null): void;
  setLoading(loading: boolean, error?: string | null): void;
  setPanel(panel: PanelId): void;
  setTransform(patch: Partial<TransformParams>): void;
  setAdjust(patch: Partial<AdjustParams>): void;
  setFaceMask(patch: Partial<FaceMaskParams>): void;
  setFaceMaskEnabled(enabled: boolean): void;
  resetTransform(): void;
  resetAdjust(): void;
  resetFaceMask(): void;
  setCurrentTime(t: number): void;
  setPlaying(playing: boolean): void;
  setTrim(start: number, end: number): void;
  setFacesInFrame(n: number): void;
  setExportJob(patch: Partial<ExportJob>): void;
  setCompare(compare: boolean): void;
  addPerson(name: string, sample: PersonSample): Person;
  addPersonSample(id: string, sample: PersonSample): void;
  renamePerson(id: string, name: string): void;
  removePerson(id: string): void;
  setFaceOverride(key: string, decision: FaceOverride | null): void;
  clearFaceOverrides(): void;
  setPreviewThumb(thumb: HTMLCanvasElement | null): void;
}

const idleExport: ExportJob = { active: false, progress: 0, message: '', error: null, done: null };

export const useEditor = create<EditorState>((set, get) => ({
  asset: null,
  loading: false,
  loadError: null,
  panel: 'faces',
  transform: defaultTransform,
  adjust: defaultAdjust,
  faceMask: defaultFaceMask,
  faceMaskEnabled: true,
  currentTime: 0,
  playing: false,
  trimStart: 0,
  trimEnd: 0,
  facesInFrame: 0,
  exportJob: idleExport,
  compare: false,
  people: loadPeople(),
  faceOverrides: {},
  previewThumb: null,

  setAsset: (asset) => {
    releaseAsset(get().asset);
    set({
      asset,
      loadError: null,
      transform: defaultTransform,
      adjust: defaultAdjust,
      currentTime: 0,
      playing: false,
      trimStart: 0,
      trimEnd: asset?.kind === 'video' ? asset.duration : 0,
      facesInFrame: 0,
      exportJob: idleExport,
      faceOverrides: {},
      previewThumb: null,
    });
  },
  setLoading: (loading, error = null) => set({ loading, loadError: error }),
  setPanel: (panel) => set({ panel }),
  setTransform: (patch) => set((s) => ({ transform: { ...s.transform, ...patch } })),
  setAdjust: (patch) => set((s) => ({ adjust: { ...s.adjust, ...patch } })),
  setFaceMask: (patch) => set((s) => ({ faceMask: { ...s.faceMask, ...patch } })),
  setFaceMaskEnabled: (faceMaskEnabled) => set({ faceMaskEnabled }),
  resetTransform: () => set({ transform: defaultTransform }),
  resetAdjust: () => set({ adjust: defaultAdjust }),
  resetFaceMask: () => set({ faceMask: defaultFaceMask }),
  setCurrentTime: (currentTime) => set({ currentTime }),
  setPlaying: (playing) => set({ playing }),
  setTrim: (trimStart, trimEnd) => set({ trimStart, trimEnd }),
  setFacesInFrame: (facesInFrame) => set({ facesInFrame }),
  setExportJob: (patch) => set((s) => ({ exportJob: { ...s.exportJob, ...patch } })),
  setCompare: (compare) => set((s) => (s.compare === compare ? s : { compare })),
  addPerson: (name, sample) => {
    const person: Person = { id: newPersonId(), name, samples: [sample] };
    const people = [...get().people, person];
    persistPeople(people);
    set({ people });
    return person;
  },
  addPersonSample: (id, sample) => {
    const people = get().people.map((p) => (p.id === id ? { ...p, samples: [...p.samples, sample].slice(-8) } : p));
    persistPeople(people);
    set({ people });
  },
  renamePerson: (id, name) => {
    const people = get().people.map((p) => (p.id === id ? { ...p, name } : p));
    persistPeople(people);
    set({ people });
  },
  removePerson: (id) => {
    const people = get().people.filter((p) => p.id !== id);
    persistPeople(people);
    set({ people });
  },
  setFaceOverride: (key, decision) =>
    set((s) => {
      const faceOverrides = { ...s.faceOverrides };
      if (decision) faceOverrides[key] = decision;
      else delete faceOverrides[key];
      return { faceOverrides };
    }),
  clearFaceOverrides: () => set({ faceOverrides: {} }),
  setPreviewThumb: (previewThumb) => set({ previewThumb }),
}));

// The render pipeline reads the gallery from the module registry; seed it from persisted state.
setPeople(useEditor.getState().people);

/**
 * Builds the ordered operation list from the current editor state.
 * `compare` keeps geometry (transform) but drops masks and adjustments, so the user can flip
 * between edited and original without the frame jumping. Detection still runs so the tracker
 * stays warm and the detection-box overlay keeps working.
 */
export function buildOperations(
  s: Pick<EditorState, 'transform' | 'adjust' | 'faceMask' | 'faceMaskEnabled' | 'faceOverrides'>,
  compare = false,
): Operation[] {
  const detect = s.faceMaskEnabled || s.faceMask.showBoxes;
  return [
    { type: TRANSFORM_TYPE, enabled: true, params: s.transform },
    {
      type: FACE_MASK_TYPE,
      enabled: detect,
      params: { ...s.faceMask, applyMask: s.faceMaskEnabled && !compare, overrides: s.faceOverrides },
    },
    { type: ADJUST_TYPE, enabled: !compare, params: s.adjust },
  ];
}
