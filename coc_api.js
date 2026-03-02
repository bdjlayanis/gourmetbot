// =============================================================
// coc_api.js — Clash of Clans REST API wrapper
// =============================================================
//
// Thin wrapper around the official CoC API (https://developer.clashofclans.com).
// Every function makes one HTTP call and returns a clean JS object.
// No business logic lives here — that's in war_analysis.js / cwl_analysis.js.
//
// Used by:  coc_test.js (CLI), commands.js (slash commands), scheduler.js (auto-check)
// =============================================================

const axios = require("axios");
const { COC_API_BASE, COC_API_TOKEN } = require("./config");

// ---- Internal helpers ---------------------------------------

/** URL-encode a tag so the '#' becomes '%23' (required by the CoC API). */
function encodeClanTag(tag) {
  return encodeURIComponent(tag);
}

/** Build the Authorization header for every API request. */
function authHeaders() {
  return { Authorization: `Bearer ${COC_API_TOKEN}` };
}

// ---- API functions ------------------------------------------

/**
 * Fetch the clan's current war (regular war, not CWL).
 * Returns the full war object with state, members, attacks, etc.
 * Possible states: "notInWar", "preparation", "inWar", "warEnded".
 */
async function getCurrentWar(clanTag) {
  const encoded = encodeClanTag(clanTag);
  const url = `${COC_API_BASE}/clans/${encoded}/currentwar`;
  const response = await axios.get(url, { headers: authHeaders() });
  return response.data;
}

/**
 * Fetch a simplified list of clan members (name + tag only).
 * Used for autocomplete on /link and /player-stats commands.
 */
async function getClanMembers(clanTag) {
  const encoded = encodeClanTag(clanTag);
  const url = `${COC_API_BASE}/clans/${encoded}`;
  const response = await axios.get(url, { headers: authHeaders() });
  const members = response.data.memberList || [];
  return members.map((m) => ({ name: m.name, tag: m.tag }));
}

/**
 * Fetch high-level clan info: level, war record, league, member count.
 * Used by the /clan-stats command.
 */
async function getClanInfo(clanTag) {
  const encoded = encodeClanTag(clanTag);
  const url = `${COC_API_BASE}/clans/${encoded}`;
  const response = await axios.get(url, { headers: authHeaders() });
  const d = response.data;

  return {
    name:         d.name,
    tag:          d.tag,
    clanLevel:    d.clanLevel,
    memberCount:  d.members,
    warWins:      d.warWins    ?? 0,
    warLosses:    d.warLosses  ?? 0,
    warTies:      d.warTies    ?? 0,
    warFrequency: d.warFrequency,
    warLeague:    d.warLeague?.name ?? "Unranked",
  };
}

/**
 * Fetch a single player's profile (town hall, trophies, lifetime stats).
 * Used by the /player-stats command.
 */
async function getPlayerInfo(playerTag) {
  const encoded = encodeClanTag(playerTag);
  const url = `${COC_API_BASE}/players/${encoded}`;
  const response = await axios.get(url, { headers: authHeaders() });
  const d = response.data;

  return {
    name:              d.name,
    tag:               d.tag,
    townHallLevel:     d.townHallLevel,
    trophies:          d.trophies,
    warStars:          d.warStars        ?? 0,
    attackWins:        d.attackWins      ?? 0,
    defenseWins:       d.defenseWins     ?? 0,
    donations:         d.donations       ?? 0,
    donationsReceived: d.donationsReceived ?? 0,
    role:              d.role ?? "member",
  };
}

/**
 * Fetch the clan's war log (most recent wars).
 * Only works if the clan's war log is set to public in-game.
 * @param {number} limit  Max entries to return (default 10).
 */
async function getClanWarLog(clanTag, limit = 10) {
  const encoded = encodeClanTag(clanTag);
  const url = `${COC_API_BASE}/clans/${encoded}/warlog`;
  const response = await axios.get(url, { headers: authHeaders() });
  const items = response.data.items || [];
  return items.slice(0, limit);
}

/**
 * Fetch the CWL league group for the current season.
 * Contains the list of 8 clans and round/warTag arrays.
 * Throws 404 if the clan is not currently in CWL.
 */
async function getCwlLeagueGroup(clanTag) {
  const encoded = encodeClanTag(clanTag);
  const url = `${COC_API_BASE}/clans/${encoded}/currentwar/leaguegroup`;
  const response = await axios.get(url, { headers: authHeaders() });
  return response.data;
}

/**
 * Fetch a single CWL war by its war tag.
 * Each CWL round has multiple wars (one per matchup); this fetches one.
 */
async function getCwlWar(warTag) {
  const encoded = encodeClanTag(warTag);
  const url = `${COC_API_BASE}/clanwarleagues/wars/${encoded}`;
  const response = await axios.get(url, { headers: authHeaders() });
  return response.data;
}

// ---- Date parsing -------------------------------------------

/**
 * Convert a CoC API date string to a standard JS Date.
 *
 * The API returns dates in a compact format without separators:
 *   "20260217T150000.000Z"
 *
 * This function inserts the dashes and colons so Date() can parse it:
 *   "2026-02-17T15:00:00.000Z"
 */
function parseWarDate(apiDate) {
  const formatted = apiDate.replace(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/,
    "$1-$2-$3T$4:$5:$6"
  );
  return new Date(formatted);
}

// ---- Error helper -------------------------------------------

/**
 * Turn an axios error into a human-readable message.
 * Handles common CoC API status codes with helpful hints.
 */
function cocErrorMessage(error) {
  if (!error.response) {
    return `Network error: ${error.message}`;
  }
  const status = error.response.status;
  const reason = error.response.data?.reason || error.response.data?.message || "unknown";

  switch (status) {
    case 400: return `Bad request — check the clan tag format. (${reason})`;
    case 403: return `Access denied — the CoC API token is invalid or the IP is not whitelisted. (${reason})`;
    case 404: return `Clan not found — verify the clan tag. (${reason})`;
    case 429: return "Rate limited — too many requests, try again later.";
    case 503: return "Clash of Clans API is under maintenance, try again later.";
    default:  return `CoC API error ${status}: ${reason}`;
  }
}

// ---- Exports ------------------------------------------------

module.exports = {
  getCurrentWar,
  getClanMembers,
  getClanInfo,
  getPlayerInfo,
  getClanWarLog,
  getCwlLeagueGroup,
  getCwlWar,
  parseWarDate,
  cocErrorMessage,
};
