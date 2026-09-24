// =============================================================
// discord_messages.js — All Discord message builder/formatter functions
// =============================================================
//
// Every piece of text the bot sends to Discord is built here.
// Functions take raw data and return a plain string (Discord markdown).
//
// Split into two sections:
//   1. Regular war messages  (buildWarMessage, buildClanStatsMessage, etc.)
//   2. CWL messages          (buildCwlWarMessage, buildCwlStandingsMessage, etc.)
//
// Design rule: formatters are pure — they take a playerDiscordMap as
// a parameter instead of reading a global, making them testable.
// =============================================================

const { parseWarDate } = require("./coc_api");
const {
  getWarScoreboard,
  isWarDecided,
  getTimeRemaining,
  groupMembersByAttacks,
  getPlayersToRemind,
} = require("./war_analysis");
const {
  groupCwlMembersByAttacks,
  getCwlPlayersToRemind,
} = require("./cwl_analysis");

// ---- Formatters ---------------------------------------------

/**
 * Format a single player line for war reminder messages.
 * If the player is linked to a Discord account, shows an @mention.
 * suppressPing is true for manual /war-check (avoids unwanted pings).
 */
function formatPlayerLine(player, playerDiscordMap, { suppressPing = false } = {}) {
  const discordId = playerDiscordMap[player.tag];
  const label = discordId && !suppressPing ? `<@${discordId}>` : `**${player.name}**`;
  const detail =
    player.attacks === 0
      ? "(0 attacks)"
      : "(1 attack, no triple)";
  return `${label} ${detail}`;
}

/**
 * Build a roster listing of every player on our side of the war.
 * Sorted by map position so it reads top-down like the in-game roster.
 * Linked players show as @mentions; unlinked players show their CoC name.
 */
function buildParticipantList(warData, playerDiscordMap) {
  const members = warData.clan.members || [];
  const sorted = [...members].sort((a, b) => a.mapPosition - b.mapPosition);
  const lines = [`**Participants (${members.length}):**`];
  for (const m of sorted) {
    const discordId = playerDiscordMap[m.tag];
    const label = discordId ? `<@${discordId}>` : m.name;
    lines.push(`${m.mapPosition}. ${label}`);
  }
  return lines.join("\n");
}

/**
 * Convert a CoC API date into a Discord dynamic timestamp (<t:unix:F>).
 * Discord renders these in the user's local timezone automatically.
 */
function formatWarDate(apiDate) {
  const d = parseWarDate(apiDate);
  const unix = Math.floor(d.getTime() / 1000);
  return `<t:${unix}:F>`;
}

// ---- Message builders (regular war) -------------------------

/** Build the "started / ends / attacks / remaining" info block. */
function buildExtendedInfo(warData) {
  const members = warData.clan.members || [];

  const totalUsed = members.reduce(
    (sum, m) => sum + (m.attacks ? m.attacks.length : 0),
    0
  );
  const totalAvailable = members.length * 2;
  const remaining = totalAvailable - totalUsed;

  const lines = [
    `📅 **Started:** ${formatWarDate(warData.startTime)}`,
    `🏁 **Ends:** ${formatWarDate(warData.endTime)}`,
    `⚔️ **Attacks:** ${totalUsed} / ${totalAvailable}`,
    `❗ **Remaining:** ${remaining}`,
  ];
  return lines.join("\n");
}

/**
 * Build a per-player breakdown of every attack.
 * Shows who attacked, which base they hit, stars earned, and destruction %.
 * Players are sorted: fewest attacks first (so 0-attack players appear at top).
 */
