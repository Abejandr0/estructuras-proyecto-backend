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
  const csrfResponse = await fetch(api + '/api/auth/csrf', {credentials: 'include'});
  const {csrfToken} = await csrfResponse.json() as {csrfToken: string};
  const response = await fetch(api + route, {method: 'POST', credentials: 'include', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken}, body: JSON.stringify(body)});
  const result = await response.json() as T & {error?: string};
  if (!response.ok) throw new Error(result.error ?? response.statusText);
  return result;
}

export default function App() {
  const [page, setPage] = useState<'home'|'feed'|'workspace'|'login'|'register'|'account'|'settings'|'prs'|'pricing'>('home');
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

  if (page === 'login' || page === 'register') return <main className="auth-page">
    <div className="auth-aside"><button className="wordmark" onClick={()=>setPage('home')}>◈ AIVerse</button><div><p className="eyebrow">TU CÓDIGO, EN MOVIMIENTO</p><h2>Construye algo que valga la pena compartir.</h2><p>Un espacio para versionar, revisar y mejorar software junto a tu equipo.</p></div><span>Versionamiento claro · Revisiones cuidadas · IA cuando la necesitas</span></div>
    <section className="auth-card"><button className="auth-back" onClick={()=>setPage('home')}>← Volver al inicio</button><p className="eyebrow">{page==='login'?'QUÉ BUENO VERTE':'EMPIEZA GRATIS'}</p><h1>{page==='login'?'Bienvenido de vuelta':'Crea tu cuenta'}</h1><p className="auth-intro">{page==='login'?'Continúa donde dejaste tu trabajo.':'Tu próximo proyecto empieza con un buen historial.'}</p>
      <form onSubmit={event=>void submitAuth(event)}>{page==='register'&&<><label>Nombre de usuario<input name="username" placeholder="tu-usuario" required minLength={1} maxLength={39} autoComplete="username" pattern="[A-Za-z0-9][A-Za-z0-9-]{0,37}[A-Za-z0-9]?"/><small>Usa letras, números y guiones.</small></label><label>Nombre visible<input name="displayName" placeholder="¿Cómo te llamas?" required maxLength={80} autoComplete="name"/></label></>}<label>Correo electrónico<input name="email" type="email" placeholder="nombre@ejemplo.com" required maxLength={254} autoComplete="email"/></label><label>Contraseña<input name="password" type="password" placeholder={page==='register'?'Al menos 12 caracteres':'Tu contraseña'} required minLength={12} maxLength={256} autoComplete={page==='register'?'new-password':'current-password'}/>{page==='register'&&<small>12 caracteres como mínimo.</small>}</label>{formError&&<p className="form-error" role="alert">{formError}</p>}<button className="action auth-submit">{page==='login'?'Iniciar sesión':'Crear cuenta gratis'}<span>→</span></button></form>
      <p className="auth-switch">{page==='login'?'¿Primera vez en AIVerse?':'¿Ya tienes una cuenta?'} <button className="inline-button" onClick={()=>{setFormError('');setPage(page==='login'?'register':'login')}}>{page==='login'?'Crea tu cuenta':'Inicia sesión'}</button></p><p className="auth-legal">Al continuar aceptas nuestros términos de servicio y política de privacidad.</p>
    </section></main>;

  if (page === 'home' || page === 'feed' || page === 'account' || page === 'settings' || page === 'prs' || page === 'pricing') return <main className={dark?'app dark':'app'}><header><button className="wordmark" onClick={()=>setPage('home')}>◈ AIVerse</button><nav>{(['home','feed','prs'] as const).map(item=><button className="nav-button" key={item} onClick={()=>setPage(item)}>{item==='home'?'Inicio':item==='feed'?'Explorar':'Pull requests'}</button>)}<button className="nav-button" onClick={()=>setPage('pricing')}>Precios</button></nav><div className="header-right"><button className="nav-button" onClick={()=>setPage('settings')}>Configuración</button><button className="branch" onClick={()=>setPage(user?'account':'login')}>{user?.username??'Iniciar sesión'}</button><button className="action small" onClick={()=>setPage(user?'workspace':'register')}>{user?'Abrir espacio':'Crear cuenta'}</button></div></header>
    {page==='settings'?<section className="product-page"><p className="eyebrow">TU ESPACIO</p><h1>Configuración de AIVerse</h1><p>Personaliza la experiencia de tu cuenta.</p><label>Idioma<select onChange={event=>localStorage.setItem('aiverse-language',event.target.value)} defaultValue={localStorage.getItem('aiverse-language')??'es'}>{[['es','Español'],['en','English'],['fr','Français'],['de','Deutsch'],['pt','Português'],['ja','日本語']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label className="theme-setting">Tema <button className="secondary action" onClick={()=>setDark(!dark)}>{dark?'Oscuro':'Claro'} · cambiar</button></label><p>La preferencia de idioma se guarda en este dispositivo.</p></section>
    :page==='account'?<section className="product-page account-panel"><p className="eyebrow">PERFIL DE DESARROLLADOR</p><div className="account-heading"><span className="avatar">{user?.display_name?.[0]?.toUpperCase()??'A'}</span><div><h1>{user?.display_name??'Tu cuenta'}</h1><p>@{user?.username} · {user?.email}</p></div></div><div className="account-plan"><div><b>Plan Free</b><p>Hasta 3 repositorios · revisión con IA con tu propia clave</p></div><button className="action" onClick={()=>setPage('pricing')}>Ver planes</button></div><button className="secondary action" onClick={()=>setPage('settings')}>Editar preferencias</button></section>
    :page==='prs'?<section className="product-page"><p className="eyebrow">COLABORACIÓN</p><h1>Pull requests</h1><p>Reúne el contexto, revisa cada cambio y conversa antes de integrarlo.</p><div className="feature-row"><article><b>Revisión con contexto</b><p>Compara ramas y conversa sobre líneas específicas.</p></article><article><b>Decisiones claras</b><p>Aprueba, comenta o solicita cambios con tu equipo.</p></article><article><b>Ayuda de IA</b><p>Usa Gemini para señalar riesgos y oportunidades en el diff.</p></article></div><button className="action" onClick={()=>setPage(user?'workspace':'register')}>Empieza a colaborar</button></section>
    :page==='pricing'?<><section className="pricing-hero"><p className="eyebrow">PRECIOS SENCILLOS</p><h1>Empieza gratis.<br/><span>Crece a tu ritmo.</span></h1><p>Todos los planes incluyen versionamiento, repositorios y colaboración.</p><div className="billing-note">Precios de referencia en USD · beta sin cobros activos</div></section><section className="pricing-section"><div className="pricing-grid"><PlanCard name="Free" price="$0" cadence="para siempre" description="Para aprender, experimentar y publicar tus primeros proyectos." features={['Hasta 3 repositorios','Repositorios públicos','Pull requests y revisión de código','Feed y perfil de desarrollador','Revisión IA con tu clave de Gemini']} action="Crear cuenta gratis" onClick={()=>setPage(user?'account':'register')}/><PlanCard name="Plus" price="$8" cadence="por usuario / mes" description="Para desarrolladores que necesitan más espacio para sus proyectos." features={['Hasta 20 repositorios','Repositorios públicos y privados','Herramientas de colaboración en equipo','Pull requests y revisiones avanzadas','Asistencia prioritaria']} action="Próximamente" highlighted disabled onClick={()=>undefined}/><PlanCard name="Pro" price="$18" cadence="por usuario / mes" description="AIVerse completo para equipos que construyen sin límites." features={['Repositorios ilimitados','Todas las funciones de Plus','Colaboradores ilimitados','Controles avanzados de equipo','Todas las funciones actuales y futuras']} action="Próximamente" disabled onClick={()=>undefined}/></div><p className="pricing-footnote">Durante la beta solo puedes activar Free. El límite de repositorios ya se aplica en el backend: Free hasta 3, Plus hasta 20 y Pro ilimitado. Los planes de pago se habilitarán cuando integremos facturación; el uso de IA requiere configurar una clave de Gemini propia.</p></section></>
    :<><section className="hero"><div className="hero-copy"><p className="eyebrow">LA PLATAFORMA PARA CONSTRUIR EN EQUIPO</p><h1>Tu código avanza.<br/><span>Tu equipo también.</span></h1><p>Versiona proyectos, revisa cambios con contexto y convierte cada pull request en una oportunidad para mejorar.</p><div><button className="action hero-primary" onClick={()=>setPage(user?'workspace':'register')}>Crear cuenta gratis <span>→</span></button><button className="secondary action" onClick={()=>setPage('feed')}>Explorar proyectos</button></div><small className="hero-proof">Sin tarjeta de crédito · 3 repositorios gratis · Configura tu propia IA</small></div><div className="hero-visual"><div className="visual-window"><div className="window-bar"><i/><i/><i/><span>aiverse / api</span></div><div className="visual-branch">◉ feature/auth-refresh <span>2 commits</span></div><div className="visual-code"><span>@@ auth/session.ts</span><p><b>+ </b>export async function refreshSession() {'{'}</p><p>+ &nbsp; const user = await verifyToken(token);</p><p>+ &nbsp; return createSession(user.id);</p><p>{'}'}</p><div className="review-note">✦ <strong>Gemini sugiere</strong><br/>Valida la expiración antes de renovar.</div></div></div><div className="hero-float">✓ <span>Revisión lista</span></div></div></section>
      <section className="trust-strip"><span>Diseñado para flujos de trabajo reales</span><b>HISTORIAL CLARO</b><b>REVISIONES CON CONTEXTO</b><b>IA BAJO TU CONTROL</b></section><section className="home-section"><div className="section-heading"><p className="eyebrow">UN FLUJO, DE PRINCIPIO A FIN</p><h2>Menos fricción entre<br/>una idea y un buen release.</h2><p>Herramientas que trabajan juntas para que cada cambio sea fácil de entender y seguro de integrar.</p></div><div className="home-features"><article><span>01</span><h3>Versiona con confianza</h3><p>Commits, ramas y diffs claros. Entiende cómo evoluciona cada proyecto desde el primer cambio.</p></article><article><span>02</span><h3>Revisa mejor en equipo</h3><p>Abre pull requests, comenta cambios y decide qué integrar con contexto compartido.</p></article><article><span>03</span><h3>Usa IA con intención</h3><p>Gemini analiza los cambios cuando tú lo pides. Tu clave y el acceso externo quedan bajo tu control.</p></article></div></section><section className="home-community"><div><p className="eyebrow">COMUNIDAD AIVERSE</p><h2>Encuentra proyectos.<br/>Comparte lo que sabes.</h2><p>Explora repositorios públicos y descubre en qué están trabajando otros desarrolladores.</p><button className="secondary action" onClick={()=>setPage('feed')}>Ver proyectos populares →</button></div><div className="community-card"><div className="community-card-top"><span>✦ Explorando AIVerse</span><button onClick={()=>setPage('feed')}>Ver todo ↗</button></div>{feed.slice(0,3).map(item=><article key={item.id}><span className="repo-mark">◈</span><div><b>{item.username}/{item.name}</b><p>{item.description||'Un proyecto de la comunidad AIVerse.'}</p></div><small>☆ {item.stars_count}</small></article>)}{feed.length===0&&<p className="community-empty">Los primeros proyectos de la comunidad aparecerán aquí.</p>}</div></section><section className="home-cta"><p className="eyebrow">LISTO PARA TU PRÓXIMO COMMIT</p><h2>Construye con un equipo<br/>que entiende tu código.</h2><button className="action" onClick={()=>setPage(user?'workspace':'register')}>Crear cuenta gratis <span>→</span></button><button className="cta-link" onClick={()=>setPage('pricing')}>Compara los planes</button></section></>}
    {page==='feed'&&<section className="product-page"><p className="eyebrow">COMUNIDAD</p><h1>Proyectos populares</h1><p>Descubre repositorios que desarrolladores están construyendo en AIVerse.</p><div className="repo-grid">{feed.map(item=><article className="repo-card" key={item.id}><b>{item.username}/{item.name}</b><p>{item.description||'Repositorio público de AIVerse.'}</p><small>☆ {item.stars_count} · código versionado</small></article>)}</div>{feed.length===0&&<p>El feed se llenará cuando se publiquen repositorios en AIVerse.</p>}</section>}<footer><span>◈ AIVerse</span><span>Versionamiento · Revisión · Colaboración</span><button onClick={()=>setPage('pricing')}>Precios</button></footer></main>;

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

function PlanCard({name, price, cadence, description, features, action, highlighted = false, disabled = false, onClick}: {
  name: string; price: string; cadence: string; description: string; features: string[]; action: string; highlighted?: boolean; disabled?: boolean; onClick: () => void;
}) {
  return <article className={highlighted ? 'plan-card featured-plan' : 'plan-card'}>{highlighted&&<span className="plan-badge">MÁS ELEGIDO</span>}<p className="plan-name">{name}</p><div className="plan-price">{price}<small>/{cadence.includes('mes')?'mes':''}</small></div><p className="plan-cadence">{cadence}</p><p className="plan-description">{description}</p><button className={highlighted?'action':'secondary action'} onClick={onClick} disabled={disabled}>{action}{!disabled&&<span>→</span>}</button><div className="plan-divider"/><p className="included-label">INCLUYE</p><ul>{features.map(feature=><li key={feature}><span>✓</span>{feature}</li>)}</ul></article>;
}
