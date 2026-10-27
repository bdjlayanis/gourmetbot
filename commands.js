// =============================================================
// commands.js — Slash command definitions, registration, handlers
// =============================================================
//
// Everything related to Discord slash commands lives here:
//
//   1. Command definitions  — what shows up in the Discord "/" menu
//   2. Registration         — pushes definitions to the Discord API per guild
//   3. Autocomplete handler — clan members for /link and /player-stats, time zones for /bedtime
//   4. Command handlers     — the logic behind each slash command
//
// Supported commands:
//   /war-check, /link, /links, /clan-stats, /player-stats,
//   /war-log, /bedtime, /bedtime-clear, /cwl-check,
//   /cwl-standings, /cwl-stats, /missed, /raid-check, /help
// =============================================================

const { SlashCommandBuilder, REST, Routes } = require("discord.js");
const {
  CLAN_TAG,
  DISCORD_BOT_TOKEN,
  GUILDS,
  MEMBER_CACHE_TTL_MS,
} = require("./config");
const {
  getCurrentWar,
  getClanMembers,
  getClanInfo,
  getPlayerInfo,
  getClanWarLog,
  getCapitalRaidSeason,
  parseWarDate,
  cocErrorMessage,
} = require("./coc_api");
const {
  toEmbedMessages,
  buildMissedAttacksMessage,
  buildRaidMessage,
  buildWarMessage,
  buildClanStatsMessage,
  buildPlayerStatsMessage,
  buildWarLogMessage,
  buildCwlWarMessage,
  buildCwlStandingsMessage,
  buildCwlStatsMessage,
} = require("./discord_messages");
const { getCurrentCwlWar, getAllCwlWarsForClan, getAllCwlRoundWars } = require("./cwl_api");
const { getCwlLeagueGroup } = require("./coc_api");
const { computeCwlStandings, computeCwlPlayerStats } = require("./cwl_analysis");
const { computeMissedAttacks } = require("./war_analysis");
const { savePlayerMap, saveBedtimeMap, loadWarHistory, offsetToTimeZone } = require("./persistence");

// All IANA zones known to Node (e.g. "Europe/Paris"), for /bedtime autocomplete
const TIME_ZONES = Intl.supportedValuesOf("timeZone");

// ---- Clan member cache (private to this module) -------------
// Cached so autocomplete doesn't hit the CoC API on every keystroke.
// TTL is configured via MEMBER_CACHE_TTL_MS (default: 10 minutes).

const memberCache = {
  members: [],
  fetchedAt: 0,
};

/** Return cached clan members, refreshing from the API if stale. */
async function getCachedClanMembers() {
  const now = Date.now();
  if (memberCache.members.length > 0 && (now - memberCache.fetchedAt) < MEMBER_CACHE_TTL_MS) {
    return memberCache.members;
  }

  try {
    const members = await getClanMembers(CLAN_TAG);
    members.sort((a, b) => a.name.localeCompare(b.name));
    memberCache.members = members;
    memberCache.fetchedAt = now;
    return members;
  } catch (err) {
    console.error("Failed to fetch clan members for autocomplete:", err.message);
    return memberCache.members;
  }
}

/** Reply to a deferred command as embed(s): editReply the first, followUp the rest. */
async function replyLong(interaction, text) {
  const [first, ...rest] = toEmbedMessages(text);
  await interaction.editReply(first);
  for (const message of rest) await interaction.followUp(message);
}

// ---- Command definitions ------------------------------------

