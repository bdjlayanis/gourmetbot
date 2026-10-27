// =============================================================
// test.js — Self-check for the pure logic (no API, no Discord)
// =============================================================
//
// Usage:  node test.js   (needs config.js to exist, like the bot)
// =============================================================

const assert = require("assert");
const { isWarDecided, getWarScoreboard, getWarResult, getMissedAttacks, computeMissedAttacks, getRaidPlayersToRemind } = require("./war_analysis");
const { computeCwlStandings } = require("./cwl_analysis");
const { splitMessage, toEmbedMessages, buildWarEndSummary } = require("./discord_messages");
const { claimThreshold } = require("./scheduler");
const { offsetToTimeZone } = require("./persistence");

const side = (tag, stars, destructionPercentage, members = []) => ({ tag, name: tag, stars, destructionPercentage, members });
const war = (state, clan, opponent, extra = {}) => ({ state, teamSize: 2, clan, opponent, ...extra });

// Result: destruction breaks a star tie
assert.strictEqual(getWarResult(getWarScoreboard(war("warEnded", side("#A", 4, 80), side("#B", 4, 70)))), "Victory");
assert.strictEqual(getWarResult(getWarScoreboard(war("warEnded", side("#A", 4, 70), side("#B", 4, 70)))), "Tie");

// CWL (1 attack each): 5-0 with 1 opponent attack left (max +3) is decided; with 2 attacks/member it isn't
const atk = { attacks: [{ stars: 3 }] };
const cwl = war("inWar", side("#A", 5, 90, [atk, atk]), side("#B", 0, 0, [atk, {}]), { attacksPerMember: 1 });
assert.strictEqual(isWarDecided(getWarScoreboard(cwl), cwl), true);
assert.strictEqual(isWarDecided(getWarScoreboard(cwl), { ...cwl, attacksPerMember: 2 }), false);

// CWL standings: +10 stars per win, in-progress rounds count stars but no W/L
const standings = computeCwlStandings(
  [war("warEnded", side("#A", 4, 80), side("#B", 5, 90)), war("inWar", side("#A", 3, 50), side("#C", 0, 0))],
  [{ tag: "#A", name: "A" }, { tag: "#B", name: "B" }, { tag: "#C", name: "C" }]
);
assert.deepStrictEqual(standings.map((s) => [s.tag, s.stars, s.wins, s.losses]), [["#B", 15, 1, 0], ["#A", 7, 0, 1], ["#C", 0, 0, 0]]);

// Thresholds [12,6,4,2,1]: starting at 3h left sends "< 4h" once, never the older 6h/12h after
const sent = {};
assert.strictEqual(claimThreshold(sent, "w", 3), 4);
assert.strictEqual(claimThreshold(sent, "w", 3), null);
assert.strictEqual(claimThreshold(sent, "w", 1), 2);
assert.strictEqual(claimThreshold(sent, "w", 0), 1);
assert.strictEqual(claimThreshold(sent, "w", 13), null);

// Long messages split on lines, every chunk within Discord's limit, nothing lost
const long = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
const chunks = splitMessage(long);
assert.ok(chunks.length > 1 && chunks.every((c) => c.length <= 2000));
assert.strictEqual(chunks.join("\n"), long);

// End summary lists unused attacks
const ended = war("warEnded", side("#A", 3, 60, [{ name: "Bob", attacks: [{ stars: 3 }] }, { name: "Al" }]), side("#B", 1, 20));
assert.match(buildWarEndSummary(ended, "War Over"), /Victory[\s\S]*Missed attacks:\*\* Bob \(1\), Al \(2\)/);

// Missed history: CWL counts 1 attack/member; Al missed 2 + 1 over 2 wars, Bob 1 over 1, Cy never → excluded
const cwlEnded = war("warEnded", side("#A", 3, 60, [{ tag: "#AL", name: "Al" }, { tag: "#CY", name: "Cy", attacks: [{}] }]), side("#B", 1, 20), { attacksPerMember: 1 });
const regular = { ...ended, clan: { ...ended.clan, members: [{ tag: "#BOB", name: "Bob", attacks: [{}] }, { tag: "#AL", name: "Al" }] } };
const missed = computeMissedAttacks([regular, cwlEnded].map((w) => ({ members: getMissedAttacks(w) })));
assert.deepStrictEqual(missed.map((p) => [p.name, p.missed, p.wars]), [["Al", 3, 2], ["Bob", 1, 1]]);

// Raid: only players who started are reminded; the bonus 6th attack counts
const raid = { members: [
  { tag: "#1", name: "Done", attacks: 6, attackLimit: 5, bonusAttackLimit: 1 },
  { tag: "#2", name: "Bonus", attacks: 5, attackLimit: 5, bonusAttackLimit: 1 },
  { tag: "#3", name: "Started", attacks: 2, attackLimit: 5, bonusAttackLimit: 0 },
] };
assert.deepStrictEqual(getRaidPlayersToRemind(raid).map((p) => [p.name, p.attacks, p.limit]), [["Bonus", 5, 6], ["Started", 2, 5]]);

// Embeds: first line → title, mentions repeated in content (embeds don't ping), long bodies split at 4096
const [msg] = toEmbedMessages("**⏰ War Reminder**\nGo!\n<@1> (0 attacks)\n<@2> (0 attacks)");
assert.strictEqual(msg.embeds[0].title, "⏰ War Reminder");
assert.strictEqual(msg.content, "<@1> <@2>");
assert.strictEqual(toEmbedMessages("🌙 <@9> — Bedtime soon")[0].embeds[0].title, undefined);
const many = toEmbedMessages("**Big**\n" + long + "\n" + long);
assert.ok(many.length > 1 && many.every((m) => m.embeds[0].description.length <= 4096) && many[1].content === undefined);

// Offsets map to fixed IANA zones (inverted sign), and Intl accepts them
assert.strictEqual(offsetToTimeZone(2), "Etc/GMT-2");
assert.strictEqual(offsetToTimeZone(-5), "Etc/GMT+5");
for (let h = -12; h <= 14; h++) new Intl.DateTimeFormat("en-US", { timeZone: offsetToTimeZone(h) });

console.log("All checks passed.");
