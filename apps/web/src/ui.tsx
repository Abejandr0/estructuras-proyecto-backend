import {useCallback, useEffect, useMemo, useState} from 'react';
import type {FormEvent} from 'react';
import {motion} from 'framer-motion';

type Commit = {hash: string; commit: {message: string; date: string; parents: string[]}};
type Entry = {path: string; hash: string};
type Status = {branch: string; staged: Entry[]; untracked: string[]; modified: string[]};
type Change = {path: string; status: 'modified' | 'deleted' | 'untracked'; oldText: string; newText: string; lines: string[]};
type AITask = {id: string; kind: string; state: 'pending' | 'processing' | 'ready' | 'error'; result?: string; error?: string; attempts: number};
type Health = {ok: boolean; root: string; provider: string};

const api = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:4179';
const wsUrl = api.replace(/^http/, 'ws') + '/api/events';

async function getJSON<T>(route: string): Promise<T> {
  const response = await fetch(api + route, {credentials: 'include'});
  if (!response.ok) throw new Error((await response.json() as {error?: string}).error ?? response.statusText);
  return response.json() as Promise<T>;
}

async function postJSON<T>(route: string, body: unknown): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('aiverse_csrf='))?.split('=').slice(1).join('=') ?? '';
  const response = await fetch(api + route, {method: 'POST', credentials: 'include', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf)}, body: JSON.stringify(body)});
  const result = await response.json() as T & {error?: string};
  if (!response.ok) throw new Error(result.error ?? response.statusText);
  return result;
}