/** Build all slash command definitions using discord.js SlashCommandBuilder. */
function getCommandDefinitions() {
  const warCheckCommand = new SlashCommandBuilder()
    .setName("war-check")
    .setDescription("Check the current Clan War and remind players who still need to attack.");

  const linkCommand = new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link a Clash of Clans player to a Discord user.")
    .addStringOption((opt) =>
      opt
        .setName("player")
        .setDescription("Start typing a player name to search your clan")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addUserOption((opt) =>
      opt.setName("discord_user").setDescription("The Discord user to link").setRequired(true)
    );

  const linksCommand = new SlashCommandBuilder()
    .setName("links")
    .setDescription("Show all linked CoC players and their Discord accounts.");

  const clanStatsCommand = new SlashCommandBuilder()
    .setName("clan-stats")
    .setDescription("Show clan level, war record, member count, and war league.");

  const playerStatsCommand = new SlashCommandBuilder()
    .setName("player-stats")
    .setDescription("Show a player's war performance and lifetime stats.")
    .addStringOption((opt) =>
      opt
        .setName("player")
        .setDescription("Start typing a player name to search your clan")
        .setRequired(true)
        .setAutocomplete(true)
    );

  const warLogCommand = new SlashCommandBuilder()
    .setName("war-log")
    .setDescription("Show recent war results (requires public war log).")
    .addIntegerOption((opt) =>
      opt
        .setName("count")
        .setDescription("Number of wars to show (1-10, default 5)")
        .setMinValue(1)
        .setMaxValue(10)
        .setRequired(false)
    );

  const bedtimeCommand = new SlashCommandBuilder()
    .setName("bedtime")
    .setDescription("Set a personal bedtime reminder for war days.")
    .addStringOption((opt) =>
      opt
        .setName("time")
        .setDescription("Your bedtime in 24h format, e.g. 23:00")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("timezone")
        .setDescription("Your time zone, e.g. Europe/Paris (handles summer time). A fixed offset like +2 also works.")
        .setRequired(true)
        .setAutocomplete(true)
    );

  const bedtimeClearCommand = new SlashCommandBuilder()
    .setName("bedtime-clear")
    .setDescription("Remove your bedtime reminder.");

  const cwlCheckCommand = new SlashCommandBuilder()
    .setName("cwl-check")
    .setDescription("Check the current CWL war and see who still needs to attack.");

  const cwlStandingsCommand = new SlashCommandBuilder()
    .setName("cwl-standings")
    .setDescription("Show CWL group standings (all 8 clans).");

  const cwlStatsCommand = new SlashCommandBuilder()
    .setName("cwl-stats")
    .setDescription("Show per-player CWL performance across all rounds.");

  const missedCommand = new SlashCommandBuilder()
    .setName("missed")
    .setDescription("Rank players by missed war attacks (wars and CWL rounds).")
    .addIntegerOption((opt) =>
      opt
        .setName("days")
        .setDescription("How far back to look (default 30)")
        .setMinValue(1)
        .setMaxValue(365)
        .setRequired(false)
    );

  const raidCheckCommand = new SlashCommandBuilder()
    .setName("raid-check")
    .setDescription("Check the raid weekend and see who still has raid attacks left.");

  const helpCommand = new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show all available commands and what the bot does.");

  return [
    warCheckCommand,
    linkCommand,
    linksCommand,
    clanStatsCommand,
    playerStatsCommand,
    warLogCommand,
    bedtimeCommand,
    bedtimeClearCommand,
    cwlCheckCommand,
    cwlStandingsCommand,
    cwlStatsCommand,
    missedCommand,
    raidCheckCommand,
    helpCommand,
  ];
}

// ---- Registration -------------------------------------------

/**
 * Register all slash commands with Discord for each configured guild.
 * Uses guild-scoped registration (instant) rather than global (up to 1h delay).
 */
async function registerCommands(client) {
  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);

  const commands = getCommandDefinitions().map((c) => c.toJSON());

  console.log("Registering slash commands...");
  for (const { guildId } of GUILDS) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guildId),
        { body: commands }
      );
      console.log(`${commands.length} slash commands registered for guild ${guildId}.`);
    } catch (err) {
      console.error(`Failed to register slash commands for guild ${guildId}:`, err.message);
    }
  }
}

// ---- Handler setup ------------------------------------------

/**
 * Wire up autocomplete and command handlers on the Discord client.
 *
 * @param {Client} client            Discord.js client
 * @param {object} playerDiscordMap  Mutable CoC tag → Discord ID map
 * @param {object} bedtimeMap        Mutable Discord ID → bedtime settings
 */
