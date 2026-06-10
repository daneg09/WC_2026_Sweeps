/**
 * scripts/fetch-tournament-data.js
 *
 * Run by GitHub Actions on a schedule. Fetches World Cup data from
 * football-data.org, normalises it into the app's data model, merges
 * any manual overrides, and writes the result to data/tournament.json.
 *
 * This version safely dynamically tracks progress of team eliminations
 * without retaining static mock values from the kickoff seed state.
 */

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '../data/tournament.json');

const API_KEY  = process.env.FOOTBALL_DATA_API_KEY;
const BASE_URL = 'https://api.football-data.org/v4';

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

async function apiFetch(endpoint) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { 'X-Auth-Token': API_KEY },
  });
  if (!res.ok) throw new Error(`API error ${res.status} for ${endpoint}`);
  return res.json();
}

async function main() {
  const cached = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

  console.log('Fetching standings…');
  const standings = await apiFetch('/competitions/WC/standings?season=2026');

  console.log('Fetching matches…');
  const matches = await apiFetch('/competitions/WC/matches?season=2026');

  // Build goals conceded map from actual tournament groups
  const goalsConcededMap = {};
  for (const group of standings.standings ?? []) {
    for (const entry of group.table ?? []) {
      const name = resolveAlias(entry.team.name);
      goalsConcededMap[name] = entry.goalsAgainst;
    }
  }

  // Collect stages and map progress dynamically
  const roundMap = {}; 
  const qualifiedR32 = new Set();
  const qualifiedR16 = new Set();
  let r32Started = false;
  let r16Started = false;

  for (const match of matches.matches ?? []) {
    const home = resolveAlias(match.homeTeam?.name);
    const away = resolveAlias(match.awayTeam?.name);
    if (!home || !away) continue;

    if (match.stage === 'ROUND_OF_32') {
      r32Started = true;
      qualifiedR32.add(home);
      qualifiedR32.add(away);
    }
    if (match.stage === 'LAST_16') {
      r16Started = true;
      qualifiedR16.add(home);
      qualifiedR16.add(away);
    }

    // Capture explicit results
    if (match.status === 'FINISHED') {
      const stage = match.stage;
      const hs = match.score.fullTime.home + (match.score.extraTime?.home ?? 0);
      const as = match.score.fullTime.away + (match.score.extraTime?.away ?? 0);
      let winner, loser;

      if (hs > as) { winner = home; loser = away; }
      else if (as > hs) { winner = away; loser = home; }
      else {
        const hp = match.score.penalties?.home ?? 0;
        const ap = match.score.penalties?.away ?? 0;
        winner = hp > ap ? home : away;
        loser  = hp > ap ? away : home;
      }

      const roundLabel = {
        ROUND_OF_32:    'Round of 32',
        LAST_16:        'Round of 16',
        QUARTER_FINALS: 'Quarter-Final',
        SEMI_FINALS:    'Semi-Final',
        FINAL:          'Final',
      }[stage];

      if (stage === 'FINAL') {
        roundMap[winner] = { ...roundMap[winner], isChampion: true, status: 'Champion' };
        roundMap[loser]  = { ...roundMap[loser],  isRunnerUp: true, status: 'Runner-Up', eliminatedRound: 'Final' };
      } else if (roundLabel) {
        roundMap[loser]  = { ...roundMap[loser],  status: 'Eliminated', eliminatedRound: roundLabel };
      }
    }
  }

  // Update teams using the dynamic data
  const updatedTeams = cached.teams.map(team => {
    const prog = roundMap[team.name] || {};
    const conceded = goalsConcededMap[team.name] ?? 0;

    let reachedR16 = prog.reachedR16 || qualifiedR16.has(team.name);
    let isChampion = prog.isChampion || false;
    let isRunnerUp = prog.isRunnerUp || false;
    let status = prog.status || 'Alive';
    let eliminatedRound = prog.eliminatedRound || null;

    // Evaluate Group Stage vs Round of 32 eliminations
    if (!status || status === 'Alive') {
      if (r16Started && !qualifiedR16.has(team.name)) {
        status = 'Eliminated';
        eliminatedRound = qualifiedR32.has(team.name) ? 'Round of 32' : 'Group Stage';
      } else if (r32Started && !qualifiedR32.has(team.name)) {
        status = 'Eliminated';
        eliminatedRound = 'Group Stage';
      }
    }

    return {
      ...team,
      groupGoalsConceded: conceded,
      reachedR16,
      eliminatedRound,
      isChampion,
      isRunnerUp,
      status,
    };
  });

  const output = {
    ...cached,
    _meta: {
      ...cached._meta,
      lastUpdated:       new Date().toISOString(),
      updateStatus:      'ok',
      cacheAgeMinutes:   0,
    },
    teams:  updatedTeams,
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));
  console.log(`✓ data/tournament.json updated cleanly.`);
}

main().catch(err => {
  console.error('Fetch script failed:', err.message);
  process.exit(1);
});
