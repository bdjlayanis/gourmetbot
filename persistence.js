// =============================================================
// persistence.js — Read/write JSON data files to disk
// =============================================================
//
// Three JSON files store the bot's persistent state:
//
//   player_map.json   — CoC player tag → Discord user ID links
//   bedtime_map.json  — Discord user ID → { time, utcOffset } settings
//   spam_guard.json   — Anti-spam state so the bot doesn't repeat
//                        messages after a restart
//
// The spam guard uses an atomic write (write to .tmp then rename)
// so a crash mid-write can't corrupt the file. The other two files
// are small enough that corruption risk is negligible.
// =============================================================

const fs = require("fs");
const path = require("path");

// Resolve paths relative to this file's directory (project root)
const PLAYER_MAP_FILE = path.join(__dirname, "player_map.json");
const BEDTIME_MAP_FILE = path.join(__dirname, "bedtime_map.json");
const SPAM_GUARD_FILE = path.join(__dirname, "spam_guard.json");

/** Load the CoC tag → Discord ID map. Returns {} if the file doesn't exist yet. */
function loadPlayerMap() {
  try {
    const raw = fs.readFileSync(PLAYER_MAP_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Overwrite player_map.json with the current in-memory map. */
function savePlayerMap(data) {
  fs.writeFileSync(PLAYER_MAP_FILE, JSON.stringify(data, null, 2));
}

/** Load bedtime settings. Returns {} if the file doesn't exist yet. */
function loadBedtimeMap() {
  try {
    const raw = fs.readFileSync(BEDTIME_MAP_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Overwrite bedtime_map.json with the current in-memory map. */
function saveBedtimeMap(data) {
  fs.writeFileSync(BEDTIME_MAP_FILE, JSON.stringify(data, null, 2));
}

/**
 * Load the spam guard state from disk.
 *
 * The sentThresholds and cwlSentThresholds fields are stored as
 * arrays in JSON (since JSON has no Set type) and converted back
 * to Sets here so the rest of the code can use .has() / .add().
 *
 * Returns null if the file doesn't exist or is corrupted, which
 * tells createSpamGuard() to start with a fresh state.
 */
function loadSpamGuard() {
  try {
    const raw = fs.readFileSync(SPAM_GUARD_FILE, "utf-8");
    const data = JSON.parse(raw);

    // Convert threshold arrays back to Sets for fast .has() lookups
    const sentThresholds = {};
    for (const [key, arr] of Object.entries(data.sentThresholds || {})) {
      sentThresholds[key] = new Set(arr);
    }
    const cwlSentThresholds = {};
    for (const [key, arr] of Object.entries(data.cwlSentThresholds || {})) {
      cwlSentThresholds[key] = new Set(arr);
    }

    return {
      lastAutoReminderAt: data.lastAutoReminderAt || null,
      sentThresholds,
      warEndSentForWar: data.warEndSentForWar || null,
      preparationSentForWar: data.preparationSentForWar || null,
      warStartSentForWar: data.warStartSentForWar || null,
      bedtimeRemindedOn: data.bedtimeRemindedOn || {},
      cwlSentThresholds,
      cwlPreparationSentForWar: data.cwlPreparationSentForWar || null,
      cwlWarStartSentForWar: data.cwlWarStartSentForWar || null,
      cwlWarEndSentForWar: data.cwlWarEndSentForWar || null,
    };
  } catch (err) {
    console.error("[spam-guard] Failed to load spam_guard.json:", err.message);
    return null;
  }
}

/**
 * Persist the spam guard state to disk.
 *
 * Sets are converted to arrays for JSON serialization.
 * Uses atomic write (write to .tmp, then rename) so a crash
 * mid-write can't corrupt the file and cause duplicate messages.
 */
function saveSpamGuard(guard) {
  // Convert Sets to arrays for JSON serialization
  const sentThresholds = {};
  for (const [key, set] of Object.entries(guard.sentThresholds || {})) {
    sentThresholds[key] = [...set];
  }
  const cwlSentThresholds = {};
  for (const [key, set] of Object.entries(guard.cwlSentThresholds || {})) {
    cwlSentThresholds[key] = [...set];
  }

  const data = {
    lastAutoReminderAt: guard.lastAutoReminderAt,
    sentThresholds,
    warEndSentForWar: guard.warEndSentForWar,
    preparationSentForWar: guard.preparationSentForWar,
    warStartSentForWar: guard.warStartSentForWar,
    bedtimeRemindedOn: guard.bedtimeRemindedOn,
    cwlSentThresholds,
    cwlPreparationSentForWar: guard.cwlPreparationSentForWar,
    cwlWarStartSentForWar: guard.cwlWarStartSentForWar,
    cwlWarEndSentForWar: guard.cwlWarEndSentForWar,
  };

  // Atomic write: temp file + rename prevents corruption on crash
  const tmpFile = SPAM_GUARD_FILE + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, SPAM_GUARD_FILE);
}

module.exports = {
  loadPlayerMap,
  savePlayerMap,
  loadBedtimeMap,
  saveBedtimeMap,
  loadSpamGuard,
  saveSpamGuard,
};
