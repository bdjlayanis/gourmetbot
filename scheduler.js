// =============================================================
// scheduler.js — Automatic war checks, reminders, and anti-spam
// =============================================================
//
// This module runs on a timer (every 30 min by default) and handles
// three independent jobs each cycle:
//
//   1. Regular war check  — announce prep/start, countdown reminders, war-ended summary
//   2. CWL war check      — same lifecycle events but for Clan War League rounds
//   3. Bedtime check      — DM players who are about to go to sleep with attacks left
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

const { CLAN_TAG, AUTO_CHECK_INTERVAL_MS, REMINDER_THRESHOLDS_HOURS } = require("./config");
const { getCurrentWar, parseWarDate, cocErrorMessage } = require("./coc_api");
const { getWarScoreboard, isWarDecided, getTimeRemaining, groupMembersByAttacks, getPlayersToRemind } = require("./war_analysis");
const { formatPlayerLine, formatCwlPlayerLine } = require("./discord_messages");
const { getCurrentCwlWar } = require("./cwl_api");
const { groupCwlMembersByAttacks, getCwlPlayersToRemind } = require("./cwl_analysis");
const { loadSpamGuard, saveSpamGuard } = require("./persistence");

// ---- Spam guard factory -------------------------------------

/**
 * Create or restore the anti-spam state object.
 * Tries to load from disk first; falls back to a fresh state.
 */
function createSpamGuard() {
  const loaded = loadSpamGuard();
  if (loaded) {
    console.log("[spam-guard] Restored state from disk.");
    return loaded;
  }
  return {
    lastAutoReminderAt: null,
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
  };
}

// ---- Anti-spam helpers --------------------------------------

/** Check if enough time has passed since the last auto-reminder. */
function canSendAutoReminder(spamGuard) {
  if (!spamGuard.lastAutoReminderAt) return true;
  const elapsed = Date.now() - spamGuard.lastAutoReminderAt;
  return elapsed >= AUTO_CHECK_INTERVAL_MS;
}

function markAutoReminderSent(spamGuard) {
  spamGuard.lastAutoReminderAt = Date.now();
}

/** Check if a specific countdown threshold was already sent for this war. */
function hasThresholdBeenSent(spamGuard, warEndTime, thresholdHours) {
  const sent = spamGuard.sentThresholds[warEndTime];
  return sent ? sent.has(thresholdHours) : false;
}

/** Record that a threshold was sent so it won't fire again for this war. */
function markThresholdSent(spamGuard, warEndTime, thresholdHours) {
  if (!spamGuard.sentThresholds[warEndTime]) {
    spamGuard.sentThresholds[warEndTime] = new Set();
  }
  spamGuard.sentThresholds[warEndTime].add(thresholdHours);
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
 * @param {object}   bedtimeMap        Discord user ID → { time, utcOffset }
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
          const resultStr = clan.stars > opponent.stars ? "Victory"
            : clan.stars < opponent.stars ? "Defeat" : "Tie";
          const recapLines = [
            `**🏁 War Decided — ${resultStr}!**`,
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
            let triggeredThreshold = null;
            for (const threshold of REMINDER_THRESHOLDS_HOURS) {
              if (remaining.hours < threshold && !hasThresholdBeenSent(spamGuard, warData.endTime, threshold)) {
                triggeredThreshold = threshold;
              }
            }

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
              markThresholdSent(spamGuard, warData.endTime, triggeredThreshold);
              markAutoReminderSent(spamGuard);
              saveSpamGuard(spamGuard);
              console.log(`[auto] Threshold reminder sent: < ${triggeredThreshold}h`);
            }
          }
        }
      }
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

  // ---- Bedtime reminders (independent of regular reminders) ----
  try {
    await runBedtimeCheck(spamGuard, playerDiscordMap, bedtimeMap, sendToChannel);
  } catch (error) {
    console.error("[bedtime] Error during bedtime check:", error.message);
  }
}

// ---- Automatic CWL check ------------------------------------

/**
 * CWL auto-check: same lifecycle as regular wars but for CWL rounds.
 * Announces prep, battle day start, countdown reminders, and war-ended summary.
 * Silently skips if the clan is not in CWL (404 from the API).
 */
