import crypto from 'node:crypto';

const SESSION_TTL = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW = 15 * 60 * 1000;
const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/;

export class AdminAuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string' || !/^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(stored)) return false;
  const [salt, expected] = stored.split(':');
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), actual);
}

export function createAdminAuth({ readData, writeData, secret, adminPassword, resetPassword = false }) {
  const sessions = new Map();
  const loginAttempts = new Map();
  const publicAccount = ({ id, username, name, role, enabled, createdAt, updatedAt }) => ({ id, username, name, role, enabled, createdAt, updatedAt });
  const cleanUsername = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
  const sign = value => crypto.createHmac('sha256', secret).update(value).digest('hex');
  const validatePassword = password => {
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw new AdminAuthError('密码长度必须为 8 至 128 个字符');
  };
  const validateProfile = input => {
    const username = cleanUsername(input.username);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!USERNAME_PATTERN.test(username)) throw new AdminAuthError('账号须为 3 至 32 位字母、数字、下划线、点或短横线，并以字母或数字开头');
    if (!name || name.length > 60) throw new AdminAuthError('管理员姓名须为 1 至 60 个字符');
    return { username, name };
  };
  const revokeSessions = id => {
    for (const [token, session] of sessions) if (session.adminId === id) sessions.delete(token);
  };

  // Migrate the existing password once; never overwrite business data or existing accounts.
  const initial = readData();
  let changed = false;
  if (!Array.isArray(initial.admins)) {
    const now = new Date().toISOString();
    initial.admins = [{ id: crypto.randomUUID(), username: 'admin', name: '超级管理员', role: 'superadmin', enabled: true, passwordHash: initial.adminPasswordHash || hashPassword(adminPassword), createdAt: now, updatedAt: now }];
    changed = true;
  }
  if (!initial.admins.some(account => account.role === 'superadmin' && account.enabled !== false)) throw new Error('No active super administrator found. Restore the administrator data from backup.');
  if (resetPassword) {
    const owner = initial.admins.find(account => account.role === 'superadmin' && account.enabled !== false);
    owner.passwordHash = hashPassword(adminPassword);
    owner.updatedAt = new Date().toISOString();
    changed = true;
  }
  if (Object.hasOwn(initial, 'adminPasswordHash')) { delete initial.adminPasswordHash; changed = true; }
  if (changed) writeData(initial);

  function authenticate(token) {
    if (typeof token !== 'string') return null;
    const [id, signature, extra] = token.split('.');
    if (extra !== undefined || !/^[a-f0-9]{64}$/.test(id || '') || !/^[a-f0-9]{64}$/.test(signature || '')) return null;
    if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(id), 'hex'))) return null;
    const session = sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) { sessions.delete(id); return null; }
    const account = readData().admins.find(account => account.id === session.adminId && account.enabled !== false);
    if (!account) { sessions.delete(id); return null; }
    return publicAccount(account);
  }

  function login(username, password, ip = 'unknown') {
    const now = Date.now();
    for (const [key, value] of loginAttempts) if (now - value.startedAt >= LOGIN_WINDOW) loginAttempts.delete(key);
    const attempts = loginAttempts.get(ip) || { startedAt: now, count: 0 };
    if (attempts.count >= 10) throw new AdminAuthError('登录失败次数过多，请 15 分钟后重试', 429);
    // Require a username even when migrating the previous password-only site.
    const account = readData().admins.find(account => account.username === cleanUsername(username) && account.enabled !== false);
    const validLength = typeof password === 'string' && password.length <= 128;
    const valid = validLength && verifyPassword(password, account?.passwordHash || dummyHash);
    if (!account || !valid) {
      attempts.count++;
      loginAttempts.set(ip, attempts);
      throw new AdminAuthError('账号或密码错误', 401);
    }
    loginAttempts.delete(ip);
    for (const [key, value] of sessions) if (value.expiresAt <= now) sessions.delete(key);
    const id = crypto.randomBytes(32).toString('hex');
    sessions.set(id, { adminId: account.id, expiresAt: now + SESSION_TTL });
    return { token: `${id}.${sign(id)}`, admin: publicAccount(account) };
  }

  function logout(token) {
    if (typeof token === 'string') sessions.delete(token.split('.')[0]);
  }

  function changePassword(id, input) {
    const data = readData();
    const account = data.admins.find(account => account.id === id && account.enabled !== false);
    if (!account) throw new AdminAuthError('请重新登录', 401);
    if (typeof input.currentPassword !== 'string' || input.currentPassword.length > 128 || !verifyPassword(input.currentPassword, account.passwordHash)) throw new AdminAuthError('当前密码不正确');
    validatePassword(input.newPassword);
    if (input.newPassword !== input.confirmPassword) throw new AdminAuthError('两次输入的新密码不一致');
    account.passwordHash = hashPassword(input.newPassword);
    account.updatedAt = new Date().toISOString();
    writeData(data);
    revokeSessions(id);
  }

  function requireOwner(actorId, data) {
    if (!data.admins.some(account => account.id === actorId && account.role === 'superadmin' && account.enabled !== false)) throw new AdminAuthError('只有超级管理员可以管理管理员账号', 403);
  }

  function list(actorId) {
    const data = readData();
    requireOwner(actorId, data);
    return data.admins.map(publicAccount);
  }

  function create(actorId, input) {
    const data = readData();
    requireOwner(actorId, data);
    const profile = validateProfile(input);
    validatePassword(input.password);
    if (input.password !== input.confirmPassword) throw new AdminAuthError('两次输入的密码不一致');
    if (data.admins.some(account => account.username === profile.username)) throw new AdminAuthError('该管理员账号已存在');
    const now = new Date().toISOString();
    const account = { id: crypto.randomUUID(), ...profile, role: 'admin', enabled: true, passwordHash: hashPassword(input.password), createdAt: now, updatedAt: now };
    data.admins.push(account);
    writeData(data);
    return publicAccount(account);
  }

  function update(actorId, id, input) {
    const data = readData();
    requireOwner(actorId, data);
    const account = data.admins.find(account => account.id === id);
    if (!account) throw new AdminAuthError('管理员不存在', 404);
    const profile = validateProfile(input);
    if (data.admins.some(other => other.id !== id && other.username === profile.username)) throw new AdminAuthError('该管理员账号已存在');
    const enabled = input.enabled === undefined ? account.enabled !== false : input.enabled;
    if (typeof enabled !== 'boolean') throw new AdminAuthError('账号状态无效');
    if (!enabled && (account.id === actorId || account.role === 'superadmin')) throw new AdminAuthError('不能停用当前账号或超级管理员');
    let passwordHash = account.passwordHash;
    if (input.password !== undefined && input.password !== '') {
      validatePassword(input.password);
      if (input.password !== input.confirmPassword) throw new AdminAuthError('两次输入的密码不一致');
      passwordHash = hashPassword(input.password);
    }
    const invalidate = passwordHash !== account.passwordHash || !enabled || profile.username !== account.username;
    Object.assign(account, profile, { enabled, passwordHash, updatedAt: new Date().toISOString() });
    writeData(data);
    if (invalidate) revokeSessions(id);
    return { admin: publicAccount(account), reauthenticate: id === actorId && invalidate };
  }

  const dummyHash = hashPassword(crypto.randomBytes(32).toString('hex'));
  return { authenticate, login, logout, changePassword, list, create, update };
}
