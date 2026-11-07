import {afterEach, expect, it} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {AIProvider, AITaskKind} from '../packages/server/src/ai.js';
import {AITaskQueue, HeuristicAIProvider} from '../packages/server/src/ai.js';
import {resolveRepository} from '../packages/server/src/repository-root.js';

let directory = '';
afterEach(async () => { if (directory) await rm(directory, {recursive: true, force: true}); });

it('auto-initializes the repository selected through INIT_CWD', async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'minigit-server-'));
  const result = await resolveRepository({cwd: path.join(directory, 'packages', 'server'), initCwd: directory, autoInit: true});
  expect(result.initialized).toBe(true);
  expect(result.repo.root).toBe(directory);
});

it('runs heuristic AI tasks through the project queue', async () => {
  const queue = new AITaskQueue(new HeuristicAIProvider(), 1, 0);
  const task = queue.enqueue('review', '+ console.log("debug")');
  await waitUntilFinished(queue, task.id);
  expect(queue.get(task.id)?.state).toBe('ready');
  expect(queue.get(task.id)?.result).toContain('console.log');
});

it('retries failed AI tasks before completing', async () => {
  let calls = 0;
  const provider: AIProvider = {async run(_kind: AITaskKind) { calls++; if (calls === 1) throw new Error('temporary'); return 'ok'; }};
  const queue = new AITaskQueue(provider, 1, 1);
  const task = queue.enqueue('review', 'diff');
  await waitUntilFinished(queue, task.id);
  expect(queue.get(task.id)?.result).toBe('ok');
  expect(queue.get(task.id)?.attempts).toBe(2);
});

async function waitUntilFinished(queue: AITaskQueue, id: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const state = queue.get(id)?.state;
    if (state === 'ready' || state === 'error') return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('AI task did not finish');
}
