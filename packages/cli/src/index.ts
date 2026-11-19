#!/usr/bin/env node
import {BloomFilter, Repository, type HashAlgorithm} from 'aiverse-core';
import {chmod, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const [command, ...args] = process.argv.slice(2);
const bloomFor = (hashes: string[]) => {
  const filter = new BloomFilter(Math.max(8192, hashes.length * 16));
  for (const hash of hashes) filter.add(hash);
  return filter.serialize();
};

type RepositoryConfig = {format: number; hash: string; remotes?: Record<string, string>};
type Credentials = {tokens?: Record<string, string>};
type Snapshot = {hashAlgorithm?: HashAlgorithm; objects: Array<{hash: string; data: string}>; refs: Record<string, string>; head: string};

function parseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('AIVerse remotes must use HTTPS (HTTP is allowed for local development).');
  if (url.username || url.password || url.search || url.hash) throw new Error('Remote URL must not include credentials, query parameters, or a fragment.');
  return url;
}

function scopedRemote(value: string): boolean {
  const url = parseUrl(value);
  return /^\/api\/repositories\/[a-f0-9-]{36}$/i.test(url.pathname.replace(/\/$/, ''));
}

function remoteEndpoint(value: string, route: string): string {
  const normalized = value.replace(/\/$/, '');
  return scopedRemote(normalized) ? `${normalized}/remote/${route}` : `${normalized}/api/remote/${route}`;
}

const configDirectory = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, 'aiverse')
  : process.platform === 'win32'
    ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'AIVerse')
    : path.join(os.homedir(), '.config', 'aiverse');
const credentialsPath = path.join(configDirectory, 'credentials.json');

async function readCredentials(): Promise<Credentials> {
  try {
    const credentials = JSON.parse(await readFile(credentialsPath, 'utf8')) as Credentials;
    return credentials && typeof credentials === 'object' ? credentials : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Could not read CLI credentials: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeCredentials(credentials: Credentials): Promise<void> {
  await mkdir(configDirectory, {recursive: true, mode: 0o700});
  await writeFile(credentialsPath, JSON.stringify(credentials, null, 2), {mode: 0o600});
  await chmod(credentialsPath, 0o600);
}

async function tokenFor(remote: string): Promise<string> {
  const credentials = await readCredentials();
  const scopedToken = credentials.tokens?.[parseUrl(remote).origin];
  return scopedToken ?? (process.env.AIVERSE_REMOTE_TOKEN ?? '');
}

async function request<T>(remote: string, route: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = await tokenFor(remote);
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(remoteEndpoint(remote, route), body === undefined
    ? {headers}
    : {method: 'POST', headers, body: JSON.stringify(body)});
  if (!response.ok) {
    const message = await response.json().then(value => (value as {error?: string}).error).catch(() => response.statusText);
    throw new Error(`AIVerse remote failed (${response.status}): ${message}`);
  }
  return response.json() as Promise<T>;
}

async function repositoryConfig(repo: Repository): Promise<RepositoryConfig> {
  return JSON.parse(await readFile(path.join(repo.gitDir, 'config'), 'utf8')) as RepositoryConfig;
}

async function saveRepositoryConfig(repo: Repository, config: RepositoryConfig): Promise<void> {
  const configPath = path.join(repo.gitDir, 'config');
  await writeFile(configPath, JSON.stringify(config, null, 2), {mode: 0o600});
  await chmod(configPath, 0o600);
}

async function originRemote(): Promise<{repo: Repository; url: string}> {
  const repo = await Repository.open();
  const config = await repositoryConfig(repo);
  const url = config.remotes?.origin;
  if (!url) throw new Error('No origin remote is configured. Run: aiverse remote add origin <repository-url>');
  return {repo, url};
}

async function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Run `aiverse auth login` in an interactive terminal so the token can be entered securely.');
  }
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      error ? reject(error) : resolve(value.trim());
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') { finish(new Error('Cancelled.')); return; }
        if (character === '\r' || character === '\n') { finish(); return; }
        if (character === '\u007f' || character === '\b') { value = value.slice(0, -1); continue; }
        if (character >= ' ') value += character;
      }
    };
    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

