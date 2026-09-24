import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowUpRight, ChevronDown, ChevronUp, Download, LoaderCircle, Network, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { clearCreatorProfileMemory, useCreatorProfile } from "@/hooks/useCreatorProfile";
import { deleteSavedTrack, loadSavedTracks, resetResearchData, saveAnalysis, SavedCredit, SavedTrack } from "@/lib/researchStore";
import { trpc } from "@/lib/trpc";
import { Analysis } from "./Home";

const creatorRoles = ["작사", "작곡", "작사·작곡", "편곡", "프로듀싱", "믹싱", "마스터링"];
const chartColors = ["#e3a83b", "#3fd8a3", "#5b8def", "#e2678c", "#a78bfa", "#f4c766", "#8ec9e0", "#c97b2e"];
function displayDate(value?: string) { return value ? value.replace(/-/g, ".") : "—"; }
function splitArtists(value: string) { return value.split(/,|&| feat\.? | with /i).map(item => item.trim()).filter(Boolean); }
function escapeSpreadsheetCell(value: unknown) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function exportTracksToExcel(tracks: SavedTrack[]) {
  const headers = ["곡명", "아티스트", "앨범", "장르", "발매일", "역할", "이름", "출처 메모"];
  const rows = tracks.flatMap(track => {
    const credits = track.credits.length ? track.credits : [undefined];
    return credits.map(credit => [
      track.title,
      track.artist,
      track.album ?? "",
      (track.genres ?? []).join(", "),
      track.release_date ?? "",
      credit?.role ?? "",
      credit?.name ?? "",
      track.source_note ?? "",
    ]);
  });
  const table = `<table><thead><tr>${headers.map(header => `<th>${escapeSpreadsheetCell(header)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${escapeSpreadsheetCell(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const blob = new Blob(["\ufeff", table], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `credit-sheet-${new Date().toISOString().slice(0, 10)}.xls`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

type CreatorStat = {
  key: string;
  name: string;
  credits: SavedCredit[];
  tracks: SavedTrack[];
  compositionCount: number;
  lyricCount: number;
  combinedCount: number;
  recentCount: number;
};

export default function ResearchDashboard({ onBack }: { onBack: () => void }) {
  const { session } = useAuth();
  const [tracks, setTracks] = useState<SavedTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState("");
  const [selectedKey, setSelectedKey] = useState<string>();
  const [openedTrackId, setOpenedTrackId] = useState<string>();
  const [expandedTrackId, setExpandedTrackId] = useState<string>();
  const [trackQuery, setTrackQuery] = useState("");
  const [showSingleCreators, setShowSingleCreators] = useState(false);
  const [showAllConnections, setShowAllConnections] = useState(false);
  const [deletingTrackId, setDeletingTrackId] = useState<string>();
  const [refreshingTrackId, setRefreshingTrackId] = useState<string>();
  const reanalyze = trpc.music.analyze.useMutation();

  async function load() {
    if (!session) return;
    setLoading(true); setError("");
    try { setTracks(await loadSavedTracks(session.access_token)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "수집 데이터를 불러오지 못했습니다."); }
    finally { setLoading(false); }
  }
  async function resetAll() {
    if (!session || !window.confirm("내가 수집한 곡, 크레딧, 인물 프로필을 모두 삭제합니다. 이 작업은 되돌릴 수 없습니다. 계속할까요?")) return;
    setResetting(true); setError("");
    try {
      await resetResearchData(session.user.id, session.access_token);
      clearCreatorProfileMemory();
      setTracks([]);
      setSelectedKey(undefined);
      setOpenedTrackId(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "수집 데이터를 초기화하지 못했습니다.");
    } finally {
      setResetting(false);
    }
  }
  async function deleteTrack(track: SavedTrack) {
    if (!session || !window.confirm(`‘${track.title}’을 수집함과 DB에서 삭제할까요?`)) return;
    setDeletingTrackId(track.id); setError("");
    try {
      await deleteSavedTrack(track.id, session.user.id, session.access_token);
      setTracks(current => current.filter(item => item.id !== track.id));
      if (expandedTrackId === track.id) setExpandedTrackId(undefined);
      if (openedTrackId === track.id) setOpenedTrackId(undefined);
      if (selected?.tracks.some(item => item.id === track.id)) setSelectedKey(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "곡을 삭제하지 못했습니다.");
    } finally { setDeletingTrackId(undefined); }
  }
  async function refreshTrackCredits(track: SavedTrack) {
    if (!session) return;
    setRefreshingTrackId(track.id); setError("");
    try {
      const isrc = track.track_key.startsWith("isrc:") ? track.track_key.slice(5) : undefined;
      const mbid = track.track_key.startsWith("mbid:") ? track.track_key.slice(5) : undefined;
      const analysis = await reanalyze.mutateAsync({ title: track.title, artist: track.artist, isrc, mbid });
      await saveAnalysis(analysis, session.user.id, session.access_token);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "크레딧을 다시 조회하지 못했습니다.");
    } finally { setRefreshingTrackId(undefined); }
  }
  useEffect(() => { void load(); }, [session?.access_token]);

  const analytics = useMemo(() => {
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 3);
    const creators = new Map<string, { name: string; credits: SavedCredit[]; tracks: Map<string, SavedTrack> }>();
    const people = new Map<string, { name: string; credits: SavedCredit[]; tracks: Map<string, SavedTrack> }>();
    const albums = new Map<string, number>(); const genres = new Map<string, number>(); const artists = new Map<string, number>();
    const composers = new Map<string, number>();
    const edgeCounts = new Map<string, { names: [string, string]; count: number }>();
    for (const track of tracks) {
      if (track.album) albums.set(track.album, (albums.get(track.album) ?? 0) + 1);
      for (const genre of track.genres ?? []) genres.set(genre, (genres.get(genre) ?? 0) + 1);
      for (const artist of splitArtists(track.artist)) artists.set(artist, (artists.get(artist) ?? 0) + 1);
      for (const credit of track.credits) {
        const person = people.get(credit.creator_key) ?? { name: credit.name, credits: [], tracks: new Map<string, SavedTrack>() };
        person.credits.push(credit); person.tracks.set(track.id, track); people.set(credit.creator_key, person);
        if (["작곡", "작사·작곡"].includes(credit.role)) composers.set(credit.creator_key, (composers.get(credit.creator_key) ?? 0) + 1);
      }
      const creative = track.credits.filter(credit => creatorRoles.includes(credit.role));
      for (const credit of creative) {
        const current = creators.get(credit.creator_key) ?? { name: credit.name, credits: [], tracks: new Map<string, SavedTrack>() };
        current.credits.push(credit); current.tracks.set(track.id, track); creators.set(credit.creator_key, current);
      }
      const unique = Array.from(new Map(creative.map(credit => [credit.creator_key, credit])).values());
      for (let left = 0; left < unique.length; left += 1) for (let right = left + 1; right < unique.length; right += 1) {
        const pair = [unique[left], unique[right]].sort((a, b) => a.creator_key.localeCompare(b.creator_key));
        const key = `${pair[0].creator_key}|${pair[1].creator_key}`; const current = edgeCounts.get(key);
        edgeCounts.set(key, { names: [pair[0].name, pair[1].name], count: (current?.count ?? 0) + 1 });
      }
    }
    const creatorStats: CreatorStat[] = Array.from(creators.entries()).map(([key, value]) => {
      const creatorTracks = Array.from(value.tracks.values());
      const rolesByTrack = creatorTracks.map(track => track.credits.filter(credit => credit.creator_key === key).map(credit => credit.role));
      return {
        key, name: value.name, credits: value.credits, tracks: creatorTracks,
        compositionCount: rolesByTrack.filter(roles => roles.some(role => ["작곡", "작사·작곡"].includes(role))).length,
        lyricCount: rolesByTrack.filter(roles => roles.some(role => ["작사", "작사·작곡"].includes(role))).length,
        combinedCount: rolesByTrack.filter(roles => roles.includes("작사·작곡") || (roles.includes("작사") && roles.includes("작곡"))).length,
        recentCount: creatorTracks.filter(track => track.release_date && new Date(track.release_date) >= cutoff).length,
      };
    }).sort((a, b) => b.tracks.length - a.tracks.length || a.name.localeCompare(b.name));
    const personStats: CreatorStat[] = Array.from(people.entries()).map(([key, value]) => {
      const personTracks = Array.from(value.tracks.values());
      const rolesByTrack = personTracks.map(track => track.credits.filter(credit => credit.creator_key === key).map(credit => credit.role));
      return {
        key, name: value.name, credits: value.credits, tracks: personTracks,
        compositionCount: rolesByTrack.filter(roles => roles.some(role => ["작곡", "작사·작곡"].includes(role))).length,
        lyricCount: rolesByTrack.filter(roles => roles.some(role => ["작사", "작사·작곡"].includes(role))).length,
        combinedCount: rolesByTrack.filter(roles => roles.includes("작사·작곡") || (roles.includes("작사") && roles.includes("작곡"))).length,
        recentCount: personTracks.filter(track => track.release_date && new Date(track.release_date) >= cutoff).length,
      };
    }).sort((a, b) => b.tracks.length - a.tracks.length || a.name.localeCompare(b.name));
    const namedRanks = (source: Map<string, number>) => Array.from(source.entries()).map(([key, count]) => [people.get(key)?.name ?? key, count, key] as const).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
      creatorStats, personStats,
      composers: namedRanks(composers),
      recentTracks: tracks.filter(track => track.release_date && new Date(track.release_date) >= cutoff).sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? "")),
      albums: Array.from(albums.entries()).sort((a, b) => b[1] - a[1]),
      genres: Array.from(genres.entries()).sort((a, b) => b[1] - a[1]),
      artists: Array.from(artists.entries()).sort((a, b) => b[1] - a[1]),
      edges: Array.from(edgeCounts.values()).sort((a, b) => b.count - a.count),
    };
  }, [tracks]);

  const selected = analytics.personStats.find(creator => creator.key === selectedKey);
  const selectedNode = useMemo(() => selected ? {
    id: selected.key,
    name: selected.name,
    roles: Array.from(new Set(selected.credits.map(credit => credit.role))),
    appearances: selected.tracks.length,
    externalIpi: selected.credits.find(credit => credit.external_ipi)?.external_ipi,
    externalMbid: selected.credits.find(credit => credit.external_mbid)?.external_mbid,
  } : undefined, [selected]);
  const selectedProfile = useCreatorProfile(selectedNode);
  const latestApiWorks = useMemo(() => [...(selectedProfile.data?.works ?? [])].sort((a, b) => {
    if (!a.releaseDate && !b.releaseDate) return 0;
    if (!a.releaseDate) return 1;
    if (!b.releaseDate) return -1;
    return b.releaseDate.localeCompare(a.releaseDate);
  }).slice(0, 6), [selectedProfile.data]);
  const selectPerson = (key?: string) => setSelectedKey(current => current === key ? undefined : key);
  const repeatedCreators = analytics.creatorStats.filter(creator => creator.tracks.length > 1);
  const singleCreators = analytics.creatorStats.filter(creator => creator.tracks.length === 1);
  const visibleConnections = showAllConnections ? analytics.edges.slice(0, 12) : analytics.edges.slice(0, 6);
  const openedTrack = tracks.find(track => track.id === openedTrackId);
  const filteredTracks = useMemo(() => {
    const query = trackQuery.trim().toLocaleLowerCase();
    if (!query) return tracks;
    return tracks.filter(track => [
      track.title,
      track.artist,
      track.album,
      ...(track.genres ?? []),
      ...track.credits.flatMap(credit => [credit.name, credit.role]),
    ].some(value => value?.toLocaleLowerCase().includes(query)));
  }, [tracks, trackQuery]);
  const artistChart = analytics.artists.map(([name, count]) => [name, count, analytics.personStats.find(person => person.name.toLocaleLowerCase() === name.toLocaleLowerCase())?.key] as const);

  if (openedTrack?.raw_analysis?.track && Array.isArray(openedTrack.raw_analysis.credits)) return <div className="min-h-screen bg-[#101010] pb-12 text-white">
    <div className="mx-auto max-w-6xl px-5 pt-8 sm:px-8"><button onClick={() => setOpenedTrackId(undefined)} className="flex items-center gap-2 border border-white/25 px-4 py-2 text-xs hover:bg-white hover:text-black"><ArrowLeft className="size-3.5" />수집 목록으로 돌아가기</button><div className="mt-5 border-l-2 border-white pl-4"><p className="text-[10px] font-mono tracking-[.16em] text-white/45">SAVED ANALYSIS · {displayDate(openedTrack.updated_at)}</p><h1 className="mt-2 text-2xl font-black">저장된 분석 전체 보기</h1><p className="mt-2 text-sm text-white/55">검색 당시 저장된 곡 정보·크레딧·분석 노트를 다시 불러왔습니다.</p></div></div>
    <Analysis analysis={openedTrack.raw_analysis} />
  </div>;

  return <main className="min-h-screen bg-[#101010] px-5 py-8 text-white sm:px-8">
    <div className="mx-auto max-w-7xl"><header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/20 pb-6"><div><button onClick={onBack} className="mb-5 flex items-center gap-2 text-xs text-white/55 hover:text-white"><ArrowLeft className="size-3.5" />곡 검색으로 돌아가기</button><p className="text-[10px] font-mono tracking-[.16em] text-white/45">MY RESEARCH COLLECTION</p><h1 className="mt-2 text-4xl font-black tracking-[-.05em]">수집 크레딧 분석</h1></div><div className="flex items-center gap-2"><button onClick={() => void load()} disabled={loading || resetting} className="flex items-center gap-2 border border-white/25 px-4 py-2 text-xs disabled:opacity-40"><RefreshCw className="size-3.5" />새로고침</button><button onClick={() => void resetAll()} disabled={loading || resetting || !tracks.length} className="flex items-center gap-2 border border-red-300/50 px-4 py-2 text-xs text-red-200 disabled:opacity-30">{resetting ? <LoaderCircle className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}{resetting ? "초기화 중" : "초기화"}</button></div></header>
      {loading ? <div className="py-32 text-center"><LoaderCircle className="mx-auto size-7 animate-spin" /><p className="mt-4 text-sm text-white/55">수집 데이터를 분석하고 있습니다.</p></div> : error ? <p className="mt-8 border border-white/25 p-5 text-sm">{error}</p> : !tracks.length ? <div className="mt-10 border border-white/20 bg-[#181818] p-10"><h2 className="text-2xl font-black">아직 수집한 곡이 없습니다.</h2><p className="mt-3 text-sm text-white/55">곡을 검색하고 분석하면 자동으로 이 공간에 저장됩니다.</p></div> : <>
        <section className="mt-8 grid gap-px bg-white/15 sm:grid-cols-2 lg:grid-cols-4">{[["수집 곡", tracks.length], ["반복 등장 인물", analytics.creatorStats.filter(item => item.tracks.length > 1).length], ["확인 아티스트", analytics.artists.length], ["공동작업 연결", analytics.edges.length]].map(([label, value]) => <div key={String(label)} className="bg-[#181818] p-6"><p className="text-[10px] font-mono text-white/45">{label}</p><strong className="mt-3 block text-4xl">{value}</strong></div>)}</section>
        <section className="mt-8 border border-white/20 bg-[#181818] p-6">
          <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-[10px] font-mono tracking-[.16em] text-white/45">CREDIT SHEET · {String(tracks.length).padStart(4, "0")}</p><h2 className="mt-2 text-2xl font-black">내가 검색한 곡</h2><p className="mt-2 text-xs text-white/50">곡을 펼치면 크레딧을 바로 확인하고, 전체 분석 화면으로 이동할 수 있습니다.</p></div><button onClick={() => exportTracksToExcel(tracks)} className="flex items-center gap-2 border border-white/25 px-4 py-2 text-xs hover:bg-white hover:text-black"><Download className="size-3.5" />엑셀로 내보내기</button></div>
          <label className="mt-6 flex items-center gap-3 border border-white/20 bg-black/25 px-4 py-3 focus-within:border-white"><Search className="size-4 text-white/45" /><input value={trackQuery} onChange={event => setTrackQuery(event.target.value)} placeholder="곡명, 아티스트, 앨범, 장르, 크레딧 이름으로 검색" className="w-full bg-transparent text-sm outline-none placeholder:text-white/35" /><span className="shrink-0 font-mono text-[10px] text-white/40">{filteredTracks.length} / {tracks.length}</span></label>
          <div className="mt-5 divide-y divide-white/10 border-y border-white/15">{filteredTracks.map((track, index) => {
            const expanded = expandedTrackId === track.id;
            return <article key={track.id}>
              <div className="flex items-stretch"><button onClick={() => setExpandedTrackId(expanded ? undefined : track.id)} className="grid min-w-0 flex-1 grid-cols-[2.25rem_1fr_auto] items-center gap-3 px-2 py-4 text-left transition hover:bg-white hover:text-black sm:px-4"><span className="font-mono text-[10px] opacity-45">{String(index + 1).padStart(2, "0")}</span><span className="min-w-0"><strong className="block truncate text-base">{track.title}</strong><span className="mt-1 block truncate text-xs opacity-55">{track.artist}{track.album ? ` · ${track.album}` : ""} · {displayDate(track.release_date)}</span><span className="mt-2 block truncate text-[10px] opacity-40">{track.credits.map(credit => credit.name).filter((name, item, names) => names.indexOf(name) === item).join(" · ") || "확정 크레딧 미확인"}</span></span>{expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}</button><button onClick={() => void deleteTrack(track)} disabled={deletingTrackId === track.id} aria-label={`${track.title} 삭제`} className="w-14 shrink-0 border-l border-white/10 text-red-200/60 hover:bg-red-400 hover:text-black disabled:opacity-30">{deletingTrackId === track.id ? <LoaderCircle className="mx-auto size-4 animate-spin" /> : <Trash2 className="mx-auto size-4" />}</button></div>
              {expanded && <div className="border-t border-white/10 bg-black/20 px-4 py-5 sm:px-12"><div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">{track.credits.length ? track.credits.map(credit => <div key={credit.id} className="grid grid-cols-[6rem_1fr] border-b border-white/10 py-2 text-xs"><span className="font-mono text-white/45">{credit.role}</span><button onClick={() => selectPerson(credit.creator_key)} className="text-left font-semibold hover:underline">{credit.name}</button></div>) : <p className="text-sm text-white/45">저장된 크레딧이 없습니다.</p>}</div>{track.source_note && <p className="mt-4 text-xs leading-5 text-white/40">{track.source_note}</p>}<div className="mt-5 flex flex-wrap gap-2"><button onClick={() => setOpenedTrackId(track.id)} className="flex items-center gap-2 border border-white/25 px-4 py-2 text-xs hover:bg-white hover:text-black">저장된 전체 분석 보기 <ArrowUpRight className="size-3.5" /></button><button onClick={() => void refreshTrackCredits(track)} disabled={refreshingTrackId === track.id} className="flex items-center gap-2 border border-white/25 px-4 py-2 text-xs hover:bg-white hover:text-black disabled:opacity-40">{refreshingTrackId === track.id ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}크레딧 다시 조회</button></div></div>}
            </article>;
          })}{!filteredTracks.length && <div className="px-4 py-14 text-center"><p className="text-sm font-bold">검색 결과가 없습니다.</p><p className="mt-2 text-xs text-white/45">다른 곡명이나 참여자 이름으로 다시 검색해 보세요.</p></div>}</div>
        </section>
        <section className="mt-8 grid gap-8 xl:grid-cols-[1.15fr_.85fr]"><div className="border border-white/20 bg-[#181818] p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[10px] font-mono text-white/45">CREATOR PRIORITY</p><h2 className="mt-2 text-2xl font-black">참여자 우선순위</h2><p className="mt-2 text-xs text-white/45">여러 곡에 반복 참여한 인물을 먼저 보여줍니다.</p></div><span className="border border-white/20 px-3 py-1.5 font-mono text-[10px] text-white/50">반복 {repeatedCreators.length} · 1회 {singleCreators.length}</span></div>{repeatedCreators.length ? <div className="mt-6 overflow-x-auto"><table className="w-full min-w-[650px] text-left text-xs"><thead className="border-b border-white/20 text-white/45"><tr><th className="py-3">우선순위 / 인물</th><th>전체</th><th>작곡</th><th>작사</th><th>동시</th><th>최근 3개월</th></tr></thead><tbody>{repeatedCreators.map((creator, index) => <tr key={creator.key} onClick={() => selectPerson(creator.key)} className="cursor-pointer border-b border-white/10 hover:bg-white hover:text-black"><td className="py-4 font-bold"><span className="mr-3 font-mono text-[10px] opacity-45">{String(index + 1).padStart(2, "0")}</span>{creator.name}</td><td className="font-bold">{creator.tracks.length}</td><td>{creator.compositionCount}</td><td>{creator.lyricCount}</td><td>{creator.combinedCount}</td><td>{creator.recentCount}</td></tr>)}</tbody></table></div> : <div className="mt-6 border border-dashed border-white/20 px-5 py-7"><p className="text-sm font-bold">아직 2곡 이상 반복 참여한 인물이 없습니다.</p><p className="mt-2 text-xs text-white/45">곡이 더 쌓이면 참여 횟수가 높은 인물부터 이곳에 정렬됩니다.</p></div>}<div className="mt-5 border-t border-white/15 pt-5"><button onClick={() => setShowSingleCreators(value => !value)} className="flex w-full items-center justify-between text-left"><span><strong className="text-sm">1회 참여 인물</strong><span className="ml-2 text-xs text-white/40">{singleCreators.length}명</span></span>{showSingleCreators ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}</button>{showSingleCreators && <div className="mt-4 flex flex-wrap gap-2">{singleCreators.map(creator => <button key={creator.key} onClick={() => selectPerson(creator.key)} className="border border-white/15 px-3 py-2 text-xs text-white/65 hover:border-white hover:bg-white hover:text-black">{creator.name}<span className="ml-2 font-mono text-[9px] opacity-45">1곡</span></button>)}</div>}</div></div>
          <div className="space-y-8"><ParticipationDonut title="아티스트별 참여 횟수" subtitle="전체 수집곡에서 아티스트별 비중" items={artistChart} onSelect={selectPerson} />{analytics.albums.length > 0 && <Rank title="앨범별 참여 횟수" items={analytics.albums} />}{analytics.genres.length > 0 && <Rank title="장르별 참여" items={analytics.genres} />}</div></section>
        <section className="mt-8 grid gap-8 xl:grid-cols-2"><ParticipationDonut title="작곡가 참여 비율" subtitle="전체 작곡 크레딧에서 작곡가별 비중" items={analytics.composers} onSelect={selectPerson} /><div className="border border-white/20 bg-[#181818] p-6"><p className="text-[10px] font-mono text-white/45">RECENT 3 MONTHS</p><h2 className="mt-2 text-2xl font-black">최근 3개월 참여곡</h2><p className="mt-2 text-xs text-white/45">발매일이 확인된 곡을 최신순으로 표시합니다.</p><div className="mt-6 grid gap-3 sm:grid-cols-2">{analytics.recentTracks.length ? analytics.recentTracks.map(track => <button key={track.id} onClick={() => setOpenedTrackId(track.id)} className="border border-white/15 p-4 text-left hover:border-white hover:bg-white hover:text-black"><span className="font-mono text-[10px] opacity-45">{displayDate(track.release_date)}</span><strong className="mt-2 block text-base">{track.title}</strong><span className="mt-1 block text-xs opacity-55">{track.artist}</span></button>) : <p className="col-span-2 border border-dashed border-white/20 p-6 text-sm text-white/45">최근 3개월 내 발매된 수집곡이 없습니다.</p>}</div></div></section>
        <section className="mt-8 border border-white/20 bg-[#181818] p-6"><div className="flex flex-wrap items-center justify-between gap-4"><div className="flex items-center gap-3"><Network className="size-5" /><div><p className="text-[10px] font-mono text-white/45">CO-WRITER NETWORK</p><h2 className="mt-1 text-2xl font-black">가장 많이 함께 작업한 조합</h2></div></div>{analytics.edges.length > 6 && <button onClick={() => setShowAllConnections(value => !value)} className="flex items-center gap-2 border border-white/20 px-3 py-2 text-xs text-white/60 hover:border-white hover:text-white">{showAllConnections ? "상위 조합만 보기" : `전체 ${Math.min(analytics.edges.length, 12)}개 보기`}{showAllConnections ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}</button>}</div><div className="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{visibleConnections.map((edge, index) => <div key={`${edge.names.join("-")}-${index}`} className="border border-white/15 p-4"><div className="flex items-start gap-3"><span className="font-mono text-[10px] text-white/30">{String(index + 1).padStart(2, "0")}</span><span className="text-sm font-bold">{edge.names[0]} × {edge.names[1]}</span></div><strong className="mt-3 block text-2xl">{edge.count}<small className="ml-1 text-xs font-normal text-white/45">곡</small></strong></div>)}</div></section>
        {selected && <aside className="fixed bottom-5 right-5 z-[70] max-h-[calc(100vh-5rem)] w-[calc(100%-2.5rem)] max-w-md overflow-y-auto border border-black/20 bg-[#ecece8] text-black shadow-2xl"><div className="sticky top-0 flex items-start justify-between gap-4 bg-black p-5 text-white"><div><p className="text-[10px] font-mono text-white/45">LATEST WORKS · LIVE CATALOG</p><h2 className="mt-2 text-2xl font-black">{selectedProfile.data?.creator.name ?? selected.name}</h2><p className="mt-1 text-xs text-white/55">{(selectedProfile.data?.creator.roles ?? selectedNode?.roles ?? []).join(" · ")}</p></div><button onClick={() => selectPerson(selected.key)} aria-label="카드 닫기" className="border border-white/25 p-2 hover:bg-white hover:text-black"><X className="size-4" /></button></div><div className="p-5"><div className="flex items-center justify-between gap-3 border-b border-black/15 pb-3"><p className="text-[10px] font-mono text-black/45">API에서 확인한 최신 발매·활동곡</p>{selectedProfile.data && <span className="font-mono text-[9px] text-black/40">조회 {selectedProfile.data.scannedWorks}개</span>}</div>{selectedProfile.isLoading ? <div className="flex items-center gap-3 py-10 text-sm text-black/55"><LoaderCircle className="size-4 animate-spin" />Credits.fm·MusicBrainz 카탈로그 조회 중</div> : latestApiWorks.length ? <div className="mt-3 space-y-2">{latestApiWorks.map((work, index) => <div key={work.id} className={`border p-4 ${index === 0 ? "border-black bg-white" : "border-black/15"}`}><span className="font-mono text-[10px] opacity-45">{index === 0 ? "LATEST · " : ""}{displayDate(work.releaseDate)}</span><strong className="mt-1 block text-base">{work.title}</strong></div>)}</div> : <div className="py-8"><p className="text-sm font-bold">API에서 최근 작품을 확인하지 못했습니다.</p><p className="mt-2 text-xs leading-5 text-black/50">공개 카탈로그에 이 인물의 작품 연결이나 발매일이 없는 경우입니다.</p></div>}{selectedProfile.data && <p className="mt-4 border-t border-black/15 pt-3 text-[10px] leading-4 text-black/45">{selectedProfile.data.sourceNote}</p>}</div></aside>}
      </>}
    </div>
  </main>;
}

function Rank({ title, items }: { title: string; items: Array<[string, number]> }) {
  const max = Math.max(items[0]?.[1] ?? 1, 1);
  return <div className="border border-white/20 bg-[#181818] p-5"><p className="text-[10px] font-mono text-white/45">{title}</p><div className="mt-4 space-y-3">{items.slice(0, 6).map(([name, count]) => <div key={name}><div className="flex justify-between text-xs"><span className="truncate">{name}</span><b>{count}</b></div><div className="mt-1.5 h-1 bg-white/10"><div className="h-full bg-white" style={{ width: `${Math.max(count / max * 100, 5)}%` }} /></div></div>)}</div></div>;
}

function ParticipationDonut({ title, subtitle, items, onSelect }: { title: string; subtitle: string; items: ReadonlyArray<readonly [string, number, string?]>; onSelect: (key?: string) => void }) {
  const total = items.reduce((sum, item) => sum + item[1], 0);
  const primary = items.slice(0, 7);
  const remainder = items.slice(7).reduce((sum, item) => sum + item[1], 0);
  const visible: Array<readonly [string, number, string?]> = remainder ? [...primary, [`기타 ${items.length - 7}명`, remainder, undefined]] : [...primary];
  let cursor = 0;
  const gradient = visible.map((item, index) => {
    const start = cursor; cursor += total ? item[1] / total * 100 : 0;
    return `${chartColors[index % chartColors.length]} ${start}% ${cursor}%`;
  }).join(", ");
  return <div className="border border-white/20 bg-[#181818] p-6"><p className="text-[10px] font-mono text-white/45">PARTICIPATION SHARE</p><h2 className="mt-2 text-2xl font-black">{title}</h2><p className="mt-2 text-xs text-white/45">{subtitle}</p>{total ? <div className="mt-6 grid gap-7 sm:grid-cols-[180px_1fr] sm:items-center"><div className="relative mx-auto size-44 rounded-full" style={{ background: `conic-gradient(${gradient})` }}><div className="absolute inset-[27%] flex flex-col items-center justify-center rounded-full bg-[#181818]"><strong className="text-3xl">{total}</strong><span className="text-[10px] text-white/45">총 참여</span></div></div><div className="space-y-1">{visible.map((item, index) => { const content = <><span className="size-2.5 shrink-0 rounded-sm" style={{ background: chartColors[index % chartColors.length] }} /><span className="min-w-0 flex-1 truncate font-semibold">{item[0]}</span><span className="shrink-0 font-mono text-white/55">{item[1]}곡 · {Math.round(item[1] / total * 100)}%</span></>; return item[2] ? <button key={item[0]} onClick={() => onSelect(item[2])} className="flex w-full items-center gap-3 border-b border-white/10 py-2 text-left text-xs hover:text-white">{content}</button> : <div key={item[0]} className="flex items-center gap-3 border-b border-white/10 py-2 text-xs">{content}</div>; })}</div></div> : <p className="mt-6 border border-dashed border-white/20 p-6 text-sm text-white/45">집계할 크레딧이 없습니다.</p>}</div>;
}
