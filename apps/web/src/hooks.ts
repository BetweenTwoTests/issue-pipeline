import { useEffect, useState } from "react";
import type { SessionChunk, SessionMeta, TranscriptEvent } from "@issue-pipeline/server";
import { fetchChunk } from "./api";

export interface TranscriptState {
  events: TranscriptEvent[];
  aiTitle: string | null;
  customTitle: string | null;
  meta: SessionMeta;
  malformedLines: number;
  fileSize: number;
  loading: boolean;
  error: string | null;
  /** Bumps whenever a poll appends events; drives follow-scrolling. */
  updatedAt: number;
}

const INITIAL: TranscriptState = {
  events: [],
  aiTitle: null,
  customTitle: null,
  meta: { cwd: null, gitBranch: null, version: null, slug: null },
  malformedLines: 0,
  fileSize: 0,
  loading: true,
  error: null,
  updatedAt: 0,
};

const POLL_MS = 2000;

/**
 * Loads a transcript and keeps polling for growth. The poll always runs
 * while the session is open: when nothing changed the server answers from a
 * single stat() and the previous state object is returned untouched, so
 * React skips the re-render (and any open <details> keeps its state).
 */
export function useTranscript(project: string | null, id: string | null): TranscriptState {
  const [state, setState] = useState<TranscriptState>(INITIAL);

  useEffect(() => {
    if (!project || !id) {
      setState(INITIAL);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    let offset = 0;
    setState({ ...INITIAL });

    const tick = async (): Promise<void> => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const chunk = await fetchChunk(project, id, offset);
        if (cancelled) return;
        offset = chunk.offset;
        setState((prev) => applyChunk(prev, chunk));
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setState((prev) => ({ ...prev, loading: false, error: message }));
        }
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const interval = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [project, id]);

  return state;
}

function applyChunk(prev: TranscriptState, chunk: SessionChunk): TranscriptState {
  const unchanged =
    !chunk.reset &&
    chunk.events.length === 0 &&
    chunk.aiTitle === null &&
    chunk.customTitle === null &&
    chunk.meta.cwd === null &&
    chunk.meta.gitBranch === null &&
    chunk.meta.version === null &&
    chunk.meta.slug === null &&
    chunk.malformedLines === 0 &&
    chunk.fileSize === prev.fileSize &&
    !prev.loading &&
    prev.error === null;
  if (unchanged) return prev;

  const base = chunk.reset ? INITIAL : prev;
  const grew = chunk.reset || chunk.events.length > 0;
  return {
    events: chunk.reset ? chunk.events : grew ? [...prev.events, ...chunk.events] : prev.events,
    aiTitle: chunk.aiTitle ?? base.aiTitle,
    customTitle: chunk.customTitle ?? base.customTitle,
    meta: {
      cwd: chunk.meta.cwd ?? base.meta.cwd,
      gitBranch: chunk.meta.gitBranch ?? base.meta.gitBranch,
      version: chunk.meta.version ?? base.meta.version,
      slug: chunk.meta.slug ?? base.meta.slug,
    },
    malformedLines: base.malformedLines + chunk.malformedLines,
    fileSize: chunk.fileSize,
    loading: false,
    error: null,
    updatedAt: grew ? Date.now() : base.updatedAt,
  };
}
