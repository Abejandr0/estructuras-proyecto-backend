import express from 'express';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import {Repository} from 'aiverse-core';
import {currentCliUser, currentUser, requireCsrf} from './auth.js';
import {repositories} from './database.js';

type WorkspaceHandler = (repository: Repository, request: express.Request, response: express.Response) => Promise<void>;

function workspaceRoute(handler: WorkspaceHandler, write = false, repositoryStorageRoot = process.cwd()) {
  return async (request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (write && !requireCsrf(request, response)) return;
    try {
      if (!repositories) { response.status(503).json({error: 'El almacenamiento de repositorios no está disponible.'}); return; }
      const user = await currentUser(request);
      const stored = await repositories.findOne(
        {id: request.params.repositoryId},
        {projection: {id: 1, diskKey: 1, ownerId: 1, isPublic: 1}},
      );
      const ownsRepository = Boolean(user && String(stored?.ownerId) === String(user.id));
      if (!stored || (write && !ownsRepository) || (!write && !ownsRepository && stored.isPublic !== true)) {
        response.status(404).json({error: 'Repositorio no encontrado.'}); return;
      }
      if (write && !user) { response.status(401).json({error: 'Inicia sesión para modificar tu repositorio.'}); return; }
      const diskKey = typeof stored.diskKey === 'string' ? stored.diskKey : '';
      if (!/^[a-f0-9-]{36}$/i.test(diskKey)) { response.status(500).json({error: 'La ubicación del repositorio no es válida.'}); return; }
      const repository = await Repository.open(path.join(repositoryStorageRoot, 'aiverse-repositories', diskKey));
      await handler(repository, request, response);
    } catch (error) { next(error); }
  };
}

function remoteRoute(handler: WorkspaceHandler, write = false, repositoryStorageRoot = process.cwd()) {
  return async (request: express.Request, response: express.Response, next: express.NextFunction) => {
    try {
      if (!repositories) { response.status(503).json({error: 'El almacenamiento de repositorios no está disponible.'}); return; }
      const cliUser = await currentCliUser(request);
      const user = write ? cliUser : cliUser ?? await currentUser(request);
      if (write && !cliUser) { response.status(401).json({error: 'Necesitas un token de CLI válido para publicar.'}); return; }
      const stored = await repositories.findOne(
        {id: request.params.repositoryId},
        {projection: {id: 1, diskKey: 1, ownerId: 1, isPublic: 1}},
      );
      if (!stored) { response.status(404).json({error: 'Repositorio no encontrado.'}); return; }
      const ownsRepository = Boolean(user && String(stored.ownerId) === String(user.id));
      if ((write && !ownsRepository) || (!write && stored.isPublic !== true && !ownsRepository)) {
        response.status(404).json({error: 'Repositorio no encontrado.'}); return;
      }
      const diskKey = typeof stored.diskKey === 'string' ? stored.diskKey : '';
      if (!/^[a-f0-9-]{36}$/i.test(diskKey)) { response.status(500).json({error: 'La ubicación del repositorio no es válida.'}); return; }
      const repository = await Repository.open(path.join(repositoryStorageRoot, 'aiverse-repositories', diskKey));
      await handler(repository, request, response);
    } catch (error) { next(error); }
  };
}

