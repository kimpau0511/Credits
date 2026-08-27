import type { CreditRole, CreatorProfile, MusicAnalysis } from "../../../server/musicAnalysis";
import { supabaseRest } from "./supabase";

export type SavedCredit = {
  id: string;
  creator_key: string;
  name: string;
  role: CreditRole;
  external_ipi?: string;
  external_mbid?: string;
};

export type SavedTrack = {
  id: string;
  track_key: string;
  title: string;
  artist: string;
  release_date?: string;
  album?: string;
  genres: string[];
  created_at: string;
  credits: SavedCredit[];
};

export type SavedCreatorProfile = {
  profile: CreatorProfile;
  updatedAt: string;
  expiresAt: string;
};

export const CREATOR_PROFILE_CACHE_MS = 1000 * 60 * 60 * 24 * 30;

export async function saveAnalysis(analysis: MusicAnalysis, userId: string, accessToken: string) {
  const trackKey = analysis.track.id.includes("-") ? `mbid:${analysis.track.id}` : `isrc:${analysis.track.id}`;
  const [track] = await supabaseRest<Array<{ id: string }>>(
    "research_tracks?on_conflict=user_id,track_key",
    accessToken,
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({
        user_id: userId,
        track_key: trackKey,
        isrc: trackKey.startsWith("isrc:") ? analysis.track.id : null,
        mbid: trackKey.startsWith("mbid:") ? analysis.track.id : null,
        title: analysis.track.title,
        artist: analysis.track.artist,
        release_date: analysis.track.releaseDate || null,
        album: analysis.track.album || null,
        genres: analysis.track.genres ?? [],
        source_note: analysis.sourceNote,
        raw_analysis: analysis,
        updated_at: new Date().toISOString(),
      }),
    },
  );
  if (!track?.id) throw new Error("저장된 곡 ID를 확인하지 못했습니다.");
  await supabaseRest<void>(`research_credits?track_id=eq.${encodeURIComponent(track.id)}`, accessToken, { method: "DELETE" });
  if (analysis.credits.length) await supabaseRest<void>("research_credits", accessToken, {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(analysis.credits.map(credit => ({
      track_id: track.id,
      creator_key: credit.creatorId,
      name: credit.name,
      role: credit.role,
      external_ipi: credit.externalIpi ?? null,
      external_mbid: credit.externalMbid ?? null,
    }))),
  });
  return track.id;
}

export function loadSavedTracks(accessToken: string) {
  return supabaseRest<SavedTrack[]>(
    "research_tracks?select=id,track_key,title,artist,release_date,album,genres,created_at,credits:research_credits(id,creator_key,name,role,external_ipi,external_mbid)&order=created_at.desc",
    accessToken,
  );
}

export async function loadCreatorProfile(creatorKey: string, accessToken: string): Promise<SavedCreatorProfile | undefined> {
  const rows = await supabaseRest<Array<{ profile: CreatorProfile; updated_at: string; expires_at: string }>>(
    `creator_profiles?select=profile,updated_at,expires_at&creator_key=eq.${encodeURIComponent(creatorKey)}&status=eq.complete&limit=1`,
    accessToken,
  );
  const row = rows[0];
  return row ? { profile: row.profile, updatedAt: row.updated_at, expiresAt: row.expires_at } : undefined;
}

export async function saveCreatorProfile(profile: CreatorProfile, creatorKey: string, userId: string, accessToken: string) {
  const now = new Date();
  await supabaseRest<void>("creator_profiles?on_conflict=user_id,creator_key", accessToken, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      user_id: userId,
      creator_key: creatorKey,
      name: profile.creator.name,
      roles: profile.creator.roles,
      scanned_works: profile.scannedWorks,
      confidence: profile.confidence,
      status: "complete",
      profile,
      completed_at: now.toISOString(),
      expires_at: new Date(now.getTime() + CREATOR_PROFILE_CACHE_MS).toISOString(),
      updated_at: now.toISOString(),
    }),
  });
}