function buildAttackDetails(warData) {
  const members = warData.clan.members || [];

  // Map opponent tags to their map position so we can show "Base #3"
  // instead of a raw player tag.
  const opponentMembers = warData.opponent.members || [];
  const defenderPositionMap = {};
  for (const om of opponentMembers) {
    defenderPositionMap[om.tag] = om.mapPosition;
  }

  const details = members.map((m) => {
    const attacks = m.attacks || [];
    const totalStars = attacks.reduce((sum, a) => sum + a.stars, 0);

    return {
      name: m.name,
      attackCount: attacks.length,
      totalStars,
      attacks,
    };
  });

  details.sort((a, b) => {
    if (a.attackCount !== b.attackCount) return a.attackCount - b.attackCount;
    return a.totalStars - b.totalStars;
  });

  const lines = ["", "**📊 Attack Details:**"];

  for (const d of details) {
    lines.push(`**${d.name}:**`);

    if (d.attackCount === 0) {
      lines.push("  ➤ No attacks yet");
      continue;
    }

    for (const atk of d.attacks) {
      const pos = defenderPositionMap[atk.defenderTag];
      const target = pos ? `Base #${pos}` : atk.defenderTag;
      const destruction = atk.destructionPercentage ?? 0;
      lines.push(
        `  ➤ vs ${target} — ${atk.stars}⭐ (${destruction.toFixed(0)}%)`
      );
    }
  }

  return lines.join("\n");
}

/**
 * Build the full war status message shown by /war-check and auto-reminders.
 *
 * Handles every war state:
 *   - notInWar    → "No active war right now."
 *   - preparation → participant list + battle day countdown
 *   - inWar       → scoreboard + time remaining + reminder list
 *   - warEnded    → final result + full attack details
 *
 * @param {object}  warData           Raw war data from the CoC API
 * @param {object}  playerDiscordMap  CoC tag → Discord ID for @mentions
 * @param {boolean} isManual          True for /war-check (suppresses pings)
 */
function buildWarMessage(warData, playerDiscordMap, { isManual = false } = {}) {
  if (warData.state === "notInWar") {
    return "No active war right now.";
  }

  if (warData.state === "preparation") {
    const members = warData.clan.members || [];
    const startDate = parseWarDate(warData.startTime);
    const startUnix = Math.floor(startDate.getTime() / 1000);

    const lines = [
      `**⚔️ War — Preparation Day**`,
      `vs **${warData.opponent.name}**  (${warData.teamSize}v${warData.teamSize})`,
      `Battle day starts: <t:${startUnix}:R> (<t:${startUnix}:F>)`,
      "",
      `**Participants (${members.length}):**`,
    ];

    const sorted = [...members].sort((a, b) => a.mapPosition - b.mapPosition);
    for (const m of sorted) {
      lines.push(`${m.mapPosition}. ${m.name}`);
    }

    return lines.join("\n");
  }

  const scoreboard = getWarScoreboard(warData);
  const { clan, opponent } = scoreboard;

  const endDate = parseWarDate(warData.endTime);
  const remaining = getTimeRemaining(endDate);
  const timeStr = remaining
    ? `${remaining.hours}h ${remaining.minutes}m remaining`
    : "War has ended";

  let statusLabel;
  if (warData.state === "warEnded") {
    statusLabel = "Ended";
  } else if (warData.state === "inWar") {
    statusLabel = "In Progress";
  } else {
    statusLabel = warData.state;
  }

  const lines = [
    `**⚔️ War Status:** ${statusLabel}`,
    `**⭐** ${clan.stars} - ${opponent.stars}`,
    `**💥** ${clan.destruction.toFixed(1)}% - ${opponent.destruction.toFixed(1)}%`,
    `**⏱️** ${timeStr}`,
    "",
    buildExtendedInfo(warData),
  ];

  if (warData.state === "warEnded") {
    const clanWon = clan.stars > opponent.stars || (clan.stars === opponent.stars && clan.destruction > opponent.destruction);
    const tied = clan.stars === opponent.stars && clan.destruction === opponent.destruction;
    const resultLabel = tied ? "It's a draw!" : clanWon ? "Victory!" : "Defeat.";
    lines.push("", `**🏁 ${resultLabel}**`);
    lines.push(buildAttackDetails(warData));
    return lines.join("\n");
  }

  if (isWarDecided(scoreboard, warData)) {
    lines.push("", "War is already decided. No reminders needed.");
    lines.push(buildAttackDetails(warData));
    return lines.join("\n");
  }

  if (!isManual && remaining && remaining.hours < 2) {
    lines.push("", "War is almost over. No reminders sent.");
    lines.push(buildAttackDetails(warData));
    return lines.join("\n");
  }

  const groups = groupMembersByAttacks(warData);
  if (!groups) {
    lines.push("", "Could not parse member data.");
    return lines.join("\n");
  }

  const toRemind = getPlayersToRemind(groups);

  if (toRemind.length === 0) {
    lines.push("", "✅ Everyone has attacked well. No reminders needed!");
  } else {
    lines.push("", "**⚠️ Players who still need to attack:**");
    for (const p of toRemind) {
      lines.push(formatPlayerLine(p, playerDiscordMap, { suppressPing: isManual }));
    }
  }

  lines.push(buildAttackDetails(warData));

  return lines.join("\n");
}

