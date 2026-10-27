// =============================================================
// persistence.js — Read/write JSON data files to disk
// =============================================================
//
// Four JSON files store the bot's persistent state:
//
//   player_map.json   — CoC player tag → Discord user ID links
//   bedtime_map.json  — Discord user ID → { time, timeZone } settings
//   spam_guard.json   — Anti-spam state so the bot doesn't repeat
//                        messages after a restart
//   war_history.json  — Missed attacks per player for every ended war
//
// The spam guard and war history use an atomic write (write to .tmp
// then rename) so a crash mid-write can't corrupt them. The other two
// files are small enough that corruption risk is negligible.
// =============================================================

const fs = require("fs");
const path = require("path");

// Resolve paths relative to this file's directory (project root)
const PLAYER_MAP_FILE = path.join(__dirname, "player_map.json");
const BEDTIME_MAP_FILE = path.join(__dirname, "bedtime_map.json");
const SPAM_GUARD_FILE = path.join(__dirname, "spam_guard.json");
const WAR_HISTORY_FILE = path.join(__dirname, "war_history.json");

/** Write JSON via temp file + rename, so a crash mid-write can't corrupt it. */
function writeJsonAtomic(file, json) {
  fs.writeFileSync(file + ".tmp", json);
  fs.renameSync(file + ".tmp", file);
}

/**
 * Fixed UTC offset in hours → IANA zone name. Note the inverted sign:
 * "Etc/GMT-2" is UTC+2. Fixed zones have no daylight saving time.
 */
function offsetToTimeZone(hours) {
  return hours === 0 ? "UTC" : `Etc/GMT${hours > 0 ? "-" : "+"}${Math.abs(hours)}`;
}

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

/**
 * Load bedtime settings. Returns {} if the file doesn't exist yet.
 * Old entries stored a fixed { utcOffset }; they become a fixed zone
 * so they keep working (users re-run /bedtime to get DST handling).
 */
function loadBedtimeMap() {
  try {
    const raw = fs.readFileSync(BEDTIME_MAP_FILE, "utf-8");
    const data = JSON.parse(raw);
    for (const settings of Object.values(data)) {
      settings.timeZone ??= offsetToTimeZone(settings.utcOffset);
      delete settings.utcOffset;
    }
    return data;
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
    for (const field of ["sentThresholds", "cwlSentThresholds", "raidSentThresholds"]) {
      for (const [key, arr] of Object.entries(data[field] || {})) {
        data[field][key] = new Set(arr);
      }
    }

    return data;
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
  // Every field is saved (no whitelist to forget to update);
  // Sets become arrays since JSON has no Set type
  const json = JSON.stringify(guard, (key, value) => (value instanceof Set ? [...value] : value), 2);

  writeJsonAtomic(SPAM_GUARD_FILE, json);
}

/**
 * Load the recorded wars: [{ endTime, cwl, opponent, members: [{ tag, name, missed }] }].
 * Returns [] if the file doesn't exist yet.
 */
function loadWarHistory() {
  try {
    return JSON.parse(fs.readFileSync(WAR_HISTORY_FILE, "utf-8"));
  } catch {
    return [];
  }
}

/** Record one ended war. Ignored if that war (same endTime) is already in. */
function appendWarHistory(entry) {
  const history = loadWarHistory();
  if (history.some((w) => w.endTime === entry.endTime)) return;
  // ponytail: grows ~150 wars/year (~200 KB), prune old entries if it ever matters
  history.push(entry);
  writeJsonAtomic(WAR_HISTORY_FILE, JSON.stringify(history));
}

module.exports = {
  offsetToTimeZone,
  loadWarHistory,
  appendWarHistory,
  loadPlayerMap,
  savePlayerMap,
  loadBedtimeMap,
  saveBedtimeMap,
  loadSpamGuard,
  saveSpamGuard,
};
