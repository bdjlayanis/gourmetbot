// =============================================================
// coc_test.js — Standalone CLI tool (CoC API only, no Discord)
// =============================================================
//
// Usage:  node coc_test.js
//
// Quick way to test the CoC API connection and see war status
// without starting the full Discord bot. Prints the scoreboard,
// time remaining, attack groups, and who needs reminders.
//
// Uses the same core modules (coc_api.js, war_analysis.js) as
// the Discord bot, so it's also useful for verifying that the
// analysis logic works correctly.
// =============================================================

const { CLAN_TAG, COC_API_TOKEN } = require("./config");
const { getCurrentWar, parseWarDate, cocErrorMessage } = require("./coc_api");
const { getTimeRemaining, getWarScoreboard, isWarDecided, groupMembersByAttacks, getPlayersToRemind } = require("./war_analysis");

// ---- Display helpers (console only) -------------------------

function printGroup(label, players) {
  console.log(`\n--- ${label} (${players.length}) ---`);
  if (players.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const p of players) {
    console.log(`  ${p.name}  ${p.tag}`);
  }
}

function displayScoreboard(scoreboard) {
  const { clan, opponent } = scoreboard;
  console.log(`\n===== Scoreboard =====`);
  console.log(`  ${clan.name}: ${clan.stars}/${clan.maxStars} stars, ${clan.destruction.toFixed(2)}% destruction`);
  console.log(`  ${opponent.name}: ${opponent.stars}/${opponent.maxStars} stars, ${opponent.destruction.toFixed(2)}% destruction`);
}

function displayTimeRemaining(remaining) {
  if (!remaining) {
    console.log("  Time remaining: war has ended");
    return;
  }
  console.log(`  Time remaining: ${remaining.hours}h ${remaining.minutes}m`);
}

function displayWarSummary(groups) {
  printGroup("0 attacks used", groups[0]);
  printGroup("1 attack used", groups[1]);
  printGroup("2 attacks used", groups[2]);
}

function displayReminders(toRemind) {
  console.log(`\n===== Reminders (${toRemind.length}) =====`);
  if (toRemind.length === 0) {
    console.log("  No reminders needed — everyone is doing great!");
    return;
  }
  for (const p of toRemind) {
    console.log(`  ${p.name}  ${p.tag}  — ${p.reason}`);
  }
}

// ---- Main entry point ---------------------------------------

async function main() {
  if (!COC_API_TOKEN) {
    console.error("Error: COC_API_TOKEN is not set in config.js.");
    process.exit(1);
  }

  console.log(`Fetching current war for clan ${CLAN_TAG} ...`);

  try {
    const warData = await getCurrentWar(CLAN_TAG);

    if (warData.state === "notInWar") {
      console.log("This clan is not currently in a war.");
      return;
    }

    console.log(`War state: ${warData.state}`);
    console.log(`${warData.clan.name} vs ${warData.opponent.name}`);

    const scoreboard = getWarScoreboard(warData);
    displayScoreboard(scoreboard);

    const endDate = parseWarDate(warData.endTime);
    const remaining = getTimeRemaining(endDate);
    displayTimeRemaining(remaining);

    if (isWarDecided(scoreboard, warData)) {
      console.log("\nWar is already decided. No reminders needed.");
      return;
    }

    if (remaining && remaining.hours < 2) {
      console.log("\nWar is almost over. No reminders sent.");
      return;
    }

    const groups = groupMembersByAttacks(warData);
    if (groups) {
      displayWarSummary(groups);

      const toRemind = getPlayersToRemind(groups);
      displayReminders(toRemind);
    }
  } catch (error) {
    console.error(cocErrorMessage(error));
    process.exit(1);
  }
}

// ---- Run (only when executed directly) ----------------------

if (require.main === module) {
  main();
}
