// =============================================================
// scheduler.js — Automatic war checks, reminders, and anti-spam
// =============================================================
//
// This module runs on a timer (every 30 min by default) and handles
// four independent jobs each cycle:
//
//   1. Regular war check  — announce prep/start, countdown reminders, war-ended summary
//   2. CWL war check      — same lifecycle events but for Clan War League rounds
//   3. Raid weekend check — start announcement, reminders, end summary
//   4. Bedtime check      — ping players who are about to go to sleep with attacks left
//
// Every ended war (regular or CWL round) is also recorded to
// war_history.json for the /missed command.
//
// Anti-spam ("spam guard") ensures each message type is sent only once
// per war. State is persisted to spam_guard.json so restarts don't
// cause duplicate messages.
//
// The countdown threshold system works like this:
//   - REMINDER_THRESHOLDS_HOURS = [12, 6, 4, 2, 1]
//   - Each cycle, we check if time remaining < any threshold
//   - If a threshold hasn't been sent yet for this war, we send it
//   - Each threshold fires exactly once per war
// =============================================================

const {
  CLAN_TAG,
  REMINDER_THRESHOLDS_HOURS,
  RAID_REMINDER_THRESHOLDS_HOURS = [24, 4],  // default for config.js files predating raids
} = require("./config");
const { getCurrentWar, getCapitalRaidSeason, parseWarDate, cocErrorMessage } = require("./coc_api");
const {
  getWarScoreboard,
  isWarDecided,
  getWarResult,
  getTimeRemaining,
  groupMembersByAttacks,
  getPlayersToRemind,
  getMissedAttacks,
  getRaidPlayersToRemind,
} = require("./war_analysis");
const {
  formatPlayerLine,
  formatCwlPlayerLine,
  formatRaidPlayerLine,
  buildParticipantList,
  buildWarEndSummary,
  buildRaidMessage,
} = require("./discord_messages");
const { getCurrentCwlWar, getCwlWarsByState } = require("./cwl_api");
const { groupCwlMembersByAttacks, getCwlPlayersToRemind } = require("./cwl_analysis");
const { loadSpamGuard, saveSpamGuard, appendWarHistory } = require("./persistence");

// ---- Spam guard factory -------------------------------------

/**
 * Create or restore the anti-spam state object.
 * Tries to load from disk first; falls back to a fresh state.
 */
function createSpamGuard() {
  const loaded = loadSpamGuard();
  if (loaded) {
    console.log("[spam-guard] Restored state from disk.");
  }
  // Defaults first, so fields added after the file was written still exist
  return {
    sentThresholds: {},
    warEndSentForWar: null,
    preparationSentForWar: null,
    warStartSentForWar: null,
    warDecidedSentForWar: null,
    bedtimeRemindedOn: {},
    // CWL-specific state
    cwlSentThresholds: {},
    cwlPreparationSentForWar: null,
    cwlWarStartSentForWar: null,
    cwlWarEndSentForWar: null,
    // Raid weekend state (keyed by the raid's endTime)
    raidSentThresholds: {},
    raidStartSentFor: null,
    raidEndSentFor: null,
    ...loaded,
  };
}

// ---- Anti-spam helpers --------------------------------------

/**
 * Pick the countdown threshold to announce now, or null if none is due.
 *
 * Returns the smallest threshold already crossed, and marks *every*
 * crossed threshold as sent — otherwise a bot started at 3h left would
 * send "< 4h" now, then "< 6h" next cycle, then "< 12h"...
 *
 * @param {object}   sentMap      warEndTime → Set of sent thresholds (mutated)
 * @param {string}   warEndTime   Identifies the war
 * @param {number}   hoursLeft    Whole hours remaining
 * @param {number[]} thresholds   Hours before the end that trigger a reminder
 */
function claimThreshold(sentMap, warEndTime, hoursLeft, thresholds = REMINDER_THRESHOLDS_HOURS) {
  const crossed = thresholds.filter((t) => hoursLeft < t);
  const sent = (sentMap[warEndTime] ??= new Set());
  if (crossed.every((t) => sent.has(t))) return null;
  crossed.forEach((t) => sent.add(t));
  return Math.min(...crossed);
}

/** Record an ended war's missed attacks in war_history.json (for /missed). */
function recordWar(warData, cwl) {
  appendWarHistory({
    endTime: warData.endTime,
    cwl,
    opponent: warData.opponent.name,
    members: getMissedAttacks(warData),
  });
}

