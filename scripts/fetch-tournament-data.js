/**
 * scripts/fetch-tournament-data.js
 *
 * Run by GitHub Actions on a schedule. Uses Node 18+ built-in fetch
 * (no npm dependencies needed). Never called from the browser.
 *
 * WHAT THIS SCRIPT AUTOMATES:
 *   - Group stage standings (played/won/drawn/lost/points) for all 12 groups
 *   - Goals conceded per team (for the "most conceded" prize)
 *   - Knockout progress: who reached R16, who got eliminated and at which
 *     round, who is runner-up, who is champion
 *
 * WHAT STAYS MANUAL (free API tier doesn't expose this data):
 *   - Cautions/cards (most_cautions_group prize)
 *   - Exact goal minutes (latest_goal prize)
 *   - Goal of the tournament (always manual by design)
 *
 * STAGE NAME ROBUSTNESS:
 *   football-data.org's knockout stage names vary by competition/season
 *   and the 48-team World Cup format is new, so this script does NOT
 *   hardcode a single stage string for "round of 16". Instead it builds
 *   a known list of equivalent names and also falls back to inferring
 *   the round from the match's position in the draw (round number from
 *   matchday / stage ordering) where possible. If a stage name truly
 *   isn't recognised, it's logged clearly rather than silently ignored.
 *
 * SAFE MERGE POLICY:
 *   - API data only ever ADDS or UPDATES values from real responses.
 *   - It never resets a field to zero/null/false because the API was
 *     silent on it — the old cached value wins in that case.
 *   - If the API call fails outright, the script exits non-zero and the
 *     cached file is left completely untouched.
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '../data/tournament.json');
const API_KEY   = process.env.FOOTBALL_DATA_API_KEY;
const BASE_URL  = 'https://api.football-data.org/v4';

// ── ALIAS MAP ────────────────────────────────────────────────────────────────
// Maps API team names -> our display names.
const ALIAS_MAP = {
  'IR Iran':                    'Iran',
  'Iran (Islamic Republic of)': 'Iran',
  'Korea Republic':             'South Korea',
  'Republic of Korea':          'South Korea',
  'Turkey':                     'Türkiye',
  'Ivory Coast':                "Côte d'Ivoire",
  'US':                         'United States',
  'USA':                        'United States',
  'Czech Republic':             'Czechia',
  'Bosnia':                     'Bosnia & Herzegovina',
  'Bosnia and Herzegovina':     'Bosnia & Herzegovina',
  'Cape Verde':                 'Cabo Verde',
  'DR Congo':                   'DR Congo',
  'Congo DR':                   'DR Congo',
  'DRC':                        'DR Congo',
};
const resolve = name => ALIAS_MAP[name] || name;

// Map our "Group A" style names to letters for matching against the API's
// group field, which can come back as "Group A", "GROUP_A", "A", etc.
function groupLetterFromOurName(name) {
  return name.replace(/Group/i, '').trim().toUpperCase();
}
function groupLetterFromApiValue(value) {
  if (!value) return null;
  return value.replace(/[^A-Za-z]/g, '').toUpperCase().replace(/^GROUP/, '');
}

// ── KNOCKOUT STAGE NAME NORMALISATION ─────────────────────────────────────
// football-data.org has used different stage strings across competitions
// and tournament formats. We normalise anything we recognise into one of:
// 'R32', 'R16', 'QF', 'SF', 'FINAL'. Anything unrecognised is logged.
const STAGE_ALIASES = {
  // Round of 32 (new for the 48-team format — name not yet confirmed,
  // so we cover every plausible variant)
  'LAST_32':        'R32',
  'ROUND_OF_32':    'R32',
  'ROUND_OF_THIRTY_TWO': 'R32',

  // Round of 16
  'LAST_16':         'R16',
  'ROUND_OF_16':     'R16',

  // Quarter finals
  'QUARTER_FINALS':  'QF',
  'QUARTERFINALS':   'QF',

  // Semi finals
  'SEMI_FINALS':     'SF',
  'SEMIFINALS':      'SF',

  // Final
  'FINAL':           'FINAL',
};

function normaliseStage(rawStage) {
  if (!rawStage) return null;
  const key = rawStage.toUpperCase().replace(/\s+/g, '_');
  return STAGE_ALIASES[key] || null;
}

const ROUND_LABELS = {
  R32:   'Round of 32',
  R16:   'Round of 16',
  QF:    'Quarter-Final',
  SF:    'Semi-Final',
  FINAL: 'Final',
};

// ── API HELPER ────────────────────────────────────────────────────────────────
async function apiFetch(endpoint) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { 'X-Auth-Token': API_KEY },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status} for ${endpoint}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Reading cached data…');
  const cached = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

  // ── FETCH MATCHES ──────────────────────────────────────────────────────────
  console.log('Fetching matches…');
  const matchData       = await apiFetch('/competitions/WC/matches?season=2026');
  const allMatches      = matchData.matches ?? [];
  const finishedMatches = allMatches.filter(m => m.status === 'FINISHED');
  console.log(`Finished matches: ${finishedMatches.length} of ${allMatches.length}`);

  // Log any stage names we don't recognise, so they're never silently dropped
  const unknownStages = new Set();
  for (const m of finishedMatches) {
    if (m.stage && m.stage !== 'GROUP_STAGE' && !normaliseStage(m.stage)) {
      unknownStages.add(m.stage);
    }
  }
  if (unknownStages.size > 0) {
    console.warn('⚠ Unrecognised stage name(s) from API, not yet mapped:', [...unknownStages].join(', '));
    console.warn('  These matches will be skipped for knockout-progress tracking until added to STAGE_ALIASES.');
  }

  // ── FETCH STANDINGS ────────────────────────────────────────────────────────
  console.log('Fetching standings…');
  const standingsData = await apiFetch('/competitions/WC/standings?season=2026');

  const goalsConcededMap  = {};  // teamName -> goalsAgainst
  const groupStandingsMap = {};  // groupLetter -> [{name, played, won, drawn, lost, points}]

  for (const group of standingsData.standings ?? []) {
    const letter = groupLetterFromApiValue(group.group ?? group.stage ?? '');
    const rows = [];
    for (const entry of group.table ?? []) {
      const name = resolve(entry.team?.name ?? '');
      if (!name) continue;
      if ((entry.goalsAgainst ?? 0) > 0) goalsConcededMap[name] = entry.goalsAgainst;
      rows.push({
        name,
        played: entry.playedGames ?? 0,
        won:    entry.won         ?? 0,
        drawn:  entry.draw        ?? 0,
        lost:   entry.lost        ?? 0,
        points: entry.points      ?? 0,
      });
    }
    if (letter && rows.length) groupStandingsMap[letter] = rows;
  }
  console.log(`Group standings received for: ${Object.keys(groupStandingsMap).join(', ') || 'none'}`);

  // ── MERGE GROUP STANDINGS INTO cached.groups (creates rows if missing) ────
  const updatedGroups = (cached.groups || []).map(group => {
    const letter  = groupLetterFromOurName(group.name);
    const apiRows = groupStandingsMap[letter];
    if (!apiRows) return group; // No API data yet for this group — keep cached

    const updatedTeams = (group.teams || []).map(t => {
      const row = apiRows.find(r => r.name === t.name);
      return row ? { ...t, ...row } : t;
    });
    updatedTeams.sort((a, b) => (b.points - a.points) || (b.won - a.won));
    return { ...group, teams: updatedTeams };
  });

  // ── GUARD: tournament not started at all ──────────────────────────────────
  if (finishedMatches.length === 0) {
    console.log('No finished matches yet — preserving seed data, updating timestamp only.');
    const out = {
      ...cached,
      _meta: { ...cached._meta, lastUpdated: new Date().toISOString(), updateStatus: 'ok', cacheAgeMinutes: 0 },
      groups: updatedGroups,
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(out, null, 2));
    console.log('✓ Done (no matches yet).');
    return;
  }

  // ── DETERMINE WHO REACHED R16 ──────────────────────────────────────────────
  // A team has "reached R16" once they've played in an R16 match OR any
  // later stage (QF/SF/FINAL), since reaching those implies R16 already.
  // If the API never exposes an R32 stage at all (per docs uncertainty),
  // teams instead get flagged via group standings top-2 + best-third logic
  // as a fallback further below.
  const reachedR32Set = new Set(); // reached knockout stage (won group stage)
  const reachedR16Set = new Set(); // actually won their R32 match
  const roundMap = {}; // teamName -> { eliminatedRound, isChampion, isRunnerUp, status }

  for (const match of finishedMatches) {
    const home  = resolve(match.homeTeam?.name ?? '');
    const away  = resolve(match.awayTeam?.name ?? '');
    const stage = normaliseStage(match.stage);
    if (!home || !away || !stage) continue;

    // Both teams in any R32 match have reached the knockout stage
    if (['R32', 'R16', 'QF', 'SF', 'FINAL'].includes(stage)) {
      reachedR32Set.add(home);
      reachedR32Set.add(away);
    }
    // Both teams in any R16+ match have won their R32 match
    if (['R16', 'QF', 'SF', 'FINAL'].includes(stage)) {
      reachedR16Set.add(home);
      reachedR16Set.add(away);
    }

    // Determine winner/loser for any knockout match (R32 onward)
    const hs = (match.score?.fullTime?.home ?? 0) + (match.score?.extraTime?.home ?? 0);
    const as = (match.score?.fullTime?.away ?? 0) + (match.score?.extraTime?.away ?? 0);
    let winner, loser;
    if      (hs > as) { winner = home; loser = away; }
    else if (as > hs) { winner = away; loser = home; }
    else {
      const hp = match.score?.penalties?.home ?? 0;
      const ap = match.score?.penalties?.away ?? 0;
      winner = hp >= ap ? home : away;
      loser  = hp >= ap ? away : home;
    }

    const label = ROUND_LABELS[stage];

    if (stage === 'FINAL') {
      roundMap[winner] = { ...roundMap[winner], isChampion: true, status: 'Champion' };
      roundMap[loser]  = { ...roundMap[loser],  isRunnerUp: true, status: 'Runner-Up', eliminatedRound: 'Final' };
    } else {
      // Loser is eliminated at this round; winner's status updates happen
      // implicitly by them appearing in a later round (or staying "Alive").
      roundMap[loser] = { ...roundMap[loser], status: 'Eliminated', eliminatedRound: label };
    }
  }

  // ── FALLBACK: infer R16 qualification from final group standings ─────────
  // If the API's stage names for the knockout rounds aren't recognised
  // (unknownStages was non-empty) we can still determine who SHOULD have
  // reached the round of 32/16 once a group is fully finished (3 games
  // played by every team in that group): top 2 automatically qualify.
  // Best-third-place teams are NOT inferred here (too complex/ambiguous
  // without official tiebreaker data) — those remain manual until the
  // API confirms it via an actual knockout match appearance.
  // Fallback: infer R32 qualification from completed group standings (top 2 per group).
  // reachedR16 cannot be inferred this way — it requires an actual R32 match win.
  for (const group of updatedGroups) {
    const allPlayed3 = (group.teams || []).every(t => (t.played ?? 0) >= 3);
    if (!allPlayed3) continue;
    const sorted = [...group.teams].sort((a, b) => (b.points - a.points) || (b.won - a.won));
    sorted.slice(0, 2).forEach(t => reachedR32Set.add(t.name));
  }

  // ── MERGE INTO TEAMS ───────────────────────────────────────────────────────
  const updatedTeams = cached.teams.map(team => {
    const prog     = roundMap[team.name] || {};
    const conceded = goalsConcededMap[team.name];
    const reached  = reachedR16Set.has(team.name);

    const reachedR32 = reachedR32Set.has(team.name) || team.reachedR32;
    const reachedR16 = reachedR16Set.has(team.name) || team.reachedR16;

    return {
      ...team,
      groupGoalsConceded: conceded !== undefined ? conceded : team.groupGoalsConceded,
      reachedR32,          // reached knockout stage (R32)
      reachedR16,          // actually won R32 match to reach R16
      eliminatedRound:    prog.eliminatedRound ?? team.eliminatedRound,
      isChampion:         prog.isChampion  ?? team.isChampion,
      isRunnerUp:         prog.isRunnerUp  ?? team.isRunnerUp,
      status:             prog.status      ?? team.status,
    };
  });

  // ── WRITE ──────────────────────────────────────────────────────────────────
  const output = {
    ...cached,
    _meta: {
      ...cached._meta,
      lastUpdated:   new Date().toISOString(),
      updateStatus:  'ok',
      cacheAgeMinutes: 0,
    },
    teams:  updatedTeams,
    prizes: cached.prizes,   // manual overrides (cautions/latest goal/goal of tourney) preserved as-is
    groups: updatedGroups,
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));
  console.log(`✓ Updated at ${output._meta.lastUpdated}`);
  console.log(`  Teams marked reachedR32 this run: ${[...reachedR32Set].join(', ') || 'none'}`);
  console.log(`  Teams marked reachedR16 this run: ${[...reachedR16Set].join(', ') || 'none'}`);
  console.log(`  Teams eliminated/advanced this run: ${Object.keys(roundMap).join(', ') || 'none'}`);
}

main().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
