/**
 * scripts/fetch-tournament-data.js
 *
 * Run by GitHub Actions on a schedule. Fetches World Cup data from
 * football-data.org, normalises it into the app's data model, merges
 * any manual overrides, and writes the result to data/tournament.json.
 *
 * NEVER called from the browser. The API key is only available inside
 * the GitHub Actions environment via a repository secret.
 *
 * football-data.org free tier endpoints used:
 *   GET /v4/competitions/WC/standings   → group tables (goals conceded)
 *   GET /v4/competitions/WC/matches     → match results (status, scores)
 *   GET /v4/competitions/WC/teams       → team metadata (FIFA ranking)
 */

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '../data/tournament.json');

const API_KEY  = process.env.FOOTBALL_DATA_API_KEY;
const BASE_URL = 'https://api.football-data.org/v4';

// ─── ALIAS MAP ────────────────────────────────────────────────────────────────
// Maps source names from the API to the display names used in the app.
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

function resolveAlias(name) {
  return ALIAS_MAP[name] || name;
}

// ─── API HELPERS ──────────────────────────────────────────────────────────────
async function apiFetch(endpoint) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { 'X-Auth-Token': API_KEY },
  });
  if (!res.ok) throw new Error(`API error ${res.status} for ${endpoint}`);
  return res.json();
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  // Load current cached file so we can merge manual overrides and keep
  // anything the API can't provide (e.g. goal_of_tournament winner).
  const cached = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

  console.log('Fetching standings…');
  const standings = await apiFetch('/competitions/WC/standings?season=2026');

  console.log('Fetching matches…');
  const matches = await apiFetch('/competitions/WC/matches?season=2026');

  // ── BUILD GOALS CONCEDED MAP FROM GROUP STANDINGS ────────────────────────
  const goalsConcededMap = {}; // displayName → goalsAgainst
  for (const group of standings.standings ?? []) {
    for (const entry of group.table ?? []) {
      const name = resolveAlias(entry.team.name);
      goalsConcededMap[name] = entry.goalsAgainst;
    }
  }

  // ── DERIVE TOURNAMENT ROUND PROGRESS FROM MATCH DATA ─────────────────────
  // Track which teams have played (and won/lost) in each knockout round.
  const roundMap = {}; // displayName → { reachedR16, eliminatedRound, isChampion, isRunnerUp, status }

  for (const match of matches.matches ?? []) {
    if (match.status !== 'FINISHED') continue;

    const home = resolveAlias(match.homeTeam.name);
    const away = resolveAlias(match.awayTeam.name);
    const stage = match.stage; // GROUP_STAGE, LAST_16, QUARTER_FINALS, SEMI_FINALS, FINAL

    if (stage === 'LAST_16') {
      roundMap[home] = roundMap[home] || {};
      roundMap[away] = roundMap[away] || {};
      roundMap[home].reachedR16 = true;
      roundMap[away].reachedR16 = true;
    }

    // Determine winner/loser for knockout rounds
    if (['LAST_16', 'QUARTER_FINALS', 'SEMI_FINALS', 'FINAL'].includes(stage)) {
      const hs = match.score.fullTime.home + (match.score.extraTime?.home ?? 0);
      const as = match.score.fullTime.away + (match.score.extraTime?.away ?? 0);
      let winner, loser;

      if (hs > as) { winner = home; loser = away; }
      else if (as > hs) { winner = away; loser = home; }
      else {
        // Penalty shootout
        const hp = match.score.penalties?.home ?? 0;
        const ap = match.score.penalties?.away ?? 0;
        winner = hp > ap ? home : away;
        loser  = hp > ap ? away : home;
      }

      const roundLabel = {
        LAST_16:        'Round of 16',
        QUARTER_FINALS: 'Quarter-Final',
        SEMI_FINALS:    'Semi-Final',
        FINAL:          'Final',
      }[stage];

      if (stage === 'FINAL') {
        roundMap[winner] = { ...roundMap[winner], isChampion: true, status: 'Champion' };
        roundMap[loser]  = { ...roundMap[loser],  isRunnerUp: true, status: 'Runner-Up', eliminatedRound: 'Final' };
      } else {
        roundMap[loser] = { ...roundMap[loser], status: 'Eliminated', eliminatedRound: roundLabel };
      }
    }
  }

  // ── MERGE API DATA INTO CACHED TEAM OBJECTS ───────────────────────────────
  const updatedTeams = cached.teams.map(team => {
    const prog = roundMap[team.name] || {};
    const conceded = goalsConcededMap[team.name];

    return {
      ...team,
      groupGoalsConceded: conceded ?? team.groupGoalsConceded,
      reachedR16:         prog.reachedR16      ?? team.reachedR16,
      eliminatedRound:    prog.eliminatedRound ?? team.eliminatedRound,
      isChampion:         prog.isChampion      ?? team.isChampion,
      isRunnerUp:         prog.isRunnerUp      ?? team.isRunnerUp,
      status:             prog.status          ?? team.status,
    };
  });

  // ── MERGE MANUAL OVERRIDES ────────────────────────────────────────────────
  // Manual prize overrides survive API updates unchanged unless the API can
  // resolve them automatically. The front-end admin panel writes these back.
  const updatedPrizes = cached.prizes.map(prize => {
    return { ...prize }; // preserve existing manualOverride values
  });

  // ── WRITE OUTPUT ──────────────────────────────────────────────────────────
  const output = {
    ...cached,
    _meta: {
      ...cached._meta,
      lastUpdated:       new Date().toISOString(),
      updateStatus:      'ok',
      cacheAgeMinutes:   0,
    },
    teams:  updatedTeams,
    prizes: updatedPrizes,
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));
  console.log(`✓ data/tournament.json updated at ${output._meta.lastUpdated}`);
}

main().catch(err => {
  console.error('Fetch script failed:', err.message);
  // Exit with non-zero so GitHub Actions marks the run as failed,
  // but the old cached JSON is left untouched.
  process.exit(1);
});
