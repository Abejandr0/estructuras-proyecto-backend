import express from 'express';
import path from 'node:path';
import {Repository} from '@aiverse/core';
import {currentUser, requireCsrf} from './auth.js';
import {repositories} from './database.js';

type WorkspaceHandler = (repository: Repository, request: express.Request, response: express.Response) => Promise<void>;

function workspaceRoute(handler: WorkspaceHandler, write = false, repositoryStorageRoot = process.cwd()) {
  return async (request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (write && !requireCsrf(request, response)) return;
    try {
      if (!repositories) { response.status(503).json({error: 'El almacenamiento de repositorios no está disponible.'}); return; }
      const user = await currentUser(request);
      if (!user) { response.status(401).json({error: 'Inicia sesión para acceder a tu repositorio.'}); return; }
      const stored = await repositories.findOne(
        {id: request.params.repositoryId, ownerId: String(user.id)},
        {projection: {id: 1, diskKey: 1}},
      );
      if (!stored) { response.status(404).json({error: 'Repositorio no encontrado.'}); return; }
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

  return router;
}
