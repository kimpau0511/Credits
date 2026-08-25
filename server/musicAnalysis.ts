const MUSICBRAINZ_BASE_URL = "https://musicbrainz.org/ws/2";
const MUSICBRAINZ_USER_AGENT = "CreatorSignal/0.3 (songwriting credit explorer)";
const CREDITS_FM_BASE_URL = "https://api.credits.fm/v1";
const CREDITS_FM_API_KEY = process.env.CREDITS_FM_API_KEY?.trim();
const CACHE_TTL_MS = 1000 * 60 * 20;
const CREATOR_SCAN_LIMIT = 12;
const MUSICBRAINZ_MAX_CREATOR_WORKS = 500;

// External catalogs often describe one person with a stage name in performer
// credits and a legal name in songwriting credits. Keep these aliases in the
// provider-independent normalization layer so an API swap does not reintroduce
// duplicate people in the product.
const CREATOR_ALIAS_GROUPS = [
  {
    canonicalName: "G-DRAGON",
    aliases: ["G-DRAGON", "G Dragon", "GD", "권지용", "Kwon Ji-yong", "Kwon Jiyong"],
  },
  {
    canonicalName: "TEDDY",
    aliases: ["TEDDY", "PARK HONG JUN", "PARK HONG-JUN", "HONG JUN PARK", "박홍준"],
  },
] as const;

export type CreditRole = "아티스트" | "작사" | "작곡" | "작사·작곡" | "편곡" | "프로듀싱" | "연주" | "기타";
export type MusicCredit = {
  creatorId: string;
  name: string;
  role: CreditRole;
  source: "Credits.fm" | "MusicBrainz";
  externalIpi?: string;
  externalMbid?: string;
};
export type NetworkNode = { id: string; name: string; roles: CreditRole[]; appearances: number };
export type NetworkEdge = { source: string; target: string; weight: number };
export type TopTrack = { id: string; title: string; releaseDate?: string; relevance: number };
export type TrackCandidate = { id: string; title: string; artist: string; releaseDate?: string; source: "Credits.fm" | "MusicBrainz"; isrc?: string };
export type CollaboratorSignal = { creatorId: string; name: string; roles: CreditRole[]; workCount: number; sharePercent: number };
export type CreatorProfile = {
  creator: { id: string; name: string; roles: CreditRole[] };
  works: TopTrack[];
  collaborators: CollaboratorSignal[];
  network: { nodes: NetworkNode[]; edges: NetworkEdge[] };
  scannedWorks: number;
  confidence: "verified" | "limited";
  worksOrder: "recent" | "catalog";
  sourceNote: string;
};
export type MusicAnalysis = {
  track: { id: string; title: string; artist: string; releaseDate?: string; durationMs?: number };
  credits: MusicCredit[];
  network: { nodes: NetworkNode[]; edges: NetworkEdge[] };
  topTracks: TopTrack[];
  briefing: string;
  sourceNote: string;
  creditsStatus: "enriched" | "limited";
  aiModel: string;
  cache: { state: "fresh" | "cached"; storedAt: number; expiresAt: number };
};

type MbArtist = { id: string; name: string };
type MbRelation = { type?: string; "target-type"?: string; artist?: MbArtist; work?: { id: string }; recording?: { id: string; title?: string } };
type MbWork = { id: string; title: string; "first-release-date"?: string; relations?: MbRelation[] };
type MbRecording = { id: string; title: string; length?: number; "first-release-date"?: string; "artist-credit"?: Array<{ artist?: MbArtist; name?: string }>; relations?: MbRelation[] };
type CreditsSearchRecording = { isrc: string; title: string; artist_names?: string[]; release_date?: string };
type CreditsSearchResponse = { recordings?: { items?: CreditsSearchRecording[] } };
type CreditsSongwriter = { name: string; ipi?: string; role?: string };
type CreditsPerformer = { name: string; mbid?: string; role?: string; credit_type?: string };
type CreditsIsrcResponse = { isrc: string; recording_title?: string; song_title?: string; artist_names?: string[]; release_date?: string; songwriters?: CreditsSongwriter[]; performers?: CreditsPerformer[]; sources?: string[]; updated_at?: string };
type CreditsIpiResponse = { ipi: string; full_name: string; roles?: string[]; isrcs?: string[] };
type CreditsBatchResponse = { isrcs?: Record<string, CreditsIsrcResponse | { error?: string }> };