export function createWorkspaceRepositoriesRouter(repositoryStorageRoot: string): express.Router {
  const router = express.Router();

  router.get('/', async (request, response, next) => {
    try {
      if (!repositories) { response.status(503).json({error: 'El almacenamiento de repositorios no está disponible.'}); return; }
      const user = await currentUser(request);
      if (!user) { response.status(401).json({error: 'Inicia sesión para ver tus repositorios.'}); return; }
      const items = await repositories.find({ownerId: String(user.id)})
        .project({id: 1, name: 1, description: 1, isPublic: 1, starsCount: 1, createdAt: 1})
        .sort({createdAt: -1}).toArray();
      response.json({repositories: items.map(item => ({
        id: String(item.id), name: String(item.name), description: String(item.description ?? ''),
        isPublic: item.isPublic !== false, stars_count: Number(item.starsCount ?? 0), created_at: item.createdAt,
      }))});
    } catch (error) { next(error); }
  });

  const repositoryRoute = (handler: WorkspaceHandler, write = false) => workspaceRoute(handler, write, repositoryStorageRoot);
  router.get('/:repositoryId/workspace/status', repositoryRoute(async (repository, _request, response) => { response.json(await repository.status()); }));
  router.get('/:repositoryId/workspace/log', repositoryRoute(async (repository, _request, response) => { response.json(await repository.log()); }));
  router.get('/:repositoryId/workspace/branches', repositoryRoute(async (repository, _request, response) => { response.json(await repository.branches()); }));
  router.get('/:repositoryId/workspace/tree', workspaceRoute(async (repository, request, response) => {
    response.json(await repository.tree(typeof request.query.ref === 'string' ? request.query.ref : undefined));
  }, false, repositoryStorageRoot));
  router.get('/:repositoryId/workspace/diff', repositoryRoute(async (repository, _request, response) => { response.json(await repository.workingTreeDiff()); }));
  router.get('/:repositoryId/workspace/structures', repositoryRoute(async (repository, _request, response) => { response.json(repository.getStructureSnapshot()); }));
  router.get('/:repositoryId/workspace/file', repositoryRoute(async (repository, request, response) => {
    const filePath = typeof request.query.path === 'string' ? request.query.path : '';
    const entry = (await repository.tree()).find(item => item.path === filePath);
    if (!entry) { response.status(404).json({error: 'Archivo no encontrado.'}); return; }
    const object = await repository.readObject(entry.hash);
    response.json({path: filePath, content: object.body.toString('utf8'), hash: entry.hash});
  }));

  router.post('/:repositoryId/workspace/add', repositoryRoute(async (repository, request, response) => {
    response.json({staged: await repository.add(request.body.paths ?? [])});
  }, true));
  router.post('/:repositoryId/workspace/commit', repositoryRoute(async (repository, request, response) => {
    response.json({hash: await repository.commit(request.body.message)});
  }, true));
  router.post('/:repositoryId/workspace/branch', repositoryRoute(async (repository, request, response) => {
    await repository.branch(request.body.name);
    response.json({branches: await repository.branches()});
  }, true));
  router.post('/:repositoryId/workspace/checkout', repositoryRoute(async (repository, request, response) => {
    await repository.checkout(request.body.name);
    response.json({branch: request.body.name});
  }, true));
  router.post('/:repositoryId/workspace/merge', repositoryRoute(async (repository, request, response) => {
    response.json(await repository.merge(request.body.name));
  }, true));
  router.post('/:repositoryId/workspace/stash', repositoryRoute(async (repository, request, response) => {
    response.json({stashes: await repository.stash(request.body.action ?? 'push')});
  }, true));
  router.post('/:repositoryId/workspace/reset', repositoryRoute(async (repository, request, response) => {
    response.json({hash: await repository.reset(request.body.target ?? 'HEAD', request.body.hard ?? false)});
  }, true));
  router.post('/:repositoryId/workspace/revert', repositoryRoute(async (repository, request, response) => {
    response.json({hash: await repository.revert(request.body.target)});
  }, true));

  const pushLimiter = rateLimit({windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false});
  const remoteReadLimiter = rateLimit({windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false});
  const remote = (handler: WorkspaceHandler, write = false) => remoteRoute(handler, write, repositoryStorageRoot);
  router.get('/:repositoryId/remote/hashes', remoteReadLimiter, remote(async (repository, _request, response) => {
    response.json({hashes: await repository.objectHashes()});
  }));
  router.post('/:repositoryId/remote/pack', remoteReadLimiter, remote(async (repository, request, response) => {
    const have = Array.isArray(request.body?.have) ? request.body.have.filter((hash: unknown): hash is string => typeof hash === 'string').slice(0, 250_000) : [];
    const bloom = typeof request.body?.bloom === 'string' && request.body.bloom.length <= 2_000_000 ? request.body.bloom : undefined;
    response.json(await repository.remoteSnapshot(have, bloom));
  }));
  router.post('/:repositoryId/remote/push', pushLimiter, remote(async (repository, request, response) => {
    const snapshot = request.body?.snapshot;
    await repository.importRemote(snapshot, {fastForwardOnly: true});
    if (snapshot?.head && snapshot.refs?.[snapshot.head]) await repository.checkout(snapshot.head, true);
    response.json({ok: true, refs: (await repository.remoteSnapshot()).refs});
  }, true));

  return router;
}