function setupHandlers(client, playerDiscordMap, bedtimeMap) {
  // ---- Autocomplete handler ---------------------------------
  // Provides fuzzy search for /link and /player-stats.
  // As the user types, we filter cached clan members by name or tag
  // and return up to 25 matching choices (Discord's autocomplete limit).
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isAutocomplete()) return;

    const { commandName } = interaction;
    const focused = interaction.options.getFocused().toLowerCase();

    // /bedtime timezone: search the IANA zone list ("paris" → Europe/Paris)
    if (commandName === "bedtime") {
      const zones = TIME_ZONES.filter((z) => z.toLowerCase().includes(focused)).slice(0, 25);
      await interaction.respond(zones.map((z) => ({ name: z, value: z })));
      return;
    }

    if (commandName !== "link" && commandName !== "player-stats") return;

    try {
      const members = await getCachedClanMembers();

      // Match on player name or tag (case-insensitive substring match)
      const filtered = members.filter(
        (m) =>
          m.name.toLowerCase().includes(focused) ||
          m.tag.toLowerCase().includes(focused)
      );

      // Discord limits autocomplete to 25 choices
      const choices = filtered.slice(0, 25).map((m) => ({
        name: `${m.name} (${m.tag})`,
        value: m.tag,
      }));

      await interaction.respond(choices);
    } catch {
      await interaction.respond([]);
    }
  });

  // ---- Slash command handlers --------------------------------
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    // /war-check
    if (commandName === "war-check") {
      await interaction.deferReply();
      try {
        const warData = await getCurrentWar(CLAN_TAG);
        const message = buildWarMessage(warData, playerDiscordMap, { isManual: true });
        await replyLong(interaction, message);
      } catch (error) {
        const errMsg = cocErrorMessage(error);
        console.error("war-check error:", errMsg);
        try {
          await interaction.editReply(`❌ ${errMsg}`);
        } catch (discordErr) {
          console.error("Failed to send error reply:", discordErr.message);
        }
      }
      return;
    }

    // /link — associate a CoC player tag with a Discord user for @mentions
    if (commandName === "link") {
      let tag = interaction.options.getString("player").toUpperCase().trim();
      if (!tag.startsWith("#")) tag = "#" + tag;  // normalize tag format

      const user = interaction.options.getUser("discord_user");

      playerDiscordMap[tag] = user.id;
      savePlayerMap(playerDiscordMap);  // persist to disk immediately

      await interaction.reply(`✅ Linked **${tag}** → **${user.displayName}**`);
      return;
    }

    // /links — show all linked CoC players and their Discord accounts
    if (commandName === "links") {
      const entries = Object.entries(playerDiscordMap);

      if (entries.length === 0) {
        await interaction.reply("No players linked yet. Use `/link` to add one.");
        return;
      }

      await interaction.deferReply();

      const members = await getCachedClanMembers();
      const nameMap = {};
      for (const m of members) {
        nameMap[m.tag] = m.name;
      }

      const lines = await Promise.all(
        entries.map(async ([tag, discordId]) => {
          const cocName = nameMap[tag] || tag;
          let discordName = discordId;
          try {
            const user = await client.users.fetch(discordId);
            discordName = user.displayName;
          } catch {
            // User may not exist — fall back to raw ID
          }
          return `**${cocName}** (${tag}) → **${discordName}**`;
        })
      );

      await replyLong(interaction, `**Linked players (${entries.length}):**\n${lines.join("\n")}`);
      return;
    }

    // /clan-stats — show clan level, war record, member count, league
    if (commandName === "clan-stats") {
      await interaction.deferReply();
      try {
        const info = await getClanInfo(CLAN_TAG);
        await replyLong(interaction, buildClanStatsMessage(info));
      } catch (error) {
        await interaction.editReply(`❌ ${cocErrorMessage(error)}`);
      }
      return;
    }

    // /player-stats — show a player's profile and current war performance
    if (commandName === "player-stats") {
      await interaction.deferReply();

      let tag = interaction.options.getString("player").toUpperCase().trim();
      if (!tag.startsWith("#")) tag = "#" + tag;

      try {
        const [playerInfo, warData] = await Promise.all([
          getPlayerInfo(tag),
          getCurrentWar(CLAN_TAG).catch(() => null),
        ]);
        await replyLong(interaction, buildPlayerStatsMessage(playerInfo, warData, tag));
      } catch (error) {
        await interaction.editReply(`❌ ${cocErrorMessage(error)}`);
      }
      return;
    }

    // /war-log — show recent war results (requires public war log in-game)
    if (commandName === "war-log") {
      await interaction.deferReply();

      const count = interaction.options.getInteger("count") ?? 5;

      try {
        const entries = await getClanWarLog(CLAN_TAG, count);
        await replyLong(interaction, buildWarLogMessage(entries));
      } catch (error) {
        if (error.response?.status === 403) {
          await interaction.editReply(
            "❌ This clan's war log is set to **private** in-game. The leader must set it to public."
          );
        } else {
          await interaction.editReply(`❌ ${cocErrorMessage(error)}`);
        }
      }
      return;
    }

    // /bedtime — set a personal bedtime reminder for war days
    // Validates HH:MM format and time zone, then stores in bedtime_map.json.
    if (commandName === "bedtime") {
      const timeStr = interaction.options.getString("time").trim();
      const zoneStr = interaction.options.getString("timezone").trim();

      const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})$/);
      if (!timeMatch) {
        await interaction.reply({ content: "❌ Invalid time format. Use HH:MM (24h), e.g. `23:00`.", ephemeral: true });
        return;
      }
      const hour = parseInt(timeMatch[1], 10);
      const minute = parseInt(timeMatch[2], 10);
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        await interaction.reply({ content: "❌ Invalid time. Hours must be 0–23, minutes 0–59.", ephemeral: true });
        return;
      }

      // Either a fixed offset ("+2", "UTC-5") or an IANA zone ("Europe/Paris")
      const offsetMatch = zoneStr.match(/^(?:UTC|GMT)?([+-]?\d{1,2})$/i);
      const utcOffset = offsetMatch ? parseInt(offsetMatch[1], 10) : null;
      if (utcOffset !== null && (utcOffset < -12 || utcOffset > 14)) {
        await interaction.reply({ content: "❌ UTC offset must be between -12 and +14.", ephemeral: true });
        return;
      }

      let timeZone;
      try {
        // Intl throws on unknown zones and canonicalises case ("europe/paris" → "Europe/Paris")
        timeZone = new Intl.DateTimeFormat("en-US", {
          timeZone: utcOffset !== null ? offsetToTimeZone(utcOffset) : zoneStr,
        }).resolvedOptions().timeZone;
      } catch {
        await interaction.reply({ content: "❌ Unknown time zone. Pick one from the list (e.g. `Europe/Paris`) or use an offset like `+2`.", ephemeral: true });
        return;
      }

      const normalised = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

      bedtimeMap[interaction.user.id] = { time: normalised, timeZone };
      saveBedtimeMap(bedtimeMap);

      const dstNote = utcOffset !== null ? "\n-# Fixed offset: it won't follow summer/winter time. Pick a zone like `Europe/Paris` for that." : "";
      await interaction.reply(`✅ Bedtime set to **${normalised}** (${timeZone}). You'll be reminded ~30 min before if there's an active war and you still need to attack.${dstNote}`);
      return;
    }

    // /bedtime-clear — remove the user's bedtime reminder
    if (commandName === "bedtime-clear") {
      if (!bedtimeMap[interaction.user.id]) {
        await interaction.reply({ content: "You don't have a bedtime set.", ephemeral: true });
        return;
      }

      delete bedtimeMap[interaction.user.id];
      saveBedtimeMap(bedtimeMap);

      await interaction.reply("✅ Bedtime reminder removed.");
      return;
    }

    // /cwl-check — check the current CWL round and show who needs to attack
    if (commandName === "cwl-check") {
      await interaction.deferReply();
      try {
        const result = await getCurrentCwlWar(CLAN_TAG);
        if (!result) {
          await interaction.editReply("The clan is not currently in CWL, or no CWL wars are available.");
          return;
        }
        const message = buildCwlWarMessage(result.war, result.roundIndex, playerDiscordMap, { isManual: true });
        await replyLong(interaction, message);
      } catch (error) {
        if (error.response?.status === 404) {
          await interaction.editReply("The clan is not currently in CWL.");
        } else {
          const errMsg = cocErrorMessage(error);
          console.error("cwl-check error:", errMsg);
          try {
            await interaction.editReply(`❌ ${errMsg}`);
          } catch (discordErr) {
            console.error("Failed to send error reply:", discordErr.message);
          }
        }
      }
      return;
    }

    // /cwl-standings — show ranked CWL group standings for all 8 clans
    if (commandName === "cwl-standings") {
      await interaction.deferReply();
      try {
        const leagueGroup = await getCwlLeagueGroup(CLAN_TAG);
        const allWars = await getAllCwlRoundWars(leagueGroup);
        const standings = computeCwlStandings(allWars, leagueGroup.clans || []);
        const season = leagueGroup.season || null;
        await replyLong(interaction, buildCwlStandingsMessage(standings, season));
      } catch (error) {
        if (error.response?.status === 404) {
          await interaction.editReply("The clan is not currently in CWL.");
        } else {
          const errMsg = cocErrorMessage(error);
          console.error("cwl-standings error:", errMsg);
          try {
            await interaction.editReply(`❌ ${errMsg}`);
          } catch (discordErr) {
            console.error("Failed to send error reply:", discordErr.message);
          }
        }
      }
      return;
    }

    // /cwl-stats — show per-player CWL performance across all rounds
    if (commandName === "cwl-stats") {
      await interaction.deferReply();
      try {
        const { wars, leagueGroup } = await getAllCwlWarsForClan(CLAN_TAG);
        const playerStats = computeCwlPlayerStats(wars);
        const season = leagueGroup.season || null;
        await replyLong(interaction, buildCwlStatsMessage(playerStats, season));
      } catch (error) {
        if (error.response?.status === 404) {
          await interaction.editReply("The clan is not currently in CWL.");
        } else {
          const errMsg = cocErrorMessage(error);
          console.error("cwl-stats error:", errMsg);
          try {
            await interaction.editReply(`❌ ${errMsg}`);
          } catch (discordErr) {
            console.error("Failed to send error reply:", discordErr.message);
          }
        }
      }
      return;
    }

    // /missed — rank players by missed attacks over the last N days
    if (commandName === "missed") {
      await interaction.deferReply();
      const days = interaction.options.getInteger("days") ?? 30;
      const since = Date.now() - days * 24 * 60 * 60 * 1000;
      const wars = loadWarHistory().filter((w) => parseWarDate(w.endTime).getTime() >= since);
      await replyLong(interaction, buildMissedAttacksMessage(computeMissedAttacks(wars), days, wars.length));
      return;
    }

    // /raid-check — raid weekend status and who still has raid attacks left
    if (commandName === "raid-check") {
      await interaction.deferReply();
      try {
        const raid = await getCapitalRaidSeason(CLAN_TAG);
        await replyLong(interaction, buildRaidMessage(raid, playerDiscordMap, { isManual: true }));
      } catch (error) {
        await interaction.editReply(`❌ ${cocErrorMessage(error)}`);
      }
      return;
    }

    // /help — show all available commands (ephemeral so only the caller sees it)
    if (commandName === "help") {
      const helpText = [
        "**Clash of Clans War Reminder Bot**",
        "",
        "**War Commands:**",
        "`/war-check` — Check the current war status and see who still needs to attack.",
        "`/war-log [count]` — Show recent war results (1–10, default 5).",
        "`/missed [days]` — Rank players by missed attacks (wars + CWL, default 30 days).",
        "",
        "**Raid Weekend:**",
        "`/raid-check` — Raid weekend status and who still has raid attacks left.",
        "",
        "**CWL Commands:**",
        "`/cwl-check` — Check the current CWL war and see who still needs to attack.",
        "`/cwl-standings` — Show CWL group standings (all 8 clans).",
        "`/cwl-stats` — Show per-player CWL performance across all rounds.",
        "",
        "**Player & Clan:**",
        "`/link <player> <discord_user>` — Link a CoC player to a Discord account for @mentions in reminders.",
        "`/links` — Show all linked players.",
        "`/clan-stats` — Show clan level, war record, member count, and league.",
        "`/player-stats <player>` — Show a player's stats and current war performance.",
        "`/bedtime <time> <timezone>` — Set a personal bedtime reminder (e.g. `/bedtime 23:00 Europe/Paris`).",
        "`/bedtime-clear` — Remove your bedtime reminder.",
        "`/help` — Show this message.",
        "",
        "**Automatic reminders:**",
        "The bot checks for active wars and CWL every 30 minutes and pings players who haven't used their attacks.",
        "Countdown alerts fire at 12h, 6h, 4h, 2h, and 1h remaining.",
        "A summary with the result is posted when each war ends.",
        "Raid weekends get a start announcement, reminders for unused raid attacks, and an end summary.",
      ];
      await interaction.reply({ content: helpText.join("\n"), ephemeral: true });
      return;
    }
  });
}

module.exports = {
  getCommandDefinitions,
  registerCommands,
  setupHandlers,
};