async function runAutoCwlCheck(spamGuard, playerDiscordMap, sendToChannel) {
  let result;
  try {
    result = await getCurrentCwlWar(CLAN_TAG);
  } catch (error) {
    if (error.response?.status === 404) {
      // Clan not in CWL — silently skip
      return;
    }
    throw error;
  }

  if (!result) return;

  const { war: warData, roundIndex } = result;

  if (warData.state === "notInWar") return;

  // ---- Preparation phase: announce CWL round ----
  if (warData.state === "preparation") {
    if (spamGuard.cwlPreparationSentForWar === warData.endTime) return;

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
    return;
  }

  // ---- War just started: announce battle day ----
  if (warData.state === "inWar" && spamGuard.cwlWarStartSentForWar !== warData.endTime) {
    const endDate = parseWarDate(warData.endTime);
    const endUnix = Math.floor(endDate.getTime() / 1000);
    const lines = [
      `**🏆⚔️ CWL Round ${roundIndex} — Battle Day!**`,
      `vs **${warData.opponent.name}** — ${warData.teamSize}v${warData.teamSize}`,
      `War ends: <t:${endUnix}:R> (<t:${endUnix}:F>)`,
      `Remember: **1 attack** per player!`,
    ];
    await sendToChannel(lines.join("\n"));
    spamGuard.cwlWarStartSentForWar = warData.endTime;
    console.log(`[cwl-auto] CWL round ${roundIndex} battle day announcement sent.`);
    return;
  }

  // ---- War ended: post summary ----
  if (warData.state === "warEnded") {
    if (spamGuard.cwlWarEndSentForWar === warData.endTime) return;

    const scoreboard = getWarScoreboard(warData);
    const { clan, opponent } = scoreboard;
    const resultStr = clan.stars > opponent.stars ? "Victory" :
                      clan.stars < opponent.stars ? "Defeat" : "Tie";

    const lines = [
      `**🏆 CWL Round ${roundIndex} — ${resultStr}!**`,
      `**⭐** ${clan.stars} - ${opponent.stars}`,
      `**💥** ${clan.destruction.toFixed(1)}% - ${opponent.destruction.toFixed(1)}%`,
    ];
    await sendToChannel(lines.join("\n"));
    spamGuard.cwlWarEndSentForWar = warData.endTime;
    console.log(`[cwl-auto] CWL round ${roundIndex} war-ended summary sent.`);
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

  let triggeredThreshold = null;
  for (const threshold of REMINDER_THRESHOLDS_HOURS) {
    const sent = spamGuard.cwlSentThresholds[warData.endTime];
    const alreadySent = sent ? sent.has(threshold) : false;
    if (remaining.hours < threshold && !alreadySent) {
      triggeredThreshold = threshold;
    }
  }

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

  if (!spamGuard.cwlSentThresholds[warData.endTime]) {
    spamGuard.cwlSentThresholds[warData.endTime] = new Set();
  }
  spamGuard.cwlSentThresholds[warData.endTime].add(triggeredThreshold);
  console.log(`[cwl-auto] CWL round ${roundIndex} threshold reminder sent: < ${triggeredThreshold}h`);
}

// ---- Bedtime check ------------------------------------------

/**
 * Send personal bedtime reminders to players who:
 *   1. Have a bedtime set (/bedtime command)
 *   2. Are within 30 minutes of their bedtime
 *   3. Have a linked CoC account that still needs to attack
 *   4. Haven't already been reminded today
 *
 * Time calculation converts UTC to the user's local time using
 * their configured UTC offset, then checks the 0–30 minute window.
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

  for (const [discordId, settings] of users) {
    const { time, utcOffset } = settings;
    const [bedH, bedM] = time.split(":").map(Number);

    const userNow = new Date(now.getTime() + utcOffset * 60 * 60 * 1000);
    const userHour = userNow.getUTCHours();
    const userMin = userNow.getUTCMinutes();

    const userDateStr = userNow.toISOString().slice(0, 10);

    if (spamGuard.bedtimeRemindedOn[discordId] === userDateStr) continue;

    const bedMinutes = bedH * 60 + bedM;
    const nowMinutes = userHour * 60 + userMin;
    const minutesUntilBed = bedMinutes - nowMinutes;

    if (minutesUntilBed < 0 || minutesUntilBed > 30) continue;

    const linkedTags = reversePlayerMap[discordId];
    if (!linkedTags || linkedTags.length === 0) continue;

    const needsAttack = linkedTags.some((tag) => tagsToRemind.has(tag));
    if (!needsAttack) continue;

    const warType = isCwl ? "CWL" : "war";
    await sendToChannel(
      `🌙 <@${discordId}> — Bedtime in ~${minutesUntilBed} min! You still have ${warType} attacks left. Get them in before you sleep!`
    );
    spamGuard.bedtimeRemindedOn[discordId] = userDateStr;
    console.log(`[bedtime] Reminder sent to ${discordId} (${time} UTC${utcOffset >= 0 ? "+" : ""}${utcOffset}).`);
  }
}

module.exports = {
  createSpamGuard,
  runAutoWarCheck,
  runBedtimeCheck,
};