try {
  if (command === 'init') {
    await Repository.init(args[0] ?? process.cwd());
    console.log('Initialized empty AIVerse repository');
  } else if (command === 'remote') {
    const [action, name, value] = args;
    const repo = await Repository.open();
    const config = await repositoryConfig(repo);
    config.remotes ??= {};
    if (action === 'add') {
      if (!name || !value) throw new Error('Usage: aiverse remote add <name> <repository-url>');
      const url = parseUrl(value);
      if (!scopedRemote(url.toString())) throw new Error('Use the repository URL shown in AIVerse, ending in /api/repositories/<repository-id>.');
      config.remotes[name] = url.toString().replace(/\/$/, '');
      await saveRepositoryConfig(repo, config);
      console.log(`Added remote ${name}`);
    } else if (action === 'remove') {
      if (!name || !config.remotes[name]) throw new Error('Usage: aiverse remote remove <name>');
      delete config.remotes[name];
      await saveRepositoryConfig(repo, config);
      console.log(`Removed remote ${name}`);
    } else if (action === 'list' || !action) {
      for (const [remoteName, remoteUrl] of Object.entries(config.remotes)) console.log(`${remoteName}\t${remoteUrl}`);
    } else throw new Error('Usage: aiverse remote add|remove|list');
  } else if (command === 'auth') {
    const [action, serverUrl] = args;
    if (!serverUrl) throw new Error(`Usage: aiverse auth ${action === 'logout' ? 'logout' : 'login'} <server-url>`);
    const origin = parseUrl(serverUrl).origin;
    const credentials = await readCredentials();
    credentials.tokens ??= {};
    if (action === 'logout') {
      delete credentials.tokens[origin];
      await writeCredentials(credentials);
      console.log(`Removed CLI credentials for ${origin}`);
    } else if (action === 'login') {
      const token = await readSecret('Paste your one-time AIVerse CLI token (input hidden): ');
      if (!token.startsWith('aiv_cli_')) throw new Error('That does not look like an AIVerse CLI token.');
      const response = await fetch(`${origin}/api/auth/cli/me`, {headers: {Authorization: `Bearer ${token}`}});
      if (!response.ok) throw new Error(`Authentication failed (${response.status}). Generate a new token in your AIVerse account and try again.`);
      credentials.tokens[origin] = token;
      await writeCredentials(credentials);
      const result = await response.json() as {user: {username: string}};
      console.log(`Authenticated as @${result.user.username} on ${origin}`);
    } else throw new Error('Usage: aiverse auth login|logout <server-url>');
  } else if (command === 'clone') {
    const [remote, directory] = args;
    if (!remote || !directory) throw new Error('Usage: aiverse clone <repository-url> <directory>');
    const normalizedRemote = parseUrl(remote).toString().replace(/\/$/, '');
    if (!scopedRemote(normalizedRemote)) throw new Error('Clone URL must point to a repository in AIVerse.');
    const snapshot = await request<Snapshot>(normalizedRemote, 'pack', {have: [], bloom: bloomFor([])});
    const target = path.resolve(directory);
    await mkdir(target, {recursive: true});
    if ((await readdir(target)).length) throw new Error(`The target directory is not empty: ${target}`);
    const repo = await Repository.init(target);
    await repo.importRemote(snapshot);
    if (snapshot.head && snapshot.refs[snapshot.head]) await repo.checkout(snapshot.head, true);
    const config = await repositoryConfig(repo);
    config.remotes = {...config.remotes, origin: normalizedRemote};
    await saveRepositoryConfig(repo, config);
    console.log(`Cloned ${normalizedRemote} into ${target}`);
  } else if (command === 'serve') {
    const {spawn} = await import('node:child_process');
    const entry = new URL('../../server/dist/index.js', import.meta.url);
    const child = spawn(process.execPath, [entry.pathname], {stdio: 'inherit', env: {...process.env, MINIGIT_REPO: process.cwd()}});
    child.on('exit', code => process.exit(code ?? 0));
  } else if (command === 'push' || command === 'pull') {
    const first = args[0];
    const usesExplicitLegacyUrl = Boolean(first && /^https?:\/\//i.test(first));
    const {repo, url} = usesExplicitLegacyUrl ? {repo: await Repository.open(), url: first!} : await originRemote();
    const status = await repo.status();
    const branch = usesExplicitLegacyUrl ? args[1] ?? status.branch : first ?? status.branch;
    if (command === 'push') {
      if (!scopedRemote(url) && !usesExplicitLegacyUrl) throw new Error('Publishing with a configured remote requires a repository URL from AIVerse.');
      const remote = await request<{hashes: string[]}>(url, 'hashes');
      const snapshot = await repo.remoteSnapshot(remote.hashes, bloomFor(remote.hashes), [branch]);
      if (!snapshot.refs[branch]) throw new Error(`Local branch ${branch} has no commits to publish.`);
      snapshot.head = branch;
      await request(url, 'push', {snapshot});
      console.log(`Pushed ${branch} to ${url}`);
    } else {
      if (status.staged.length || status.modified.length || status.untracked.length) throw new Error('Commit, move, or stash local changes before pulling.');
      const known = await repo.objectHashes();
      const snapshot = await request<Snapshot>(url, 'pack', {have: known, bloom: bloomFor(known)});
      await repo.importRemote(snapshot, {fastForwardOnly: true});
      const target = args[0] && !usesExplicitLegacyUrl ? args[0] : snapshot.head;
      if (target && snapshot.refs[target]) await repo.checkout(target, true);
      console.log(`Pulled ${target || 'remote changes'} from ${url}`);
    }
  } else {
    const repo = await Repository.open();
    switch (command) {
      case 'add': console.log(`Staged ${await repo.add(args.length ? args : ['.'])} file(s)`); break;
      case 'commit': {
        const message = args[0] === '-m' ? args.slice(1).join(' ') : args.join(' ');
        if (!message) throw new Error('Usage: aiverse commit -m "message"');
        console.log(await repo.commit(message));
        break;
      }
      case 'status': console.log(JSON.stringify(await repo.status(), null, 2)); break;
      case 'log': for (const item of await repo.log()) console.log(`${item.hash.slice(0, 8)} ${item.commit.date} ${item.commit.message}`); break;
      case 'branch': if (args[0]) await repo.branch(args[0]); console.log((await repo.branches()).join('\n')); break;
      case 'checkout': if (!args[0]) throw new Error('Usage: aiverse checkout <branch>'); await repo.checkout(args[0]); break;
      case 'merge': if (!args[0]) throw new Error('Usage: aiverse merge <branch>'); { const result = await repo.merge(args[0]); console.log(result.conflicts.length ? `Conflicts: ${result.conflicts.join(', ')}` : `Merged ${args[0]} as ${result.hash}`); } break;
      case 'diff': console.log('Use the AIVerse workspace to inspect the current diff.'); break;
      case 'stash': { const action = (args[0] ?? 'push') as 'push' | 'apply' | 'pop' | 'list'; console.log(JSON.stringify(await repo.stash(action), null, 2)); break; }
      case 'reset': console.log(await repo.reset(args[0] ?? 'HEAD', args[1] === '--hard')); break;
      case 'revert': console.log(await repo.revert(args[0])); break;
      default: console.log('AIVerse: init, add, commit, status, log, branch, checkout, merge, remote, auth, clone, push [branch], pull [branch]');
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