// ---- Automatic war check ------------------------------------

/**
 * Main scheduler entry point — called every AUTO_CHECK_INTERVAL_MS.
 *
 * Runs three independent checks in sequence:
 *   1. Regular war: prep announcement → battle day start → countdown
 *      reminders → war-decided recap
 *   2. CWL war: same lifecycle but for CWL rounds
 *   3. Bedtime: personal reminders for players close to bedtime
 *
 * Each check is wrapped in its own try/catch so one failure
 * doesn't prevent the others from running.
 *
 * @param {object}   spamGuard        Mutable anti-spam state (persisted to disk)
 * @param {object}   playerDiscordMap  CoC tag → Discord user ID
 * @param {object}   bedtimeMap        Discord user ID → { time, timeZone }
 * @param {function} sendToChannel     async (text) => void — sends to reminder channel
 */
async function runAutoWarCheck(spamGuard, playerDiscordMap, bedtimeMap, sendToChannel) {
  console.log(`[auto] Running scheduled war check at ${new Date().toISOString()}`);

  try {
    const warData = await getCurrentWar(CLAN_TAG);

    if (warData.state === "notInWar") {
      console.log(`[auto] No active war. Skipping.`);
    } else if (warData.state === "preparation") {
      if (spamGuard.preparationSentForWar === warData.endTime) {
        console.log("[auto] Preparation message already sent for this war. Skipping.");
      } else {
        const startDate = parseWarDate(warData.startTime);
        const startUnix = Math.floor(startDate.getTime() / 1000);
        const lines = [
          `**🔍 War Found!**`,
          `Opponent: **${warData.opponent.name}** (${warData.opponent.tag})`,
          `Size: **${warData.teamSize}v${warData.teamSize}**`,
          `Battle day starts: <t:${startUnix}:R> (<t:${startUnix}:F>)`,
        ];
        await sendToChannel(lines.join("\n"));
        spamGuard.preparationSentForWar = warData.endTime;
        saveSpamGuard(spamGuard);
        console.log("[auto] Preparation phase announcement sent.");
      }
    } else if (warData.state === "inWar" && spamGuard.warStartSentForWar !== warData.endTime) {
      const endDate = parseWarDate(warData.endTime);
      const endUnix = Math.floor(endDate.getTime() / 1000);
      const lines = [
        `**⚔️ Battle Day has begun!**`,
        `vs **${warData.opponent.name}** — ${warData.teamSize}v${warData.teamSize}`,
        `War ends: <t:${endUnix}:R> (<t:${endUnix}:F>)`,
        `Good luck!`,
        "",
        buildParticipantList(warData, playerDiscordMap),
      ];
      await sendToChannel(lines.join("\n"));
      spamGuard.warStartSentForWar = warData.endTime;
      saveSpamGuard(spamGuard);
      console.log("[auto] War started announcement sent.");
    } else if (warData.state === "inWar") {
      // ---- From here on, only inWar state ----
      const scoreboard = getWarScoreboard(warData);
      if (isWarDecided(scoreboard, warData)) {
        if (spamGuard.warDecidedSentForWar !== warData.endTime) {
          const { clan, opponent } = scoreboard;
          const recapLines = [
            `**🏁 War Decided — ${getWarResult(scoreboard)}!**`,
            `vs **${warData.opponent.name}**`,
            `**⭐** ${clan.stars} - ${opponent.stars}`,
            `**💥** ${clan.destruction.toFixed(1)}% - ${opponent.destruction.toFixed(1)}%`,
          ];
          await sendToChannel(recapLines.join("\n"));
          spamGuard.warDecidedSentForWar = warData.endTime;
          saveSpamGuard(spamGuard);
          console.log("[auto] War decided recap sent.");
        } else {
          console.log("[auto] War decided recap already sent. Skipping.");
        }
      } else {
        const groups = groupMembersByAttacks(warData);
        const toRemind = groups ? getPlayersToRemind(groups) : [];

        if (toRemind.length === 0) {
          console.log("[auto] No players need reminders. Skipping.");
        } else {
          const endDate = parseWarDate(warData.endTime);
          const remaining = getTimeRemaining(endDate);

          if (!remaining) {
            console.log("[auto] War appears to have ended. Skipping.");
          } else {
            // ---- Threshold-based countdown reminders ----
            const triggeredThreshold = claimThreshold(spamGuard.sentThresholds, warData.endTime, remaining.hours);

            if (triggeredThreshold === null) {
              console.log("[auto] No threshold crossed. Skipping.");
            } else {
              const label = triggeredThreshold === 1
                ? "< 1 hour left"
                : `< ${triggeredThreshold} hours left`;

              const reminderLines = [
                `**⏰ War Reminder (${label})**`,
                "Please finish your attacks!",
                "",
              ];
              for (const p of toRemind) {
                reminderLines.push(formatPlayerLine(p, playerDiscordMap));
              }
              await sendToChannel(reminderLines.join("\n"));
              saveSpamGuard(spamGuard);
              console.log(`[auto] Threshold reminder sent: < ${triggeredThreshold}h`);
            }
          }
        }
      }
    } else if (warData.state === "warEnded" && spamGuard.warEndSentForWar !== warData.endTime) {
      recordWar(warData, false);
      await sendToChannel(buildWarEndSummary(warData, "War Over"));
      spamGuard.warEndSentForWar = warData.endTime;
      saveSpamGuard(spamGuard);
      console.log("[auto] War-ended summary sent.");
    }
  } catch (error) {
    console.error("[auto] Error during scheduled check:", cocErrorMessage(error));
  }

  // ---- CWL auto check (runs independently of regular war) ----
  try {
    await runAutoCwlCheck(spamGuard, playerDiscordMap, sendToChannel);
  } catch (error) {
    console.error("[cwl-auto] Error during CWL check:", error.message);
  }

  // ---- Raid weekend (independent of wars) ----
  try {
    await runAutoRaidCheck(spamGuard, playerDiscordMap, sendToChannel);
  } catch (error) {
    console.error("[raid-auto] Error during raid check:", cocErrorMessage(error));
  }

  // ---- Bedtime reminders (independent of regular reminders) ----
  try {
    await runBedtimeCheck(spamGuard, playerDiscordMap, bedtimeMap, sendToChannel);
  } catch (error) {
    console.error("[bedtime] Error during bedtime check:", error.message);
  }

  // CWL and bedtime checks mutate the guard too — persist once for all
  saveSpamGuard(spamGuard);
}