/** Build the /clan-stats response: level, war record, league, member count. */
function buildClanStatsMessage(info) {
  const total = info.warWins + info.warLosses + info.warTies;
  const record = `${info.warWins}W / ${info.warLosses}L / ${info.warTies}T`;

  const freq = info.warFrequency
    ? info.warFrequency
        .replace(/([A-Z])/g, " $1")
        .replace(/^./, (s) => s.toUpperCase())
        .trim()
    : "Unknown";

  return [
    `**🏰 ${info.name}** (${info.tag})`,
    `🌟 **Clan Level:** ${info.clanLevel}`,
    `👥 **Members:** ${info.memberCount} / 50`,
    `⚔️ **War Record:** ${record} (${total} wars)`,
    `📅 **War Frequency:** ${freq}`,
    `🏆 **War League:** ${info.warLeague}`,
  ].join("\n");
}

/** Build the /player-stats response: profile info + current war performance. */
function buildPlayerStatsMessage(playerInfo, warData, playerTag) {
  const roleEmoji = { leader: "👑", coLeader: "⚜️", admin: "🔰", member: "👤" };
  const roleIcon = roleEmoji[playerInfo.role] ?? "👤";

  const lines = [
    `**${roleIcon} ${playerInfo.name}** (${playerInfo.tag})`,
    `🏠 **Town Hall:** ${playerInfo.townHallLevel}`,
    `🏆 **Trophies:** ${playerInfo.trophies}`,
    ``,
    `**Lifetime Stats:**`,
    `⭐ **War Stars:** ${playerInfo.warStars}`,
    `⚔️ **Attack Wins:** ${playerInfo.attackWins}`,
    `🛡️ **Defense Wins:** ${playerInfo.defenseWins}`,
    `🎁 **Donations:** ${playerInfo.donations} given / ${playerInfo.donationsReceived} received`,
  ];

  if (!warData || warData.state === "notInWar" || warData.state === "preparation") {
    lines.push(``, `*No active war to show current performance.*`);
  } else {
    const warMember = (warData.clan.members || []).find(
      (m) => m.tag.toUpperCase() === playerTag.toUpperCase()
    );

    lines.push(``, `**Current War:**`);

    if (!warMember) {
      lines.push(`*Not participating in the current war.*`);
    } else {
      const attacks = warMember.attacks || [];
      if (attacks.length === 0) {
        lines.push(`No attacks used yet.`);
      } else {
        for (const atk of attacks) {
          const destruction = atk.destructionPercentage ?? 0;
          lines.push(`  ➤ ${atk.stars}⭐ (${destruction.toFixed(0)}%)`);
        }
      }
    }
  }

  return lines.join("\n");
}

