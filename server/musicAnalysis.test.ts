import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildBriefing,
  buildArtistCollaborations,
  buildCooccurrenceNetwork,
  consolidateMusicCredits,
  normalizeCreditRole,
  normalizeCreditsFmRole,
  musicBrainzNameVariants,
  profileKindForRoles,
  selectBestCreditsRecording,
  selectBestMusicBrainzArtist,
  type MusicCredit,
} from "./musicAnalysis.ts";

const credits: MusicCredit[] = [
  { creatorId: "a", name: "A", role: "아티스트", source: "MusicBrainz" },
  { creatorId: "b", name: "B", role: "작곡", source: "MusicBrainz" },
  { creatorId: "c", name: "C", role: "프로듀싱", source: "MusicBrainz" },
];

describe("music credit normalization", () => {
  it("maps known relationship labels into the credit taxonomy", () => {
    assert.equal(normalizeCreditRole("composer"), "작곡");
    assert.equal(normalizeCreditRole("lyricist"), "작사");
    assert.equal(normalizeCreditRole("writer"), "작사·작곡");
    assert.equal(normalizeCreditRole("producer"), "프로듀싱");
    assert.equal(normalizeCreditRole("unknown"), "기타");
  });

  it("selects a title and artist match and maps Credits.fm roles", () => {
    const result = selectBestCreditsRecording([
      { isrc: "other", title: "BANG BANG BANG", artist_names: ["Other"] },
      { isrc: "target", title: "뱅뱅뱅 (BANG BANG BANG)", artist_names: ["BIGBANG"] },
    ], "뱅뱅뱅", "BIGBANG");
    assert.equal(result?.isrc, "target");
    assert.equal(normalizeCreditsFmRole("ComposerLyricist"), "작사·작곡");
    assert.equal(normalizeCreditsFmRole("arranger", "producer"), "편곡");
  });

  it("routes every selectable role to the correct profile catalog", () => {
    assert.equal(profileKindForRoles(["아티스트"]), "artist");
    assert.equal(profileKindForRoles(["작사"]), "creator");
    assert.equal(profileKindForRoles(["작곡", "편곡"]), "creator");
    assert.equal(profileKindForRoles(["아티스트", "작사·작곡"]), "creator");
  });

  it("resolves exact Korean and stage-name identities without picking a similar stranger", () => {
    const candidates = [
      { id: "wrong", name: "IU tribute", score: 99 },
      { id: "iu", name: "IU", score: 95, aliases: [{ name: "아이유" }, { name: "이지은" }] },
      { id: "bigbang", name: "BIGBANG", score: 100 },
      { id: "kim-eana", name: "김이나", score: 100 },
    ];
    assert.equal(selectBestMusicBrainzArtist(candidates, "아이유")?.id, "iu");
    assert.equal(selectBestMusicBrainzArtist(candidates, "BIGBANG")?.id, "bigbang");
    assert.equal(selectBestMusicBrainzArtist(candidates, "김이나")?.id, "kim-eana");
    assert.equal(selectBestMusicBrainzArtist(candidates, "완전히 다른 사람"), undefined);
  });

  it("generates safe Korean romanized name-order variants", () => {
    assert.deepEqual(musicBrainzNameVariants("CHAN HYEOK LEE"), ["CHAN HYEOK LEE", "LEE CHANHYEOK"]);
    assert.deepEqual(musicBrainzNameVariants("CHOI RAE SEONG"), ["CHOI RAE SEONG", "CHOI RAESEONG"]);
    assert.deepEqual(musicBrainzNameVariants("Taylor Swift"), ["Taylor Swift"]);
  });

  it("merges provider rows that share a name when one supplies the stable ID", () => {
    const result = consolidateMusicCredits([
      { creatorId: "artist:akmu", name: "AKMU", role: "아티스트", source: "Credits.fm" },
      { creatorId: "mbid:akmu", externalMbid: "akmu", name: "AKMU", role: "연주", source: "Credits.fm" },
    ]);
    assert.equal(new Set(result.map(credit => credit.creatorId)).size, 1);
    assert.deepEqual(result.map(credit => credit.role).sort(), ["아티스트", "연주"].sort());
  });

  it("keeps the missing-credit state explicit", () => {
    const briefing = buildBriefing(
      { id: "missing", title: "Untitled work", artist: "Unknown artist" },
      [],
      "limited",
    );
    assert.match(briefing, /확정된 송라이팅 크레딧을 찾지 못했습니다/);
    assert.match(briefing, /교차 확인하는 것이 우선입니다/);
    assert.match(briefing, /누락 가능성이 있습니다/);
  });

  it("turns verified credits into a structured research insight", () => {
    const briefing = buildBriefing(
      { id: "track", title: "Signal", artist: "Artist" },
      [
        { creatorId: "writer", name: "Writer", role: "작사·작곡", source: "Credits.fm" },
        { creatorId: "producer", name: "Producer", role: "프로듀싱", source: "Credits.fm" },
        { creatorId: "artist", name: "Artist", role: "아티스트", source: "Credits.fm" },
      ],
      "enriched",
    );
    assert.match(briefing, /핵심 요약/);
    assert.match(briefing, /송라이팅에는 1명이/);
    assert.match(briefing, /Writer 중심의 송라이팅 구조/);
    assert.match(briefing, /Producer\(프로듀싱\)/);
    assert.match(briefing, /계약상 지분이나 실제 기여량을 의미하지 않습니다/);
  });

  it("aggregates repeated creator co-occurrences without duplicate nodes", () => {
    const network = buildCooccurrenceNetwork([credits, credits.slice(0, 2)]);
    assert.equal(network.nodes.length, 3);
    assert.equal(network.nodes.find(node => node.id === "a")?.appearances, 2);
    assert.equal(
      network.edges.find(edge => edge.source === "a" && edge.target === "b")?.weight,
      2,
    );
  });

  it("ranks artists separately by unique works and keeps recent evidence", () => {
    const result = buildArtistCollaborations([
      { work: { id: "w1", title: "First", releaseDate: "2024-01-01", relevance: 0 }, artists: [{ id: "iu", name: "IU" }, { id: "iu", name: "IU" }] },
      { work: { id: "w2", title: "Second", releaseDate: "2025-02-03", relevance: 0 }, artists: [{ id: "iu", name: "아이유" }, { id: "guest", name: "Guest" }] },
      { work: { id: "w3", title: "Third", releaseDate: "2023-03-01", relevance: 0 }, artists: [{ id: "guest", name: "Guest" }] },
      { work: { id: "w4", title: "Fourth", releaseDate: "2025-04-01", relevance: 0 }, artists: [{ name: "IU" }] },
    ]);
    assert.equal(result[0].name, "IU");
    assert.equal(result[0].workCount, 3);
    assert.equal(result[0].sharePercent, 75);
    assert.equal(result[0].latestReleaseDate, "2025-04-01");
    assert.deepEqual(result[0].works.map(work => work.title), ["Fourth", "Second", "First"]);
    assert.equal(result[1].workCount, 2);
  });

  it("merges stage and legal names into one creator with combined roles", () => {
    const result = consolidateMusicCredits([
      { creatorId: "mbid:gdragon", externalMbid: "gdragon", name: "G-DRAGON", role: "아티스트", source: "Credits.fm" },
      { creatorId: "ipi:123", externalIpi: "123", name: "권지용", role: "작사", source: "Credits.fm" },
      { creatorId: "ipi:123", externalIpi: "123", name: "Kwon Ji-yong", role: "작곡", source: "Credits.fm" },
    ]);
    assert.deepEqual([...new Set(result.map(credit => credit.creatorId))], ["ipi:123"]);
    assert.deepEqual([...new Set(result.map(credit => credit.name))], ["G-DRAGON"]);
    assert.deepEqual(result.map(credit => credit.role).sort(), ["아티스트", "작곡", "작사"].sort());

    const teddy = consolidateMusicCredits([
      { creatorId: "ipi:teddy", externalIpi: "teddy", name: "PARK HONG JUN", role: "작사·작곡", source: "Credits.fm" },
      { creatorId: "mbid:teddy", externalMbid: "teddy", name: "TEDDY", role: "편곡", source: "Credits.fm" },
    ]);
    assert.deepEqual([...new Set(teddy.map(credit => credit.creatorId))], ["ipi:teddy"]);
    assert.deepEqual([...new Set(teddy.map(credit => credit.name))], ["TEDDY"]);
    assert.deepEqual(teddy.map(credit => credit.role).sort(), ["작사·작곡", "편곡"].sort());
    const teddyNode = buildCooccurrenceNetwork([teddy]).nodes[0];
    assert.equal(teddyNode.externalIpi, "teddy");
    assert.equal(teddyNode.externalMbid, "teddy");
  });
});
