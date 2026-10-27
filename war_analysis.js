// =============================================================
// war_analysis.js — Pure war analysis functions (no I/O, no API calls)
// =============================================================
//
// All the "brain" of the bot for regular clan wars lives here:
// - Calculating time remaining
// - Building a scoreboard summary
// - Deciding if a war's outcome is already locked in
// - Grouping members by how many attacks they've used
// - Deciding who still needs to be reminded
// - Missed-attack history and Clan Capital raid reminders
//
// These are pure functions (no side effects) so they're easy to
// test and reuse across the CLI tool and the Discord bot.
// =============================================================

/**
 * Calculate hours + minutes remaining until a war ends.
 * Returns null if the war has already ended (i.e. endDate is in the past).
 */
function getTimeRemaining(endDate) {
  const now = new Date();
  const totalMs = endDate.getTime() - now.getTime();
  if (totalMs <= 0) return null;

  const totalMinutes = Math.floor(totalMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return { hours, minutes, totalMs };
}

/**
 * Extract a simplified scoreboard from the raw war data.
 * maxStars = teamSize * 3 (every base can be 3-starred).
 */
function getWarScoreboard(warData) {
  const clan = warData.clan;
  const opponent = warData.opponent;
  const maxStars = warData.teamSize * 3;

  return {
    clan: {
      name: clan.name,
      stars: clan.stars,
      maxStars,
      destruction: clan.destructionPercentage,
    },
    opponent: {
      name: opponent.name,
      stars: opponent.stars,
      maxStars,
      destruction: opponent.destructionPercentage,
    },
  };
}

/**
 * Count total attacks used by one side (clan or opponent).
 * We sum member.attacks.length manually instead of trusting the
 * top-level warData.clan.attacks field, which can be inaccurate
 * for ended wars.
 */
function countAttacksUsed(sideData) {
  return (sideData.members || [])
    .reduce((sum, m) => sum + (m.attacks ? m.attacks.length : 0), 0);
}

/**
 * Determine if a war's outcome is already mathematically locked in.
 *
 * A war is "decided" when no sequence of remaining attacks can
 * change which side wins. We check:
 *   1. Clan already 3-starred every base (perfect war)
 *   2. Star gap is too large for the losing side to catch up
 *   3. Both sides have used all their attacks
 *
 * This prevents the bot from spamming "go attack!" when the
 * result is already settled.
 */
function isWarDecided(scoreboard, warData) {
  const { clan, opponent } = scoreboard;

  if (!warData) {
    // Fallback: no warData available, use simple check
    return (
      clan.stars >= clan.maxStars ||
      opponent.stars >= opponent.maxStars ||
      clan.destruction >= 100 ||
      opponent.destruction >= 100
    );
  }

  // Clan already 3-starred every base — nothing more to gain
  if (clan.stars >= clan.maxStars) return true;

  // Calculate how many attacks each side still has
  // (attacksPerMember is 2 in regular wars, 1 in CWL)
  const maxAttacks = warData.teamSize * (warData.attacksPerMember ?? 2);
  const clanAttacksUsed = countAttacksUsed(warData.clan);
  const opponentAttacksUsed = countAttacksUsed(warData.opponent);
  const clanRemaining = maxAttacks - clanAttacksUsed;
  const opponentRemaining = maxAttacks - opponentAttacksUsed;

  // Best-case additional stars each side could earn
  // (capped by remaining attacks * 3 stars each, and by unstarred bases)
  const clanMaxAdditional = Math.min(clanRemaining * 3, clan.maxStars - clan.stars);
  const opponentMaxAdditional = Math.min(opponentRemaining * 3, opponent.maxStars - opponent.stars);

  // Clan winning by too much — opponent can't catch up even with perfect attacks
  if (clan.stars > opponent.stars + opponentMaxAdditional) return true;
  // Opponent winning by too much — clan can't catch up
  if (opponent.stars > clan.stars + clanMaxAdditional) return true;

  // Both sides exhausted all attacks — final result is locked in
  if (clanRemaining === 0 && opponentRemaining === 0) return true;

  return false;
}

/**
 * "Victory" / "Defeat" / "Tie" from our side's point of view.
 * Stars first, destruction as tiebreaker (in-game rules).
 */
function getWarResult(scoreboard) {
  const { clan, opponent } = scoreboard;
  if (clan.stars !== opponent.stars) return clan.stars > opponent.stars ? "Victory" : "Defeat";
  if (clan.destruction !== opponent.destruction) return clan.destruction > opponent.destruction ? "Victory" : "Defeat";
  return "Tie";
}

/** Check if a member landed at least one 3-star attack. */
function hasThreeStarAttack(member) {
  if (!member.attacks) return false;
  return member.attacks.some((atk) => atk.stars === 3);
}

/**
 * Sort clan members into buckets by attack count: 0, 1, or 2 attacks used.
 * Each bucket entry includes the player's name, tag, attack count, and
 * whether they have a 3-star (used later for reminder logic).
 * Returns null if the clan is not in a war.
 */
function groupMembersByAttacks(warData) {
  if (warData.state === "notInWar") {
    return null;
  }

  const members = warData.clan.members || [];
  const groups = { 0: [], 1: [], 2: [] };

  for (const member of members) {
    const attackCount = member.attacks ? member.attacks.length : 0;

    groups[attackCount].push({
      name: member.name,
      tag: member.tag,
      attacks: attackCount,
      hasThreeStar: hasThreeStarAttack(member),
    });
  }

  return groups;
}

/**
 * Decide which players still need a reminder.
 *
 * Reminder rules:
 *   - 0 attacks used  => always remind
 *   - 1 attack used, no 3-star => remind (they can still improve)
 *   - 1 attack used, has 3-star => skip (great hit, save 2nd for cleanup)
 *   - 2 attacks used => skip (nothing left to do)
 */
function getPlayersToRemind(groups) {
  const toRemind = [];

  // Everyone with 0 attacks needs a reminder
  for (const p of groups[0]) {
    toRemind.push({ ...p, reason: "0 attacks used" });
  }

  // Players with 1 attack but no 3-star still have work to do
  for (const p of groups[1]) {
    if (!p.hasThreeStar) {
      toRemind.push({ ...p, reason: "1 attack used, no 3-star" });
    }
  }

  return toRemind;
}

/**
 * Missed attacks per member of our side, once the war is over.
 * Everyone is listed (missed may be 0) so the history also knows who played.
 */
function getMissedAttacks(warData) {
  const perMember = warData.attacksPerMember ?? 2;
  return (warData.clan.members || []).map((m) => ({
    tag: m.tag,
    name: m.name,
    missed: perMember - (m.attacks?.length ?? 0),
  }));
}

/**
 * Aggregate recorded wars (see persistence.appendWarHistory) into
 * per-player totals. Only players who missed at least once, worst first.
 */
function computeMissedAttacks(wars) {
  const players = {};
  for (const war of wars) {
    for (const m of war.members) {
      const p = (players[m.tag] ??= { name: m.name, missed: 0, wars: 0 });
      p.name = m.name;  // keep the latest name
      p.missed += m.missed;
      p.wars++;
    }
  }
  return Object.values(players)
    .filter((p) => p.missed > 0)
    .sort((a, b) => b.missed - a.missed || a.wars - b.wars);
}

// ---- Clan Capital raids -------------------------------------

/**
 * Players who started raiding this weekend but still have attacks left.
 * Members who never raid aren't nagged — raid.members (from the API)
 * only lists players who attacked at least once anyway.
 *
 * @param {object} raid  Raid season from getCapitalRaidSeason()
 */
function getRaidPlayersToRemind(raid) {
  return (raid.members || [])
    .map((m) => ({ name: m.name, tag: m.tag, attacks: m.attacks, limit: m.attackLimit + m.bonusAttackLimit }))
    .filter((p) => p.attacks < p.limit);
}

module.exports = {
  getTimeRemaining,
  getWarScoreboard,
  countAttacksUsed,
  isWarDecided,
  getWarResult,
  groupMembersByAttacks,
  getPlayersToRemind,
  getMissedAttacks,
  computeMissedAttacks,
  getRaidPlayersToRemind,
};