/** Build the /war-log response: recent war results with win/loss icons. */
function buildWarLogMessage(entries) {
  if (!entries || entries.length === 0) {
    return "No war history available.";
  }

  const resultIcon = { win: "✅", lose: "❌", tie: "🤝" };

  const lines = [`**⚔️ Recent War History (${entries.length} wars):**`, ""];

  for (const entry of entries) {
    const icon = resultIcon[entry.result] ?? "❓";
    const result = entry.result
      ? entry.result.charAt(0).toUpperCase() + entry.result.slice(1)
      : "Unknown";

    const ourStars = entry.clan?.stars ?? 0;
    const oppStars = entry.opponent?.stars ?? 0;
    const ourDest  = (entry.clan?.destructionPercentage ?? 0).toFixed(1);
    const oppDest  = (entry.opponent?.destructionPercentage ?? 0).toFixed(1);
    const oppName  = entry.opponent?.name ?? "Unknown";
    const size     = entry.teamSize ?? "?";

    let dateStr = "Unknown date";
    if (entry.endTime) {
      const d = parseWarDate(entry.endTime);
      const unix = Math.floor(d.getTime() / 1000);
      dateStr = `<t:${unix}:d>`;
    }

    lines.push(
      `${icon} **${result}** vs **${oppName}** (${size}v${size}) — ${dateStr}`,
      `  ⭐ ${ourStars} - ${oppStars}  |  💥 ${ourDest}% - ${oppDest}%`
    );
  }

  return lines.join("\n");
}

// ---- CWL message builders -----------------------------------

/** Format a CWL player line — same idea as formatPlayerLine but for 1-attack CWL wars. */
function formatCwlPlayerLine(player, playerDiscordMap, { suppressPing = false } = {}) {
  const discordId = playerDiscordMap[player.tag];
  const label = discordId && !suppressPing ? `<@${discordId}>` : `**${player.name}**`;
  return `${label} (no attack used)`;
}

/** Build the CWL "started / ends / attacks / remaining" info block (1 atk per player). */
function buildCwlExtendedInfo(warData) {
  const members = warData.clan.members || [];

  const totalUsed = members.reduce(
    (sum, m) => sum + (m.attacks ? m.attacks.length : 0),
    0
  );
  const totalAvailable = members.length;
  const remaining = totalAvailable - totalUsed;

  const lines = [
    `📅 **Started:** ${formatWarDate(warData.startTime)}`,
    `🏁 **Ends:** ${formatWarDate(warData.endTime)}`,
    `⚔️ **Attacks:** ${totalUsed} / ${totalAvailable}`,
    `❗ **Remaining:** ${remaining}`,
  ];
  return lines.join("\n");
}

/**
 * Build the full CWL war status message (similar to buildWarMessage but for CWL).
 * Shows round number, uses 1-attack-per-player logic, and labels it as CWL.
 */
