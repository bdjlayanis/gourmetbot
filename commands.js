// =============================================================
// commands.js — Slash command definitions, registration, handlers
// =============================================================
//
// Everything related to Discord slash commands lives here:
//
//   1. Command definitions  — what shows up in the Discord "/" menu
//   2. Registration         — pushes definitions to the Discord API per guild
//   3. Autocomplete handler — fuzzy-searches clan members for /link and /player-stats
//   4. Command handlers     — the logic behind each slash command
//
// Supported commands:
//   /war-check, /link, /links, /clan-stats, /player-stats,
//   /war-log, /bedtime, /bedtime-clear, /cwl-check,
//   /cwl-standings, /cwl-stats, /help
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
  cocErrorMessage,
} = require("./coc_api");
const {
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
const { savePlayerMap, saveBedtimeMap } = require("./persistence");

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
        .setName("utc_offset")
        .setDescription("Your UTC offset, e.g. +2 or -5")
        .setRequired(true)
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
    if (commandName !== "link" && commandName !== "player-stats") return;

    const focused = interaction.options.getFocused().toLowerCase();

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
        await interaction.editReply(message);
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

      await interaction.editReply(
        `**Linked players (${entries.length}):**\n${lines.join("\n")}`
      );
      return;
    }

    // /clan-stats — show clan level, war record, member count, league
    if (commandName === "clan-stats") {
      await interaction.deferReply();
      try {
        const info = await getClanInfo(CLAN_TAG);
        await interaction.editReply(buildClanStatsMessage(info));
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
        await interaction.editReply(buildPlayerStatsMessage(playerInfo, warData, tag));
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
        await interaction.editReply(buildWarLogMessage(entries));
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
    // Validates HH:MM format and UTC offset, then stores in bedtime_map.json.
    if (commandName === "bedtime") {
      const timeStr = interaction.options.getString("time").trim();
      const offsetStr = interaction.options.getString("utc_offset").trim();

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

      const offsetMatch = offsetStr.match(/^([+-]?)(\d{1,2})$/);
      if (!offsetMatch) {
        await interaction.reply({ content: "❌ Invalid UTC offset. Use e.g. `+2`, `-5`, `0`.", ephemeral: true });
        return;
      }
      const utcOffset = offsetMatch[1] === "-"
        ? -parseInt(offsetMatch[2], 10)
        : parseInt(offsetMatch[2], 10);

      if (utcOffset < -12 || utcOffset > 14) {
        await interaction.reply({ content: "❌ UTC offset must be between -12 and +14.", ephemeral: true });
        return;
      }

      const normalised = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

      bedtimeMap[interaction.user.id] = { time: normalised, utcOffset };
      saveBedtimeMap(bedtimeMap);

      const sign = utcOffset >= 0 ? "+" : "";
      await interaction.reply(`✅ Bedtime set to **${normalised}** (UTC${sign}${utcOffset}). You'll be reminded ~30 min before if there's an active war and you still need to attack.`);
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
        await interaction.editReply(message);
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
        await interaction.editReply(buildCwlStandingsMessage(standings, season));
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
        await interaction.editReply(buildCwlStatsMessage(playerStats, season));
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

    // /help — show all available commands (ephemeral so only the caller sees it)
    if (commandName === "help") {
      const helpText = [
        "**Clash of Clans War Reminder Bot**",
        "",
        "**War Commands:**",
        "`/war-check` — Check the current war status and see who still needs to attack.",
        "`/war-log [count]` — Show recent war results (1–10, default 5).",
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
        "`/bedtime <time> <utc_offset>` — Set a personal bedtime reminder (e.g. `/bedtime 23:00 +2`).",
        "`/bedtime-clear` — Remove your bedtime reminder.",
        "`/help` — Show this message.",
        "",
        "**Automatic reminders:**",
        "The bot checks for active wars and CWL every 30 minutes and pings players who haven't used their attacks.",
        "Countdown alerts fire at 12h, 6h, 4h, 2h, and 1h remaining.",
        "A summary with the result is posted when each war ends.",
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
