import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import {
  saveOrganiserVerificationConfig,
  getOrganiserVerificationConfig,
  loadAllOrganiserVerificationConfigs,
  recordOrganiserVerification,
} from './mongoService.js';
import { getBackendApiUrl, getBackendBotSecret } from './tournamentService.js';

/**
 * In-memory cache of guild verification configs:
 * Map<guildId, { guildId, verificationChannelId, organiserRoleId, updatedBy, updatedAt }>
 */
const verificationConfigsCache = new Map();

/**
 * Draft state for interactive .setup org verification panel:
 * Map<guildId, { channelId?: string, roleId?: string, initiatedBy: string }>
 */
const setupDrafts = new Map();

/**
 * Rate limit map for activation code attempts per Discord user:
 * Map<userId, { count: number, firstAttempt: number, blockedUntil: number }>
 */
const activationRateLimits = new Map();

/**
 * Loads all verification configs into memory on bot startup.
 */
export async function initOrganiserVerificationConfigsCache() {
  try {
    const configs = await loadAllOrganiserVerificationConfigs();
    verificationConfigsCache.clear();
    for (const cfg of configs) {
      if (cfg && cfg.guildId) {
        verificationConfigsCache.set(cfg.guildId, cfg);
      }
    }
    console.log(`[OrganiserVerification] 📋 Loaded ${verificationConfigsCache.size} guild verification configs.`);
  } catch (err) {
    console.warn('[OrganiserVerification] ⚠️ Error loading configs cache:', err.message);
  }
}

/**
 * Retrieves the verification configuration for a guild.
 * @param {string} guildId
 * @returns {object|null}
 */
export function getGuildVerificationConfig(guildId) {
  if (!guildId) return null;
  return verificationConfigsCache.get(guildId) || null;
}

/**
 * Updates the in-memory cache for a guild.
 * @param {string} guildId
 * @param {object} config
 */
export function setGuildVerificationConfig(guildId, config) {
  if (!guildId || !config) return;
  verificationConfigsCache.set(guildId, config);
}

/**
 * Checks whether member has admin rights to configure verification.
 * @param {import('discord.js').GuildMember} member
 * @returns {boolean}
 */
function isMemberAdmin(member) {
  if (!member) return false;
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    member.guild.ownerId === member.id
  );
}

/**
 * Builds the interactive setup panel embed and components.
 * @param {import('discord.js').Guild} guild
 * @param {object} draft
 */
