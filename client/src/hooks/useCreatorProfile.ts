import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { loadCreatorProfile, saveCreatorProfile, type SavedCreatorProfile } from "@/lib/researchStore";
import { trpc } from "@/lib/trpc";
import type { CreatorProfile, NetworkNode } from "../../../server/musicAnalysis";

type CacheState = "idle" | "checking" | "missing" | "fresh" | "stale" | "failed";
type SaveState = "idle" | "saving" | "saved" | "failed";

const memoryProfiles = new Map<string, SavedCreatorProfile>();

export function clearCreatorProfileMemory() {
  memoryProfiles.clear();
}

export function useCreatorProfile(selected?: NetworkNode) {
  const { session } = useAuth();
  const [cached, setCached] = useState<SavedCreatorProfile>();
  const [cacheState, setCacheState] = useState<CacheState>("idle");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const creatorKey = selected?.id;
  const input = useMemo(() => selected ? {
    creatorId: selected.id,
    name: selected.name,
    roles: selected.roles,
    externalIpi: selected.externalIpi,
    externalMbid: selected.externalMbid,
  } : { creatorId: "unknown", name: "Unknown", roles: ["기타" as const] }, [selected]);

  useEffect(() => {
    let cancelled = false;
    setSaveState("idle");
    if (!creatorKey) { setCached(undefined); setCacheState("idle"); return () => { cancelled = true; }; }
    const memory = memoryProfiles.get(creatorKey);
    if (memory) {
      setCached(memory);
      setCacheState(Date.parse(memory.expiresAt) > Date.now() ? "fresh" : "stale");
      return () => { cancelled = true; };
    }
    if (!session) { setCached(undefined); setCacheState("missing"); return () => { cancelled = true; }; }
    setCached(undefined);
    setCacheState("checking");
    void loadCreatorProfile(creatorKey, session.access_token).then(saved => {
      if (cancelled) return;
      if (!saved) { setCacheState("missing"); return; }
      memoryProfiles.set(creatorKey, saved);
      setCached(saved);
      setCacheState(Date.parse(saved.expiresAt) > Date.now() ? "fresh" : "stale");
    }).catch(() => { if (!cancelled) setCacheState("failed"); });
    return () => { cancelled = true; };
  }, [creatorKey, session?.user.id, session?.access_token]);

  const shouldAnalyze = Boolean(selected) && !["idle", "checking", "fresh"].includes(cacheState);
  const query = trpc.music.creatorProfile.useQuery(input, {
    enabled: shouldAnalyze,
    staleTime: 900_000,
    retry: 2,
    retryDelay: attempt => Math.min(1_000 * 2 ** attempt, 4_000),
  });

  useEffect(() => {
    if (!query.data || !creatorKey) return;
    const now = new Date();
    const next: SavedCreatorProfile = {
      profile: query.data,
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 1000 * 60 * 60 * 24 * 30).toISOString(),
    };
    memoryProfiles.set(creatorKey, next);
    setCached(next);
    setCacheState("fresh");
    if (!session) return;
    setSaveState("saving");
    void saveCreatorProfile(query.data, creatorKey, session.user.id, session.access_token)
      .then(() => setSaveState("saved"))
      .catch(() => setSaveState("failed"));
  }, [query.data, creatorKey, session]);

  const data: CreatorProfile | undefined = query.data ?? cached?.profile;
  return {
    data,
    cacheState,
    saveState,
    isLoading: Boolean(selected) && !data && (cacheState === "checking" || query.isLoading),
    isRefreshing: Boolean(data) && query.isFetching,
    isError: !data && query.isError,
    fromSupabase: Boolean(cached?.profile) && !query.data,
  };
}
