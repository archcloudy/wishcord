const ADMINISTRATOR = 1n << 3n;
const KICK_MEMBERS = 1n << 1n;
const CREATE_INSTANT_INVITE = 1n << 0n;
const VIEW_CHANNEL = 1n << 10n;
const MANAGE_CHANNELS = 1n << 4n;
const MANAGE_MESSAGES = 1n << 13n;
const MANAGE_GUILD = 1n << 5n;
const MANAGE_NICKNAMES = 1n << 27n;
const MANAGE_ROLES = 1n << 28n;
const MODERATE_MEMBERS = 1n << 40n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const SEND_MESSAGES = 1n << 11n;

const normalizePermissionString = (value) => {
  if (value === null || value === undefined || value === '') {
    return '0';
  }
  return String(value);
};

const toBigInt = (value) => BigInt(normalizePermissionString(value));

const serializePermission = (value) => value.toString();

const hasPermission = (permissions, flag) => {
  const permissionValue = typeof permissions === 'bigint' ? permissions : toBigInt(permissions);
  return (permissionValue & flag) === flag;
};

const itemIsMemberOverwrite = (overwrite, userId) =>
  overwrite.type === 1 && String(overwrite.id) === String(userId);

const computeBasePermissions = ({ guild, member, roles }) => {
  if (!guild || !member) {
    return 0n;
  }

  if (String(guild.owner_id) === String(member.user.id)) {
    return ADMINISTRATOR;
  }

  let permissions = 0n;
  for (const role of roles) {
    permissions |= toBigInt(role.permissions);
  }

  if (hasPermission(permissions, ADMINISTRATOR)) {
    return ADMINISTRATOR;
  }

  return permissions;
};

const computeChannelPermissions = ({ guild, member, roles, channel }) => {
  let permissions = computeBasePermissions({ guild, member, roles });
  if (hasPermission(permissions, ADMINISTRATOR)) {
    return serializePermission(permissions);
  }

  const overwrites = channel.permission_overwrites || [];
  const everyoneOverwrite = overwrites.find((overwrite) => String(overwrite.id) === String(guild.id));
  if (everyoneOverwrite) {
    permissions &= ~toBigInt(everyoneOverwrite.deny);
    permissions |= toBigInt(everyoneOverwrite.allow);
  }

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const role of roles) {
    const overwrite = overwrites.find((item) => item.type === 0 && String(item.id) === String(role.id));
    if (overwrite) {
      roleAllow |= toBigInt(overwrite.allow);
      roleDeny |= toBigInt(overwrite.deny);
    }
  }

  permissions &= ~roleDeny;
  permissions |= roleAllow;

  const memberOverwrite = overwrites.find((overwrite) => itemIsMemberOverwrite(overwrite, member.user.id));
  if (memberOverwrite) {
    permissions &= ~toBigInt(memberOverwrite.deny);
    permissions |= toBigInt(memberOverwrite.allow);
  }

  return serializePermission(permissions);
};

module.exports = {
  ADMINISTRATOR,
  KICK_MEMBERS,
  CREATE_INSTANT_INVITE,
  VIEW_CHANNEL,
  MANAGE_CHANNELS,
  MANAGE_MESSAGES,
  MANAGE_NICKNAMES,
  MANAGE_GUILD,
  MANAGE_ROLES,
  MODERATE_MEMBERS,
  READ_MESSAGE_HISTORY,
  SEND_MESSAGES,
  normalizePermissionString,
  toBigInt,
  serializePermission,
  hasPermission,
  computeBasePermissions,
  computeChannelPermissions,
};