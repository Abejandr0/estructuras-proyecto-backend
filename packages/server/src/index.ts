import {createServer} from 'node:http';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {watch} from 'node:fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import {WebSocketServer, WebSocket} from 'ws';
import type {AITask, AITaskKind} from './ai.js';
import {AITaskQueue, GeminiProvider, OpenAIProvider} from './ai.js';
import {resolveRepository} from './repository-root.js';
import {Repository} from '@minigit/core';
import {database, initializeDatabase} from './database.js';
import {createAccount, createSession, currentUser, destroySession, login, requireCsrf} from './auth.js';

const autoInit = process.argv.includes('--auto-init') || process.env.MINIGIT_AUTO_INIT === 'true';
const {repo, initialized} = await resolveRepository({cwd: process.cwd(), initCwd: process.env.INIT_CWD, explicitRoot: process.env.MINIGIT_REPO, autoInit});
const port = Number(process.env.PORT ?? 4179);
const host = process.env.HOST ?? '127.0.0.1';
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({server, path: '/api/events'});

function broadcast(event: unknown): void {
  const payload = JSON.stringify(event);
  for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(payload);
}

const aiProvider = process.env.AI_PROVIDER ?? 'gemini';
const externalAIEnabled = process.env.AI_ALLOW_NETWORK === 'true' && Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
const provider = externalAIEnabled && aiProvider === 'gemini' && process.env.GEMINI_API_KEY
  ? new GeminiProvider(process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL ?? 'gemini-2.5-flash')
  : externalAIEnabled && process.env.OPENAI_API_KEY
    ? new OpenAIProvider(process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL ?? 'gpt-4o-mini')
    : {async run() { throw new Error('Configura GEMINI_API_KEY y AI_ALLOW_NETWORK=true para habilitar la revisión con IA.'); }};
const aiTasks = new AITaskQueue(provider, Number(process.env.AI_CONCURRENCY ?? 2), Number(process.env.AI_MAX_RETRIES ?? 2),
  (task: AITask) => broadcast({type: 'ai-task', task}));

app.disable('x-powered-by');
app.use(helmet({crossOriginResourcePolicy: {policy: 'same-site'}}));
app.use(express.json({limit: '2mb'}));
app.use(cookieParser());
app.use((request, response, next) => {
  const origin = request.headers.origin;
  const allowed = new Set(['http://localhost:5173', 'http://127.0.0.1:5173', process.env.WEB_ORIGIN].filter(Boolean));
  if (origin && allowed.has(origin)) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Access-Control-Allow-Credentials', 'true'); }
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  next();
});
app.options('*', (_request, response) => response.sendStatus(204));

