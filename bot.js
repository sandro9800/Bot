const {
  Client, GatewayIntentBits, EmbedBuilder,
  ButtonBuilder, ButtonStyle, ActionRowBuilder,
  ChannelType, PermissionFlagsBits, Partials,
  StringSelectMenuBuilder, AttachmentBuilder
} = require("discord.js");
const fs   = require("fs");
const path = require("path");

// ── EDIT THESE ────────────────────────────────────────────────────────────────
const TOKEN            = ""; // ⚠️ Put your token in a .env file!
const ALLOWED_USERS    = ["1188143467948417024", "1496199601861034035"];
const DEFAULT_COOLDOWN = 300; // seconds (5 minutes)
// ─────────────────────────────────────────────────────────────────────────────

const PREFIX        = "?";
const DB_FILE       = "db.txt";
const STORAGE_FILE  = path.join(__dirname, "storage.json");
const CLIENTS_FILE  = path.join(__dirname, "clients.json");
const CLIENTS_DIR   = path.join(__dirname, "clients");

// ── Client Catalog Helpers ────────────────────────────────────────────────────

function getClients() {
  if (!fs.existsSync(CLIENTS_FILE)) fs.writeFileSync(CLIENTS_FILE, JSON.stringify([]));
  return JSON.parse(fs.readFileSync(CLIENTS_FILE, "utf-8"));
}

function saveClients(list) {
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify(list, null, 2));
}

const allowedSet     = new Set(ALLOWED_USERS);
const userCooldowns  = {};
const lastClick      = {};
const purgeIntervals = {}; // channelId -> intervalId
const giveaways      = {}; // messageId -> { item, entries: Set, endsAt, channelId, timeoutId }
const giveawaysByName  = {}; // itemName.toLowerCase() -> messageId
const giveawayRerolData = {}; // itemName.toLowerCase() -> { entries[], item, channelId } after end
const LOW_STOCK_THRESHOLD = 5;  // ← change this to your preferred low-stock alert number
const LOW_STOCK_ALERTED   = new Set(); // messageIds already alerted, avoid spam

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// ── Storage Helpers (for tracking gen panel messages) ─────────────────────────

function getStorage() {
  if (!fs.existsSync(STORAGE_FILE))
    fs.writeFileSync(STORAGE_FILE, JSON.stringify({ genMessages: [] }));
  return JSON.parse(fs.readFileSync(STORAGE_FILE, "utf-8"));
}

function saveStorage(data) {
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2));
}

// ── DB Helpers ────────────────────────────────────────────────────────────────

function readLines() {
  if (!fs.existsSync(DB_FILE)) return [];
  return fs.readFileSync(DB_FILE, "utf-8").split("\n").map(l => l.trimEnd()).filter(l => l.length > 0);
}

function popFirstLine() {
  const lines = readLines();
  if (!lines.length) return null;
  fs.writeFileSync(DB_FILE, lines.slice(1).join("\n") + (lines.length > 1 ? "\n" : ""), "utf-8");
  return lines[0];
}

// ── Cooldown Helpers ──────────────────────────────────────────────────────────

function getCooldown(userId) {
  return userCooldowns[userId] !== undefined ? userCooldowns[userId] : DEFAULT_COOLDOWN;
}

function secondsUntilReady(userId) {
  const elapsed = (Date.now() - (lastClick[userId] || 0)) / 1000;
  return Math.max(0, getCooldown(userId) - elapsed);
}

function fmtTime(s) {
  s = Math.ceil(s);
  if (s >= 86400) {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  if (s >= 60) {
    const m = Math.floor(s / 60);
    return m + "m " + (s % 60) + "s";
  }
  return s + "s";
}

// ── Purge Helpers ─────────────────────────────────────────────────────────────

// Parses "30s", "5m", "2h", "1d" → milliseconds. Returns null if invalid.
function parseInterval(str) {
  const match = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const n = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "s") return n * 1000;
  if (unit === "m") return n * 60 * 1000;
  if (unit === "h") return n * 3600 * 1000;
  if (unit === "d") return n * 86400 * 1000;
  return null;
}

function fmtInterval(ms) {
  const s = ms / 1000;
  if (s >= 86400) return (s / 86400) + "d";
  if (s >= 3600)  return (s / 3600) + "h";
  if (s >= 60)    return (s / 60) + "m";
  return s + "s";
}

async function purgeChannel(channel) {
  try {
    // bulkDelete only works on messages < 14 days old, max 100 at a time
    let deleted;
    do {
      deleted = await channel.bulkDelete(100, true);
    } while (deleted.size >= 2);
  } catch (err) {
    console.error(`Auto-purge error in #${channel.name}:`, err.message);
  }
}

function startPurge(channel, intervalMs) {
  // Cancel any existing schedule for this channel
  if (purgeIntervals[channel.id]) {
    clearInterval(purgeIntervals[channel.id]);
  }
  purgeIntervals[channel.id] = setInterval(() => purgeChannel(channel), intervalMs);

  // Also save to storage so we know which channels are active
  const data = getStorage();
  if (!data.purges) data.purges = {};
  data.purges[channel.id] = { channelId: channel.id, intervalMs };
  saveStorage(data);
}

function stopPurge(channelId) {
  if (purgeIntervals[channelId]) {
    clearInterval(purgeIntervals[channelId]);
    delete purgeIntervals[channelId];
  }
  const data = getStorage();
  if (data.purges) delete data.purges[channelId];
  saveStorage(data);
}

// ── Reaction Role Helpers ─────────────────────────────────────────────────────

function getReactRoles() {
  const data = getStorage();
  return data.reactRoles || {};
}

function saveReactRole(messageId, channelId, pairs) {
  const data = getStorage();
  if (!data.reactRoles) data.reactRoles = {};
  data.reactRoles[messageId] = { channelId, pairs }; // pairs: [{ emoji, roleId }]
  saveStorage(data);
}

function deleteReactRole(messageId) {
  const data = getStorage();
  if (data.reactRoles) delete data.reactRoles[messageId];
  saveStorage(data);
}

// ── Giveaway Storage Helpers ─────────────────────────────────────────────────

function saveGiveaway(messageId, data) {
  const storage = getStorage();
  if (!storage.giveaways) storage.giveaways = {};
  // Store entries as array (Set not JSON-serialisable)
  storage.giveaways[messageId] = {
    item:        data.item,
    endsAt:      data.endsAt,
    channelId:   data.channelId,
    entries:     [...data.entries],
    winnerCount: data.winnerCount || 1,
  };
  saveStorage(storage);
}

function removeGiveaway(messageId) {
  const storage = getStorage();
  if (storage.giveaways) delete storage.giveaways[messageId];
  saveStorage(storage);
}

function saveRerolData(itemKey, data) {
  const storage = getStorage();
  if (!storage.giveawayRerol) storage.giveawayRerol = {};
  storage.giveawayRerol[itemKey] = data;
  saveStorage(storage);
}

function removeRerolData(itemKey) {
  const storage = getStorage();
  if (storage.giveawayRerol) delete storage.giveawayRerol[itemKey];
  saveStorage(storage);
}

// ── Warning Helpers ──────────────────────────────────────────────────────────

function getWarnings(userId) {
  const s = getStorage();
  return (s.warnings && s.warnings[userId]) ? s.warnings[userId] : [];
}

function addWarning(userId, moderatorId, reason) {
  const s = getStorage();
  if (!s.warnings) s.warnings = {};
  if (!s.warnings[userId]) s.warnings[userId] = [];
  s.warnings[userId].push({ reason, moderatorId, timestamp: Date.now() });
  saveStorage(s);
  return s.warnings[userId].length;
}

function clearWarnings(userId) {
  const s = getStorage();
  if (s.warnings) delete s.warnings[userId];
  saveStorage(s);
}

// ── Gen Log Helper ────────────────────────────────────────────────────────────

async function sendGenLog(guild, user, line) {
  const s = getStorage();
  if (!s.genLogChannel) return;
  try {
    const ch = await guild.channels.fetch(s.genLogChannel);
    const embed = new EmbedBuilder()
      .setColor("#5865F2")
      .setTitle("📋 Account Generated")
      .addFields(
        { name: "👤 User",    value: `<@${user.id}> (${user.tag})`, inline: true },
        { name: "🕒 Time",    value: `<t:${Math.floor(Date.now()/1000)}:F>`, inline: true },
        { name: "📦 Account", value: `\`\`\`${line}\`\`\`` }
      )
      .setTimestamp();
    await ch.send({ embeds: [embed] });
  } catch (_) {}
}