// ---- Automatic CWL check ------------------------------------

/**
 * CWL auto-check: same lifecycle as regular wars but for CWL rounds.
 * Announces prep, battle day start, countdown reminders, and war-ended summary.
 * Silently skips if the clan is not in CWL (404 from the API).
 *
 * Rounds overlap (round N battles while N+1 preps and N-1 just ended),
 * so each cycle looks at all three. Posted in chronological order:
 * result of N-1, battle day of N, prep of N+1.
 */
async function runAutoCwlCheck(spamGuard, playerDiscordMap, sendToChannel) {
  let wars;
  try {
    wars = await getCwlWarsByState(CLAN_TAG);
  } catch (error) {
    if (error.response?.status === 404) {
      // Clan not in CWL — silently skip
      return;
    }
    throw error;
  }

  // ---- Previous round ended: post summary ----
  if (wars.warEnded && spamGuard.cwlWarEndSentForWar !== wars.warEnded.war.endTime) {
    const { war: warData, roundIndex } = wars.warEnded;
    recordWar(warData, true);
    await sendToChannel(buildWarEndSummary(warData, `CWL Round ${roundIndex}`));
    spamGuard.cwlWarEndSentForWar = warData.endTime;
    console.log(`[cwl-auto] CWL round ${roundIndex} war-ended summary sent.`);
  }

  if (wars.inWar) {
    await runCwlBattleDay(spamGuard, playerDiscordMap, sendToChannel, wars.inWar);
  }

  // ---- Next round in preparation: announce it ----
  if (wars.preparation && spamGuard.cwlPreparationSentForWar !== wars.preparation.war.endTime) {
    const { war: warData, roundIndex } = wars.preparation;
    const startDate = parseWarDate(warData.startTime);
    const startUnix = Math.floor(startDate.getTime() / 1000);
    const lines = [
      `**🏆 CWL Round ${roundIndex} — War Found!**`,
      `Opponent: **${warData.opponent.name}** (${warData.opponent.tag})`,
      `Size: **${warData.teamSize}v${warData.teamSize}**`,
      `Battle day starts: <t:${startUnix}:R> (<t:${startUnix}:F>)`,
    ];
    await sendToChannel(lines.join("\n"));
    spamGuard.cwlPreparationSentForWar = warData.endTime;
    console.log(`[cwl-auto] CWL round ${roundIndex} preparation announcement sent.`);
  }
}

