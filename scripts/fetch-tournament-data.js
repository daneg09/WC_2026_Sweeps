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
 * SAFE MERGE POLICY:
 *   - If the API returns no matches (tournament not started), the cached
 *     team data is preserved exactly as-is. Nothing gets wiped.
 *   - API data only UPDATES values — it never resets them to zero/null.
 *   - If the API call itself fails, the script exits with an error and
 *     the cached file is left completely untouched.
 *
 * football-data.org free tier endpoints used:
 *   GET /v4/competitions/WC/standings   → group tables (goals conceded)
 *   GET /v4/competitions/WC/matches     → match results (status, scores)
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
  // Always load the existing cached file first.
  // If the API has nothing useful, we keep this data intact.
  const cached = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

  console.log('Fetching matches from football-data.org…');
  const matchData = await apiFetch('/competitions/WC/matches?season=2026');

  const finishedMatches = (matchData.matches ?? []).filter(m => m.status === 'FINISHED');
  console.log(`Found ${finishedMatches.length} finished matches.`);

  // ── GUARD: No matches played yet ─────────────────────────────────────────
  // If the tournament hasn't started (zero finished matches), just update the
  // timestamp and exit. Don't touch any team data.
  if (finishedMatches.length === 0) {
    console.log('No finished matches yet — tournament has not started. Preserving cached team data.');
    const output = {
      ...cached,
      _meta: {
        ...cached._meta,
        lastUpdated:     new Date().toISOString(),
        updateStatus:    'ok',
        cacheAgeMinutes: 0,
        note:            'No matches played yet. Team data preserved from seed.',
      },
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));
    console.log('✓ Timestamp updated. Seed data preserved.');
    return;
  }

  // ── FETCH STANDINGS (only useful once group games have been played) ────────
  console.log('Fetching standings…');
  const standingsData = await apiFetch('/competitions/WC/standings?season=2026');

  // Build goals-conceded map from group stage standings
  const goalsConcededMap = {};
  for (const group of standingsData.standings ?? []) {
    for (const entry of group.table ?? []) {
      const name = resolveAlias(entry.team.name);
      // Only update if the API value is greater than zero (real data)
      if (entry.goalsAgainst > 0) {
        goalsConcededMap[name] = entry.goalsAgainst;
      }
    }
  }

  // ── BUILD ROUND PROGRESS FROM FINISHED MATCHES ────────────────────────────
  const roundMap = {};

  for (const match of finishedMatches) {
    const home  = resolveAlias(match.homeTeam.name);
    const away  = resolveAlias(match.awayTeam.name);
    const stage = match.stage;

    // Mark both teams as having reached R16 once a R16 match is played
    if (stage === 'LAST_16') {
      roundMap[home] = roundMap[home] || {};
      roundMap[away] = roundMap[away] || {};
      roundMap[home].reachedR16 = true;
      roundMap[away].reachedR16 = true;
    }

    // Determine knockout winner/loser
    if (['LAST_16', 'QUARTER_FINALS', 'SEMI_FINALS', 'FINAL'].includes(stage)) {
      const hs = (match.score.fullTime.home ?? 0) + (match.score.extraTime?.home ?? 0);
      const as = (match.score.fullTime.away ?? 0) + (match.score.extraTime?.away ?? 0);
      let winner, loser;

      if (hs > as)      { winner = home; loser = away; }
      else if (as > hs) { winner = away; loser = home; }
      else {
        // Penalties
        const hp = match.score.penalties?.home ?? 0;
        const ap = match.score.penalties?.away ?? 0;
        winner = hp >= ap ? home : away;
        loser  = hp >= ap ? away : home;
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

    // Mark group stage eliminations (teams with 0 points after 3 games — 
    // handled below via standings, not match-by-match)
  }

  // ── MERGE API DATA INTO CACHED TEAMS ─────────────────────────────────────
  // IMPORTANT: We only update a field if the API gives us a real value.
  // We never reset a field to null/false/0 just because the API is silent on it.
  const updatedTeams = cached.teams.map(team => {
    const prog     = roundMap[team.name] || {};
    const conceded = goalsConcededMap[team.name];

    return {
      ...team,
      // Only update goals conceded if the API returned a real number
      groupGoalsConceded: conceded !== undefined ? conceded : team.groupGoalsConceded,
      // Only update round progress if the API has new info
      reachedR16:      prog.reachedR16      !== undefined ? prog.reachedR16      : team.reachedR16,
      eliminatedRound: prog.eliminatedRound !== undefined ? prog.eliminatedRound : team.eliminatedRound,
      isChampion:      prog.isChampion      !== undefined ? prog.isChampion      : team.isChampion,
      isRunnerUp:      prog.isRunnerUp      !== undefined ? prog.isRunnerUp      : team.isRunnerUp,
      status:          prog.status          !== undefined ? prog.status          : team.status,
    };
  });

  // Preserve manual prize overrides exactly as they are
  const updatedPrizes = cached.prizes.map(prize => ({ ...prize }));

  // ── WRITE OUTPUT ──────────────────────────────────────────────────────────
  const output = {
    ...cached,
    _meta: {
      ...cached._meta,
      lastUpdated:     new Date().toISOString(),
      updateStatus:    'ok',
      cacheAgeMinutes: 0,
    },
    teams:  updatedTeams,
    prizes: updatedPrizes,
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));
  console.log(`✓ data/tournament.json updated at ${output._meta.lastUpdated}`);
  console.log(`  Goals conceded updated for: ${Object.keys(goalsConcededMap).join(', ') || 'none yet'}`);
  console.log(`  Round progress updated for: ${Object.keys(roundMap).join(', ') || 'none yet'}`);
}

main().catch(err => {
  console.error('Fetch script failed:', err.message);
  // Exit non-zero so GitHub Actions marks the run as failed.
  // The cached JSON file is NOT modified on failure.
  process.exit(1);
});