function buildSetupPanel(guild, draft = {}) {
  const channelText = draft.channelId ? `<#${draft.channelId}>` : '_Not selected_';
  const roleText = draft.roleId ? `<@&${draft.roleId}>` : '_Not selected_';

  const embed = new EmbedBuilder()
    .setTitle('⚙️ Match District – Organiser Verification Setup')
    .setColor(0x5865f2)
    .setDescription(
      'Configure automated Match District organiser accreditation verification for this Discord server.\n\n' +
      'When approved organisers paste their verification code (`MD-VERIFY-XXXXXX`) in the verification channel, ' +
      'the bot validates it with Match District, links their Discord account, and assigns the Organisers role.'
    )
    .addFields(
      { name: '1️⃣ Verification Channel', value: channelText, inline: true },
      { name: '2️⃣ Organisers Role', value: roleText, inline: true }
    )
    .setFooter({ text: 'Match District Tournament Bot • Admin Configuration' })
    .setTimestamp();

  // Channel dropdown
  const channelRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('org_verify:select_channel')
      .setPlaceholder('Select #organiser-verify channel...')
      .setChannelTypes(ChannelType.GuildText)
  );

  // Role dropdown
  const roleRow = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId('org_verify:select_role')
      .setPlaceholder('Select Organisers role...')
  );

  // Action buttons
  const isReady = Boolean(draft.channelId && draft.roleId);
  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('org_verify:save')
      .setLabel('Save Configuration')
      .setStyle(isReady ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setEmoji('💾')
      .setDisabled(!isReady),
    new ButtonBuilder()
      .setCustomId('org_verify:cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [channelRow, roleRow, buttonRow] };
}

/**
 * Handles .setup org verification command.
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').TextChannel} channel
 * @param {Function} replyFn
 */
export async function handleOrganiserVerificationSetupCommand(guild, member, channel, replyFn) {
  if (!guild || !member) return;

  if (!isMemberAdmin(member)) {
    const errorEmbed = new EmbedBuilder()
      .setTitle('⛔ Permission Denied')
      .setColor(0xef4444)
      .setDescription('You must have Administrator or Manage Server permissions to configure Organiser Verification.');
    await replyFn({ embeds: [errorEmbed] });
    return;
  }

  // Check existing config or auto-detect defaults (#organiser-verify and Organisers role)
  const existingConfig = getGuildVerificationConfig(guild.id);
  const draft = {
    channelId: existingConfig?.verificationChannelId || null,
    roleId: existingConfig?.organiserRoleId || null,
    initiatedBy: member.id,
  };

  // Auto-detect #organiser-verify channel if not yet configured
  if (!draft.channelId && guild.channels?.cache) {
    const channels = typeof guild.channels.cache.find === 'function'
      ? guild.channels.cache
      : Array.from(guild.channels.cache.values());
    const verifyChannel = typeof channels.find === 'function'
      ? channels.find((c) => c.type === ChannelType.GuildText && (c.name === 'organiser-verify' || c.name === 'organizer-verify'))
      : null;
    if (verifyChannel) draft.channelId = verifyChannel.id;
  }

  // Auto-detect Organisers role if not yet configured
  if (!draft.roleId && guild.roles?.cache) {
    const roles = typeof guild.roles.cache.find === 'function'
      ? guild.roles.cache
      : Array.from(guild.roles.cache.values());
    const orgRole = typeof roles.find === 'function'
      ? roles.find((r) => {
          const name = (r.name || '').toLowerCase();
          return name === 'organisers' || name === 'organizers' || name === 'organiser';
        })
      : null;
    if (orgRole) draft.roleId = orgRole.id;
  }

  setupDrafts.set(guild.id, draft);

  const panelData = buildSetupPanel(guild, draft);
  await replyFn(panelData);
}

/**
 * Handles interaction components for .setup org verification panel and role claim button.
 * @param {import('discord.js').Interaction} interaction
 */
export async function handleOrganiserVerificationInteraction(interaction) {
  if (!interaction.isMessageComponent()) return false;
  const customId = interaction.customId;

  // Handle retry / claim role button
  if (customId.startsWith('org_claim_role:')) {
    const targetUserId = customId.split(':')[1];
    if (interaction.user.id !== targetUserId) {
      await interaction.reply({ content: '❌ Only the verified organizer can claim this role.', ephemeral: true });
      return true;
    }
    const config = getGuildVerificationConfig(interaction.guildId);
    if (!config?.organiserRoleId) {
      await interaction.reply({ content: '❌ Organisers role is not configured for this server.', ephemeral: true });
      return true;
    }
    try {
      const member = await interaction.guild.members.fetch(targetUserId);
      await member.roles.add(config.organiserRoleId);
      await interaction.reply({ content: '✅ Your **Organisers** role has been successfully assigned!', ephemeral: true });
    } catch (err) {
      await interaction.reply({
        content: `❌ Could not assign role: ${err.message}. Please ensure the bot's highest role is positioned above the Organisers role in Server Settings > Roles.`,
        ephemeral: true,
      });
    }
    return true;
  }

  // Handle setup panel interactions
  if (!customId.startsWith('org_verify:')) return false;

  const guild = interaction.guild;
  if (!guild) return false;

  const member = interaction.member;
  if (!isMemberAdmin(member)) {
    await interaction.reply({ content: '⛔ Only administrators can configure Organiser Verification.', ephemeral: true });
    return true;
  }

  const draft = setupDrafts.get(guild.id) || { initiatedBy: member.id };

  if (customId === 'org_verify:select_channel') {
    draft.channelId = interaction.values[0];
    setupDrafts.set(guild.id, draft);
    const panelData = buildSetupPanel(guild, draft);
    await interaction.update(panelData);
    return true;
  }

  if (customId === 'org_verify:select_role') {
    draft.roleId = interaction.values[0];
    setupDrafts.set(guild.id, draft);
    const panelData = buildSetupPanel(guild, draft);
    await interaction.update(panelData);
    return true;
  }

  if (customId === 'org_verify:cancel') {
    setupDrafts.delete(guild.id);
    const cancelEmbed = new EmbedBuilder()
      .setTitle('❌ Setup Cancelled')
      .setColor(0x6b7280)
      .setDescription('Organiser Verification setup was cancelled.');
    await interaction.update({ embeds: [cancelEmbed], components: [] });
    return true;
  }

  if (customId === 'org_verify:save') {
    if (!draft.channelId || !draft.roleId) {
      await interaction.reply({ content: '⚠️ Please select both a verification channel and an organisers role first.', ephemeral: true });
      return true;
    }

    const config = {
      guildId: guild.id,
      verificationChannelId: draft.channelId,
      organiserRoleId: draft.roleId,
      updatedBy: member.id,
    };

    const saved = await saveOrganiserVerificationConfig(guild.id, config);
    if (!saved) {
      await interaction.reply({ content: '❌ Failed to save configuration to database. Please try again.', ephemeral: true });
      return true;
    }

    setGuildVerificationConfig(guild.id, config);
    setupDrafts.delete(guild.id);

    const successEmbed = new EmbedBuilder()
      .setTitle('✅ Organiser Verification Configured')
      .setColor(0x10b981)
      .setDescription(
        'Organiser Verification system is now active!\n\n' +
        `• **Verification Channel:** <#${config.verificationChannelId}>\n` +
        `• **Organisers Role:** <@&${config.organiserRoleId}>\n\n` +
        'Organisers can now paste their `MD-VERIFY-XXXXXX` verification code into the channel to become verified.'
      )
      .setFooter({ text: 'Match District Organiser System' })
      .setTimestamp();

    await interaction.update({ embeds: [successEmbed], components: [] });
    return true;
  }

  return false;
}

/**
 * Monitors incoming messages in the configured verification channel.
 * Validates activation codes and assigns the Organisers role.
 * @param {import('discord.js').Message} message
 */
export async function handleOrganiserActivationMessage(message) {
  if (!message || message.author?.bot || !message.guild) return;

  const config = getGuildVerificationConfig(message.guild.id);
  if (!config || !config.verificationChannelId) return;

  // Only listen in the configured verification channel
  if (message.channelId !== config.verificationChannelId) return;

  const content = (message.content || '').trim();

  // If someone accidentally pastes an MD-ORG-... Discord Server Linking code in #organiser-verify:
  const orgLinkingMatch = content.match(/\b(MD-ORG-[A-Z0-9-]{6,36})\b/i);
  if (orgLinkingMatch) {
    await message.delete().catch(() => {});
    const infoEmbed = new EmbedBuilder()
      .setTitle('ℹ️ Discord Server Linking Code Detected')
      .setColor(0x5865f2)
      .setDescription(
        `Hey <@${message.author.id}>, \`${orgLinkingMatch[1]}\` is your **Discord Server Linking Code** used to connect your bot to your own Discord server via \`.organiser setup\`.\n\n` +
        `To verify your organizer account on Match District, please submit your **Organizer Verification Code** (\`MD-VERIFY-XXXXXX\`) generated from your organizer dashboard.`
      )
      .setFooter({ text: 'Match District Organiser System' });
    const replyMsg = await message.channel.send({ content: `<@${message.author.id}>`, embeds: [infoEmbed] });
    setTimeout(() => replyMsg.delete().catch(() => {}), 15000);
    return;
  }

  // Match official organizer verification code format MD-VERIFY-XXXXXX
  const codeMatch = content.match(/\b(MD-VERIFY-[A-Z0-9]{4,16})\b/i);
  if (!codeMatch) return;

  const activationCode = codeMatch[1].toUpperCase();
  const userId = message.author.id;
  const username = message.author.tag || message.author.username || userId;

  // Rate limit check: max 5 attempts per 10 minutes per Discord user
  const now = Date.now();
  const userRate = activationRateLimits.get(userId) || { count: 0, firstAttempt: now, blockedUntil: 0 };
  if (userRate.blockedUntil > now) {
    const remainingMins = Math.ceil((userRate.blockedUntil - now) / 60000);
    // Delete submitted message
    await message.delete().catch(() => {});
    const rateEmbed = new EmbedBuilder()
      .setTitle('⏳ Verification Rate Limited')
      .setColor(0xf59e0b)
      .setDescription(`Too many verification attempts. Please wait **${remainingMins} minute(s)** before trying again.`);
    const replyMsg = await message.channel.send({ content: `<@${userId}>`, embeds: [rateEmbed] });
    setTimeout(() => replyMsg.delete().catch(() => {}), 10000);
    return;
  }

  if (now - userRate.firstAttempt > 10 * 60 * 1000) {
    userRate.count = 0;
    userRate.firstAttempt = now;
  }
  userRate.count += 1;
  if (userRate.count > 5) {
    userRate.blockedUntil = now + 10 * 60 * 1000;
    activationRateLimits.set(userId, userRate);
    await message.delete().catch(() => {});
    const rateEmbed = new EmbedBuilder()
      .setTitle('⏳ Verification Rate Limited')
      .setColor(0xf59e0b)
      .setDescription('Too many verification attempts. You are temporarily rate-limited for 10 minutes.');
    const replyMsg = await message.channel.send({ content: `<@${userId}>`, embeds: [rateEmbed] });
    setTimeout(() => replyMsg.delete().catch(() => {}), 10000);
    return;
  }
  activationRateLimits.set(userId, userRate);

  // Delete message from channel to avoid leaving activation codes exposed in public chat
  await message.delete().catch(() => {});

  // Call Backend API
  const backendUrl = getBackendApiUrl();
  const botSecret = getBackendBotSecret();

  try {
    const res = await fetch(`${backendUrl}/api/bot/organizer/verify-activation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bot-secret': botSecret,
        Authorization: `Bearer ${botSecret}`,
      },
      body: JSON.stringify({
        code: activationCode,
        discord_user_id: userId,
        discord_username: username,
        guild_id: message.guild.id,
      }),
    });

    const data = await res.json().catch(() => ({ success: false, error: 'PARSE_ERROR' }));

    if (res.ok && data.success) {
      // SUCCESSFUL VERIFICATION
      let roleAssigned = false;
      let roleErrorMsg = null;

      if (config.organiserRoleId) {
        try {
          const member = message.member || await message.guild.members.fetch(userId);
          await member.roles.add(config.organiserRoleId);
          roleAssigned = true;
        } catch (roleErr) {
          roleErrorMsg = roleErr.message;
          console.warn(`[OrganiserVerification] ⚠️ Failed to assign role to ${username}:`, roleErr.message);
        }
      }

      await recordOrganiserVerification({
        guildId: message.guild.id,
        discordUserId: userId,
        discordUsername: username,
        organiserId: data.organizerId,
        organiserName: data.orgName || data.applicantName,
        status: roleAssigned ? 'verified' : 'role_assignment_pending',
        roleError: roleErrorMsg,
      });

      const successEmbed = new EmbedBuilder()
        .setTitle('Organizer Verification Successful')
        .setColor(0x10b981)
        .setDescription(
          `Congratulations <@${userId}>! Your Match District organiser account has been successfully verified.\n\n` +
          `• **Your Discord account is now linked.**\n` +
          `• **Your Organisers role has been ${roleAssigned ? 'assigned' : 'queued'}.**\n` +
          `• **You can now create and host tournaments on Match District.**`
        )
        .addFields(
          { name: 'Organization', value: data.orgName || data.applicantName || 'Verified Organiser', inline: true },
          { name: 'Status', value: '✅ Verified Host', inline: true }
        )
        .setFooter({ text: 'Match District Organiser System' })
        .setTimestamp();

      const components = [];
      if (!roleAssigned && config.organiserRoleId) {
        const claimRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`org_claim_role:${userId}`)
            .setLabel('Claim Organisers Role')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🛡️')
        );
        components.push(claimRow);
      }

      await message.channel.send({
        content: `<@${userId}>`,
        embeds: [successEmbed],
        components,
      });
      return;
    }

    // ERROR RESPONSES
    let errorEmbed;
    const errorCode = data.error || 'INVALID_CODE';

    if (errorCode === 'EXPIRED_CODE') {
      errorEmbed = new EmbedBuilder()
        .setTitle('Activation Code Expired')
        .setColor(0xf59e0b)
        .setDescription('Your activation code has expired. Please contact the Match District administration for a new code.')
        .setFooter({ text: 'Match District Organiser System' })
        .setTimestamp();
    } else if (errorCode === 'ALREADY_USED') {
      errorEmbed = new EmbedBuilder()
        .setTitle('Activation Code Already Used')
        .setColor(0xef4444)
        .setDescription('This activation code has already been redeemed.')
        .setFooter({ text: 'Match District Organiser System' })
        .setTimestamp();
    } else if (errorCode === 'DISCORD_USER_ALREADY_LINKED' || errorCode === 'ORGANIZER_ALREADY_LINKED') {
      errorEmbed = new EmbedBuilder()
        .setTitle('Account Already Linked')
        .setColor(0xef4444)
        .setDescription(data.message || 'Your Discord account is already linked to another organiser profile.')
        .setFooter({ text: 'Match District Organiser System' })
        .setTimestamp();
    } else {
      // Invalid code
      errorEmbed = new EmbedBuilder()
        .setTitle('Invalid Activation Code')
        .setColor(0xef4444)
        .setDescription('This activation code is invalid. Please check the code and try again.')
        .setFooter({ text: 'Match District Organiser System' })
        .setTimestamp();
    }

    const replyMsg = await message.channel.send({
      content: `<@${userId}>`,
      embeds: [errorEmbed],
    });

    // Automatically remove error notification after 20 seconds so channel stays clean
    setTimeout(() => replyMsg.delete().catch(() => {}), 20000);
  } catch (apiErr) {
    console.error('[OrganiserVerification] ❌ Backend API call failed:', apiErr);
    const failEmbed = new EmbedBuilder()
      .setTitle('Verification Service Unavailable')
      .setColor(0xef4444)
      .setDescription('Unable to connect to Match District verification services. Please try again shortly.');
    const replyMsg = await message.channel.send({ content: `<@${userId}>`, embeds: [failEmbed] });
    setTimeout(() => replyMsg.delete().catch(() => {}), 15000);
  }
}