// ── Low Stock Alert ───────────────────────────────────────────────────────────

async function checkLowStock(guild, remaining, panelMessageId) {
  if (remaining > LOW_STOCK_THRESHOLD) {
    LOW_STOCK_ALERTED.delete(panelMessageId);
    return;
  }
  if (LOW_STOCK_ALERTED.has(panelMessageId)) return;
  LOW_STOCK_ALERTED.add(panelMessageId);
  const s = getStorage();
  if (!s.genLogChannel) return;
  try {
    const ch = await guild.channels.fetch(s.genLogChannel);
    const mentions = ALLOWED_USERS.map(id => `<@${id}>`).join(" ");
    await ch.send({
      content: `⚠️ ${mentions} **Low stock alert!** Only **${remaining}** account(s) left in the database.`,
      allowedMentions: { users: ALLOWED_USERS },
    });
  } catch (_) {}
}

// Normalise emoji so both "👍" and "<:name:id>" match what Discord returns
function normaliseEmoji(str) {
  str = str.trim();
  // Custom emoji: <:name:id> or <a:name:id> → extract the id
  const custom = str.match(/^<a?:\w+:(\d+)>$/);
  if (custom) return custom[1];
  return str; // unicode emoji stays as-is
}

// ── Giveaway Helpers ──────────────────────────────────────────────────────────

function buildGiveawayEmbed(item, endsAt, entries, guild, ended = false, winners = [], winnerCount = 1) {
  const unixEnd = Math.floor(endsAt / 1000);
  const winnerStr = winners.length ? winners.map(w => `<@${w}>`).join(", ") : null;

  const embed = new EmbedBuilder()
    .setColor(ended ? "#ed4245" : "#1b2838")
    .setTitle("🎉 Giveaway!")
    .setDescription(ended
      ? winnerStr
        ? `🏆 **Winner${winners.length > 1 ? "s" : ""}:** ${winnerStr}\n\nThanks to everyone who entered!`
        : "😔 No one entered the giveaway."
      : `Click the button below to enter!\n\n**Prize:** \`${item}\`${winnerCount > 1 ? `\n**Winners:** ${winnerCount}` : ""}`
    )
    .addFields(
      { name: "🎁 Prize",   value: `\`${item}\``,                              inline: true },
      { name: "👥 Entries", value: `**${entries}**`,                            inline: true },
      { name: "🏅 Winners", value: `**${winnerCount}**`,                         inline: true },
      { name: ended ? "⏹️ Status" : "⏰ Ends At",
        value: ended ? "**Ended**" : `<t:${unixEnd}:R> (<t:${unixEnd}:f>)`,    inline: false },
    )
    .setFooter({ text: ended ? "Giveaway ended" : "Powered by Generator Bot",
                 iconURL: guild ? guild.iconURL() : undefined })
    .setTimestamp();

  return embed;
}

function buildGiveawayRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("join_giveaway")
      .setLabel("🎉 Enter Giveaway")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled)
  );
}

async function endGiveaway(messageId) {
  const gw = giveaways[messageId];
  if (!gw) return;

  clearTimeout(gw.timeoutId);
  clearInterval(gw.tickerId);

  try {
    const channel = await client.channels.fetch(gw.channelId);
    const msg     = await channel.messages.fetch(messageId);

    const entrantList = [...gw.entries];
    const wCount      = gw.winnerCount || 1;
    const shuffled    = [...entrantList].sort(() => Math.random() - 0.5);
    const winners     = shuffled.slice(0, Math.min(wCount, shuffled.length));

    await msg.edit({
      embeds:     [buildGiveawayEmbed(gw.item, gw.endsAt, entrantList.length, msg.guild, true, winners, wCount)],
      components: [buildGiveawayRow(true)],
    });

    if (winners.length) {
      const mentions = winners.map(w => `<@${w}>`).join(", ");
      await channel.send({
        content: `🎊 Congratulations ${mentions}! You won **${gw.item}**!`,
        allowedMentions: { users: winners },
      });
    } else {
      await channel.send({ content: "😔 The giveaway ended with no entries." });
    }

    // Save entries for potential reroll (kept in memory + storage, expires 24h)
    const rerolKey = gw.item.toLowerCase();
    giveawayRerolData[rerolKey] = {
      entries:   entrantList,
      item:      gw.item,
      channelId: gw.channelId,
    };
    saveRerolData(rerolKey, { entries: entrantList, item: gw.item, channelId: gw.channelId });
    setTimeout(() => {
      delete giveawayRerolData[rerolKey];
      removeRerolData(rerolKey);
    }, 86400000);

  } catch (err) {
    console.error("End giveaway error:", err.message);
  }

  const gw2 = giveaways[messageId];
  if (gw2) delete giveawaysByName[gw2.item.toLowerCase()];
  delete giveaways[messageId];
  removeGiveaway(messageId);
}

// ── Embed Builders ────────────────────────────────────────────────────────────

// Steam-style gen panel embed (like !G3N from index.js)
function buildGenEmbed(count, guild) {
  return new EmbedBuilder()
    .setColor("#1b2838")
    .setTitle("<:Steam:1500822008236081264> Steam Account Generator")
    .setDescription("Click the button below to generate a fresh Steam account instantly!\n\n**Note:** Accounts are first-come, first-served.")
    .addFields({ name: "📊 Current Stock", value: `\`${count}\` accounts available`, inline: false })
    .setFooter({ text: "Powered by Generator Bot", iconURL: guild ? guild.iconURL() : undefined })
    .setTimestamp();
}

function buildRow(empty) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("get_line_btn")
      .setLabel(empty ? "📭 Out of Stock" : "Click to Generate")
      .setStyle(empty ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setEmoji(empty ? "📭" : "1500822008236081264")
      .setDisabled(empty)
  );
}

function buildCooldownEmbed() {
  const lines = Array.from(allowedSet).map(uid =>
    `<@${uid}> — **${fmtTime(getCooldown(uid))}**`
  );
  return new EmbedBuilder()
    .setTitle("Cooldown Settings")
    .setColor(0x5865f2)
    .setDescription(lines.join("\n") || "No users.")
    .setFooter({ text: "Use ?gen cooldown <userid> <seconds> to change." });
}

// ── Ready ─────────────────────────────────────────────────────────────────────

