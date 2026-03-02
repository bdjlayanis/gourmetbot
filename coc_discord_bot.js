// =============================================================
// coc_discord_bot.js — Main entry point: start the Discord bot
// =============================================================
//
// This is the file you run to start the bot:  node coc_discord_bot.js
//
// It wires together all the other modules:
//   config.js          → credentials and settings
//   persistence.js     → load/save JSON data files
//   scheduler.js       → automatic war checks on a timer
//   commands.js        → slash command definitions and handlers
//
// Startup flow:
//   1. Load persistent state from disk (player links, bedtimes, spam guard)
//   2. Create Discord client and attach command handlers
//   3. On "ready", register slash commands and start the auto-check timer
//   4. Bot runs until killed — the timer fires every 30 minutes
// =============================================================

const { Client, GatewayIntentBits } = require("discord.js");
const { DISCORD_BOT_TOKEN, GUILDS, AUTO_CHECK_INTERVAL_MS } = require("./config");
const { loadPlayerMap, loadBedtimeMap } = require("./persistence");
const { createSpamGuard, runAutoWarCheck } = require("./scheduler");
const { registerCommands, setupHandlers } = require("./commands");

// ---- Load persistent state ----------------------------------
// These are mutable objects shared across the bot's lifetime.
// Commands and the scheduler both read/write to them.

const playerDiscordMap = loadPlayerMap();   // CoC tag → Discord user ID
const bedtimeMap = loadBedtimeMap();        // Discord ID → { time, utcOffset }
const spamGuard = createSpamGuard();        // anti-spam state (restored from disk)

// ---- Discord client -----------------------------------------

const client = new Client({
  intents: [GatewayIntentBits.Guilds],  // minimal intent — we only need slash commands
});

// ---- Send helper (closure over client) ----------------------

/**
 * Send a message to the configured reminder channel in every guild.
 * Used by the scheduler for automatic reminders and announcements.
 */
async function sendToReminderChannel(text) {
  for (const { reminderChannelId } of GUILDS) {
    try {
      const channel = await client.channels.fetch(reminderChannelId);
      if (!channel || !channel.isTextBased()) {
        console.error(`Reminder channel ${reminderChannelId} is not a text channel or was not found.`);
        continue;
      }
      await channel.send(text);
    } catch (err) {
      console.error(`Failed to send to reminder channel ${reminderChannelId}:`, err.message);
    }
  }
}

// ---- Wire up handlers and start -----------------------------
// Attach autocomplete + slash command listeners to the client.

setupHandlers(client, playerDiscordMap, bedtimeMap);

client.once("ready", async () => {
  console.log(`Bot logged in as ${client.user.tag}`);
  await registerCommands(client);

  console.log(
    `Scheduler started: auto war-check every ${AUTO_CHECK_INTERVAL_MS / 60000} minutes.`
  );
  setInterval(
    () => runAutoWarCheck(spamGuard, playerDiscordMap, bedtimeMap, sendToReminderChannel),
    AUTO_CHECK_INTERVAL_MS
  );

  console.log("Ready. Use /war-check or wait for automatic reminders.");
});

// ---- Validate config and connect ----------------------------

if (!DISCORD_BOT_TOKEN) {
  console.error("Error: DISCORD_BOT_TOKEN is not set.");
  process.exit(1);
}
if (!GUILDS || GUILDS.length === 0) {
  console.error("Error: No guilds configured in config.js.");
  process.exit(1);
}

client.login(DISCORD_BOT_TOKEN);
