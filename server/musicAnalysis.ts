const MUSICBRAINZ_BASE_URL = "https://musicbrainz.org/ws/2";
const MUSICBRAINZ_USER_AGENT = "CreatorSignal/0.3 (songwriting credit explorer)";
const CREDITS_FM_BASE_URL = "https://api.credits.fm/v1";
const CACHE_TTL_MS = 1000 * 60 * 20;
const CREATOR_SCAN_LIMIT = 12;

// External catalogs often describe one person with a stage name in performer
// credits and a legal name in songwriting credits. Keep these aliases in the
// provider-independent normalization layer so an API swap does not reintroduce
// duplicate people in the product.
const CREATOR_ALIAS_GROUPS = [
  {
    canonicalName: "G-DRAGON",
    aliases: ["G-DRAGON", "G Dragon", "GD", "권지용", "Kwon Ji-yong", "Kwon Jiyong"],
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
type MbRelation = { type?: string; "target-type"?: string; artist?: MbArtist; work?: { id: string } };
type MbWork = { id: string; title: string; "first-release-date"?: string; relations?: MbRelation[] };
type MbRecording = { id: string; title: string; length?: number; "first-release-date"?: string; "artist-credit"?: Array<{ artist?: MbArtist; name?: string }>; relations?: MbRelation[] };
type CreditsSearchRecording = { isrc: string; title: string; artist_names?: string[]; release_date?: string };
type CreditsSearchResponse = { recordings?: { items?: CreditsSearchRecording[] } };
type CreditsSongwriter = { name: string; ipi?: string; role?: string };
type CreditsPerformer = { name: string; mbid?: string; role?: string; credit_type?: string };
type CreditsIsrcResponse = { isrc: string; recording_title?: string; song_title?: string; artist_names?: string[]; release_date?: string; songwriters?: CreditsSongwriter[]; performers?: CreditsPerformer[]; sources?: string[]; updated_at?: string };
type CreditsIpiResponse = { ipi: string; full_name: string; roles?: string[]; isrcs?: string[] };

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
  const wait = Math.max(0, 1050 - (Date.now() - lastMusicBrainzRequestAt));
  if (wait) await sleep(wait);
  lastMusicBrainzRequestAt = Date.now();
  const response = await fetch(`${MUSICBRAINZ_BASE_URL}${path}`, { headers: { Accept: "application/json", "User-Agent": MUSICBRAINZ_USER_AGENT } });
  if (!response.ok) throw new Error(`MUSICBRAINZ_${response.status}`);
  return response.json() as Promise<T>;
}

async function creditsFmRequest<T>(path: string, kind: "search" | "lookup" = "lookup"): Promise<T> {
  enforceCreditsRateLimit(kind);
  const response = await fetch(`${CREDITS_FM_BASE_URL}${path}`, { headers: { Accept: "application/json" } });
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
  const songwriters = credits.filter(credit => ["작사", "작곡", "작사·작곡"].includes(credit.role));
  const people = songwriters.length ? songwriters.map(credit => `${credit.name}(${credit.role})`).join(", ") : "확정된 송라이팅 크레딧을 찾지 못했습니다";
  const scope = status === "enriched" ? "확인된 작사·작곡 크레딧을 우선 노출합니다." : "현재 소스에서는 상세 송라이팅 크레딧이 제한적입니다.";
  return `SONGWRITING SIGNAL\n${track.title}의 우선 확인 대상은 ${people}입니다. ${scope}\n\nCREATOR TRAIL\n크리에이터를 선택하면 공개 카탈로그의 표본 참여작과, 같은 표본에서 반복 등장한 동시 크레딧을 확인할 수 있습니다.\n\nREADING NOTE\n검색할 때 외부 API에서 받은 공개 데이터만 메모리에서 정리합니다. 검색 결과를 데이터베이스나 파일에 저장하지 않으며, 서버를 재시작하면 캐시도 초기화됩니다.`;
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
  const rows: Array<{ recording: CreditsIsrcResponse; credits: MusicCredit[] }> = [];
  for (const isrc of (profile.isrcs ?? []).slice(0, CREATOR_SCAN_LIMIT)) {
    try { const recording = await creditsFmRequest<CreditsIsrcResponse>(`/isrc/${encodeURIComponent(isrc)}`); rows.push({ recording, credits: creditsFromCreditsFm(recording) }); }
    catch (error) { console.warn("[Creator Signal] skipped Credits.fm work", isrc, error); }
  }
  const network = buildCooccurrenceNetwork(rows.map(row => row.credits));
  const collaborators = network.edges.filter(edge => edge.source === input.creatorId || edge.target === input.creatorId).map(edge => {
    const collaboratorId = edge.source === input.creatorId ? edge.target : edge.source;
    const node = network.nodes.find(candidate => candidate.id === collaboratorId);
    return node ? { creatorId: node.id, name: node.name, roles: node.roles, workCount: edge.weight, sharePercent: Math.round((edge.weight / Math.max(rows.length, 1)) * 100) } : undefined;
  }).filter((item): item is CollaboratorSignal => Boolean(item)).sort((a, b) => b.workCount - a.workCount || a.name.localeCompare(b.name)).slice(0, 5);
  const result: CreatorProfile = {
    creator: { id: input.creatorId, name: profile.full_name || input.name, roles: input.roles },
    works: rows.map(row => ({ id: row.recording.isrc, title: row.recording.song_title ?? row.recording.recording_title ?? row.recording.isrc, releaseDate: row.recording.release_date, relevance: 0 })).sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "")).slice(0, 6),
    collaborators,
    network,
    scannedWorks: rows.length,
    sourceNote: "Credits.fm IPI 카탈로그의 최근 표본을 요청 시 조회해 동시 출현을 집계했습니다.",
  };
  creatorCache.set(input.creatorId, { createdAt: Date.now(), result });
  return result;
}

async function getMusicBrainzCreatorProfile(input: { creatorId: string; name: string; roles: CreditRole[] }): Promise<CreatorProfile> {
  const id = input.creatorId.replace("mbid:", "");
  const works = await musicBrainzRequest<{ works?: MbWork[] }>(`/work?artist=${encodeURIComponent(id)}&limit=${CREATOR_SCAN_LIMIT}&fmt=json`);
  return { creator: { id: input.creatorId, name: input.name, roles: input.roles }, works: (works.works ?? []).map(work => ({ id: work.id, title: work.title, releaseDate: work["first-release-date"], relevance: 0 })), collaborators: [], network: { nodes: [], edges: [] }, scannedWorks: 0, sourceNote: "MusicBrainz 공개 작품 관계에서 조회했습니다. 상세 반복 협업은 송라이팅 IPI 연결이 있는 크리에이터에서 가장 잘 작동합니다." };
}

export async function getCreatorProfile(input: { creatorId: string; name: string; roles: CreditRole[] }): Promise<CreatorProfile> {
  return input.creatorId.startsWith("ipi:")
    ? await getCreditsFmCreatorProfile(input)
    : input.creatorId.startsWith("mbid:")
      ? await getMusicBrainzCreatorProfile(input)
      : { creator: { id: input.creatorId, name: input.name, roles: input.roles }, works: [], collaborators: [], network: { nodes: [], edges: [] }, scannedWorks: 0, sourceNote: "공개 카탈로그와 연결할 고유 식별자가 없습니다." };
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
  const creditsRecording = await (input.isrc ? creditsFmRequest<CreditsIsrcResponse>(`/isrc/${encodeURIComponent(input.isrc)}`) : creditsFmTrack(title, artist)).catch(error => { console.warn("[Creator Signal] Credits.fm fallback", error); return undefined; });
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
