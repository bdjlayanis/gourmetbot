// =============================================================
// cwl_api.js — CWL orchestration (multiple API calls)
// =============================================================
//
// CWL (Clan War League) data is spread across many endpoints:
// one call for the league group, then one call per war per round.
// This module combines those calls into higher-level operations:
//
//   getCwlWarsByState()      — Our latest prep / battle-day / ended CWL wars
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
 * Find our latest CWL war in each state.
 *
 * CWL rounds overlap: while round N is on battle day, round N+1 is
 * already in preparation and round N-1 has just ended. The scheduler
 * needs all three to announce prep / battle day / result for every round.
 *
 * roundIndex is 1-based (Round 1, Round 2, ...) for display purposes.
 *
 * @param {string} clanTag  Our clan tag
 * @returns {{ preparation, inWar, warEnded }}  each { war, roundIndex } or null
 */
async function getCwlWarsByState(clanTag) {
  const leagueGroup = await getCwlLeagueGroup(clanTag);
  const rounds = leagueGroup.rounds || [];
  const found = { preparation: null, inWar: null, warEnded: null };

  // Newest round first; once we hit an ended round, every older one is ended too
  for (let i = rounds.length - 1; i >= 0 && !found.warEnded; i--) {
    const war = await findOurCwlWar(rounds[i].warTags || [], clanTag);
    if (war && war.state in found && !found[war.state]) {
      found[war.state] = { war, roundIndex: i + 1 };
    }
  }

  return found;
}

/**
 * Get the current CWL war for our clan: the active battle day if any,
 * else the upcoming prep round, else the most recently ended round.
 *
 * @param {string} clanTag  Our clan tag
 * @returns {{ war: object, roundIndex: number }|null}
 */
async function getCurrentCwlWar(clanTag) {
  const { inWar, preparation, warEnded } = await getCwlWarsByState(clanTag);
  return inWar ?? preparation ?? warEnded;
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
  getCwlWarsByState,
  getCurrentCwlWar,
  getAllCwlWarsForClan,
  getAllCwlRoundWars,
};
