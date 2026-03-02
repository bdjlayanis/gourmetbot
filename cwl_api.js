// =============================================================
// cwl_api.js — CWL orchestration (multiple API calls)
// =============================================================
//
// CWL (Clan War League) data is spread across many endpoints:
// one call for the league group, then one call per war per round.
// This module combines those calls into higher-level operations:
//
//   getCurrentCwlWar()       — Find the active/latest CWL war for our clan
//   getAllCwlWarsForClan()   — Get all our CWL wars (for /cwl-stats)
//   getAllCwlRoundWars()     — Get every war across all clans (for /cwl-standings)
//
// "Normalizing" a war means ensuring our clan is always in the
// .clan field (the API can put us in .opponent if we're the away team).
// =============================================================

const { getCwlLeagueGroup, getCwlWar } = require("./coc_api");

/**
 * Scan a round's war tags and find/normalize the war our clan is in.
 * Swaps clan/opponent if our clan appears as the opponent.
 * Skips war tags that are "#0" (round not yet scheduled).
 *
 * @param {string[]} warTags  Array of war tags for a single round
 * @param {string}   clanTag  Our clan tag
 * @returns {object|null}     Normalized war data, or null if not found
 */
async function findOurCwlWar(warTags, clanTag) {
  const normalizedClanTag = clanTag.toUpperCase();

  for (const warTag of warTags) {
    if (warTag === "#0") continue;

    let war;
    try {
      war = await getCwlWar(warTag);
    } catch {
      continue;
    }

    if (war.clan.tag.toUpperCase() === normalizedClanTag) {
      return war;
    }

    if (war.opponent.tag.toUpperCase() === normalizedClanTag) {
      return {
        ...war,
        clan: war.opponent,
        opponent: war.clan,
      };
    }
  }

  return null;
}

/**
 * Get the current (active or most recent) CWL war for our clan.
 *
 * Iterates rounds backwards (newest first) looking for:
 *   1. An active war (inWar) — return immediately
 *   2. A prep-phase war (preparation) — return immediately
 *   3. The most recently ended war — return as fallback
 *
 * roundIndex is 1-based (Round 1, Round 2, ...) for display purposes.
 *
 * @param {string} clanTag  Our clan tag
 * @returns {{ war: object, roundIndex: number, leagueGroup: object }|null}
 */
async function getCurrentCwlWar(clanTag) {
  const leagueGroup = await getCwlLeagueGroup(clanTag);
  const rounds = leagueGroup.rounds || [];

  let bestWar = null;      // fallback: most recent ended war
  let bestRoundIndex = -1;

  for (let i = rounds.length - 1; i >= 0; i--) {
    const warTags = rounds[i].warTags || [];
    const war = await findOurCwlWar(warTags, clanTag);

    if (!war) continue;

    if (war.state === "inWar") {
      return { war, roundIndex: i + 1, leagueGroup };
    }

    if (war.state === "preparation") {
      return { war, roundIndex: i + 1, leagueGroup };
    }

    if (war.state === "warEnded" && !bestWar) {
      bestWar = war;
      bestRoundIndex = i + 1;
    }
  }

  if (bestWar) {
    return { war: bestWar, roundIndex: bestRoundIndex, leagueGroup };
  }

  return null;
}

/**
 * Get all CWL wars our clan participated in (for /cwl-stats).
 *
 * @param {string} clanTag  Our clan tag
 * @returns {{ wars: object[], leagueGroup: object }}
 */
async function getAllCwlWarsForClan(clanTag) {
  const leagueGroup = await getCwlLeagueGroup(clanTag);
  const rounds = leagueGroup.rounds || [];
  const wars = [];

  for (let i = 0; i < rounds.length; i++) {
    const warTags = rounds[i].warTags || [];
    const war = await findOurCwlWar(warTags, clanTag);
    if (war) wars.push(war);
  }

  return { wars, leagueGroup };
}

/**
 * Get all CWL wars across all rounds for all clans (for /cwl-standings).
 *
 * @param {object} leagueGroup  The league group response
 * @returns {object[]}          All war objects
 */
async function getAllCwlRoundWars(leagueGroup) {
  const rounds = leagueGroup.rounds || [];
  const allWars = [];

  for (const round of rounds) {
    const warTags = round.warTags || [];

    for (const warTag of warTags) {
      if (warTag === "#0") continue;

      try {
        const war = await getCwlWar(warTag);
        allWars.push(war);
      } catch {
        // War not available yet — skip
      }
    }
  }

  return allWars;
}

module.exports = {
  findOurCwlWar,
  getCurrentCwlWar,
  getAllCwlWarsForClan,
  getAllCwlRoundWars,
};
