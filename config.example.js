// =============================================================
// config.example.js — Template for config.js
// =============================================================
//
// Copy this file to config.js and fill in your values:
//   cp config.example.js config.js
//
// config.js is in .gitignore so your secrets stay local.
// =============================================================

// ---- Clash of Clans API -------------------------------------

// Base URL for all CoC REST endpoints (v1).
const COC_API_BASE = "https://api.clashofclans.com/v1";

// Bearer token from https://developer.clashofclans.com.
// Tokens are IP-locked — you must whitelist your server's public IP.
const COC_API_TOKEN = "YOUR_COC_API_TOKEN_HERE";

// ---- Clan ---------------------------------------------------

// The clan tag to monitor (include the leading '#').
const CLAN_TAG = "#YOUR_CLAN_TAG";

// ---- Discord ------------------------------------------------

// Bot token from https://discord.com/developers/applications.
const DISCORD_BOT_TOKEN = "YOUR_DISCORD_BOT_TOKEN_HERE";

// Each guild (Discord server) the bot operates in.
// guildId:           the server's snowflake ID
// reminderChannelId: the text channel where automatic reminders are posted
const GUILDS = [
  { guildId: "YOUR_GUILD_ID", reminderChannelId: "YOUR_CHANNEL_ID" },
];

// ---- Scheduler ----------------------------------------------

// How often the automatic war-check loop runs (milliseconds).
const AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1000;       // 30 minutes

// Countdown thresholds (hours before war ends) that trigger
// reminder pings. Each threshold fires only once per war.
const REMINDER_THRESHOLDS_HOURS = [12, 6, 4, 2, 1];

// ---- Caches -------------------------------------------------

// How long the clan member list is cached for autocomplete (milliseconds).
const MEMBER_CACHE_TTL_MS = 10 * 60 * 1000;          // 10 minutes

// ---- Exports ------------------------------------------------

module.exports = {
  COC_API_BASE,
  COC_API_TOKEN,
  CLAN_TAG,
  DISCORD_BOT_TOKEN,
  GUILDS,
  AUTO_CHECK_INTERVAL_MS,
  REMINDER_THRESHOLDS_HOURS,
  MEMBER_CACHE_TTL_MS,
};