app.get('/api/health', (_request, response) => response.json({ok: true, root: repo.root, provider: externalAIEnabled ? aiProvider : 'unconfigured'}));
app.get('/api/auth/csrf', (_request, response) => {
  const token = randomUUID() + randomUUID();
  response.cookie('aiverse_csrf', token, {httpOnly: false, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/'});
  response.json({csrfToken: token});
});
app.get('/api/health/ready', async (_request, response) => {
  if (!database) { response.status(503).json({ok: false, database: 'DATABASE_URL is not configured'}); return; }
  try { await database.query('SELECT 1'); response.json({ok: true, database: 'connected'}); }
  catch { response.status(503).json({ok: false, database: 'unavailable'}); }
});
app.get('/api/repo/status', async (_request, response, next) => { try { response.json(await repo.status()); } catch (error) { next(error); } });
app.get('/api/repo/log', async (_request, response, next) => { try { response.json(await repo.log()); } catch (error) { next(error); } });
app.get('/api/repo/branches', async (_request, response, next) => { try { response.json(await repo.branches()); } catch (error) { next(error); } });
app.get('/api/repo/tree', async (request, response, next) => { try { response.json(await repo.tree(typeof request.query.ref === 'string' ? request.query.ref : undefined)); } catch (error) { next(error); } });
app.get('/api/repo/diff', async (_request, response, next) => { try { response.json(await repo.workingTreeDiff()); } catch (error) { next(error); } });
app.get('/api/repo/file', async (request, response, next) => {
  try {
    const filePath = typeof request.query.path === 'string' ? request.query.path : '';
    const entry = (await repo.tree()).find(item => item.path === filePath);
    if (!entry) { response.status(404).json({error: 'File not found'}); return; }
    const object = await repo.readObject(entry.hash);
    response.json({path: filePath, content: object.body.toString('utf8'), hash: entry.hash});
  } catch (error) { next(error); }
});
app.get('/api/structures', (_request, response) => response.json(repo.getStructureSnapshot()));

const authLimiter = rateLimit({windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false});
app.post('/api/auth/register', authLimiter, async (request, response, next) => {
  try {
    if (!requireCsrf(request, response)) return;
    const user = await createAccount(request.body ?? {});
    await createSession(String(user.id), response);
    response.status(201).json({user});
  } catch (error) { next(error); }
});
app.post('/api/auth/login', authLimiter, async (request, response, next) => {
  try {
    if (!requireCsrf(request, response)) return;
    const user = await login(request.body ?? {});
    await createSession(String(user.id), response);
    response.json({user});
  } catch (error) { next(error); }
});
app.post('/api/auth/logout', async (request, response, next) => {
  try { if (!requireCsrf(request, response)) return; await destroySession(request, response); response.sendStatus(204); }
  catch (error) { next(error); }
});
app.get('/api/auth/me', async (request, response, next) => {
  try { response.json({user: await currentUser(request)}); }
  catch (error) { next(error); }
});

app.get('/api/feed', async (_request, response, next) => {
  try {
    if (!database) { response.status(503).json({error: 'Configura DATABASE_URL para habilitar el feed.'}); return; }
    const result = await database.query(
      `SELECT r.id,r.name,r.description,r.stars_count,r.created_at,u.username,u.display_name
       FROM repositories r JOIN users u ON u.id=r.owner_id WHERE r.is_public=true
       ORDER BY r.stars_count DESC,r.created_at DESC LIMIT 50`,
    );
    response.json({repositories: result.rows});
  } catch (error) { next(error); }
});
app.post('/api/repositories', async (request, response, next) => {
  try {
    if (!requireCsrf(request, response)) return;
    if (!database) { response.status(503).json({error: 'Configura DATABASE_URL para crear repositorios.'}); return; }
    const user = await currentUser(request);
    if (!user) { response.status(401).json({error: 'Inicia sesión para continuar.'}); return; }
    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
    const description = typeof request.body?.description === 'string' ? request.body.description.trim() : '';
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || description.length > 350) { response.status(400).json({error: 'Nombre o descripción no válidos.'}); return; }
    const result = await database.query(
      `INSERT INTO repositories(owner_id,name,description,is_public) VALUES($1,$2,$3,$4)
       RETURNING id,name,description,is_public,disk_key,created_at`,
      [user.id,name,description,request.body?.isPublic !== false],
    );
    const repositoryRoot = path.join(repo.root, 'aiverse-repositories', String(result.rows[0].disk_key));
    await mkdir(path.dirname(repositoryRoot), {recursive: true});
    await Repository.init(repositoryRoot);
    response.status(201).json({repository: result.rows[0]});
  } catch (error) { next(error); }
});
app.get('/api/pull-requests', async (request, response, next) => {
  try {
    if (!database) { response.status(503).json({error: 'Configura DATABASE_URL para habilitar los PRs.'}); return; }
    const repositoryId = typeof request.query.repositoryId === 'string' ? request.query.repositoryId : '';
    const result = await database.query(
      `SELECT p.*,u.username FROM pull_requests p JOIN users u ON u.id=p.author_id
       JOIN repositories r ON r.id=p.repository_id WHERE ($1='' OR r.id=$1) AND (r.is_public=true OR r.owner_id=$2)
       ORDER BY p.created_at DESC LIMIT 100`,
      [repositoryId,(await currentUser(request))?.id ?? null],
    );
    response.json({pullRequests: result.rows});
  } catch (error) { next(error); }
});
app.post('/api/pull-requests', async (request, response, next) => {
  try {
    if (!requireCsrf(request, response)) return;
    if (!database) { response.status(503).json({error: 'Configura DATABASE_URL para habilitar los PRs.'}); return; }
    const user = await currentUser(request);
    if (!user) { response.status(401).json({error: 'Inicia sesión para continuar.'}); return; }
    const {repositoryId, title, body, sourceBranch, targetBranch} = request.body ?? {};
    if (![repositoryId,title,sourceBranch,targetBranch].every(value => typeof value === 'string' && value.trim().length > 0) || title.length > 180 || String(body ?? '').length > 20_000) {
      response.status(400).json({error: 'Datos del pull request no válidos.'}); return;
    }
    const repository = await database.query('SELECT id FROM repositories WHERE id=$1 AND owner_id=$2', [repositoryId,user.id]);
    if (!repository.rowCount) { response.status(404).json({error: 'Repositorio no encontrado o sin permisos.'}); return; }
    const result = await database.query(
      `INSERT INTO pull_requests(repository_id,author_id,title,body,source_branch,target_branch)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [repositoryId,user.id,title.trim(),String(body ?? ''),sourceBranch.trim(),targetBranch.trim()],
    );
    await database.query('INSERT INTO activity_events(actor_id,repository_id,kind,payload) VALUES($1,$2,$3,$4)',
      [user.id,repositoryId,'pull_request_opened',JSON.stringify({pullRequestId:result.rows[0].id,title})]);
    response.status(201).json({pullRequest: result.rows[0]});
  } catch (error) { next(error); }
});
app.post('/api/pull-requests/:id/reviews', async (request, response, next) => {
  try {
    if (!requireCsrf(request, response)) return;
    if (!database) { response.status(503).json({error: 'Configura DATABASE_URL para habilitar las revisiones.'}); return; }
    const user = await currentUser(request);
    if (!user) { response.status(401).json({error: 'Inicia sesión para continuar.'}); return; }
    const {body, state} = request.body ?? {};
    if (typeof body !== 'string' || body.length > 20_000 || !['commented','approved','changes_requested'].includes(state)) { response.status(400).json({error: 'Revisión no válida.'}); return; }
    const access = await database.query(`SELECT p.id FROM pull_requests p JOIN repositories r ON r.id=p.repository_id
      WHERE p.id=$1 AND (p.author_id=$2 OR r.owner_id=$2)`, [request.params.id,user.id]);
    if (!access.rowCount) { response.status(404).json({error: 'PR no encontrado o sin permisos.'}); return; }
    const result = await database.query('INSERT INTO pull_request_reviews(pull_request_id,reviewer_id,body,state) VALUES($1,$2,$3,$4) RETURNING *',
      [request.params.id,user.id,body,state]);
    response.status(201).json({review: result.rows[0]});
  } catch (error) { next(error); }
});

app.post('/api/repo/add', async (request, response, next) => { try { response.json({staged: await repo.add(request.body.paths ?? [])}); } catch (error) { next(error); } });
app.post('/api/repo/commit', async (request, response, next) => { try { response.json({hash: await repo.commit(request.body.message)}); } catch (error) { next(error); } });
app.post('/api/repo/branch', async (request, response, next) => { try { await repo.branch(request.body.name); response.json({branches: await repo.branches()}); } catch (error) { next(error); } });
app.post('/api/repo/checkout', async (request, response, next) => { try { await repo.checkout(request.body.name); response.json({branch: request.body.name}); } catch (error) { next(error); } });
app.post('/api/repo/merge', async (request, response, next) => { try { response.json(await repo.merge(request.body.name)); } catch (error) { next(error); } });
app.post('/api/repo/stash', async (request, response, next) => { try { response.json({stashes: await repo.stash(request.body.action ?? 'push')}); } catch (error) { next(error); } });
app.post('/api/repo/reset', async (request, response, next) => { try { response.json({hash: await repo.reset(request.body.target ?? 'HEAD', request.body.hard ?? false)}); } catch (error) { next(error); } });
app.post('/api/repo/revert', async (request, response, next) => { try { response.json({hash: await repo.revert(request.body.target)}); } catch (error) { next(error); } });

app.get('/api/ai/tasks', (_request, response) => response.json(aiTasks.list()));
app.get('/api/ai/tasks/:id', (request, response) => {
  const task = aiTasks.get(request.params.id);
  if (!task) { response.status(404).json({error: 'Task not found'}); return; }
  response.json(task);
});
app.post('/api/ai/:kind', (request, response) => {
  const kind = request.params.kind as AITaskKind;
  if (!['review', 'commit-msg', 'resolve'].includes(kind)) { response.status(404).json({error: 'Unknown AI task'}); return; }
  response.status(202).json(aiTasks.enqueue(kind, request.body.diff ?? request.body.text ?? ''));
});

app.get('/api/remote/refs', async (_request, response, next) => { try { response.json({refs: (await repo.remoteSnapshot()).refs}); } catch (error) { next(error); } });
app.get('/api/remote/hashes', async (_request, response, next) => { try { response.json({hashes: await repo.objectHashes()}); } catch (error) { next(error); } });
app.post('/api/remote/pack', async (request, response, next) => { try { response.json(await repo.remoteSnapshot(request.body.have ?? [], request.body.bloom)); } catch (error) { next(error); } });
app.post('/api/remote/push', async (request, response, next) => {
  try {
    if (!request.body.snapshot) { response.status(400).json({error: 'snapshot required'}); return; }
    await repo.importRemote(request.body.snapshot);
    response.json({ok: true, refs: (await repo.remoteSnapshot()).refs});
  } catch (error) { next(error); }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  response.status(400).json({error: error instanceof Error ? error.message : String(error)});
});

try {
  watch(repo.root, {recursive: true}, (eventType, filename) => {
    if (filename && !String(filename).includes('.minigit')) broadcast({type: 'filesystem', eventType, path: filename});
  });
} catch { /* Explicit API refresh remains available on filesystems without recursive watch. */ }

if (database) await initializeDatabase();
server.listen(port, host, () => {
  if (initialized) console.log(`Initialized MiniGit repository at ${repo.root}`);
  console.log(`MiniGit server listening on http://${host}:${port} (repo ${repo.root})`);
});