/** CWL round on battle day: start announcement, then countdown reminders. */
async function runCwlBattleDay(spamGuard, playerDiscordMap, sendToChannel, { war: warData, roundIndex }) {
  // ---- War just started: announce battle day ----
  if (spamGuard.cwlWarStartSentForWar !== warData.endTime) {
    const endDate = parseWarDate(warData.endTime);
    const endUnix = Math.floor(endDate.getTime() / 1000);
    const lines = [
      `**🏆⚔️ CWL Round ${roundIndex} — Battle Day!**`,
      `vs **${warData.opponent.name}** — ${warData.teamSize}v${warData.teamSize}`,
      `War ends: <t:${endUnix}:R> (<t:${endUnix}:F>)`,
      `Remember: **1 attack** per player!`,
      "",
      buildParticipantList(warData, playerDiscordMap),
    ];
    await sendToChannel(lines.join("\n"));
    spamGuard.cwlWarStartSentForWar = warData.endTime;
    console.log(`[cwl-auto] CWL round ${roundIndex} battle day announcement sent.`);
    return;
  }

  // ---- inWar: threshold reminders ----
  const scoreboard = getWarScoreboard(warData);
  if (isWarDecided(scoreboard, warData)) return;

  const groups = groupCwlMembersByAttacks(warData);
  if (!groups) return;
  const toRemind = getCwlPlayersToRemind(groups);
  if (toRemind.length === 0) return;

  const endDate = parseWarDate(warData.endTime);
  const remaining = getTimeRemaining(endDate);
  if (!remaining) return;

  const triggeredThreshold = claimThreshold(spamGuard.cwlSentThresholds, warData.endTime, remaining.hours);
  if (triggeredThreshold === null) return;

  const label = triggeredThreshold === 1
    ? "< 1 hour left"
    : `< ${triggeredThreshold} hours left`;

  const reminderLines = [
    `**🏆⏰ CWL Round ${roundIndex} Reminder (${label})**`,
    "Please use your attack!",
    "",
  ];
  for (const p of toRemind) {
    reminderLines.push(formatCwlPlayerLine(p, playerDiscordMap));
  }
  await sendToChannel(reminderLines.join("\n"));
  console.log(`[cwl-auto] CWL round ${roundIndex} threshold reminder sent: < ${triggeredThreshold}h`);
}

// ---- Automatic raid weekend check ---------------------------

/**
 * Raid weekend (Friday → Monday 07:00 UTC): announce the start, remind
 * players who started raiding but have attacks left at RAID_REMINDER_THRESHOLDS_HOURS, and post
 * a summary when it ends. Each fires once per raid (keyed by endTime).
 */
async function runAutoRaidCheck(spamGuard, playerDiscordMap, sendToChannel) {
  const raid = await getCapitalRaidSeason(CLAN_TAG);
  if (!raid) return;

  if (raid.state === "ended") {
    if (spamGuard.raidEndSentFor === raid.endTime) return;
    await sendToChannel(buildRaidMessage(raid, playerDiscordMap));
    spamGuard.raidEndSentFor = raid.endTime;
    console.log("[raid-auto] Raid weekend summary sent.");
    return;
  }

  if (spamGuard.raidStartSentFor !== raid.endTime) {
    const endUnix = Math.floor(parseWarDate(raid.endTime).getTime() / 1000);
    await sendToChannel([
      `**🏰 Raid Weekend has begun!**`,
      `Ends: <t:${endUnix}:R> (<t:${endUnix}:F>)`,
      `Don't forget your raid attacks!`,
    ].join("\n"));
    spamGuard.raidStartSentFor = raid.endTime;
    console.log("[raid-auto] Raid weekend start announcement sent.");
    return;
  }

  const remaining = getTimeRemaining(parseWarDate(raid.endTime));
  if (!remaining) return;

  const threshold = claimThreshold(spamGuard.raidSentThresholds, raid.endTime, remaining.hours, RAID_REMINDER_THRESHOLDS_HOURS);
  if (threshold === null) return;

  const toRemind = getRaidPlayersToRemind(raid);
  if (toRemind.length === 0) return;

  const lines = [
    `**🏰⏰ Raid Weekend Reminder (< ${threshold} hours left)**`,
    "Use your raid attacks!",
    "",
    ...toRemind.map((p) => formatRaidPlayerLine(p, playerDiscordMap)),
  ];
  await sendToChannel(lines.join("\n"));
  console.log(`[raid-auto] Raid reminder sent: < ${threshold}h`);
}