export default function App() {
  const [page, setPage] = useState<'home'|'feed'|'workspace'|'login'|'register'|'account'|'settings'|'prs'>('home');
  const [feed, setFeed] = useState<Array<{id:string;name:string;description:string;stars_count:number;username:string}>>([]);
  const [user, setUser] = useState<{username:string;display_name:string;email:string}|null>(null);
  const [formError, setFormError] = useState('');
  const [log, setLog] = useState<Commit[]>([]);
  const [files, setFiles] = useState<Entry[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [status, setStatus] = useState<Status>({branch: 'main', staged: [], untracked: [], modified: []});
  const [health, setHealth] = useState<Health | null>(null);
  const [selected, setSelected] = useState('');
  const [content, setContent] = useState('');
  const [terminal, setTerminal] = useState('');
  const [output, setOutput] = useState<string[]>([]);
  const [aiTask, setAiTask] = useState<AITask | null>(null);
  const [dark, setDark] = useState(false);
  const [buckets, setBuckets] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [nextLog, nextFiles, nextStatus, nextBranches, nextChanges, structures, nextHealth] = await Promise.all([
        getJSON<Commit[]>('/api/repo/log'), getJSON<Entry[]>('/api/repo/tree'), getJSON<Status>('/api/repo/status'),
        getJSON<string[]>('/api/repo/branches'), getJSON<Change[]>('/api/repo/diff'),
        getJSON<{objectBuckets: number[]}>('/api/structures'), getJSON<Health>('/api/health'),
      ]);
      setLog(nextLog); setFiles(nextFiles); setStatus(nextStatus); setBranches(nextBranches);
      setChanges(nextChanges); setBuckets(structures.objectBuckets); setHealth(nextHealth); setError('');
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void refresh();
    void getJSON('/api/auth/csrf');
    void getJSON<{user: typeof user}>('/api/auth/me').then(result=>setUser(result.user));
    void getJSON<{repositories: typeof feed}>('/api/feed').then(result=>setFeed(result.repositories)).catch(()=>undefined);
    const socket = new WebSocket(wsUrl);
    socket.onmessage = event => {
      const message = JSON.parse(event.data as string) as {type?: string; task?: AITask};
      if (message.type === 'ai-task' && message.task) setAiTask(current => current?.id === message.task?.id ? message.task ?? current : current);
      if (message.type === 'filesystem') void refresh();
    };
    return () => socket.close();
  }, [refresh]);

  const selectedChange = useMemo(() => changes.find(change => change.path === selected), [changes, selected]);
  const allPaths = useMemo(() => [...new Set([...files.map(file => file.path), ...changes.map(change => change.path)])].sort(), [files, changes]);

  useEffect(() => {
    if (!selected || selectedChange) { setContent(''); return; }
    void getJSON<{content: string}>('/api/repo/file?path=' + encodeURIComponent(selected))
      .then(result => setContent(result.content)).catch(fetchError => setContent(String(fetchError)));
  }, [selected, selectedChange]);

  useEffect(() => {
    if (!aiTask || aiTask.state === 'ready' || aiTask.state === 'error') return;
    const timer = window.setTimeout(() => {
      void getJSON<AITask>('/api/ai/tasks/' + aiTask.id).then(setAiTask).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [aiTask]);

  const run = async () => {
    const [command, ...args] = terminal.trim().split(/\s+/);
    if (!command) return;
    try {
      let result: unknown;
      if (command === 'status') result = await getJSON('/api/repo/status');
      else if (command === 'log') result = await getJSON('/api/repo/log');
      else if (command === 'add') result = await postJSON('/api/repo/add', {paths: args.length ? args : ['.']});
      else if (command === 'commit') result = await postJSON('/api/repo/commit', {message: args[0] === '-m' ? args.slice(1).join(' ') : args.join(' ')});
      else if (command === 'branch') result = await postJSON('/api/repo/branch', {name: args[0]});
      else if (command === 'checkout') result = await postJSON('/api/repo/checkout', {name: args[0]});
      else if (command === 'merge') result = await postJSON('/api/repo/merge', {name: args[0]});
      else if (command === 'stash') result = await postJSON('/api/repo/stash', {action: args[0] ?? 'push'});
      else throw new Error('Comandos: status, log, add, commit, branch, checkout, merge, stash');
      setOutput(history => [JSON.stringify(result), ...history]);
      await refresh();
    } catch (runError) { setOutput(history => [runError instanceof Error ? runError.message : String(runError), ...history]); }
    setTerminal('');
  };

  const requestAI = async (kind: 'review' | 'commit-msg') => {
    try {
      const diff = changes.map(change => `diff -- ${change.path}\n${change.lines.join('\n')}`).join('\n');
      setAiTask(await postJSON<AITask>('/api/ai/' + kind, {text: diff, diff}));
    } catch (aiError) { setError(aiError instanceof Error ? aiError.message : String(aiError)); }
  };

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setFormError(''); const data = new FormData(event.currentTarget);
    try {
      const route = page === 'register' ? '/api/auth/register' : '/api/auth/login';
      const body = page === 'register' ? {username:data.get('username'),displayName:data.get('displayName'),email:data.get('email'),password:data.get('password')} : {email:data.get('email'),password:data.get('password')};
      const result = await postJSON<{user: typeof user}>(route,body); setUser(result.user); setPage('account');
    } catch (cause) { setFormError(cause instanceof Error ? cause.message : String(cause)); }
  };

  if (page === 'login' || page === 'register') return <main className="auth-page"><div className="auth-card"><button className="wordmark" onClick={()=>setPage('home')}>◈ AIVerse</button><h1>{page==='login'?'Inicia sesión':'Crea tu cuenta'}</h1><p>Versionamiento, colaboración y revisión de código con IA.</p><form onSubmit={event=>void submitAuth(event)}>{page==='register'&&<><label>Usuario<input name="username" required minLength={1} maxLength={39} autoComplete="username"/></label><label>Nombre visible<input name="displayName" required maxLength={80} autoComplete="name"/></label></>}<label>Correo<input name="email" type="email" required maxLength={254} autoComplete="email"/></label><label>Contraseña<input name="password" type="password" required minLength={12} maxLength={256} autoComplete={page==='register'?'new-password':'current-password'}/></label>{formError&&<p className="form-error">{formError}</p>}<button className="action">{page==='login'?'Entrar':'Crear cuenta'}</button></form><button className="text-button" onClick={()=>setPage(page==='login'?'register':'login')}>{page==='login'?'Crear cuenta nueva':'Ya tengo cuenta'}</button></div></main>;

  if (page === 'home' || page === 'feed' || page === 'account' || page === 'settings' || page === 'prs') return <main className={dark?'app dark':'app'}><header><button className="wordmark" onClick={()=>setPage('home')}>◈ AIVerse</button><nav>{(['home','feed','prs'] as const).map(item=><button className="nav-button" key={item} onClick={()=>setPage(item)}>{item==='home'?'Inicio':item==='feed'?'Explorar':'Pull requests'}</button>)}</nav><div className="header-right"><button className="nav-button" onClick={()=>setPage('settings')}>Configuración</button><button className="branch" onClick={()=>setPage(user?'account':'login')}>{user?.username??'Iniciar sesión'}</button><button className="action small" onClick={()=>setPage('workspace')}>Abrir espacio</button></div></header>{page==='settings'?<section className="product-page"><h1>Configuración de AIVerse</h1><p>Preferencias de interfaz</p><label>Idioma<select onChange={event=>localStorage.setItem('aiverse-language',event.target.value)} defaultValue={localStorage.getItem('aiverse-language')??'es'}>{[['es','Español'],['en','English'],['fr','Français'],['de','Deutsch'],['pt','Português'],['ja','日本語']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label className="theme-setting">Tema <button className="secondary action" onClick={()=>setDark(!dark)}>{dark?'Oscuro':'Claro'} · cambiar</button></label><p>El cambio de idioma se guarda localmente; se completará la traducción de todos los paneles en la siguiente pasada.</p></section>:page==='account'?<section className="product-page"><h1>{user?.display_name??'Tu cuenta'}</h1><p>@{user?.username} · {user?.email}</p><button className="action" onClick={()=>setPage('settings')}>Editar preferencias</button></section>:page==='prs'?<section className="product-page"><h1>Pull requests</h1><p>Las solicitudes de cambio y las revisiones de código aparecen aquí.</p><button className="action" onClick={()=>setPage('login')}>Inicia sesión para crear un PR</button></section>:<><section className="hero"><p className="eyebrow">DONDE EL CÓDIGO EVOLUCIONA</p><h1>Construye en equipo.<br/><span>Revisa con inteligencia.</span></h1><p>Versiona proyectos, comparte tu trabajo y revisa cambios con Gemini.</p><div><button className="action" onClick={()=>setPage(user?'workspace':'register')}>Empieza gratis</button><button className="secondary action" onClick={()=>setPage('feed')}>Explorar proyectos</button></div></section><section className="product-page"><h2>{page==='feed'?'Proyectos populares':'Explora repositorios'}</h2><div className="repo-grid">{feed.map(item=><article className="repo-card" key={item.id}><b>{item.username}/{item.name}</b><p>{item.description||'Repositorio público de AIVerse.'}</p><small>☆ {item.stars_count} · código versionado</small></article>)}</div>{feed.length===0&&<p>El feed se llenará cuando se publiquen repositorios en AIVerse.</p>}</section></>}<footer>AIVerse · Repositorios, revisiones y colaboración</footer></main>;

  return <main className={dark ? 'app dark' : 'app'}>
    <header>
      <div className="brand"><span className="logo">A</span><div><b>AIVerse</b><small>{health?.root ?? 'Conectando al repositorio…'}</small></div></div>
      <div className="header-right"><span className={error ? 'connection offline' : 'connection'}>● {error ? 'sin conexión' : 'servidor local'}</span><span className="branch">⌘ {status.branch}</span><button onClick={() => setDark(!dark)} aria-label="Cambiar tema">{dark ? '☀' : '◐'}</button></div>
    </header>
    {error && <div className="error-banner">No se pudo conectar con MiniGit: {error}. Ejecuta <code>npm run dev:server</code>.</div>}
    <section className="workspace">
      <aside className="sidebar">
        <div className="side-title">EXPLORADOR <span>{allPaths.length}</span></div>
        {allPaths.map(file => { const change = changes.find(item => item.path === file); return <button className={selected === file ? 'file active' : 'file'} key={file} onClick={() => setSelected(file)}><span className={`dot ${change?.status ?? 'clean'}`}/>{file}</button>; })}
        {!allPaths.length && <p className="muted">{loading ? 'Cargando…' : 'Añade archivos para comenzar'}</p>}
        <div className="side-title branch-heading">RAMAS <span>{branches.length}</span></div>
        {branches.map(branch => <div className={branch === status.branch ? 'file current' : 'file'} key={branch}>◉ {branch}</div>)}
      </aside>
      <section className="center">
        <div className="graph">
          <div className="panel-head"><span>Grafo de commits</span><small>{log.length} confirmaciones</small></div>
          <svg viewBox={`0 0 640 ${Math.max(150, log.length * 74)}`} preserveAspectRatio="xMinYMin meet">
            {log.length > 1 && <line x1="32" y1="36" x2="32" y2={36 + (log.length - 1) * 74} stroke="#6971ff" strokeWidth="3"/>}
            {log.map((item, index) => <motion.g key={item.hash} initial={{opacity: 0, x: -12}} animate={{opacity: 1, x: 0}} transition={{delay: index * .06}}><circle cx="32" cy={36 + index * 74} r="9" fill="#746bff"/><text x="56" y={32 + index * 74} className="commit-msg">{item.commit.message.slice(0, 56)}</text><text x="56" y={51 + index * 74} className="commit-meta">{item.hash.slice(0, 8)} · {new Date(item.commit.date).toLocaleString('es-CO')}</text></motion.g>)}
          </svg>
          {!log.length && <p className="empty">El historial aparecerá después del primer commit.</p>}
        </div>
        <div className="editor">
          <div className="panel-head"><span>{selected || 'Cambios del árbol de trabajo'}</span><small>{selectedChange ? selectedChange.status : 'contenido confirmado'}</small></div>
          {selectedChange ? <div className="diff-grid"><DiffColumn title="ANTES" text={selectedChange.oldText}/><DiffColumn title="DESPUÉS" text={selectedChange.newText}/></div> : <pre>{selected ? content : 'Selecciona un archivo para inspeccionarlo.'}</pre>}
        </div>
      </section>
      <aside className="right">
        <div className="panel-head">Asistente IA <span className="online">● {health?.provider ?? 'heuristic'}</span></div>
        <p className="muted">La revisión usa el diff real del árbol de trabajo.</p>
        <button className="action" onClick={() => void requestAI('review')} disabled={!changes.length}>Revisar {changes.length} cambio{changes.length === 1 ? '' : 's'}</button>
        <button className="action secondary" onClick={() => void requestAI('commit-msg')} disabled={!changes.length}>Sugerir mensaje</button>
        <div className={`task-state ${aiTask?.state ?? ''}`}>{aiTask ? `${aiTask.state} · intento ${aiTask.attempts}` : 'Sin tareas recientes'}</div>
        <pre className="ai-result">{aiTask?.result ?? aiTask?.error ?? 'La respuesta aparecerá aquí.'}</pre>
        <div className="inspector"><div className="panel-head">Data Structure Inspector</div><small>HashTable · buckets de objetos</small><div className="buckets">{buckets.slice(0, 32).map((count, index) => <div key={index} title={`Bucket ${index}: ${count}`} style={{height: Math.max(4, count * 12)}}/>)}</div><small>{buckets.length} buckets · {files.length} archivos confirmados</small></div>
        <div className="panel-head state-heading">Estado</div><div className="stats"><span>{status.staged.length}<small>staged</small></span><span>{status.modified.length}<small>modificados</small></span><span>{status.untracked.length}<small>nuevos</small></span></div>
      </aside>
    </section>
    <section className="terminal"><div className="terminal-head"><span>TERMINAL</span><small>Comandos sobre el servidor local</small></div><div className="terminal-body"><div className="terminal-history">{output.slice(0, 5).map((line, index) => <div key={index}>{line}</div>)}</div><div className="prompt"><b>minigit ❯</b><input value={terminal} onChange={event => setTerminal(event.target.value)} onKeyDown={event => event.key === 'Enter' && void run()} placeholder="status, add ., commit -m mensaje"/><button onClick={() => void run()}>↵</button></div></div></section>
    <footer><span>MiniGit</span><span>{changes.length} CAMBIOS · RAMA {status.branch.toUpperCase()}</span><span>● {error ? 'Desconectado' : 'Listo'}</span></footer>
  </main>;
}

function DiffColumn({title, text}: {title: string; text: string}) {
  return <section className="diff-column"><div>{title}</div><pre>{text || '∅'}</pre></section>;
}
