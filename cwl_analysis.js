// =============================================================
// cwl_analysis.js — Pure CWL analysis functions (no I/O)
// =============================================================
//
// Similar to war_analysis.js but for Clan War League (CWL).
// Key difference: in CWL each player gets only 1 attack (not 2),
// so the grouping and reminder logic is simpler.
//
// Also includes cross-round aggregation for standings and
// per-player performance stats.
// =============================================================

/**
 * Group CWL war members by attack count.
 * Only two buckets: 0 (hasn't attacked) or 1 (has attacked).
 * In CWL, each player gets exactly 1 attack per round.
 */
function groupCwlMembersByAttacks(warData) {
  if (warData.state === "notInWar") return null;

  const members = warData.clan.members || [];
  const groups = { 0: [], 1: [] };

  for (const member of members) {
    const attackCount = member.attacks ? member.attacks.length : 0;
    groups[attackCount].push({
      name: member.name,
      tag: member.tag,
      attacks: attackCount,
    });
  }

  return groups;
}

/**
 * In CWL, the reminder rule is simple: anyone with 0 attacks needs a ping.
 * No 3-star logic needed since there's only 1 attack per player.
 */
function getCwlPlayersToRemind(groups) {
  return groups[0].map((p) => ({ ...p, reason: "no attack used" }));
}

/**
 * Compute CWL group standings for all 8 clans across all rounds.
 *
 * Iterates every completed war, tallying stars, destruction, and
 * win/loss/tie records for both sides. Winners are determined by
 * stars first, then destruction as tiebreaker (matching in-game rules).
 *
 * @param {Array} allWars       All resolved CWL war objects across all rounds
 * @param {Array} leagueClans   The clans array from the league group response
 * @returns {Array}             Sorted standings: [{ tag, name, stars, destruction, wins, losses, ties }]
 */
function computeCwlStandings(allWars, leagueClans) {
  // Initialize a stats entry for each clan in the group
  const stats = {};

  for (const clan of leagueClans) {
    stats[clan.tag] = {
      tag: clan.tag,
      name: clan.name,
      stars: 0,
      destruction: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      roundsPlayed: 0,
    };
  }

  for (const war of allWars) {
    if (war.state === "preparation" || war.state === "notInWar") continue;

    const clanTag = war.clan.tag;
    const oppTag = war.opponent.tag;

    if (!stats[clanTag] || !stats[oppTag]) continue;

    stats[clanTag].stars += war.clan.stars;
    stats[clanTag].destruction += war.clan.destructionPercentage;
    stats[clanTag].roundsPlayed++;

    stats[oppTag].stars += war.opponent.stars;
    stats[oppTag].destruction += war.opponent.destructionPercentage;
    stats[oppTag].roundsPlayed++;

    if (war.clan.stars > war.opponent.stars) {
      stats[clanTag].wins++;
      stats[oppTag].losses++;
    } else if (war.clan.stars < war.opponent.stars) {
      stats[clanTag].losses++;
      stats[oppTag].wins++;
    } else if (war.clan.destructionPercentage > war.opponent.destructionPercentage) {
      stats[clanTag].wins++;
      stats[oppTag].losses++;
    } else if (war.clan.destructionPercentage < war.opponent.destructionPercentage) {
      stats[clanTag].losses++;
      stats[oppTag].wins++;
    } else {
      stats[clanTag].ties++;
      stats[oppTag].ties++;
    }
  }

  const standings = Object.values(stats);

  standings.sort((a, b) => {
    if (b.stars !== a.stars) return b.stars - a.stars;
    return b.destruction - a.destruction;
  });

  return standings;
}

/**
 * Compute per-player CWL stats aggregated across all rounds.
 *
 * Tracks stars, destruction, attacks used, and missed attacks for
 * each player. A "missed attack" means the player was rostered for
 * a round but didn't use their attack (only counted for active/ended rounds).
 *
 * Sorted by: most stars > highest destruction > fewest missed attacks.
 *
 * @param {Array} wars  CWL war objects (normalized so our clan is always .clan)
 * @returns {Array}     Sorted player stats array
 */
function computeCwlPlayerStats(wars) {
  const players = {};

  for (const war of wars) {
    // Skip prep-phase rounds — no attacks to count yet
    if (war.state === "preparation" || war.state === "notInWar") continue;

    const members = war.clan.members || [];
    for (const member of members) {
      if (!players[member.tag]) {
        players[member.tag] = {
          name: member.name,
          tag: member.tag,
          stars: 0,
          totalDestruction: 0,
          attacks: 0,
          missedAttacks: 0,
          rounds: 0,
        };
      }

      const p = players[member.tag];
      p.rounds++;

      if (member.attacks && member.attacks.length > 0) {
        for (const atk of member.attacks) {
          p.stars += atk.stars;
          p.totalDestruction += atk.destructionPercentage ?? 0;
          p.attacks++;
        }
      } else if (war.state === "warEnded" || war.state === "inWar") {
        p.missedAttacks++;
      }
    }
  }

  const result = Object.values(players);

  result.sort((a, b) => {
    if (b.stars !== a.stars) return b.stars - a.stars;
    if (b.totalDestruction !== a.totalDestruction) return b.totalDestruction - a.totalDestruction;
    return a.missedAttacks - b.missedAttacks;
  });

  return result;
}

module.exports = {
  groupCwlMembersByAttacks,
  getCwlPlayersToRemind,
  computeCwlStandings,
  computeCwlPlayerStats,
};