// ---- Bedtime check ------------------------------------------

/** Wall-clock date ("YYYY-MM-DD") and minutes since midnight in an IANA time zone. */
function localClock(timeZone, date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/**
 * Send personal bedtime reminders to players who:
 *   1. Have a bedtime set (/bedtime command)
 *   2. Are within 30 minutes of their bedtime
 *   3. Have a linked CoC account that still needs to attack
 *   4. Haven't already been reminded today
 *
 * Local time comes from the user's IANA time zone (e.g. Europe/Paris),
 * so daylight saving changes are handled automatically.
 */
async function runBedtimeCheck(spamGuard, playerDiscordMap, bedtimeMap, sendToChannel) {
  const users = Object.entries(bedtimeMap);
  if (users.length === 0) return;

  // Try regular war first
  let warData;
  let isCwl = false;
  try {
    warData = await getCurrentWar(CLAN_TAG);
  } catch {
    warData = null;
  }

  // If no regular war active, try CWL
  if (!warData || warData.state !== "inWar") {
    try {
      const cwlResult = await getCurrentCwlWar(CLAN_TAG);
      if (cwlResult && cwlResult.war.state === "inWar") {
        warData = cwlResult.war;
        isCwl = true;
      }
    } catch {
      // No CWL either — fall through
    }
  }

  if (!warData || warData.state !== "inWar") return;

  let playersToRemind;
  if (isCwl) {
    const groups = groupCwlMembersByAttacks(warData);
    if (!groups) return;
    playersToRemind = getCwlPlayersToRemind(groups);
  } else {
    const groups = groupMembersByAttacks(warData);
    if (!groups) return;
    playersToRemind = getPlayersToRemind(groups);
  }
  if (playersToRemind.length === 0) return;

  const tagsToRemind = new Set(playersToRemind.map((p) => p.tag));

  // Build a reverse map: Discord ID → [CoC tags]
  // (one Discord user can have multiple linked CoC accounts)
  const reversePlayerMap = {};
  for (const [cocTag, discordId] of Object.entries(playerDiscordMap)) {
    if (!reversePlayerMap[discordId]) reversePlayerMap[discordId] = [];
    reversePlayerMap[discordId].push(cocTag);
  }

  const now = new Date();

  for (const [discordId, { time, timeZone }] of users) {
    const [bedH, bedM] = time.split(":").map(Number);

    // Modulo wraps past midnight: 23:45 → 00:00 bedtime is 15 min away, not -1425
    const minutesUntilBed = (bedH * 60 + bedM - localClock(timeZone, now).minutes + 1440) % 1440;

    if (minutesUntilBed > 30) continue;

    // Keyed by the bedtime's own date, so 23:50 and 00:20 checks for a
    // 00:20 bedtime count as the same night
    const bedDateStr = localClock(timeZone, new Date(now.getTime() + minutesUntilBed * 60000)).date;
    if (spamGuard.bedtimeRemindedOn[discordId] === bedDateStr) continue;

    const linkedTags = reversePlayerMap[discordId];
    if (!linkedTags || linkedTags.length === 0) continue;

    const needsAttack = linkedTags.some((tag) => tagsToRemind.has(tag));
    if (!needsAttack) continue;

    const warType = isCwl ? "CWL" : "war";
    await sendToChannel(
      `🌙 <@${discordId}> — Bedtime in ~${minutesUntilBed} min! You still have ${warType} attacks left. Get them in before you sleep!`
    );
    spamGuard.bedtimeRemindedOn[discordId] = bedDateStr;
    console.log(`[bedtime] Reminder sent to ${discordId} (${time} ${timeZone}).`);
  }
}

module.exports = {
  createSpamGuard,
  runAutoWarCheck,
  runBedtimeCheck,
  claimThreshold,
};