client.once("ready", async () => {
  console.log(`🤖 Bot is online as ${client.user.tag}!`);

  // Update stock count on all saved gen panel messages
  const data = getStorage();
  const activeMessages = [];

  for (const entry of data.genMessages) {
    try {
      const channel = await client.channels.fetch(entry.channelId);
      const msg     = await channel.messages.fetch(entry.messageId);
      const count   = readLines().length;

      const updatedEmbed = EmbedBuilder.from(msg.embeds[0])
        .setFields({ name: "📊 Current Stock", value: `\`${count}\` accounts available`, inline: false });

      await msg.edit({ embeds: [updatedEmbed], components: [buildRow(count === 0)] });
      activeMessages.push(entry);
    } catch (_) {
      // Message was deleted — skip it
    }
  }

  data.genMessages = activeMessages;
  saveStorage(data);

  // Restore active giveaways from storage
  if (data.giveaways) {
    const now = Date.now();
    for (const [msgId, gw] of Object.entries(data.giveaways)) {
      if (gw.endsAt <= now) {
        // Already expired while bot was offline — end it now
        const fakeGw = {
          item: gw.item, entries: new Set(gw.entries),
          endsAt: gw.endsAt, channelId: gw.channelId,
          winnerCount: gw.winnerCount || 1,
          timeoutId: null, tickerId: null,
        };
        giveaways[msgId] = fakeGw;
        giveawaysByName[gw.item.toLowerCase()] = msgId;
        await endGiveaway(msgId);
        console.log(`⏰ Ended expired giveaway "${gw.item}" (was offline)`);
      } else {
        const remaining = gw.endsAt - now;
        const tickerId = setInterval(async () => {
          const active = giveaways[msgId];
          if (!active) return clearInterval(tickerId);
          try {
            const ch  = await client.channels.fetch(active.channelId);
            const msg = await ch.messages.fetch(msgId);
            await msg.edit({
              embeds:     [buildGiveawayEmbed(active.item, active.endsAt, active.entries.size, msg.guild, false, [], active.winnerCount || 1)],
              components: [buildGiveawayRow()],
            });
          } catch (_) { clearInterval(tickerId); }
        }, 30000);
        const timeoutId = setTimeout(() => endGiveaway(msgId), remaining);
        giveaways[msgId] = {
          item: gw.item, entries: new Set(gw.entries),
          endsAt: gw.endsAt, channelId: gw.channelId,
          winnerCount: gw.winnerCount || 1,
          timeoutId, tickerId,
        };
        giveawaysByName[gw.item.toLowerCase()] = msgId;
        console.log(`♻️  Restored giveaway "${gw.item}" — ends in ${fmtTime(remaining / 1000)}`);
      }
    }
  }

  // Restore rerol data from storage
  if (data.giveawayRerol) {
    for (const [key, rd] of Object.entries(data.giveawayRerol)) {
      giveawayRerolData[key] = rd;
    }
    console.log(`♻️  Restored ${Object.keys(data.giveawayRerol).length} rerollable giveaway(s)`);
  }

  // Restore any active auto-purge schedules
  if (data.purges) {
    for (const [channelId, entry] of Object.entries(data.purges)) {
      try {
        const ch = await client.channels.fetch(channelId);
        purgeIntervals[channelId] = setInterval(() => purgeChannel(ch), entry.intervalMs);
        console.log(`♻️  Restored auto-purge for #${ch.name} every ${fmtInterval(entry.intervalMs)}`);
      } catch (_) {
        // Channel no longer exists — remove it
        delete data.purges[channelId];
        saveStorage(data);
      }
    }
  }
});

// ── Reaction Roles ────────────────────────────────────────────────────────────

client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) { try { await reaction.fetch(); } catch { return; } }

  const rr = getReactRoles()[reaction.message.id];
  if (!rr) return;

  const emojiKey = reaction.emoji.id || reaction.emoji.name;
  const pair     = rr.pairs.find(p => p.emoji === emojiKey);
  if (!pair) return;

  try {
    const guild  = reaction.message.guild;
    const member = await guild.members.fetch(user.id);
    await member.roles.add(pair.roleId);
  } catch (err) {
    console.error("Reaction role add error:", err.message);
  }
});

client.on("messageReactionRemove", async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) { try { await reaction.fetch(); } catch { return; } }

  const rr = getReactRoles()[reaction.message.id];
  if (!rr) return;

  const emojiKey = reaction.emoji.id || reaction.emoji.name;
  const pair     = rr.pairs.find(p => p.emoji === emojiKey);
  if (!pair) return;

  try {
    const guild  = reaction.message.guild;
    const member = await guild.members.fetch(user.id);
    await member.roles.remove(pair.roleId);
  } catch (err) {
    console.error("Reaction role remove error:", err.message);
  }
});

// ── Button & Select Menu Interactions ────────────────────────────────────────

client.on("interactionCreate", async interaction => {

  // ── Client Catalog Select Menu ──
  if (interaction.isStringSelectMenu() && interaction.customId === "client_select") {
    const fileName = interaction.values[0];
    const clients  = getClients();
    const entry    = clients.find(c => c.fileName === fileName);

    if (!entry) {
      return interaction.reply({ ephemeral: true, content: "❌ Client not found in catalog." });
    }

    // Find whichever supported file type exists
    const EXTS     = [".jar", ".zip", ".dll"];
    const foundExt = EXTS.find(ext => fs.existsSync(path.join(CLIENTS_DIR, `${fileName}${ext}`)));
    const txtPath  = path.join(CLIENTS_DIR, `${fileName}.txt`);

    if (!foundExt) {
      return interaction.reply({ ephemeral: true, content: `❌ No file found for \`${fileName}\` (.jar / .zip / .dll). Make sure it's in the clients folder.` });
    }

    await interaction.deferReply({ ephemeral: true });

    const filePath = path.join(CLIENTS_DIR, `${fileName}${foundExt}`);

    // Read instruction text if it exists
    let instructions = "No instructions provided.";
    if (fs.existsSync(txtPath)) {
      instructions = fs.readFileSync(txtPath, "utf-8").trim();
      if (instructions.length > 4000) instructions = instructions.slice(0, 4000) + "\n...";
    }

    const infoEmbed = new EmbedBuilder()
      .setColor("#1b2838")
      .setTitle(`📦 ${entry.name}`)
      .setDescription(instructions)
      .setFooter({ text: `File: ${fileName}${foundExt}` })
      .setTimestamp();

    const file = new AttachmentBuilder(filePath, { name: `${fileName}${foundExt}` });

    await interaction.editReply({ embeds: [infoEmbed], files: [file] });
    return;
  }

  if (!interaction.isButton()) return;

  // ── Generate Account Button ──
  if (interaction.customId === "get_line_btn") {
    try {
      const userId = interaction.user.id;
      const wait   = secondsUntilReady(userId);

      if (wait > 0) {
        return await interaction.reply({ ephemeral: true, content: `⏳ You're on cooldown! Try again in **${fmtTime(wait)}**.` });
      }

      const line = popFirstLine();
      if (!line) {
        return await interaction.reply({ ephemeral: true, content: "❌ **Out of Stock!** No more accounts in the database." });
      }

      lastClick[userId] = Date.now();
      const remaining = readLines().length;

      // Update the panel first
      await interaction.deferUpdate();
      await interaction.editReply({
        embeds:     [buildGenEmbed(remaining, interaction.guild)],
        components: [buildRow(remaining === 0)],
      });

      // Send DM
      const dmEmbed = new EmbedBuilder()
        .setColor("#2ef76e")
        .setTitle("🎮 Account Generated Successfully!")
        .setDescription("🎮 **Orbit Studio | Delivery Service**\n\nYour account has been retrieved from the database and successfully deleted from our records.\n\n**Product:** Steam Premium Tier\n**Status:** Verified\n\n*Orbit Studio • Quality Guaranteed*")
        .addFields({ name: "🔑 Credentials", value: `\`\`\`${line}\`\`\`` })
        .setTimestamp();

      try {
        await interaction.user.send({ embeds: [dmEmbed] });
        await interaction.followUp({ ephemeral: true, content: "✅ Sent to your DMs!" });
      } catch (_) {
        await interaction.followUp({ ephemeral: true, content: "❌ Couldn't DM you! Please enable DMs from server members." });
      }

      await sendGenLog(interaction.guild, interaction.user, line);
      await checkLowStock(interaction.guild, remaining, interaction.message.id);
    } catch (err) {
      console.error("Button error:", err);
    }
  }

  // ── Join Giveaway Button ──
  if (interaction.customId === "join_giveaway") {
    const messageId = interaction.message.id;
    const gw        = giveaways[messageId];

    if (!gw) {
      return interaction.reply({ content: "❌ This giveaway is no longer active.", flags: 64 });
    }

    if (gw.entries.has(interaction.user.id)) {
      return interaction.reply({ content: "⚠️ You have already entered this giveaway!", flags: 64 });
    }

    gw.entries.add(interaction.user.id);
    saveGiveaway(messageId, gw); // persist updated entries

    // Update entry count on the embed
    await interaction.update({
      embeds:     [buildGiveawayEmbed(gw.item, gw.endsAt, gw.entries.size, interaction.guild)],
      components: [buildGiveawayRow()],
    });

    await interaction.followUp({ content: "✅ You have entered the giveaway! Good luck 🍀", flags: 64 });
    return;
  }

  // ── Create Ticket Button ──
  if (interaction.customId === "create_ticket") {
    await interaction.deferReply({ ephemeral: true });

    const ticketName     = `ticket-${interaction.user.username}`.toLowerCase();
    const existingChannel = interaction.guild.channels.cache.find(c => c.name === ticketName);

    if (existingChannel) {
      return interaction.editReply({ content: `❌ You already have an open ticket: ${existingChannel}` });
    }

    const channel = await interaction.guild.channels.create({
      name: ticketName,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: interaction.guild.id,           deny:  [PermissionFlagsBits.ViewChannel] },
        { id: interaction.guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id:    interaction.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
      ],
    });

    const welcomeEmbed = new EmbedBuilder()
      .setColor("#5865F2")
      .setTitle(`Welcome to your Ticket, ${interaction.user.username}!`)
      .setDescription("Support will be with you shortly. Please state your issue or what you wish to purchase.")
      .addFields(
        { name: "💰 Payment Methods", value: "<:crypto:1501190777378836641> <:tbc:1501188691727482921> <:bank_of_georgia:1501188400026357801>" },
        { name: "💎 Krypton Prices", value: "<:dollar:1508436226552627240> 4 dollar\n**OR**\n<:donutsmp:1508436379489665034> 50M on donutsmp" }
      )
      .setTimestamp();

    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("close_ticket")
        .setLabel("Close Ticket")
        .setStyle(ButtonStyle.Danger)
        .setEmoji("🔒")
    );

    await channel.send({ content: `${interaction.user} | Support Team`, embeds: [welcomeEmbed], components: [closeRow] });
    await interaction.editReply({ content: `✅ Ticket created! Go to ${channel}` });
  }

  // ── Close Ticket Button ──
  if (interaction.customId === "close_ticket") {
    await interaction.reply({ content: "🔒 Closing ticket in 5 seconds..." });
    setTimeout(async () => {
      try {
        await interaction.channel.delete();
      } catch (err) {
        console.error("Failed to delete channel:", err);
      }
    }, 5000);
  }
});

