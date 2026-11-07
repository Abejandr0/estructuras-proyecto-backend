import {createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import type {Request, Response} from 'express';
import {database} from './database.js';

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = 'aiverse_session';
const CSRF_COOKIE = 'aiverse_csrf';
const SESSION_DAYS = 14;

function cookieOptions(httpOnly: boolean, expires?: Date) {
  return {httpOnly, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/', expires};
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

export async function createAccount(input: {username: unknown; email: unknown; password: unknown; displayName?: unknown}) {
  if (!database) throw new Error('Account storage is unavailable; configure DATABASE_URL.');
  const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : username;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(username)) throw new Error('El nombre de usuario no es válido.');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('El correo no es válido.');
  if (password.length < 12 || password.length > 256) throw new Error('La contraseña debe tener entre 12 y 256 caracteres.');
  if (!displayName || displayName.length > 80) throw new Error('El nombre visible no es válido.');
  const salt = randomBytes(16);
  const digest = await scrypt(password, salt, 64) as Buffer;
  const passwordHash = `scrypt$${salt.toString('base64')}$${digest.toString('base64')}`;
  const result = await database.query(
    'INSERT INTO users(username,email,password_hash,display_name) VALUES($1,$2,$3,$4) RETURNING id,username,email,display_name,bio,language,created_at',
    [username, email, passwordHash, displayName],
  );
  return result.rows[0] as Record<string, unknown>;
}

export async function createSession(userId: string, response: Response): Promise<void> {
  if (!database) throw new Error('Account storage is unavailable; configure DATABASE_URL.');
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await database.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)',
    [userId, createHash('sha256').update(token).digest('hex'), expires]);
  response.cookie(SESSION_COOKIE, token, cookieOptions(true, expires));
  response.cookie(CSRF_COOKIE, csrf, cookieOptions(false, expires));
}

export async function login(input: {email: unknown; password: unknown}) {
  if (!database) throw new Error('Account storage is unavailable; configure DATABASE_URL.');
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const result = await database.query('SELECT id,username,email,display_name,bio,language,password_hash FROM users WHERE email=$1', [email]);
  if (!result.rowCount) throw new Error('Correo o contraseña incorrectos.');
  const user = result.rows[0] as Record<string, string>;
  const [scheme, saltText, digestText] = user.password_hash.split('$');
  const expected = Buffer.from(digestText, 'base64');
  const candidate = scheme === 'scrypt' ? await scrypt(password, Buffer.from(saltText, 'base64'), expected.length) as Buffer : Buffer.alloc(expected.length);
  if (scheme !== 'scrypt' || candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) throw new Error('Correo o contraseña incorrectos.');
  delete user.password_hash;
  return user;
}

export async function currentUser(request: Request): Promise<Record<string, unknown> | null> {
  if (!database) return null;
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const result = await database.query(
    `SELECT u.id,u.username,u.email,u.display_name,u.bio,u.language,u.created_at
     FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`,
    [createHash('sha256').update(token).digest('hex')],
  );
  return result.rows[0] as Record<string, unknown> ?? null;
}

export async function destroySession(request: Request, response: Response): Promise<void> {
  const token = request.cookies?.[SESSION_COOKIE];
  if (database && token) await database.query('DELETE FROM sessions WHERE token_hash=$1', [createHash('sha256').update(token).digest('hex')]);
  response.clearCookie(SESSION_COOKIE, cookieOptions(true));
  response.clearCookie(CSRF_COOKIE, cookieOptions(false));
}