type CacheRecord<T> = { createdAt: number; result: T };
const analysisCache = new Map<string, CacheRecord<MusicAnalysis>>();
const creatorCache = new Map<string, CacheRecord<CreatorProfile>>();
let lastMusicBrainzRequestAt = 0;
const creditsRateWindows: Record<"search" | "lookup", number[]> = { search: [], lookup: [] };

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
function normalizedText(value: string) { return value.toLowerCase().replace(/[^a-z0-9가-힣]/g, ""); }

function creatorIdentityKey(credit: MusicCredit) {
  const normalizedName = normalizedText(credit.name);
  const aliasGroup = CREATOR_ALIAS_GROUPS.find(group => group.aliases.some(alias => normalizedText(alias) === normalizedName));
  if (aliasGroup) return `alias:${normalizedText(aliasGroup.canonicalName)}`;
  if (credit.externalIpi) return `ipi:${credit.externalIpi}`;
  if (credit.externalMbid) return `mbid:${credit.externalMbid}`;
  return `name:${normalizedName}`;
}

function preferredCreatorId(credits: MusicCredit[]) {
  return credits.find(credit => credit.externalIpi)?.creatorId
    ?? credits.find(credit => credit.creatorId.startsWith("ipi:"))?.creatorId
    ?? credits.find(credit => credit.externalMbid)?.creatorId
    ?? credits[0]?.creatorId;
}

export function consolidateMusicCredits(credits: MusicCredit[]): MusicCredit[] {
  const people = new Map<string, MusicCredit[]>();
  for (const credit of credits) {
    const key = creatorIdentityKey(credit);
    people.set(key, [...(people.get(key) ?? []), credit]);
  }

  return Array.from(people.entries()).flatMap(([identityKey, matches]) => {
    const aliasGroup = CREATOR_ALIAS_GROUPS.find(group => `alias:${normalizedText(group.canonicalName)}` === identityKey);
    const creatorId = preferredCreatorId(matches) ?? identityKey;
    const name = aliasGroup?.canonicalName ?? matches[0]?.name ?? "Unknown creator";
    const byRole = new Map<CreditRole, MusicCredit>();
    for (const match of matches) {
      const existing = byRole.get(match.role);
      byRole.set(match.role, {
        ...(existing ?? match),
        creatorId,
        name,
        externalIpi: existing?.externalIpi ?? match.externalIpi,
        externalMbid: existing?.externalMbid ?? match.externalMbid,
      });
    }
    return Array.from(byRole.values());
  });
}

function enforceCreditsRateLimit(kind: "search" | "lookup") {
  const now = Date.now();
  const windowStart = now - 60_000;
  const entries = creditsRateWindows[kind].filter(timestamp => timestamp > windowStart);
  const ceiling = kind === "search" ? 9 : 28;
  if (entries.length >= ceiling) throw new Error("CREDITS_RATE_LIMIT");
  entries.push(now);
  creditsRateWindows[kind] = entries;
}

async function musicBrainzRequest<T>(path: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const wait = Math.max(0, 1050 - (Date.now() - lastMusicBrainzRequestAt));
    if (wait) await sleep(wait);
    lastMusicBrainzRequestAt = Date.now();
    try {
      const response = await fetch(`${MUSICBRAINZ_BASE_URL}${path}`, { headers: { Accept: "application/json", "User-Agent": MUSICBRAINZ_USER_AGENT }, signal: AbortSignal.timeout(10_000) });
      if (response.ok) return response.json() as Promise<T>;
      const error = new Error(`MUSICBRAINZ_${response.status}`);
      if (response.status < 500 || attempt === 1) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (attempt === 1) throw error;
    }
  }
  throw lastError;
}

async function creditsFmRequest<T>(path: string, kind: "search" | "lookup" = "lookup", timeoutMs = 10_000): Promise<T> {
  enforceCreditsRateLimit(kind);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (CREDITS_FM_API_KEY) headers["x-api-key"] = CREDITS_FM_API_KEY;
  const attempts = kind === "search" ? 2 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${CREDITS_FM_BASE_URL}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return response.json() as Promise<T>;
      const error = new Error(response.status === 429 ? "CREDITS_RATE_LIMIT" : `CREDITS_FM_${response.status}`);
      if (response.status !== 503 || attempt === attempts - 1) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
    }
    await sleep(250);
  }
  throw lastError;
}

