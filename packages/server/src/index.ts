import {createServer} from 'node:http';
import {watch} from 'node:fs';
import express from 'express';
import {WebSocketServer, WebSocket} from 'ws';
import type {AITask, AITaskKind} from './ai.js';
import {AITaskQueue, HeuristicAIProvider, OpenAIProvider} from './ai.js';
import {resolveRepository} from './repository-root.js';

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

const externalAIEnabled = process.env.AI_ALLOW_NETWORK === 'true' && Boolean(process.env.OPENAI_API_KEY);
const provider = externalAIEnabled
  ? new OpenAIProvider(process.env.OPENAI_API_KEY!, process.env.OPENAI_MODEL ?? 'gpt-4o-mini')
  : new HeuristicAIProvider();
const aiTasks = new AITaskQueue(provider, Number(process.env.AI_CONCURRENCY ?? 2), Number(process.env.AI_MAX_RETRIES ?? 2),
  (task: AITask) => broadcast({type: 'ai-task', task}));

app.use(express.json({limit: '2mb'}));
app.use((request, response, next) => {
  const origin = request.headers.origin;
  const allowed = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
  if (origin && allowed.has(origin)) response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  next();
});
app.options('*', (_request, response) => response.sendStatus(204));

app.get('/api/health', (_request, response) => response.json({ok: true, root: repo.root, provider: externalAIEnabled ? 'openai' : 'heuristic'}));
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

server.listen(port, host, () => {
  if (initialized) console.log(`Initialized MiniGit repository at ${repo.root}`);
  console.log(`MiniGit server listening on http://${host}:${port} (repo ${repo.root})`);
});
