/**
 * scripts/fetch-tournament-data.js
 *
 * Run by GitHub Actions on a schedule. Uses Node 18+ built-in fetch
 * (no npm dependencies needed). Never called from the browser.
 *
 * SAFE MERGE POLICY:
 * - If no matches played yet, only updates timestamp. Nothing else changes.
 * - API data only updates values — never resets them to zero/null.
 * - If the API call fails, script exits non-zero and cached file is untouched.
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '../data/tournament.json');
const API_KEY   = process.env.FOOTBALL_DATA_API_KEY;
const BASE_URL  = 'https://api.football-data.org/v4';

// ── ALIAS MAP ─────────────────────────────────────────────────────────────────
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
  'Cape Verde':                 'Cabo Verde',
};
const resolve = name => ALIAS_MAP[name] || name;

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
  const matchData      = await apiFetch('/competitions/WC/matches?season=2026');
  const allMatches     = matchData.matches ?? [];
  const finishedMatches = allMatches.filter(m => m.status === 'FINISHED');
  console.log(`Finished matches: ${finishedMatches.length} of ${allMatches.length}`);

  // ── FETCH STANDINGS ────────────────────────────────────────────────────────
  console.log('Fetching standings…');
  const standingsData = await apiFetch('/competitions/WC/standings?season=2026');

  // Parse goals conceded + group standings from API
  const goalsConcededMap  = {};  // teamName -> goalsAgainst
  const groupStandingsMap = {};  // "GROUP_A" -> [{name, played, won, drawn, lost, points}]

  for (const group of standingsData.standings ?? []) {
    const key = group.group ?? group.stage ?? null;
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
    if (key && rows.length) groupStandingsMap[key] = rows;
  }

  // ── GUARD: tournament not started ─────────────────────────────────────────
  if (finishedMatches.length === 0) {
    console.log('No finished matches — preserving seed data, updating timestamp only.');
    const out = {
      ...cached,
      _meta: { ...cached._meta, lastUpdated: new Date().toISOString(), updateStatus: 'ok', cacheAgeMinutes: 0 },
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(out, null, 2));
    console.log('✓ Done (no matches yet).');
    return;
  }

  // ── KNOCKOUT ROUND PROGRESS FROM FINISHED MATCHES ─────────────────────────
  const roundMap = {}; // teamName -> { reachedR16, eliminatedRound, isChampion, isRunnerUp, status }

  for (const match of finishedMatches) {
    const home  = resolve(match.homeTeam?.name ?? '');
    const away  = resolve(match.awayTeam?.name ?? '');
    const stage = match.stage;
    if (!home || !away) continue;

    if (stage === 'LAST_16') {
      roundMap[home] = roundMap[home] || {};
      roundMap[away] = roundMap[away] || {};
      roundMap[home].reachedR16 = true;
      roundMap[away].reachedR16 = true;
    }

    if (['LAST_16','QUARTER_FINALS','SEMI_FINALS','FINAL'].includes(stage)) {
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
      const label = { LAST_16:'Round of 16', QUARTER_FINALS:'Quarter-Final', SEMI_FINALS:'Semi-Final', FINAL:'Final' }[stage];
      if (stage === 'FINAL') {
        roundMap[winner] = { ...roundMap[winner], isChampion: true,  status: 'Champion'  };
        roundMap[loser]  = { ...roundMap[loser],  isRunnerUp: true,  status: 'Runner-Up', eliminatedRound: 'Final' };
      } else {
        roundMap[loser]  = { ...roundMap[loser],  status: 'Eliminated', eliminatedRound: label };
      }
    }
  }

  // ── MERGE INTO TEAMS ───────────────────────────────────────────────────────
  const updatedTeams = cached.teams.map(team => {
    const prog     = roundMap[team.name] || {};
    const conceded = goalsConcededMap[team.name];
    return {
      ...team,
      groupGoalsConceded: conceded     !== undefined ? conceded            : team.groupGoalsConceded,
      reachedR16:         prog.reachedR16 !== undefined ? prog.reachedR16  : team.reachedR16,
      eliminatedRound:    prog.eliminatedRound ?? team.eliminatedRound,
      isChampion:         prog.isChampion  ?? team.isChampion,
      isRunnerUp:         prog.isRunnerUp  ?? team.isRunnerUp,
      status:             prog.status      ?? team.status,
    };
  });

  // ── MERGE INTO GROUPS ──────────────────────────────────────────────────────
  const updatedGroups = (cached.groups || []).map(group => {
    // API uses keys like "GROUP_A" — match against our "Group A"
    const letter  = group.name.replace('Group ', '').trim().toUpperCase();
    const apiKey  = Object.keys(groupStandingsMap).find(k =>
      k.replace(/[^A-Z]/gi, '').toUpperCase() === letter
    );
    if (!apiKey) return group;

    const apiRows     = groupStandingsMap[apiKey];
    const updatedTeams = group.teams.map(t => {
      const row = apiRows.find(r => r.name === t.name);
      return row ? { ...t, ...row } : t;
    });
    updatedTeams.sort((a, b) => b.points - a.points || b.won - a.won);
    return { ...group, teams: updatedTeams };
  });

  // ── WRITE ──────────────────────────────────────────────────────────────────
  const output = {
    ...cached,
    _meta:  { ...cached._meta, lastUpdated: new Date().toISOString(), updateStatus: 'ok', cacheAgeMinutes: 0 },
    teams:  updatedTeams,
    prizes: cached.prizes,   // manual overrides preserved as-is
    groups: updatedGroups,
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));
  console.log(`✓ Updated at ${output._meta.lastUpdated}`);
}

main().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
