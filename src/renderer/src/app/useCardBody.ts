import { useEffect, useState } from "react";
import type { CardBody, CardSummary, MumblerCard, ShellSnapshot } from "@shared/app-shell";
import { reportRendererDiagnostic } from "./presentFailure";
import { shellApi } from "@renderer/shell-api";

// One selected body, not a second queue cache. A late reply belongs to the
// exact selection and revision that requested it. Metadata-only progress does
// not reload text or replace the mounted editor and its local trim drafts.
export function useCardBody(summary: CardSummary | null, onSnapshot: (snapshot: ShellSnapshot) => void) {
  const [body, setBody] = useState<CardBody | null>(null);
  const [failure, setFailure] = useState<{ id: string; revision: number; error: unknown } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const id = summary?.id;
  const revision = summary?.bodyRevision;
  useEffect(() => {
    if (id === undefined) { setBody(null); return; }
    let current = true;
    setFailure(null);
    void shellApi.getCardBody(id).then(async (next) => {
      if (!current) return;
      if (next?.cardId === id && next.revision === revision) setBody(next);
      else {
        const snapshot = await shellApi.getSnapshot();
        if (current) onSnapshot(snapshot);
      }
    }).catch((error: unknown) => {
      reportRendererDiagnostic(error, "recording text read failed");
      if (current) setFailure({ id, revision: revision!, error });
    });
    return () => { current = false; };
  }, [id, revision, attempt, onSnapshot]);

  const ready = body !== null && body.cardId === id && body.revision === revision;
  // Empty presentation fields while loading are never a saved body: callers
  // must gate text-dependent actions on ready. Keep the metadata editor mounted.
  const card: MumblerCard | null = summary === null ? null : {
    ...summary, transcription: { text: ready ? body.transcription : null },
    metadata: { ...summary.metadata, structured: ready ? body.structured : null },
  };
  return { card, ready, error: failure !== null && failure.id === id && failure.revision === revision ? failure : null,
    retry: () => setAttempt((value) => value + 1) };
}