function buildCwlWarMessage(warData, roundIndex, playerDiscordMap, { isManual = false } = {}) {
  if (!warData || warData.state === "notInWar") {
    return "No active CWL war right now.";
  }

  if (warData.state === "preparation") {
    const startDate = parseWarDate(warData.startTime);
    const startUnix = Math.floor(startDate.getTime() / 1000);
    return [
      `**🏆 CWL Round ${roundIndex} — Preparation**`,
      `vs **${warData.opponent.name}**  (${warData.teamSize}v${warData.teamSize})`,
      `Battle day starts: <t:${startUnix}:R> (<t:${startUnix}:F>)`,
    ].join("\n");
  }

  const scoreboard = getWarScoreboard(warData);
  const { clan, opponent } = scoreboard;

  const endDate = parseWarDate(warData.endTime);
  const remaining = getTimeRemaining(endDate);
  const timeStr = remaining
    ? `${remaining.hours}h ${remaining.minutes}m remaining`
    : "War has ended";

  let cwlStatusLabel;
  if (warData.state === "warEnded") {
    cwlStatusLabel = "Ended";
  } else if (warData.state === "inWar") {
    cwlStatusLabel = "In Progress";
  } else {
    cwlStatusLabel = warData.state;
  }

  const lines = [
    `**🏆 CWL Round ${roundIndex}**`,
    `**⚔️ War Status:** ${cwlStatusLabel}`,
    `**⭐** ${clan.stars} - ${opponent.stars}`,
    `**💥** ${clan.destruction.toFixed(1)}% - ${opponent.destruction.toFixed(1)}%`,
    `**⏱️** ${timeStr}`,
    "",
    buildCwlExtendedInfo(warData),
  ];

  if (warData.state === "warEnded") {
    const clanWon = clan.stars > opponent.stars || (clan.stars === opponent.stars && clan.destruction > opponent.destruction);
    const tied = clan.stars === opponent.stars && clan.destruction === opponent.destruction;
    const resultLabel = tied ? "It's a draw!" : clanWon ? "Victory!" : "Defeat.";
    lines.push("", `**🏁 ${resultLabel}**`);
    lines.push(buildAttackDetails(warData));
    return lines.join("\n");
  }

  if (isWarDecided(scoreboard, warData)) {
    lines.push("", "War is already decided. No reminders needed.");
    lines.push(buildAttackDetails(warData));
    return lines.join("\n");
  }

  const groups = groupCwlMembersByAttacks(warData);
  if (!groups) {
    lines.push("", "Could not parse member data.");
    return lines.join("\n");
  }

  const toRemind = getCwlPlayersToRemind(groups);

  if (toRemind.length === 0) {
    lines.push("", "✅ Everyone has attacked! No reminders needed.");
  } else {
    lines.push("", "**⚠️ Players who still need to attack:**");
    for (const p of toRemind) {
      lines.push(formatCwlPlayerLine(p, playerDiscordMap, { suppressPing: isManual }));
    }
  }

  lines.push(buildAttackDetails(warData));

  return lines.join("\n");
}

/** Build the /cwl-standings response: ranked list of all 8 clans with medals. */
function buildCwlStandingsMessage(standings, season) {
  const header = season
    ? `**🏆 CWL Standings — ${season}**`
    : `**🏆 CWL Standings**`;

  const medalEmoji = ["🥇", "🥈", "🥉"];
  const lines = [header, ""];

  for (let i = 0; i < standings.length; i++) {
    const s = standings[i];
    const rank = medalEmoji[i] ?? `**${i + 1}.**`;
    const record = `${s.wins}W/${s.losses}L/${s.ties}T`;
    const dest = s.roundsPlayed > 0
      ? (s.destruction / s.roundsPlayed).toFixed(1)
      : "0.0";
    lines.push(`${rank} **${s.name}** — ${s.stars}⭐ | ${dest}% avg | ${record}`);
  }

  return lines.join("\n");
}

/** Build the /cwl-stats response: per-player CWL performance across all rounds. */
function buildCwlStatsMessage(playerStats, season) {
  const header = season
    ? `**📊 CWL Player Stats — ${season}**`
    : `**📊 CWL Player Stats**`;

  if (playerStats.length === 0) {
    return `${header}\n\nNo player data available yet.`;
  }

  const lines = [header, ""];

  for (const p of playerStats) {
    const avgDest = p.attacks > 0
      ? (p.totalDestruction / p.attacks).toFixed(1)
      : "0.0";
    const missed = p.missedAttacks > 0 ? ` | ${p.missedAttacks} missed` : "";
    lines.push(
      `**${p.name}** — ${p.stars}⭐ / ${p.attacks} atk | ${avgDest}% avg${missed}`
    );
  }

  // Discord has a 2000-character message limit — truncate if needed
  let result = lines.join("\n");
  if (result.length > 1950) {
    result = result.slice(0, 1950) + "\n*(truncated)*";
  }

  return result;
}

module.exports = {
  formatPlayerLine,
  formatWarDate,
  buildParticipantList,
  buildExtendedInfo,
  buildAttackDetails,
  buildWarMessage,
  buildClanStatsMessage,
  buildPlayerStatsMessage,
  buildWarLogMessage,
  formatCwlPlayerLine,
  buildCwlWarMessage,
  buildCwlStandingsMessage,
  buildCwlStatsMessage,
};