// ── Commands ──────────────────────────────────────────────────────────────────

client.on("messageCreate", async message => {
  try {
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args    = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();
    if (command !== "gen") return;

    // Merge two-word sub-commands into one token so spaced variants work.
    // e.g. "giveaway add" → "giveawayadd", "add stock" → "addstock", etc.
    const TWO_WORD_CMDS = {
      "giveaway add":   "giveawayadd",
      "giveaway winner":"giveawaywinner",
      "giveaway rerol": "giveawayrerol",
      "giveaway time":  "giveawaytime",
      "add stock":      "addstock",
      "set log":        "setlog",
      "react role":     "reactrole",
      "clear warns":    "clearwarns",
      "server info":    "serverinfo",
    };
    if (args.length >= 2) {
      const twoWord = (args[0] + " " + args[1]).toLowerCase();
      if (TWO_WORD_CMDS[twoWord]) {
        args.splice(0, 2, TWO_WORD_CMDS[twoWord]);
      }
    }

    const userId = message.author.id;

    if (!allowedSet.has(userId)) {
      await message.delete().catch(() => {});
      const w = await message.channel.send(`🚫 ${message.author} You are not allowed to use this command.`);
      setTimeout(() => w.delete().catch(() => {}), 5000);
      return;
    }

    // ?gen client [add <fileName> = <Display Name>]
    if (args[0] && args[0].toLowerCase() === "client") {

      // ?gen client add gugugaga = GuguGaga Client
      if (args[1] && args[1].toLowerCase() === "add") {
        const rest     = args.slice(2).join(" ");
        const eqIndex  = rest.indexOf("=");
        if (eqIndex === -1) {
          const e = await message.channel.send("❌ Usage: `?gen client add <filename> = <Display Name>`\nExample: `?gen client add gugugaga = GuguGaga Client`");
          setTimeout(() => e.delete().catch(() => {}), 8000);
          return;
        }

        const fileName   = rest.slice(0, eqIndex).trim().toLowerCase().replace(/\s+/g, "_");
        const clientName = rest.slice(eqIndex + 1).trim();

        if (!fileName || !clientName) {
          const e = await message.channel.send("❌ Both filename and display name are required.");
          setTimeout(() => e.delete().catch(() => {}), 8000);
          return;
        }

        const EXTS       = [".jar", ".zip", ".dll"];
        const foundExt   = EXTS.find(ext => fs.existsSync(path.join(CLIENTS_DIR, `${fileName}${ext}`)));
        if (!foundExt) {
          const e = await message.channel.send(`❌ No file found for \`${fileName}\` (.jar / .zip / .dll) in the \`clients/\` folder. Upload it first.`);
          setTimeout(() => e.delete().catch(() => {}), 8000);
          return;
        }

        const clients = getClients();
        if (clients.find(c => c.fileName === fileName)) {
          const e = await message.channel.send(`❌ \`${fileName}\` is already in the catalog.`);
          setTimeout(() => e.delete().catch(() => {}), 8000);
          return;
        }

        if (clients.length >= 25) {
          const e = await message.channel.send("❌ Catalog is full (max 25 clients — Discord dropdown limit).");
          setTimeout(() => e.delete().catch(() => {}), 8000);
          return;
        }

        // Ensure clients folder exists
        if (!fs.existsSync(CLIENTS_DIR)) fs.mkdirSync(CLIENTS_DIR);

        clients.push({ name: clientName, fileName });
        saveClients(clients);

        const hasTxt = fs.existsSync(path.join(CLIENTS_DIR, `${fileName}.txt`));
        await message.channel.send({
          embeds: [new EmbedBuilder()
            .setColor("#2ef76e")
            .setTitle("📦 Client Added to Catalog")
            .addFields(
              { name: "📛 Name",         value: clientName,                    inline: true },
              { name: "📁 File",         value: `\`${fileName}${foundExt}\``,  inline: true },
              { name: "📋 Instructions", value: hasTxt ? `\`${fileName}.txt\` ✅` : "⚠️ No `.txt` found — add one for install instructions", inline: false }
            )
            .setTimestamp()
          ]
        });
        await message.delete().catch(() => {});
        return;
      }

      // ?gen client — post the catalog
      const clients = getClients();

      if (!clients.length) {
        const e = await message.channel.send("❌ No clients in the catalog yet. Use `?gen client add <filename> = <Name>` to add one.");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }

      const menu = new StringSelectMenuBuilder()
        .setCustomId("client_select")
        .setPlaceholder("Select a client...")
        .addOptions(clients.map(c => ({
          label: c.name,
          value: c.fileName,
          description: `Download ${c.name}`,
          emoji: "📦",
        })));

      const row = new ActionRowBuilder().addComponents(menu);

      await message.channel.send({ content: "📦 **Client Catalog** — Pick a client below to get the file and instructions:", components: [row] });
      await message.delete().catch(() => {});
      return;
    }

    // ?gen ticket — posts the ticket panel
    if (args[0] && args[0].toLowerCase() === "ticket") {
      const ticketEmbed = new EmbedBuilder()
        .setColor("#2f3136")
        .setTitle("📩 Support & Purchase Ticket")
        .setDescription("Welcome to our support center. If you encounter any issues or wish to make a purchase, please open a ticket.")
        .addFields(
          { name: "⏰ Response Time", value: "> Usually within 1-2 hours",    inline: true },
          { name: "💳 Payments",      value: "> <:crypto:1501190777378836641> <:tbc:1501188691727482921> <:bank_of_georgia:1501188400026357801>",            inline: true },
          { name: "💎 Krypton Prices", value: "> <:dollar:1508436226552627240> 4 dollar\n> **OR**\n> <:donutsmp:1508436379489665034> 50M on donutsmp" },
          { name: "📜 Instructions",  value: "Once the ticket is open, please provide your details immediately." }
        )
        .setFooter({ text: "Support Team", iconURL: message.guild.iconURL() })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("create_ticket")
          .setLabel("Create Ticket")
          .setStyle(ButtonStyle.Primary)
          .setEmoji("📩")
      );

      await message.channel.send({ embeds: [ticketEmbed], components: [row] });
      await message.delete().catch(() => {});
      return;
    }

    // ?gen cooldown [userid] [seconds]
    if (args[0] && args[0].toLowerCase() === "cooldown") {
      const targetId = args[1];
      const seconds  = args[2] !== undefined ? parseInt(args[2]) : undefined;

      if (!targetId) {
        return message.channel.send({ embeds: [buildCooldownEmbed()] });
      }
      if (seconds === undefined || isNaN(seconds)) {
        const e = await message.channel.send("❌ Usage: `?gen cooldown <userid> <seconds>`");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }
      if (!allowedSet.has(targetId)) {
        const e = await message.channel.send(`❌ User \`${targetId}\` is not in the allowed-users list.`);
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }
      if (seconds < 0) {
        const e = await message.channel.send("❌ Cooldown must be 0 or more seconds.");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }

      userCooldowns[targetId] = seconds;
      return message.channel.send({
        content: `✅ Cooldown for <@${targetId}> set to **${fmtTime(seconds)}**.`,
        allowedMentions: { parse: [] },
      });
    }

    // ?gen help — show all commands
    if (args[0] && args[0].toLowerCase() === "help") {
      const helpEmbed = new EmbedBuilder()
        .setColor("#5865F2")
        .setTitle("📖 Bot Commands")
        .setDescription("All commands use the `?gen` prefix.")
        .addFields(
          {
            name: "🎮 Generator",
            value: [
              "`?gen` — Posts the Steam account generator panel",
              "`?gen stock` — Shows current stock count",
              "`?gen add stock <lines>` — Add accounts (or attach a .txt file)",
              "`?gen set log #channel` — Set gen log + low stock alert channel",
              "`?gen cooldown` — Shows cooldown settings for all allowed users",
              "`?gen cooldown <userid> <seconds>` — Sets cooldown for a specific user",
            ].join("\n"),
          },
          {
            name: "🛡️ Moderation",
            value: [
              "`?gen warn @user <reason>` — Warn a user (logged + DM'd)",
              "`?gen warnings @user` — View all warnings for a user",
              "`?gen clear warns @user` — Clear all warnings for a user",
              "`?gen mute @user <time> [reason]` — Timeout a user (e.g. `10m`, `1h`, `1d`)",
              "`?gen kick @user [reason]` — Kick a user from the server",
            ].join("\n"),
          },
          {
            name: "📩 Tickets",
            value: [
              "`?gen ticket` — Posts the support ticket panel",
            ].join("\n"),
          },
          {
            name: "🗑️ Auto-Purge",
            value: [
              "`?gen purge #channel` — Instantly clears a channel (one-time)",
              "`?gen purge #channel now` — Same as above",
              "`?gen purge #channel <interval>` — Auto-clears on a schedule",
              "`?gen purge #channel stop` — Stops the auto-purge for a channel",
              "`?gen purge list` — Shows all active auto-purge schedules",
              "",
              "**Interval examples:** `30s` · `5m` · `1h`",
            ].join("\n"),
          },
          {
            name: "🖥️ Client Catalog",
            value: [
              "`?gen client` — Posts the client catalog with a dropdown",
              "`?gen client add <filename> = <Name>` — Adds a client to the catalog",
              "",
              "**Example:** `?gen client add gugugaga = GuguGaga Client`",
              "Put `gugugaga.jar` and `gugugaga.txt` in the `clients/` folder first.",
            ].join("\n"),
          },
          {
            name: "🎭 Reaction Roles",
            value: [
              "`?gen react role @role emoji, @role emoji` — Posts a reaction role panel",
              "",
              "**Example:** `?gen react role @Gamer 🎮, @VIP ⭐, @News 📰`",
              "Bot reacts first. Users react to get the role, remove to lose it.",
            ].join("\n"),
          },
          {
            name: "🎉 Giveaway",
            value: [
              "`?gen giveaway <item> <time>` — Starts a giveaway (1 winner)",
              "`?gen giveaway[N] <item> <time>` — Starts a giveaway with N winners",
              "`?gen giveaway winner <name>` — End a giveaway early and pick winner(s) now",
              "`?gen giveaway rerol <name>` — Reroll winner(s) of a recently ended giveaway",
              "`?gen giveaway time <name> <time>` — Extend an active giveaway's end time",
              "`?gen giveaway add <name> @user` — Secretly add a user to a giveaway (result DM'd to you)",
              "`?gen giveaway add <name> @role` — Secretly add all members of a role (result DM'd to you)",
              "",
              "**Example:** `?gen giveaway Steam Key 10m`",
              "**Example:** `?gen giveaway[3] Steam Keys Pack 1h`",
              "**Example:** `?gen giveaway winner Steam Key`",
            ].join("\n"),
          },
          {
            name: "🔧 Utility",
            value: [
              "`?gen say #channel <message>` — Send a message to any channel as the bot",
              "`?gen dm @user <message>` — DM a user as the bot",
              "`?gen server info` — Show server stats",
            ].join("\n"),
          }
        )
        .setFooter({ text: "Only allowed users can run these commands." })
        .setTimestamp();

      await message.channel.send({ embeds: [helpEmbed] });
      await message.delete().catch(() => {});
      return;
    }

    // ?gen purge #channel <interval|stop> | list
    if (args[0] && args[0].toLowerCase() === "purge") {
      const sub = args[1]; // could be "list", a channel mention, or undefined

      // ?gen purge list
      if (sub && sub.toLowerCase() === "list") {
        const data = getStorage();
        const purges = data.purges ? Object.values(data.purges) : [];

        if (!purges.length) {
          return message.channel.send("📋 No active auto-purge schedules.");
        }

        const lines = purges.map(p => `<#${p.channelId}> — every **${fmtInterval(p.intervalMs)}**`);
        const listEmbed = new EmbedBuilder()
          .setColor("#1b2838")
          .setTitle("🗑️ Active Auto-Purge Schedules")
          .setDescription(lines.join("\n"))
          .setTimestamp();

        return message.channel.send({ embeds: [listEmbed] });
      }

      // Extract channel from mention or ID
      const channelId  = sub ? sub.replace(/[<#>]/g, "") : null;
      const target     = channelId ? message.guild.channels.cache.get(channelId) : null;

      if (!target) {
        const e = await message.channel.send("❌ Usage: `?gen purge #channel <interval>` or `?gen purge #channel stop`");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }

      const intervalArg = args[2] ? args[2].toLowerCase() : null;

      // ?gen purge #channel now — instant one-shot clear
      if (!intervalArg || intervalArg === "now") {
        await message.delete().catch(() => {});
        await purgeChannel(target);
        const done = await message.channel.send({
          embeds: [new EmbedBuilder()
            .setColor("#2ef76e")
            .setTitle("🗑️ Channel Cleared")
            .addFields({ name: "📌 Channel", value: `${target}`, inline: true })
            .setFooter({ text: "Only messages under 14 days old were deleted (Discord limit)." })
            .setTimestamp()
          ]
        });
        setTimeout(() => done.delete().catch(() => {}), 5000);
        return;
      }

      // ?gen purge #channel stop
      if (intervalArg === "stop") {
        if (!purgeIntervals[target.id]) {
          return message.channel.send(`❌ No active auto-purge on ${target}.`);
        }
        stopPurge(target.id);
        return message.channel.send(`✅ Auto-purge stopped for ${target}.`);
      }

      // ?gen purge #channel <interval>
      const intervalMs = intervalArg ? parseInterval(intervalArg) : null;
      if (!intervalMs) {
        const e = await message.channel.send("❌ Invalid interval. Use formats like `30s`, `5m`, or `1h`.");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }

      if (intervalMs < 10000) {
        const e = await message.channel.send("❌ Minimum interval is `10s`.");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }

      startPurge(target, intervalMs);
      const confirmEmbed = new EmbedBuilder()
        .setColor("#2ef76e")
        .setTitle("🗑️ Auto-Purge Activated")
        .addFields(
          { name: "📌 Channel",  value: `${target}`,                    inline: true },
          { name: "⏱️ Interval", value: `Every **${intervalArg}**`,     inline: true },
          { name: "ℹ️ Note",     value: "Only messages under 14 days old can be bulk-deleted (Discord limit)." }
        )
        .setTimestamp();

      await message.channel.send({ embeds: [confirmEmbed] });
      await message.delete().catch(() => {});
      return;
    }


    // ?gen reactrole @role emoji, @role emoji, ...
    if (args[0] && args[0].toLowerCase() === "reactrole") {
      const input = args.slice(1).join(" ");

      if (!input.trim()) {
        const e = await message.channel.send("❌ Usage: `?gen react role @role emoji, @role emoji`");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }

      // Parse comma-separated pairs: "@role emoji"
      const rawPairs = input.split(",").map(s => s.trim()).filter(Boolean);
      const pairs    = [];

      for (const raw of rawPairs) {
        // Each entry: <@&roleId> emoji  OR  <@&roleId> <:name:id>
        const match = raw.match(/^<@&(\d+)>\s+(.+)$/);
        if (!match) {
          const e = await message.channel.send(`❌ Couldn't parse: \`${raw}\`\nFormat must be: \`@role emoji\``);
          setTimeout(() => e.delete().catch(() => {}), 8000);
          return;
        }
        pairs.push({ roleId: match[1], emoji: normaliseEmoji(match[2]) });
      }

      // Build the embed
      const lines = pairs.map(p => {
        const emojiDisplay = p.emoji.match(/^\d+$/)
          ? message.guild.emojis.cache.get(p.emoji)?.toString() || `<:?:${p.emoji}>`
          : p.emoji;
        return `${emojiDisplay} → <@&${p.roleId}>`;
      });

      const rrEmbed = new EmbedBuilder()
        .setColor("#1b2838")
        .setTitle("🎭 Reaction Roles")
        .setDescription("React below to receive a role. Remove your reaction to lose it.")
        .addFields({ name: "📋 Available Roles", value: lines.join("\n") })
        .setFooter({ text: "Powered by Generator Bot", iconURL: message.guild.iconURL() })
        .setTimestamp();

      const sentMsg = await message.channel.send({ embeds: [rrEmbed] });

      // Bot reacts first so the emojis are there for users to click
      for (const pair of pairs) {
        try {
          const emoji = pair.emoji.match(/^\d+$/)
            ? message.guild.emojis.cache.get(pair.emoji)
            : pair.emoji;
          await sentMsg.react(emoji);
        } catch (err) {
          console.error(`Failed to react with emoji ${pair.emoji}:`, err.message);
        }
      }

      // Save to storage so reactions keep working after restart
      saveReactRole(sentMsg.id, sentMsg.channelId, pairs);
      await message.delete().catch(() => {});
      return;
    }

    // ?gen giveaway[N] <item> <time>  (N = number of winners, default 1)
    if (args[0] && args[0].toLowerCase().startsWith("giveaway") && !args[0].toLowerCase().startsWith("giveawayw") && !args[0].toLowerCase().startsWith("giveawayr") && !args[0].toLowerCase().startsWith("giveawayadd") && !args[0].toLowerCase().startsWith("giveawaytime")) {
      // Parse optional winner count from "giveaway[3]"
      const gwMatch   = args[0].match(/^giveaway(?:\[(\d+)\])?$/i);
      const winnerCount = gwMatch && gwMatch[1] ? Math.min(parseInt(gwMatch[1]), 20) : 1;

      if (args.length < 3) {
        const e = await message.channel.send("❌ Usage: `?gen giveaway <item> <time>` or `?gen giveaway[3] <item> <time>`");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }

      const timeArg    = args[args.length - 1];
      const itemName   = args.slice(1, args.length - 1).join(" ");
      const intervalMs = parseInterval(timeArg);

      if (!intervalMs) {
        const e = await message.channel.send("❌ Invalid time. Use formats like `30s`, `5m`, or `1h`.");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }

      if (intervalMs < 10000) {
        const e = await message.channel.send("❌ Minimum giveaway duration is `10s`.");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }

      const endsAt  = Date.now() + intervalMs;
      const sentMsg = await message.channel.send({
        embeds:     [buildGiveawayEmbed(itemName, endsAt, 0, message.guild, false, [], winnerCount)],
        components: [buildGiveawayRow()],
      });

      const timeoutId = setTimeout(() => endGiveaway(sentMsg.id), intervalMs);

      // Ticker: update entry count on embed every 30s
      const tickerId = setInterval(async () => {
        const gw = giveaways[sentMsg.id];
        if (!gw) return clearInterval(tickerId);
        try {
          const msg = await message.channel.messages.fetch(sentMsg.id);
          await msg.edit({
            embeds:     [buildGiveawayEmbed(gw.item, gw.endsAt, gw.entries.size, message.guild, false, [], gw.winnerCount)],
            components: [buildGiveawayRow()],
          });
        } catch (_) { clearInterval(tickerId); }
      }, 30000);

      giveaways[sentMsg.id] = {
        item: itemName, entries: new Set(), winnerCount,
        endsAt, channelId: sentMsg.channelId, timeoutId, tickerId,
      };
      giveawaysByName[itemName.toLowerCase()] = sentMsg.id;
      saveGiveaway(sentMsg.id, giveaways[sentMsg.id]);

      await message.delete().catch(() => {});
      return;
    }

    // ?gen giveawaywinner <name> — end a giveaway early by name
    if (args[0] && args[0].toLowerCase() === "giveawaywinner") {
      const name = args.slice(1).join(" ").toLowerCase();
      if (!name) {
        const e = await message.channel.send("❌ Usage: `?gen giveawaywinner <giveaway name>`");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }
      const msgId = giveawaysByName[name];
      if (!msgId || !giveaways[msgId]) {
        const e = await message.channel.send(`❌ No active giveaway found with name: \`${args.slice(1).join(" ")}\``);
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }
      await endGiveaway(msgId);
      await message.delete().catch(() => {});
      return;
    }

    // ?gen giveawayrerol <name> — reroll winner for an ended giveaway
    if (args[0] && args[0].toLowerCase() === "giveawayrerol") {
      const name = args.slice(1).join(" ").toLowerCase();
      if (!name) {
        const e = await message.channel.send("❌ Usage: `?gen giveawayrerol <giveaway name>`");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }

      // Find by searching storage for ended giveaways — we store rerolable data separately
      if (!giveawayRerolData[name]) {
        const e = await message.channel.send(`❌ No rerollable giveaway found for: \`${args.slice(1).join(" ")}\`\n> Only recently ended giveaways can be rerolled.`);
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }

      const { entries, item, channelId } = giveawayRerolData[name];
      if (!entries.length) {
        const e = await message.channel.send("❌ That giveaway had no entries, can't reroll.");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }

      const winner = entries[Math.floor(Math.random() * entries.length)];
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (ch) {
        await ch.send({
          content: `🎲 **Reroll!** New winner for **${item}**: <@${winner}>! Congratulations! 🎉`,
          allowedMentions: { users: [winner] },
        });
      }
      await message.delete().catch(() => {});
      return;
    }

    // ?gen giveawaytime <name> <extra> — extend an active giveaway's end time
    if (args[0] && args[0].toLowerCase() === "giveawaytime") {
      const extraArg = args[args.length - 1];
      const name     = args.slice(1, args.length - 1).join(" ").toLowerCase();

      if (!name || !extraArg) {
        const e = await message.channel.send("❌ Usage: `?gen giveawaytime <giveaway name> <extra time>`\nExample: `?gen giveawaytime Steam Key 10m`");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }

      const extraMs = parseInterval(extraArg);
      if (!extraMs) {
        const e = await message.channel.send("❌ Invalid time. Use formats like `30s`, `5m`, `1h`, `1d`.");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }

      const msgId = giveawaysByName[name];
      if (!msgId || !giveaways[msgId]) {
        const e = await message.channel.send(`❌ No active giveaway found with name: \`${args.slice(1, args.length - 1).join(" ")}\``);
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }

      const gw = giveaways[msgId];

      // Cancel old timeout, set a new one with extended time
      clearTimeout(gw.timeoutId);
      gw.endsAt    += extraMs;
      gw.timeoutId  = setTimeout(() => endGiveaway(msgId), gw.endsAt - Date.now());

      // Update the embed on the giveaway message
      try {
        const gwChannel = await client.channels.fetch(gw.channelId);
        const gwMsg     = await gwChannel.messages.fetch(msgId);
        await gwMsg.edit({
          embeds:     [buildGiveawayEmbed(gw.item, gw.endsAt, gw.entries.size, gwMsg.guild, false, [], gw.winnerCount)],
          components: [buildGiveawayRow()],
        });
      } catch (err) {
        console.error("giveawaytime edit error:", err.message);
      }

      saveGiveaway(msgId, gw);

      const embed = new EmbedBuilder()
        .setColor("#2ef76e")
        .setTitle("⏰ Giveaway Extended")
        .addFields(
          { name: "🎁 Prize",     value: `\`${gw.item}\``,                                         inline: true },
          { name: "➕ Added",     value: `**${fmtTime(extraMs / 1000)}**`,                          inline: true },
          { name: "🏁 New End",   value: `<t:${Math.floor(gw.endsAt / 1000)}:R> (<t:${Math.floor(gw.endsAt / 1000)}:f>)`, inline: false }
        )
        .setFooter({ text: `Extended by ${message.author.tag}` })
        .setTimestamp();

      await message.channel.send({ embeds: [embed] });
      await message.delete().catch(() => {});
      return;
    }

    // ?gen giveawayadd <name> @user/@role — manually add user(s) to active giveaway
    if (args[0] && args[0].toLowerCase() === "giveawayadd") {
      // Last token is the mention, everything in between is the giveaway name
      const mention = args[args.length - 1];
      const name    = args.slice(1, args.length - 1).join(" ").toLowerCase();

      if (!name || !mention) {
        const e = await message.channel.send("❌ Usage: `?gen giveawayadd <giveaway name> @user` or `?gen giveawayadd <giveaway name> @role`");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }

      const msgId = giveawaysByName[name];
      if (!msgId || !giveaways[msgId]) {
        const e = await message.channel.send(`❌ No active giveaway found with name: \`${args.slice(1, args.length - 1).join(" ")}\``);
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }

      const gw = giveaways[msgId];

      // Detect if it's a role mention <@&id> or user mention <@id> / <@!id>
      const roleId = mention.match(/^<@&(\d+)>$/)  ? mention.match(/^<@&(\d+)>$/)[1]  : null;
      const userId = mention.match(/^<@!?(\d+)>$/) ? mention.match(/^<@!?(\d+)>$/)[1] : null;

      if (!roleId && !userId) {
        const e = await message.channel.send("❌ Mention must be a @user or @role.");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }

      let added   = 0;
      let skipped = 0;

      if (userId) {
        // Single user
        if (gw.entries.has(userId)) {
          skipped = 1;
        } else {
          gw.entries.add(userId);
          added = 1;
        }
      } else {
        // Role — fetch all members with that role
        await message.guild.members.fetch(); // make sure cache is populated
        const role = message.guild.roles.cache.get(roleId);
        if (!role) {
          const e = await message.channel.send("❌ Role not found.");
          setTimeout(() => e.delete().catch(() => {}), 8000);
          return;
        }

        for (const [memberId] of role.members) {
          if (gw.entries.has(memberId)) {
            skipped++;
          } else {
            gw.entries.add(memberId);
            added++;
          }
        }
      }

      saveGiveaway(msgId, gw);

      // Update the giveaway embed with new entry count
      try {
        const gwChannel = await client.channels.fetch(gw.channelId);
        const gwMsg     = await gwChannel.messages.fetch(msgId);
        await gwMsg.edit({
          embeds:     [buildGiveawayEmbed(gw.item, gw.endsAt, gw.entries.size, gwMsg.guild, false, [], gw.winnerCount)],
          components: [buildGiveawayRow()],
        });
      } catch (err) {
        console.error("giveawayadd edit error:", err.message);
      }

      const embed = new EmbedBuilder()
        .setColor("#2ef76e")
        .setTitle("✅ Entries Added (Secret)")
        .addFields(
          { name: "🎁 Giveaway",    value: `\`${gw.item}\``,              inline: true  },
          { name: "➕ Added",       value: `**${added}** user(s)`,         inline: true  },
          { name: "⏭️ Skipped",    value: `**${skipped}** (already in)`,  inline: true  },
          { name: "👥 Total Now",   value: `**${gw.entries.size}** entries`, inline: true }
        )
        .setFooter({ text: `Added by ${message.author.tag} — only you can see this` })
        .setTimestamp();

      // Secret: DM the result to the admin only (nothing posted in the channel)
      try {
        await message.author.send({ embeds: [embed] });
      } catch (_) {
        // DMs disabled — send a brief self-deleting notice only the admin sees
        const notice = await message.channel.send({ content: `<@${message.author.id}> ✅ Entries added! (DMs disabled, check the giveaway embed for the count)`, allowedMentions: { users: [message.author.id] } });
        setTimeout(() => notice.delete().catch(() => {}), 6000);
      }
      await message.delete().catch(() => {});
      return;
    }

    // ?gen warn @user <reason>
    if (args[0] && args[0].toLowerCase() === "warn") {
      const target = message.mentions.members.first();
      const reason = args.slice(2).join(" ") || "No reason provided";
      if (!target) {
        const e = await message.channel.send("❌ Usage: `?gen warn @user <reason>`");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }
      const count = addWarning(target.id, message.author.id, reason);
      const embed = new EmbedBuilder()
        .setColor("#faa61a")
        .setTitle("⚠️ User Warned")
        .addFields(
          { name: "👤 User",      value: `${target} (${target.user.tag})`, inline: true },
          { name: "🔢 Warning #", value: `**${count}**`,                   inline: true },
          { name: "📝 Reason",    value: reason }
        )
        .setFooter({ text: `Warned by ${message.author.tag}` })
        .setTimestamp();
      await message.channel.send({ embeds: [embed] });
      try {
        await target.send({ embeds: [new EmbedBuilder()
          .setColor("#faa61a")
          .setTitle(`⚠️ You have been warned in ${message.guild.name}`)
          .addFields(
            { name: "📝 Reason",    value: reason },
            { name: "🔢 Warning #", value: `**${count}**` }
          )
          .setTimestamp()
        ]});
      } catch (_) {}
      await message.delete().catch(() => {});
      return;
    }

    // ?gen warnings @user
    if (args[0] && args[0].toLowerCase() === "warnings") {
      const target = message.mentions.members.first();
      if (!target) {
        const e = await message.channel.send("❌ Usage: `?gen warnings @user`");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }
      const warns = getWarnings(target.id);
      const embed = new EmbedBuilder()
        .setColor("#5865F2")
        .setTitle(`⚠️ Warnings for ${target.user.tag}`)
        .setDescription(warns.length
          ? warns.map((w, i) => `**${i+1}.** ${w.reason} — <t:${Math.floor(w.timestamp/1000)}:R> by <@${w.moderatorId}>`).join("\n")
          : "✅ No warnings on record."
        )
        .setTimestamp();
      await message.channel.send({ embeds: [embed] });
      await message.delete().catch(() => {});
      return;
    }

    // ?gen clearwarns @user
    if (args[0] && args[0].toLowerCase() === "clearwarns") {
      const target = message.mentions.members.first();
      if (!target) {
        const e = await message.channel.send("❌ Usage: `?gen clear warns @user`");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }
      clearWarnings(target.id);
      await message.channel.send(`✅ Cleared all warnings for ${target}.`);
      await message.delete().catch(() => {});
      return;
    }

    // ?gen mute @user <time> [reason]
    if (args[0] && args[0].toLowerCase() === "mute") {
      const target    = message.mentions.members.first();
      const timeArg   = args[2];
      const reason    = args.slice(3).join(" ") || "No reason provided";
      if (!target || !timeArg) {
        const e = await message.channel.send("❌ Usage: `?gen mute @user <time> [reason]` — e.g. `?gen mute @user 10m Spamming`");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }
      const ms = parseInterval(timeArg);
      if (!ms) {
        const e = await message.channel.send("❌ Invalid time format. Use `10s`, `5m`, `1h`, `1d`.");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }
      if (ms > 28 * 24 * 3600 * 1000) {
        const e = await message.channel.send("❌ Discord max timeout is 28 days.");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }
      try {
        await target.timeout(ms, reason);
        const embed = new EmbedBuilder()
          .setColor("#ed4245")
          .setTitle("🔇 User Muted")
          .addFields(
            { name: "👤 User",      value: `${target} (${target.user.tag})`, inline: true },
            { name: "⏱️ Duration",  value: fmtTime(ms / 1000),               inline: true },
            { name: "📝 Reason",    value: reason }
          )
          .setFooter({ text: `Muted by ${message.author.tag}` })
          .setTimestamp();
        await message.channel.send({ embeds: [embed] });
        try {
          await target.send({ embeds: [new EmbedBuilder()
            .setColor("#ed4245")
            .setTitle(`🔇 You have been muted in ${message.guild.name}`)
            .addFields(
              { name: "⏱️ Duration", value: fmtTime(ms / 1000) },
              { name: "📝 Reason",   value: reason }
            )
            .setTimestamp()
          ]});
        } catch (_) {}
      } catch (err) {
        await message.channel.send(`❌ Failed to mute: ${err.message}`);
      }
      await message.delete().catch(() => {});
      return;
    }

    // ?gen kick @user [reason]
    if (args[0] && args[0].toLowerCase() === "kick") {
      const target = message.mentions.members.first();
      const reason = args.slice(2).join(" ") || "No reason provided";
      if (!target) {
        const e = await message.channel.send("❌ Usage: `?gen kick @user [reason]`");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }
      if (!target.kickable) {
        const e = await message.channel.send("❌ I can't kick that user (missing permissions or higher role).");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }
      try {
        try {
          await target.send({ embeds: [new EmbedBuilder()
            .setColor("#ed4245")
            .setTitle(`👢 You have been kicked from ${message.guild.name}`)
            .addFields({ name: "📝 Reason", value: reason })
            .setTimestamp()
          ]});
        } catch (_) {}
        await target.kick(reason);
        const embed = new EmbedBuilder()
          .setColor("#ed4245")
          .setTitle("👢 User Kicked")
          .addFields(
            { name: "👤 User",   value: `${target.user.tag}`, inline: true },
            { name: "📝 Reason", value: reason }
          )
          .setFooter({ text: `Kicked by ${message.author.tag}` })
          .setTimestamp();
        await message.channel.send({ embeds: [embed] });
      } catch (err) {
        await message.channel.send(`❌ Failed to kick: ${err.message}`);
      }
      await message.delete().catch(() => {});
      return;
    }

    // ?gen addstock  (attach a .txt file OR paste lines after the command)
    if (args[0] && args[0].toLowerCase() === "addstock") {
      let newLines = [];

      // Check for attached .txt file first
      const attachment = message.attachments.first();
      if (attachment && attachment.name.endsWith(".txt")) {
        try {
          const res  = await fetch(attachment.url);
          const text = await res.text();
          newLines = text.split("\n").map(l => l.trimEnd()).filter(l => l.length > 0);
        } catch (err) {
          await message.channel.send(`❌ Failed to read attachment: ${err.message}`);
          return;
        }
      } else {
        // Fallback: lines typed after the command
        newLines = args.slice(1);
      }

      if (!newLines.length) {
        const e = await message.channel.send("❌ Usage: `?gen add stock <line1> <line2>...` or attach a `.txt` file.");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }

      const existing = readLines();
      fs.writeFileSync(DB_FILE, [...existing, ...newLines].join("\n") + "\n", "utf-8");
      const total = readLines().length;

      // Update all gen panels
      const data = getStorage();
      for (const entry of data.genMessages) {
        try {
          const ch  = await client.channels.fetch(entry.channelId);
          const msg = await ch.messages.fetch(entry.messageId);
          await msg.edit({
            embeds:     [buildGenEmbed(total, message.guild)],
            components: [buildRow(false)],
          });
        } catch (_) {}
      }

      const embed = new EmbedBuilder()
        .setColor("#2ef76e")
        .setTitle("📦 Stock Added")
        .addFields(
          { name: "➕ Added",    value: `**${newLines.length}** account(s)`, inline: true },
          { name: "📊 Total",    value: `**${total}** account(s)`,           inline: true }
        )
        .setTimestamp();
      await message.channel.send({ embeds: [embed] });
      await message.delete().catch(() => {});
      return;
    }

    // ?gen stock — show current stock count
    if (args[0] && args[0].toLowerCase() === "stock") {
      const count = readLines().length;
      const embed = new EmbedBuilder()
        .setColor(count === 0 ? "#ed4245" : count <= LOW_STOCK_THRESHOLD ? "#faa61a" : "#2ef76e")
        .setTitle("📊 Current Stock")
        .setDescription(`There are currently **${count}** account(s) in the database.`)
        .setTimestamp();
      await message.channel.send({ embeds: [embed] });
      await message.delete().catch(() => {});
      return;
    }

    // ?gen setlog #channel — set the gen log + low stock alert channel
    if (args[0] && args[0].toLowerCase() === "setlog") {
      const chId  = args[1] ? args[1].replace(/[<#>]/g, "") : null;
      const logCh = chId ? message.guild.channels.cache.get(chId) : null;
      if (!logCh) {
        const e = await message.channel.send("❌ Usage: `?gen set log #channel`");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }
      const s = getStorage();
      s.genLogChannel = logCh.id;
      saveStorage(s);
      await message.channel.send(`✅ Gen log channel set to ${logCh}. Low stock alerts will also go there.`);
      await message.delete().catch(() => {});
      return;
    }

    // ?gen say #channel <message>
    if (args[0] && args[0].toLowerCase() === "say") {
      const chId   = args[1] ? args[1].replace(/[<#>]/g, "") : null;
      const target = chId ? message.guild.channels.cache.get(chId) : null;
      const text   = args.slice(2).join(" ");
      if (!target || !text) {
        const e = await message.channel.send("❌ Usage: `?gen say #channel <message>`");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }
      await target.send(text);
      await message.delete().catch(() => {});
      return;
    }

    // ?gen dm @user <message>
    if (args[0] && args[0].toLowerCase() === "dm") {
      const target = message.mentions.members.first();
      const text   = args.slice(2).join(" ");
      if (!target || !text) {
        const e = await message.channel.send("❌ Usage: `?gen dm @user <message>`");
        setTimeout(() => e.delete().catch(() => {}), 8000);
        return;
      }
      try {
        await target.send({ embeds: [new EmbedBuilder()
          .setColor("#5865F2")
          .setTitle(`📩 Message from ${message.guild.name}`)
          .setDescription(text)
          .setFooter({ text: `Sent by ${message.author.tag}` })
          .setTimestamp()
        ]});
        await message.channel.send(`✅ DM sent to ${target}.`);
      } catch (_) {
        await message.channel.send(`❌ Couldn't DM ${target} — they may have DMs disabled.`);
      }
      await message.delete().catch(() => {});
      return;
    }

    // ?gen serverinfo
    if (args[0] && args[0].toLowerCase() === "serverinfo") {
      const g      = message.guild;
      const owner  = await g.fetchOwner().catch(() => null);
      const embed  = new EmbedBuilder()
        .setColor("#5865F2")
        .setTitle(`📊 ${g.name}`)
        .setThumbnail(g.iconURL())
        .addFields(
          { name: "👑 Owner",       value: owner ? `${owner.user.tag}` : "Unknown",                      inline: true },
          { name: "👥 Members",     value: `**${g.memberCount}**`,                                        inline: true },
          { name: "📅 Created",     value: `<t:${Math.floor(g.createdTimestamp/1000)}:D>`,               inline: true },
          { name: "💬 Channels",    value: `**${g.channels.cache.size}**`,                               inline: true },
          { name: "🎭 Roles",       value: `**${g.roles.cache.size}**`,                                  inline: true },
          { name: "😀 Emojis",      value: `**${g.emojis.cache.size}**`,                                 inline: true },
          { name: "🚀 Boost Level", value: `Level **${g.premiumTier}** (${g.premiumSubscriptionCount} boosts)`, inline: true },
          { name: "🆔 Server ID",   value: `\`${g.id}\``,                                                inline: true }
        )
        .setTimestamp();
      await message.channel.send({ embeds: [embed] });
      await message.delete().catch(() => {});
      return;
    }

    // ?gen — posts the Steam-style generator panel
    const count   = readLines().length;
    const sentMsg = await message.channel.send({
      embeds:     [buildGenEmbed(count, message.guild)],
      components: [buildRow(count === 0)],
    });

    // Save message so stock updates survive bot restarts
    const data = getStorage();
    data.genMessages.push({ channelId: sentMsg.channelId, messageId: sentMsg.id });
    saveStorage(data);

    await message.delete().catch(() => {});

  } catch (err) {
    console.error("Command error:", err);
  }
});

// ── Global Crash Guards ───────────────────────────────────────────────────────

process.on("unhandledRejection", err => console.error("Unhandled rejection:", err));
process.on("uncaughtException",  err => console.error("Uncaught exception:",  err));

client.login(TOKEN);
r => console.error("Uncaught exception:",  err));

client.login(TOKEN);