async function creditsFmPost<T>(path: string, body: unknown): Promise<T> {
  enforceCreditsRateLimit("lookup");
  const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
  if (CREDITS_FM_API_KEY) headers["x-api-key"] = CREDITS_FM_API_KEY;
  const response = await fetch(`${CREDITS_FM_BASE_URL}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(response.status === 429 ? "CREDITS_RATE_LIMIT" : `CREDITS_FM_${response.status}`);
  return response.json() as Promise<T>;
}

export function normalizeCreditRole(relationType?: string): CreditRole {
  const normalized = relationType?.toLowerCase().trim() ?? "";
  if (normalized === "composer") return "작곡";
  if (["lyricist", "librettist"].includes(normalized)) return "작사";
  if (["writer", "songwriter"].includes(normalized)) return "작사·작곡";
  if (["arranger", "instrument arranger"].includes(normalized)) return "편곡";
  if (["producer", "co-producer", "executive producer"].includes(normalized)) return "프로듀싱";
  if (["performer", "instrument", "vocal", "conductor"].includes(normalized)) return "연주";
  return "기타";
}

export function normalizeCreditsFmRole(role?: string, creditType?: string): CreditRole {
  const normalized = `${role ?? ""} ${creditType ?? ""}`.toLowerCase().replace(/[^a-z]/g, "");
  if (normalized.includes("composerlyricist") || normalized.includes("songwriter")) return "작사·작곡";
  if (normalized.includes("composer")) return "작곡";
  if (normalized.includes("lyricist")) return "작사";
  if (normalized.includes("arranger")) return "편곡";
  if (normalized.includes("producer")) return "프로듀싱";
  if (normalized.includes("performer") || normalized.includes("vocal") || normalized.includes("instrument")) return "연주";
  return "기타";
}

export function selectBestCreditsRecording(candidates: CreditsSearchRecording[], title: string, artist?: string) {
  const expectedTitle = normalizedText(title);
  const expectedArtist = artist ? normalizedText(artist) : "";
  return [...candidates].sort((first, second) => {
    const score = (candidate: CreditsSearchRecording) => {
      const candidateTitle = normalizedText(candidate.title);
      const candidateArtists = (candidate.artist_names ?? []).map(normalizedText).join(" ");
      return (candidateTitle === expectedTitle ? 100 : candidateTitle.includes(expectedTitle) ? 60 : 0) + (expectedArtist && candidateArtists.includes(expectedArtist) ? 35 : 0);
    };
    return score(second) - score(first);
  })[0];
}

function creditsFromCreditsFm(recording: CreditsIsrcResponse): MusicCredit[] {
  const credits = new Map<string, MusicCredit>();
  for (const artistName of recording.artist_names ?? []) {
    const creatorId = `artist:${normalizedText(artistName)}`;
    credits.set(`${creatorId}:아티스트`, { creatorId, name: artistName, role: "아티스트", source: "Credits.fm" });
  }
  for (const songwriter of recording.songwriters ?? []) {
    const role = normalizeCreditsFmRole(songwriter.role);
    if (role === "기타") continue;
    const creatorId = songwriter.ipi ? `ipi:${songwriter.ipi}` : `credits:${normalizedText(songwriter.name)}`;
    credits.set(`${creatorId}:${role}`, { creatorId, name: songwriter.name, role, source: "Credits.fm", externalIpi: songwriter.ipi });
  }
  for (const performer of recording.performers ?? []) {
    const role = normalizeCreditsFmRole(performer.role, performer.credit_type);
    if (role === "기타") continue;
    const creatorId = performer.mbid ? `mbid:${performer.mbid}` : `credits:${normalizedText(performer.name)}`;
    credits.set(`${creatorId}:${role}`, { creatorId, name: performer.name, role, source: "Credits.fm", externalMbid: performer.mbid });
  }
  return consolidateMusicCredits(Array.from(credits.values()));
}

async function creditsFmTrack(title: string, artist?: string): Promise<CreditsIsrcResponse | undefined> {
  const query = [title, artist].filter(Boolean).join(" ");
  const search = await creditsFmRequest<CreditsSearchResponse>(`/search?q=${encodeURIComponent(query)}`, "search");
  const candidate = selectBestCreditsRecording(search.recordings?.items ?? [], title, artist);
  if (!candidate?.isrc) return undefined;
  return creditsFmRequest<CreditsIsrcResponse>(`/isrc/${encodeURIComponent(candidate.isrc)}`);
}

export async function searchMusicCandidates(input: { title: string; artist?: string }): Promise<TrackCandidate[]> {
  const title = input.title.trim();
  const artist = input.artist?.trim();
  const query = [title, artist].filter(Boolean).join(" ");
  const creditsSearch = await creditsFmRequest<CreditsSearchResponse>(`/search?q=${encodeURIComponent(query)}`, "search").catch(() => undefined);
  const creditsCandidates = Array.from(new Map((creditsSearch?.recordings?.items ?? []).map(item => [item.isrc, {
    id: `isrc:${item.isrc}`,
    isrc: item.isrc,
    title: item.title,
    artist: item.artist_names?.join(", ") || "Unknown artist",
    releaseDate: item.release_date,
    source: "Credits.fm" as const,
  }])).values());
  if (creditsCandidates.length) return creditsCandidates.slice(0, 8);

  const fallback = await musicBrainzRequest<{ recordings?: MbRecording[] }>(`/recording?query=${encodeURIComponent(artist ? `recording:"${title}" AND artist:"${artist}"` : `recording:"${title}"`)}&limit=8&fmt=json`);
  return (fallback.recordings ?? []).map(recording => ({
    id: `mbid:${recording.id}`,
    title: recording.title,
    artist: primaryArtist(recording)?.name || artist || "Unknown artist",
    releaseDate: recording["first-release-date"],
    source: "MusicBrainz" as const,
  }));
}

function creditsFromArtistRelations(relations?: MbRelation[]): MusicCredit[] {
  const credits = new Map<string, MusicCredit>();
  for (const relation of relations ?? []) {
    if (relation["target-type"] !== "artist" || !relation.artist) continue;
    const role = normalizeCreditRole(relation.type);
    if (role === "기타") continue;
    const creatorId = `mbid:${relation.artist.id}`;
    credits.set(`${creatorId}:${role}`, { creatorId, name: relation.artist.name, role, source: "MusicBrainz", externalMbid: relation.artist.id });
  }
  return Array.from(credits.values());
}

function primaryArtist(recording: MbRecording): MbArtist | undefined { return recording["artist-credit"]?.find(credit => credit.artist)?.artist; }

function performanceCredits(recording: MbRecording): MusicCredit[] {
  const credits = new Map<string, MusicCredit>();
  for (const credit of recording["artist-credit"] ?? []) {
    if (!credit.artist) continue;
    const creatorId = `mbid:${credit.artist.id}`;
    credits.set(`${creatorId}:아티스트`, { creatorId, name: credit.artist.name || credit.name || "Unknown artist", role: "아티스트", source: "MusicBrainz", externalMbid: credit.artist.id });
  }
  for (const credit of creditsFromArtistRelations(recording.relations)) credits.set(`${credit.creatorId}:${credit.role}`, credit);
  return Array.from(credits.values());
}

export function buildCooccurrenceNetwork(workCreditSets: MusicCredit[][]): { nodes: NetworkNode[]; edges: NetworkEdge[] } {
  const nodeMap = new Map<string, { id: string; name: string; roles: Set<CreditRole>; appearances: number }>();
  const edgeMap = new Map<string, NetworkEdge>();
  for (const rawCredits of workCreditSets) {
    const credits = consolidateMusicCredits(rawCredits);
    const ids = Array.from(new Set(credits.map(credit => credit.creatorId)));
    for (const credit of credits) {
      const current = nodeMap.get(credit.creatorId);
      if (current) current.roles.add(credit.role);
      else nodeMap.set(credit.creatorId, { id: credit.creatorId, name: credit.name, roles: new Set([credit.role]), appearances: 0 });
    }
    for (const id of ids) { const node = nodeMap.get(id); if (node) node.appearances += 1; }
    for (let left = 0; left < ids.length; left += 1) for (let right = left + 1; right < ids.length; right += 1) {
      const [source, target] = [ids[left], ids[right]].sort();
      const key = `${source}:${target}`;
      const previous = edgeMap.get(key);
      edgeMap.set(key, previous ? { ...previous, weight: previous.weight + 1 } : { source, target, weight: 1 });
    }
  }
  return {
    nodes: Array.from(nodeMap.values()).map(node => ({ ...node, roles: Array.from(node.roles) })).sort((a, b) => b.appearances - a.appearances || a.name.localeCompare(b.name)),
    edges: Array.from(edgeMap.values()).sort((a, b) => b.weight - a.weight),
  };
}

export function buildBriefing(track: MusicAnalysis["track"], credits: MusicCredit[], status: MusicAnalysis["creditsStatus"]) {
  const people = Array.from(credits.reduce((map, credit) => {
    const person = map.get(credit.creatorId) ?? { name: credit.name, roles: new Set<CreditRole>() };
    person.roles.add(credit.role);
    map.set(credit.creatorId, person);
    return map;
  }, new Map<string, { name: string; roles: Set<CreditRole> }>()).values()).map(person => ({
    name: person.name,
    roles: Array.from(person.roles),
  }));
  const songwritingRoles: CreditRole[] = ["작사", "작곡", "작사·작곡"];
  const productionRoles: CreditRole[] = [...songwritingRoles, "편곡", "프로듀싱"];
  const songwriters = people.filter(person => person.roles.some(role => songwritingRoles.includes(role)));
  const productionPeople = people.filter(person => person.roles.some(role => productionRoles.includes(role)));
  const combinedWriters = songwriters.filter(person => person.roles.includes("작사·작곡") || (person.roles.includes("작사") && person.roles.includes("작곡")));
  const lead = [...productionPeople].sort((first, second) => {
    const roleScore = (person: typeof first) => person.roles.filter(role => productionRoles.includes(role)).length;
    return roleScore(second) - roleScore(first) || first.name.localeCompare(second.name);
  })[0];
  const songwriterNames = songwriters.map(person => `${person.name}(${person.roles.filter(role => songwritingRoles.includes(role)).join("·")})`).join(", ");
  const supportingRoles = productionPeople.flatMap(person => person.roles
    .filter(role => ["편곡", "프로듀싱"].includes(role))
    .map(role => `${person.name}(${role})`));

  const summary = songwriters.length
    ? `${track.title}에서 확인된 고유 참여자는 ${people.length}명이며, 송라이팅에는 ${songwriters.length}명이 이름을 올렸습니다. 핵심 송라이팅 크레딧은 ${songwriterNames}입니다.`
    : `${track.title}에서 확인된 고유 참여자는 ${people.length}명이지만, 현재 응답에서는 확정된 송라이팅 크레딧을 찾지 못했습니다.`;
  const structure = songwriters.length > 1
    ? `${songwriters.length}명이 참여한 공동 송라이팅 구조입니다.${combinedWriters.length ? ` 작사와 작곡을 함께 담당한 인물은 ${combinedWriters.map(person => person.name).join(", ")}이며, 곡의 창작 방향에 걸친 역할 중첩이 확인됩니다.` : " 작사와 작곡이 인물별로 분리된 구조인지 각 크리에이터의 역할을 교차 확인할 필요가 있습니다."}`
    : songwriters.length === 1
      ? `${songwriters[0].name} 중심의 송라이팅 구조로 확인됩니다.${combinedWriters.length ? " 작사와 작곡을 함께 맡아 창작 관여 범위가 넓습니다." : " 표시된 역할 범위 안에서 단독 기여 여부를 추가 확인할 가치가 있습니다."}`
      : "송라이팅 구조를 판단할 정보가 부족하므로 다른 표기, ISRC 또는 보조 출처로 교차 확인하는 것이 우선입니다.";
  const researchPoint = lead
    ? `확인된 제작 역할이 가장 넓은 우선 조사 대상은 ${lead.name}입니다. 인물 카드를 선택해 최근 작업과 반복 협업자를 확인하면 이 곡이 기존 작업 네트워크의 연장선인지 판단할 수 있습니다.${supportingRoles.length ? ` 편곡·프로듀싱 층에서는 ${supportingRoles.join(", ")}도 함께 확인됩니다.` : ""}`
    : "현재 데이터만으로 우선 조사할 제작 인물을 특정하기 어렵습니다.";
  const caveat = status === "enriched"
    ? "공개 API에서 상세 제작 크레딧이 확인된 결과입니다. 아래 판단은 표시된 크레딧을 기준으로 하며 계약상 지분이나 실제 기여량을 의미하지 않습니다."
    : "현재 소스의 상세 제작 크레딧이 제한적이므로 누락 가능성이 있습니다. 다른 API나 공식 라이너 노트와의 교차 검증이 필요합니다.";

  return `핵심 요약\n${summary}\n\n크레딧 구조\n${structure}\n\n리서치 포인트\n${researchPoint}\n\n해석 범위\n${caveat}`;
}

async function findArtistCatalog(artistId?: string): Promise<TopTrack[]> {
  if (!artistId) return [];
  const result = await musicBrainzRequest<{ recordings?: Array<Pick<MbRecording, "id" | "title" | "first-release-date"> & { score?: number }> }>(`/recording?artist=${encodeURIComponent(artistId)}&limit=12&fmt=json`);
  return (result.recordings ?? []).map(recording => ({ id: recording.id, title: recording.title, releaseDate: recording["first-release-date"], relevance: Number(recording.score ?? 0) })).sort((a, b) => b.relevance - a.relevance || (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "")).slice(0, 6);
}

async function getCreditsFmCreatorProfile(input: { creatorId: string; name: string; roles: CreditRole[] }): Promise<CreatorProfile> {
  const cached = creatorCache.get(input.creatorId);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) return cached.result;
  const profile = await creditsFmRequest<CreditsIpiResponse>(`/ipi/${encodeURIComponent(input.creatorId.replace("ipi:", ""))}`);
  const catalogIsrcs = Array.from(new Set(profile.isrcs ?? [])).slice(0, 100);
  let recordings: CreditsIsrcResponse[] = [];
  if (catalogIsrcs.length) {
    try {
      const batch = await creditsFmPost<CreditsBatchResponse>("/batch", { isrcs: catalogIsrcs });
      recordings = Object.values(batch.isrcs ?? {}).filter((recording): recording is CreditsIsrcResponse => "isrc" in recording && Boolean(recording.isrc));
    } catch (error) {
      console.warn("[Creator Signal] Credits.fm batch profile fallback", error);
    }
  }
  if (!recordings.length) {
    const fallback = await Promise.allSettled(catalogIsrcs.slice(0, CREATOR_SCAN_LIMIT).map(isrc => creditsFmRequest<CreditsIsrcResponse>(`/isrc/${encodeURIComponent(isrc)}`)));
    recordings = fallback.filter((item): item is PromiseFulfilledResult<CreditsIsrcResponse> => item.status === "fulfilled").map(item => item.value);
  }
  const rows = recordings
    .filter(recording => recording.songwriters?.some(songwriter => songwriter.ipi === profile.ipi))
    .filter((recording): recording is CreditsIsrcResponse => "isrc" in recording && Boolean(recording.isrc))
    .map(recording => ({ recording, credits: creditsFromCreditsFm(recording) }))
    .sort((first, second) => (second.recording.release_date ?? "").localeCompare(first.recording.release_date ?? "") || first.recording.isrc.localeCompare(second.recording.isrc));
  const datedWorks = rows.filter(row => Boolean(row.recording.release_date)).length;
  const confidence = rows.length >= 3 && datedWorks >= Math.min(3, rows.length) ? "verified" : "limited";
  const sampleRows = rows.slice(0, CREATOR_SCAN_LIMIT);
  const network = confidence === "verified" ? buildCooccurrenceNetwork(sampleRows.map(row => row.credits)) : { nodes: [], edges: [] };
  const collaborators = network.edges.filter(edge => edge.source === input.creatorId || edge.target === input.creatorId).map(edge => {
    const collaboratorId = edge.source === input.creatorId ? edge.target : edge.source;
    const node = network.nodes.find(candidate => candidate.id === collaboratorId);
    return node ? { creatorId: node.id, name: node.name, roles: node.roles, workCount: edge.weight, sharePercent: Math.round((edge.weight / Math.max(sampleRows.length, 1)) * 100) } : undefined;
  }).filter((item): item is CollaboratorSignal => Boolean(item)).sort((a, b) => b.workCount - a.workCount || a.name.localeCompare(b.name)).slice(0, 5);
  const result: CreatorProfile = {
    creator: { id: input.creatorId, name: input.name, roles: input.roles },
    works: sampleRows.map(row => ({ id: row.recording.isrc, title: row.recording.song_title ?? row.recording.recording_title ?? row.recording.isrc, releaseDate: row.recording.release_date, relevance: 0 })).slice(0, 6),
    collaborators,
    network,
    scannedWorks: sampleRows.length,
    confidence,
    worksOrder: confidence === "verified" ? "recent" : "catalog",
    sourceNote: confidence === "verified"
      ? `Credits.fm IPI 카탈로그 ${catalogIsrcs.length}건 중 식별자가 일치하는 ${rows.length}건을 확인하고, 날짜순 최근 ${sampleRows.length}건의 동시 크레딧을 집계했습니다. 표본 기반 결과이므로 전체 경력 통계와 다를 수 있습니다.`
      : `Credits.fm IPI 카탈로그에서 식별자가 일치하는 작품 ${rows.length}건을 찾았지만 발매일이 확인된 작품은 ${datedWorks}건뿐입니다. 최근 작업 순서와 반복 협업 통계의 신뢰 조건이 부족해 협업 비율·순위·그래프는 표시하지 않습니다.`,
  };
  creatorCache.set(input.creatorId, { createdAt: Date.now(), result });
  return result;
}

async function getMusicBrainzCreatorProfile(input: { creatorId: string; name: string; roles: CreditRole[] }): Promise<CreatorProfile> {
  const id = input.creatorId.replace("mbid:", "");
  const works: MbWork[] = [];
  let totalWorks = 0;
  while (works.length < MUSICBRAINZ_MAX_CREATOR_WORKS) {
    const offset = works.length;
    const response = await musicBrainzRequest<{ works?: MbWork[]; "work-count"?: number }>(`/work?artist=${encodeURIComponent(id)}&limit=100&offset=${offset}&inc=artist-rels+recording-rels&fmt=json`);
    const page = response.works ?? [];
    totalWorks = response["work-count"] ?? page.length;
    works.push(...page);
    if (!page.length || works.length >= totalWorks) break;
  }
  const songwritingRoles: CreditRole[] = ["작사", "작곡", "작사·작곡", "편곡", "프로듀싱"];
  const verifiedWorks = works.filter(work => work.relations?.some(relation => relation.artist?.id === id && songwritingRoles.includes(normalizeCreditRole(relation.type))));
  const creditSets = verifiedWorks.map(work => consolidateMusicCredits(creditsFromArtistRelations(work.relations)).filter(credit => songwritingRoles.includes(credit.role)));
  const network = buildCooccurrenceNetwork(creditSets);
  const collaborators = network.edges.filter(edge => edge.source === input.creatorId || edge.target === input.creatorId).map(edge => {
    const collaboratorId = edge.source === input.creatorId ? edge.target : edge.source;
    const node = network.nodes.find(candidate => candidate.id === collaboratorId);
    return node ? { creatorId: node.id, name: node.name, roles: node.roles, workCount: edge.weight, sharePercent: Math.round((edge.weight / Math.max(verifiedWorks.length, 1)) * 100) } : undefined;
  }).filter((item): item is CollaboratorSignal => Boolean(item)).sort((a, b) => b.workCount - a.workCount || a.name.localeCompare(b.name)).slice(0, 5);
  const linkedWorks = creditSets.filter(credits => credits.some(credit => credit.creatorId === input.creatorId)).length;
  const confidence = linkedWorks >= 3 && collaborators.length ? "verified" : "limited";
  const recordingToWork = new Map<string, string>();
  for (const work of verifiedWorks) {
    const recordings = (work.relations ?? []).filter(relation => relation.recording?.id).map(relation => relation.recording!);
    const recording = recordings.find(candidate => normalizedText(candidate.title ?? "") === normalizedText(work.title)) ?? recordings[0];
    if (recording) recordingToWork.set(recording.id, work.id);
  }
  const releaseDates = new Map<string, string>();
  const recordingIds = Array.from(recordingToWork.keys());
  for (let start = 0; start < recordingIds.length; start += 20) {
    const chunk = recordingIds.slice(start, start + 20);
    const query = chunk.map(recordingId => `rid:${recordingId}`).join(" OR ");
    const response = await musicBrainzRequest<{ recordings?: MbRecording[] }>(`/recording?query=${encodeURIComponent(query)}&limit=${chunk.length}&fmt=json`);
    for (const recording of response.recordings ?? []) {
      const workId = recordingToWork.get(recording.id);
      const releaseDate = recording["first-release-date"];
      if (workId && releaseDate && (!releaseDates.get(workId) || releaseDate < releaseDates.get(workId)!)) releaseDates.set(workId, releaseDate);
    }
  }
  const datedWorks = verifiedWorks.map(work => ({ id: work.id, title: work.title, releaseDate: releaseDates.get(work.id), relevance: 0 }))
    .sort((first, second) => (second.releaseDate ?? "").localeCompare(first.releaseDate ?? "") || first.title.localeCompare(second.title));
  return {
    creator: { id: input.creatorId, name: input.name, roles: input.roles },
    works: datedWorks.slice(0, CREATOR_SCAN_LIMIT),
    collaborators: confidence === "verified" ? collaborators : [],
    network: confidence === "verified" ? network : { nodes: [], edges: [] },
    scannedWorks: verifiedWorks.length,
    confidence,
    worksOrder: releaseDates.size ? "recent" : "catalog",
    sourceNote: confidence === "verified"
      ? `MusicBrainz에서 최대 500개 한도로 ${works.length}${works.length < totalWorks ? `/${totalWorks}` : ""}개를 조회하고, ${input.name}의 송라이팅 관계가 실제 확인된 ${verifiedWorks.length}개 작품만 집계했습니다. 대표 녹음 기준 발매일은 ${releaseDates.size}개 작품에서 확인했습니다.`
      : `MusicBrainz에서 최대 500개 한도로 조회한 뒤 ${input.name}의 송라이팅 관계가 실제 확인된 작품 ${verifiedWorks.length}개만 남겼지만, 공동 크레딧 관계가 충분하지 않아 협업 통계를 표시하지 않습니다.`,
  };
}

export async function getCreatorProfile(input: { creatorId: string; name: string; roles: CreditRole[] }): Promise<CreatorProfile> {
  return input.creatorId.startsWith("ipi:")
    ? await getCreditsFmCreatorProfile(input)
    : input.creatorId.startsWith("mbid:")
      ? await getMusicBrainzCreatorProfile(input)
      : { creator: { id: input.creatorId, name: input.name, roles: input.roles }, works: [], collaborators: [], network: { nodes: [], edges: [] }, scannedWorks: 0, confidence: "limited", worksOrder: "catalog", sourceNote: "공개 카탈로그와 연결할 고유 식별자가 없습니다." };
}

async function musicBrainzFallback(title: string, artist?: string): Promise<MusicAnalysis> {
  const query = artist ? `recording:"${title}" AND artist:"${artist}"` : `recording:"${title}"`;
  const search = await musicBrainzRequest<{ recordings?: Array<Pick<MbRecording, "id">> }>(`/recording?query=${encodeURIComponent(query)}&limit=5&fmt=json`);
  const match = search.recordings?.[0];
  if (!match) throw new Error("TRACK_NOT_FOUND");
  const recording = await musicBrainzRequest<MbRecording>(`/recording/${encodeURIComponent(match.id)}?inc=artist-credits+recording-rels+work-rels+releases&fmt=json`);
  const workId = recording.relations?.find(relation => relation["target-type"] === "work")?.work?.id;
  const workCredits = workId ? creditsFromArtistRelations((await musicBrainzRequest<MbWork>(`/work/${encodeURIComponent(workId)}?inc=artist-rels&fmt=json`)).relations) : [];
  const credits = consolidateMusicCredits([...workCredits, ...performanceCredits(recording)]);
  const detailed = credits.filter(credit => ["작사", "작곡", "작사·작곡", "편곡", "프로듀싱"].includes(credit.role));
  const track = { id: recording.id, title: recording.title, artist: primaryArtist(recording)?.name ?? artist ?? "Unknown artist", releaseDate: recording["first-release-date"], durationMs: recording.length };
  const storedAt = Date.now();
  return { track, credits, network: buildCooccurrenceNetwork([credits]), topTracks: await findArtistCatalog(primaryArtist(recording)?.id), briefing: buildBriefing(track, credits, detailed.length ? "enriched" : "limited"), sourceNote: "Credits.fm에서 일치하는 녹음을 찾지 못해 MusicBrainz 공개 관계 데이터를 보조 사용했습니다.", creditsStatus: detailed.length ? "enriched" : "limited", aiModel: "Rule-based credit editor", cache: { state: "fresh", storedAt, expiresAt: storedAt + CACHE_TTL_MS } };
}

export async function analyzeMusic(input: { title: string; artist?: string; isrc?: string }): Promise<MusicAnalysis> {
  const title = input.title.trim();
  const artist = input.artist?.trim();
  const key = input.isrc ? `isrc:${input.isrc}` : `${title.toLowerCase()}::${artist?.toLowerCase() ?? ""}`;
  const cached = analysisCache.get(key);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) return { ...cached.result, cache: { state: "cached", storedAt: cached.createdAt, expiresAt: cached.createdAt + CACHE_TTL_MS } };
  const creditsRecording = await (input.isrc ? creditsFmRequest<CreditsIsrcResponse>(`/isrc/${encodeURIComponent(input.isrc)}`, "lookup", 5_000) : creditsFmTrack(title, artist)).catch(error => { console.warn("[Creator Signal] Credits.fm fallback", error); return undefined; });
  let result: MusicAnalysis;
  if (creditsRecording) {
    const credits = creditsFromCreditsFm(creditsRecording);
    const detailed = credits.filter(credit => ["작사", "작곡", "작사·작곡", "편곡", "프로듀싱"].includes(credit.role));
    const track = { id: creditsRecording.isrc, title: creditsRecording.song_title ?? creditsRecording.recording_title ?? title, artist: creditsRecording.artist_names?.join(", ") ?? artist ?? "Unknown artist", releaseDate: creditsRecording.release_date };
    const storedAt = Date.now();
    result = { track, credits, network: buildCooccurrenceNetwork([credits]), topTracks: [], briefing: buildBriefing(track, credits, detailed.length ? "enriched" : "limited"), sourceNote: `Credits.fm ISRC ${creditsRecording.isrc} 응답을 우선 사용했습니다. 원본 소스: ${(creditsRecording.sources ?? []).join(", ") || "Credits.fm"}.`, creditsStatus: detailed.length ? "enriched" : "limited", aiModel: "Rule-based credit editor", cache: { state: "fresh", storedAt, expiresAt: storedAt + CACHE_TTL_MS } };
  } else result = await musicBrainzFallback(title, artist);
  analysisCache.set(key, { createdAt: result.cache.storedAt, result });
  return result;
}
