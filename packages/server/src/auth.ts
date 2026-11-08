import {createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import type {Request, Response} from 'express';
import {sessions, users} from './database.js';

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = 'aiverse_session';
const CSRF_COOKIE = 'aiverse_csrf';
const SESSION_DAYS = 14;

function cookieOptions(httpOnly: boolean, expires?: Date) {
  const secure = process.env.NODE_ENV === 'production';
  return {httpOnly, secure, sameSite: secure ? 'none' as const : 'lax' as const, path: '/', expires};
}

function csrfMatches(request: Request): boolean {
  const cookie = request.cookies?.[CSRF_COOKIE];
  const header = request.get('x-csrf-token');
  if (!cookie || !header || cookie.length !== header.length) return false;
  return timingSafeEqual(Buffer.from(cookie), Buffer.from(header));
}

export function requireCsrf(request: Request, response: Response): boolean {
  if (process.env.NODE_ENV !== 'production' && request.get('origin') === undefined) return true;
  if (csrfMatches(request)) return true;
  response.status(403).json({error: 'CSRF validation failed'});
  return false;
}

function publicUser(user: Record<string, unknown>) {
  const {_id, passwordHash: _passwordHash, ...safeUser} = user;
  return safeUser;
}

export async function createAccount(input: {username: unknown; email: unknown; password: unknown; confirmPassword?: unknown; displayName?: unknown}) {
  if (!users) throw new Error('El almacenamiento de cuentas no está disponible; configura MONGODB_URI.');
  const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : username;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(username)) throw new Error('El nombre de usuario no es válido.');
  const emailPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
  const [localPart] = email.split('@');
  if (email.length > 254 || !emailPattern.test(email) || localPart.startsWith('.') || localPart.endsWith('.') || localPart.includes('..')) throw new Error('Escribe un correo válido, por ejemplo nombre@dominio.com.');
  if (password.length < 12 || password.length > 128 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9\s]/.test(password)) {
    throw new Error('La contraseña debe tener 12 a 128 caracteres e incluir mayúscula, minúscula, número y símbolo.');
  }
  if (password.toLowerCase().includes('password') || password.toLowerCase().includes('contraseña')) throw new Error('Elige una contraseña menos predecible.');
  if (input.confirmPassword !== password) throw new Error('Las contraseñas no coinciden.');
  if (!displayName || displayName.length > 80) throw new Error('El nombre visible no es válido.');
  const salt = randomBytes(16);
  const digest = await scrypt(password, salt, 64) as Buffer;
  const user = {id: randomUUID(), username, email, passwordHash: `scrypt$${salt.toString('base64')}$${digest.toString('base64')}`,
    display_name: displayName, bio: '', language: 'es', plan: 'free', repositoryCount: 0, created_at: new Date()};
  try { await users.insertOne(user); }
  catch (error) {
    if ((error as {code?: number}).code === 11000) throw new Error('Ese nombre de usuario o correo ya está registrado.');
    throw error;
  }
  return publicUser(user);
}

export async function createSession(userId: string, response: Response): Promise<void> {
  if (!sessions) throw new Error('El almacenamiento de sesiones no está disponible; configura MONGODB_URI.');
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await sessions.insertOne({id: randomUUID(), userId, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt, createdAt: new Date()});
  response.cookie(SESSION_COOKIE, token, cookieOptions(true, expiresAt));
  response.cookie(CSRF_COOKIE, csrf, cookieOptions(false, expiresAt));
}

export async function login(input: {email: unknown; password: unknown}) {
  if (!users) throw new Error('El almacenamiento de cuentas no está disponible; configura MONGODB_URI.');
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const user = await users.findOne({email});
  if (!user) throw new Error('Correo o contraseña incorrectos.');
  const [scheme, saltText, digestText] = String(user.passwordHash).split('$');
  const expected = Buffer.from(digestText ?? '', 'base64');
  const candidate = scheme === 'scrypt' && expected.length ? await scrypt(password, Buffer.from(saltText, 'base64'), expected.length) as Buffer : Buffer.alloc(expected.length);
  if (scheme !== 'scrypt' || candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) throw new Error('Correo o contraseña incorrectos.');
  return publicUser(user);
}

export async function currentUser(request: Request): Promise<Record<string, unknown> | null> {
  if (!sessions || !users) return null;
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const session = await sessions.findOne({tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: {$gt: new Date()}});
  if (!session) return null;
  const user = await users.findOne({id: session.userId});
  return user ? publicUser(user) : null;
}

export async function destroySession(request: Request, response: Response): Promise<void> {
  const token = request.cookies?.[SESSION_COOKIE];
  if (sessions && token) await sessions.deleteOne({tokenHash: createHash('sha256').update(token).digest('hex')});
  response.clearCookie(SESSION_COOKIE, cookieOptions(true));
  response.clearCookie(CSRF_COOKIE, cookieOptions(false));
}
