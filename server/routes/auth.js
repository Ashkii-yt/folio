import express from 'express';
import { bad, HttpError } from '../util.js';
import {
  clientIp, register, login, changePassword, issueSession, verifySession, getContext,
  registrationOpenFor, listUsernames, MAX_PER_IP,
} from '../accounts.js';
import { runAs } from '../db.js';

export const COOKIE = 'folio_session';

function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSession(req, res, username) {
  const secure = process.env.FOLIO_SECURE_COOKIES === '1' || req.headers['x-forwarded-proto'] === 'https' && process.env.FOLIO_TRUST_PROXY === '1';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(issueSession(username))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 3600}${secure ? '; Secure' : ''}`);
}

export const sessionUser = (req) => verifySession(cookieOf(req, COOKIE));

/** Gate for everything that touches user data: resolves the account and runs the handler inside its context. */
export function requireUser(req, res, next) {
  const name = sessionUser(req);
  const ctx = name && getContext(name);
  if (!ctx) {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return res.status(401).json({ error: { message: 'Sign in to continue.', code: 'auth_required' } });
  }
  req.user = name;
  return runAs(ctx, () => next());
}

export const auth = express.Router();

auth.get('/session', (req, res) => {
  const ip = clientIp(req);
  res.json({
    user: sessionUser(req),
    registrationOpen: registrationOpenFor(ip),
    firstRun: listUsernames().length === 0,
    limitPerIp: MAX_PER_IP,
  });
});

auth.post('/register', async (req, res) => {
  const { username, password } = req.body || {};
  const r = await register({ username, password, ip: clientIp(req) });
  setSession(req, res, r.username);
  res.status(201).json({ user: r.username, adopted: r.adopted });
});

auth.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const name = await login({ username, password, ip: clientIp(req) });
  setSession(req, res, name);
  res.json({ user: name });
});

auth.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

auth.post('/password', async (req, res) => {
  const name = sessionUser(req);
  if (!name) throw new HttpError(401, 'Sign in to continue.', 'auth_required');
  const { current, next } = req.body || {};
  if (current === next) throw bad('Choose a new password that is different from the current one.');
  await changePassword(name, { current, next, ip: clientIp(req) });
  setSession(req, res, name); // this browser stays signed in; every other session is signed out
  res.json({ ok: true });
});
