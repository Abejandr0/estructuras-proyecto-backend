import {useCallback, useEffect, useMemo, useState} from 'react';
import type {FormEvent} from 'react';
import {motion} from 'framer-motion';

type Commit = {hash: string; commit: {message: string; date: string; parents: string[]}};
type Entry = {path: string; hash: string};
type Status = {branch: string; staged: Entry[]; untracked: string[]; modified: string[]};
type Change = {path: string; status: 'modified' | 'deleted' | 'untracked'; oldText: string; newText: string; lines: string[]};
type AITask = {id: string; kind: string; state: 'pending' | 'processing' | 'ready' | 'error'; result?: string; error?: string; attempts: number};
type Health = {ok: boolean; root: string; provider: string};

const api = (import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://127.0.0.1:4179' : '')).replace(/\/$/, '');
const wsUrl = api.replace(/^http/, 'ws') + '/api/events';

type Page = 'home'|'feed'|'workspace'|'login'|'register'|'account'|'settings'|'prs'|'pricing'|'terms'|'privacy';
type Theme = 'system'|'light'|'dark';
const pageRoutes: Record<Page, string> = {home: '/', feed: '/explore', workspace: '/workspace', login: '/login', register: '/signup', account: '/account', settings: '/settings', prs: '/pull-requests', pricing: '/pricing', terms: '/terms', privacy: '/privacy'};
function pageFromHash(): Page {
  const route = window.location.hash.replace(/^#/, '') || '/';
  return (Object.entries(pageRoutes).find(([, value]) => value === route)?.[0] as Page | undefined) ?? 'home';
}

function missingApiError(): Error | null {
  return api ? null : new Error('Falta VITE_API_URL. Configúrala en Vercel con la URL HTTPS de tu backend en Render y vuelve a desplegar.');
}

async function getJSON<T>(route: string): Promise<T> {
  const configError = missingApiError();
  if (configError) throw configError;
  let response: Response;
  try { response = await fetch(api + route, {credentials: 'include'}); }
  catch { throw new Error('No se pudo conectar con el backend. Revisa VITE_API_URL, que Render esté activo y que WEB_ORIGIN permita este dominio de Vercel.'); }
  if (!response.ok) throw new Error((await response.json() as {error?: string}).error ?? response.statusText);
  return response.json() as Promise<T>;
}

async function postJSON<T>(route: string, body: unknown): Promise<T> {
  const configError = missingApiError();
  if (configError) throw configError;
  let csrfResponse: Response;
  try { csrfResponse = await fetch(api + '/api/auth/csrf', {credentials: 'include'}); }
  catch { throw new Error('No se pudo conectar con el backend. Revisa VITE_API_URL, que Render esté activo y que WEB_ORIGIN permita este dominio de Vercel.'); }
  if (!csrfResponse.ok) throw new Error('El backend no pudo preparar la sesión segura. Revisa su configuración en Render.');
  const {csrfToken} = await csrfResponse.json() as {csrfToken: string};
  let response: Response;
  try { response = await fetch(api + route, {method: 'POST', credentials: 'include', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken}, body: JSON.stringify(body)}); }
  catch { throw new Error('No se pudo conectar con el backend. Revisa VITE_API_URL, que Render esté activo y que WEB_ORIGIN permita este dominio de Vercel.'); }
  const result = await response.json() as T & {error?: string};
  if (!response.ok) throw new Error(result.error ?? response.statusText);
  return result;
}

export default function App() {
  const [page, setCurrentPage] = useState<Page>(pageFromHash);
  const [feed, setFeed] = useState<Array<{id:string;name:string;description:string;stars_count:number;username:string;created_at?:string}>>([]);
  const [user, setUser] = useState<{username:string;display_name:string;email:string}|null>(null);
  const [formError, setFormError] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [passwordValue, setPasswordValue] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
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
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem('aiverse-theme');
    return stored === 'dark' || stored === 'light' ? stored : 'system';
  });
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [feedSearch, setFeedSearch] = useState('');
  const [feedSort, setFeedSort] = useState<'popular'|'recent'>('popular');
  const [buckets, setBuckets] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  const setPage = (nextPage: Page) => {
    const destination = nextPage === 'settings' && !user ? 'login' : nextPage;
    window.history.pushState({page: destination}, '', `#${pageRoutes[destination]}`);
    setCurrentPage(destination);
    window.scrollTo({top: 0, behavior: 'auto'});
  };

  useEffect(() => {
    const updatePage = () => setCurrentPage(pageFromHash());
    window.addEventListener('popstate', updatePage);
    return () => window.removeEventListener('popstate', updatePage);
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const updateTheme = (nextTheme: Theme) => {
    setTheme(nextTheme);
    localStorage.setItem('aiverse-theme', nextTheme);
  };
  const cycleTheme = () => updateTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system');

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
    void getJSON('/api/auth/csrf').catch(()=>undefined);
    void getJSON<{user: typeof user}>('/api/auth/me').then(result=>setUser(result.user)).catch(()=>setUser(null)).finally(()=>setAuthChecked(true));
    void getJSON<{repositories: typeof feed}>('/api/feed').then(result=>setFeed(result.repositories)).catch(()=>undefined);
    if (!api) return;
    const socket = new WebSocket(wsUrl);
    socket.onmessage = event => {
      const message = JSON.parse(event.data as string) as {type?: string; task?: AITask};
      if (message.type === 'ai-task' && message.task) setAiTask(current => current?.id === message.task?.id ? message.task ?? current : current);
      if (message.type === 'filesystem') void refresh();
    };
    return () => socket.close();
  }, [refresh]);

  useEffect(() => {
    if (authChecked && (page === 'settings' || page === 'account') && !user) setPage('login');
  }, [authChecked, page, user]);

  const selectedChange = useMemo(() => changes.find(change => change.path === selected), [changes, selected]);
  const allPaths = useMemo(() => [...new Set([...files.map(file => file.path), ...changes.map(change => change.path)])].sort(), [files, changes]);
  const filteredFeed = useMemo(() => feed
    .filter(item => `${item.name} ${item.username} ${item.description}`.toLowerCase().includes(feedSearch.trim().toLowerCase()))
    .sort((a,b) => feedSort === 'popular' ? b.stars_count-a.stars_count : new Date(b.created_at ?? 0).getTime()-new Date(a.created_at ?? 0).getTime()), [feed, feedSearch, feedSort]);

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
    event.preventDefault();
    if (authSubmitting) return;
    setFormError('');
    const data = new FormData(event.currentTarget);
    const password = String(data.get('password') ?? '');
    const email = String(data.get('email') ?? '').trim();
    if (page === 'register') {
      const policyOk = password.length >= 12 && password.length <= 128 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9\s]/.test(password);
      if (!policyOk) { setFormError('Completa todos los requisitos de contraseña antes de continuar.'); return; }
      if (data.get('confirmPassword') !== password) { setFormError('Las contraseñas no coinciden.'); return; }
    }
    if (!email) { setFormError('Escribe tu correo electrónico.'); return; }
    setAuthSubmitting(true);
    try {
      const route = page === 'register' ? '/api/auth/register' : '/api/auth/login';
      const body = page === 'register' ? {username:data.get('username'),displayName:data.get('displayName'),email,password,confirmPassword:data.get('confirmPassword')} : {email,password};
      const result = await postJSON<{user: typeof user}>(route,body);
      setUser(result.user);
      setAuthChecked(true);
      setPage('account');
    } catch (cause) { setFormError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setAuthSubmitting(false); }
  };

  const passwordChecks = [
    {label:'12 caracteres como mínimo', valid:passwordValue.length >= 12},
    {label:'Una letra mayúscula', valid:/[A-Z]/.test(passwordValue)},
    {label:'Una letra minúscula', valid:/[a-z]/.test(passwordValue)},
    {label:'Un número', valid:/[0-9]/.test(passwordValue)},
    {label:'Un símbolo (por ejemplo !, # o ?)', valid:/[^A-Za-z0-9\s]/.test(passwordValue)},
    {label:'Evita palabras fáciles de adivinar', valid:passwordValue.length>0&&!/(password|contraseña)/i.test(passwordValue)},
  ];
  const passwordValid = passwordChecks.every(check => check.valid) && !/password|contraseña/i.test(passwordValue);

  if (page === 'feed') return <main className={dark?'app marketing-app dark':'app marketing-app'}>
    <SiteHeader page={page} user={user} navigate={setPage}/>
    <section className="explore-hero"><p className="eyebrow">COMUNIDAD AIVERSE</p><h1>Explora proyectos<br/><span>hechos por desarrolladores.</span></h1><p>Busca repositorios públicos, conoce quién los crea y encuentra ideas para tu próximo proyecto.</p><div className="explore-search"><span>⌕</span><input value={feedSearch} onChange={event=>setFeedSearch(event.target.value)} placeholder="Buscar proyectos, personas o tecnologías" aria-label="Buscar repositorios"/><button onClick={()=>setFeedSearch('')} disabled={!feedSearch}>Limpiar</button></div><div className="explore-metrics"><span><b>{feed.length}</b> repositorios públicos</span><span><b>{new Set(feed.map(item=>item.username)).size}</b> desarrolladores</span><span>Actualizado desde la comunidad</span></div></section>
    <section className="explore-content"><div className="explore-heading"><div><p className="eyebrow">DIRECTORIO</p><h2>Repositorios de la comunidad</h2><p>Explora el trabajo público disponible en AIVerse.</p></div><label className="sort-select">Ordenar por<select value={feedSort} onChange={event=>setFeedSort(event.target.value as 'popular'|'recent')}><option value="popular">Más populares</option><option value="recent">Más recientes</option></select></label></div>
      <div className="explore-tags"><span>Prueba una búsqueda:</span>{['api','web','ia','minigit','typescript'].map(term=><button key={term} onClick={()=>setFeedSearch(term)}>{term}</button>)}</div>
      {filteredFeed.length>0?<div className="repo-grid explore-repos">{filteredFeed.map(item=><article className="repo-card explore-repo" key={item.id}><div className="explore-repo-title"><span className="repo-mark">◈</span><div><small>{item.username}</small><b>{item.username}/{item.name}</b></div><span className="repo-public">Público</span></div><p>{item.description||'Repositorio compartido con la comunidad AIVerse.'}</p><div className="repo-meta"><span>☆ {item.stars_count} estrellas</span><span>{item.created_at?new Date(item.created_at).toLocaleDateString('es-CO'):'Proyecto AIVerse'}</span></div></article>)}</div>
      :<div className="explore-empty"><span>⌕</span><h3>{feed.length?'No hay resultados para esta búsqueda':'La comunidad está comenzando'}</h3><p>{feed.length?'Prueba con otro nombre o tecnología.':'Cuando los desarrolladores publiquen repositorios, aparecerán aquí para que puedas explorarlos.'}</p>{feedSearch?<button className="secondary action" onClick={()=>setFeedSearch('')}>Borrar búsqueda</button>:<button className="action" onClick={()=>setPage(user?'workspace':'register')}>Crear el primer proyecto</button>}</div>}
    </section><section className="explore-invite"><div><p className="eyebrow">¿TRABAJAS EN ALGO INTERESANTE?</p><h2>Comparte tu proyecto con la comunidad.</h2><p>Publica tu repositorio y ayuda a otros a descubrirlo, aprender y colaborar.</p></div><button className="action" onClick={()=>setPage(user?'workspace':'register')}>Empieza a construir <span>→</span></button></section>
    <SiteFooter navigate={setPage}/>
  </main>;

  if (page === 'login' || page === 'register') return <main className={dark?'auth-page dark':'auth-page'}>
    <div className="auth-aside"><button className="wordmark" onClick={()=>setPage('home')}>◈ AIVerse</button><div><p className="eyebrow">TU CÓDIGO, EN MOVIMIENTO</p><h2>Construye algo que valga la pena compartir.</h2><p>Un espacio para versionar, revisar y mejorar software junto a tu equipo.</p></div><span>Versionamiento claro · Revisiones cuidadas · IA cuando la necesitas</span></div>
    <section className="auth-card"><button className="auth-back" onClick={()=>setPage('home')}>← Volver al inicio</button><p className="eyebrow">{page==='login'?'QUÉ BUENO VERTE':'EMPIEZA GRATIS'}</p><h1>{page==='login'?'Bienvenido de vuelta':'Crea tu cuenta'}</h1><p className="auth-intro">{page==='login'?'Continúa donde dejaste tu trabajo.':'Tu próximo proyecto empieza con un buen historial.'}</p>
      <form onSubmit={event=>void submitAuth(event)} noValidate={false}>
        {page==='register'&&<><label>Nombre de usuario<input name="username" placeholder="tu-usuario" required minLength={1} maxLength={39} autoComplete="username" pattern="[A-Za-z0-9][A-Za-z0-9-]{0,37}[A-Za-z0-9]?"/><small>Usa letras, números y guiones.</small></label><label>Nombre visible<input name="displayName" placeholder="¿Cómo te llamas?" required maxLength={80} autoComplete="name"/></label></>}
        <label>Correo electrónico<input name="email" type="email" inputMode="email" placeholder="nombre@ejemplo.com" required maxLength={254} autoComplete="email"/></label>
        <label>Contraseña<div className="password-field"><input name="password" type={showPassword?'text':'password'} placeholder={page==='register'?'Crea una contraseña segura':'Tu contraseña'} required minLength={page==='register'?12:1} maxLength={page==='register'?128:256} autoComplete={page==='register'?'new-password':'current-password'} value={page==='register'?passwordValue:undefined} onChange={event=>{if(page==='register')setPasswordValue(event.target.value)}}/><button type="button" className="password-toggle" onClick={()=>setShowPassword(!showPassword)} aria-label={showPassword?'Ocultar contraseña':'Mostrar contraseña'}>{showPassword?'Ocultar':'Mostrar'}</button></div></label>
        {page==='register'&&<><ul className="password-checks" aria-label="Requisitos de contraseña">{passwordChecks.map(check=><li key={check.label} className={check.valid?'passed':''}><span aria-hidden="true">{check.valid?'✓':'○'}</span>{check.label}</li>)}</ul><label>Confirma tu contraseña<input name="confirmPassword" type={showPassword?'text':'password'} placeholder="Escríbela otra vez" required minLength={12} maxLength={128} autoComplete="new-password"/></label><p className="password-match" aria-live="polite">{passwordValue&&passwordValid?'Contraseña segura. Confírmala para continuar.':'Usaremos esta contraseña para proteger tu cuenta.'}</p></>}
        {formError&&<p className="form-error" role="alert">{formError}</p>}
        <button className="action auth-submit" disabled={authSubmitting || (page==='register'&&!passwordValid)}>{authSubmitting?'Conectando…':page==='login'?'Iniciar sesión':'Crear cuenta gratis'}{!authSubmitting&&<span>→</span>}</button>
      </form>
      <p className="auth-switch">{page==='login'?'¿Primera vez en AIVerse?':'¿Ya tienes una cuenta?'} <button className="inline-button" onClick={()=>{setFormError('');setPasswordValue('');setPage(page==='login'?'register':'login')}}>{page==='login'?'Crea tu cuenta':'Inicia sesión'}</button></p><p className="auth-legal">Al continuar, aceptas nuestros <button onClick={()=>setPage('terms')}>términos de servicio</button> y <button onClick={()=>setPage('privacy')}>política de privacidad</button>.</p>
    </section></main>;

  if (page === 'home' || page === 'account' || page === 'settings' || page === 'prs' || page === 'pricing' || page === 'terms' || page === 'privacy') return <main className={dark?'app marketing-app dark':'app marketing-app'}><SiteHeader page={page} user={user} navigate={setPage}/>
    {page==='settings'?<section className="product-page settings-page"><p className="eyebrow">TU ESPACIO</p><h1>Configuración</h1><p>Personaliza AIVerse para que se adapte a ti.</p><div className="settings-card"><label>Idioma de la interfaz<select onChange={event=>localStorage.setItem('aiverse-language',event.target.value)} defaultValue={localStorage.getItem('aiverse-language')??'es'}>{[['es','Español'],['en','English'],['fr','Français'],['de','Deutsch'],['pt','Português'],['ja','日本語']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>Tema<select value={theme} onChange={event=>updateTheme(event.target.value as Theme)}><option value="system">Automático · seguir el sistema</option><option value="light">Claro</option><option value="dark">Oscuro</option></select></label><p className="system-theme-note">Tu sistema está en modo <b>{systemDark?'oscuro':'claro'}</b>. {theme==='system'?'AIVerse seguirá ese ajuste automáticamente.':'El tema elegido se mantiene aunque cambie el sistema.'}</p></div><button className="secondary action" onClick={()=>setPage('account')}>Volver a mi cuenta</button></section>
    :page==='account'?<section className="product-page account-panel"><p className="eyebrow">PERFIL DE DESARROLLADOR</p><div className="account-heading"><span className="avatar">{user?.display_name?.[0]?.toUpperCase()??'A'}</span><div><h1>{user?.display_name??'Tu cuenta'}</h1><p>@{user?.username} · {user?.email}</p></div></div><div className="account-plan"><div><b>Plan Free</b><p>Hasta 3 repositorios · revisión con IA con tu propia clave</p></div><button className="action" onClick={()=>setPage('pricing')}>Ver planes</button></div><button className="secondary action" onClick={()=>setPage('settings')}>Editar preferencias</button></section>
    :page==='prs'?<section className="product-page"><p className="eyebrow">COLABORACIÓN</p><h1>Pull requests</h1><p>Reúne el contexto, revisa cada cambio y conversa antes de integrarlo.</p><div className="feature-row"><article><b>Revisión con contexto</b><p>Compara ramas y conversa sobre líneas específicas.</p></article><article><b>Decisiones claras</b><p>Aprueba, comenta o solicita cambios con tu equipo.</p></article><article><b>Ayuda de IA</b><p>Usa Gemini para señalar riesgos y oportunidades en el diff.</p></article></div><button className="action" onClick={()=>setPage(user?'workspace':'register')}>Empieza a colaborar</button></section>
    :page==='terms'||page==='privacy'?<LegalPage kind={page}/>
    :page==='pricing'?<><section className="pricing-hero"><p className="eyebrow">PRECIOS SENCILLOS</p><h1>Empieza gratis.<br/><span>Crece a tu ritmo.</span></h1><p>Todos los planes incluyen versionamiento, repositorios y colaboración.</p><div className="billing-note">Precios de referencia en USD · beta sin cobros activos</div></section><section className="pricing-section"><div className="pricing-grid"><PlanCard name="Free" price="$0" cadence="para siempre" description="Para aprender, experimentar y publicar tus primeros proyectos." features={['Hasta 3 repositorios','Repositorios públicos','Pull requests y revisión de código','Feed y perfil de desarrollador','Revisión IA con tu clave de Gemini']} action="Crear cuenta gratis" onClick={()=>setPage(user?'account':'register')}/><PlanCard name="Plus" price="$8" cadence="por usuario / mes" description="Para desarrolladores que necesitan más espacio para sus proyectos." features={['Hasta 20 repositorios','Repositorios públicos y privados','Herramientas de colaboración en equipo','Pull requests y revisiones avanzadas','Asistencia prioritaria']} action="Próximamente" highlighted disabled onClick={()=>undefined}/><PlanCard name="Pro" price="$18" cadence="por usuario / mes" description="AIVerse completo para equipos que construyen sin límites." features={['Repositorios ilimitados','Todas las funciones de Plus','Colaboradores ilimitados','Controles avanzados de equipo','Todas las funciones actuales y futuras']} action="Próximamente" disabled onClick={()=>undefined}/></div><p className="pricing-footnote">Durante la beta solo puedes activar Free. El límite de repositorios ya se aplica en el backend: Free hasta 3, Plus hasta 20 y Pro ilimitado. Los planes de pago se habilitarán cuando integremos facturación; el uso de IA requiere configurar una clave de Gemini propia.</p></section></>
    :<><section className="hero"><div className="hero-copy"><p className="eyebrow">LA PLATAFORMA PARA CONSTRUIR EN EQUIPO</p><h1>Tu código avanza.<br/><span>Tu equipo también.</span></h1><p>Versiona proyectos, entiende cada cambio y mejora tu código con herramientas que acompañan tu flujo de trabajo.</p><div><button className="action hero-primary" onClick={()=>setPage(user?'workspace':'register')}>Crear cuenta gratis <span>→</span></button><button className="secondary action" onClick={()=>setPage('feed')}>Explorar proyectos</button></div><small className="hero-proof">Sin tarjeta de crédito · 3 repositorios gratis · Configura tu propia IA</small></div><div className="hero-visual"><div className="visual-window"><div className="window-bar"><i/><i/><i/><span>aiverse / api</span></div><div className="visual-branch">◉ feature/auth-refresh <span>2 commits</span></div><div className="visual-code"><span>@@ auth/session.ts</span><p><b>+ </b>export async function refreshSession() {'{'}</p><p>+ &nbsp; const user = await verifyToken(token);</p><p>+ &nbsp; return createSession(user.id);</p><p>{'}'}</p><div className="review-note">✦ <strong>Revisión sugerida</strong><br/>Valida la expiración antes de renovar.</div></div></div><div className="hero-float">✓ <span>Historial actualizado</span></div></div></section>
      <section className="trust-strip"><span>Diseñado para flujos de trabajo reales</span><b>HISTORIAL CLARO</b><b>CAMBIOS COMPRENSIBLES</b><b>IA BAJO TU CONTROL</b></section><section className="home-section"><div className="section-heading"><p className="eyebrow">UN FLUJO, DE PRINCIPIO A FIN</p><h2>Menos fricción entre<br/>una idea y un buen release.</h2><p>Herramientas que trabajan juntas para que cada cambio sea fácil de entender y seguro de integrar.</p></div><div className="home-features"><article><span>01</span><h3>Versiona con confianza</h3><p>Commits, ramas y diffs claros. Entiende cómo evoluciona cada proyecto desde el primer cambio.</p></article><article><span>02</span><h3>Entiende cada cambio</h3><p>Compara versiones, sigue el historial y encuentra con rapidez qué cambió y por qué.</p></article><article><span>03</span><h3>Usa IA con intención</h3><p>Gemini analiza los cambios cuando tú lo pides. Tu clave y el acceso externo quedan bajo tu control.</p></article></div></section><section className="home-community"><div><p className="eyebrow">COMUNIDAD AIVERSE</p><h2>Encuentra proyectos.<br/>Comparte lo que sabes.</h2><p>Explora repositorios públicos y descubre en qué están trabajando otros desarrolladores.</p><button className="secondary action" onClick={()=>setPage('feed')}>Ver proyectos populares →</button></div><div className="community-card"><div className="community-card-top"><span>✦ Explorando AIVerse</span><button onClick={()=>setPage('feed')}>Ver todo ↗</button></div>{feed.slice(0,3).map(item=><article key={item.id}><span className="repo-mark">◈</span><div><b>{item.username}/{item.name}</b><p>{item.description||'Un proyecto de la comunidad AIVerse.'}</p></div><small>☆ {item.stars_count}</small></article>)}{feed.length===0&&<p className="community-empty">Los primeros proyectos de la comunidad aparecerán aquí.</p>}</div></section><section className="home-cta"><p className="eyebrow">LISTO PARA TU PRÓXIMO COMMIT</p><h2>Construye con un equipo<br/>que entiende tu código.</h2><button className="action" onClick={()=>setPage(user?'workspace':'register')}>Crear cuenta gratis <span>→</span></button><button className="cta-link" onClick={()=>setPage('pricing')}>Compara los planes</button></section></>}
    <SiteFooter navigate={setPage}/></main>;

  return <main className={dark ? 'app dark' : 'app'}>
    <header>
      <div className="brand"><span className="logo">A</span><div><b>AIVerse</b><small>{health?.root ?? 'Conectando al repositorio…'}</small></div></div>
      <div className="header-right"><span className={error ? 'connection offline' : 'connection'}>● {error ? 'Sin conexión' : 'Backend conectado'}</span><span className="branch">⌘ {status.branch}</span>{user&&<button className="workspace-nav" onClick={()=>setPage('settings')}>Configuración</button>}<button className="theme-cycle" onClick={cycleTheme} aria-label={`Tema ${theme==='system'?'automático':theme}; cambiar tema`}>{theme==='system'?'◐':dark?'☀':'☾'}<small>{theme==='system'?'Sistema':dark?'Oscuro':'Claro'}</small></button>{user&&<button className="workspace-account" onClick={()=>setPage('account')}>@{user.username}</button>}</div>
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
    <footer className="workspace-footer"><span>◈ AIVerse · {changes.length} cambios · rama {status.branch}</span><div><button onClick={()=>setPage('home')}>Inicio</button><button onClick={()=>setPage('feed')}>Explorar</button><button onClick={()=>setPage('terms')}>Términos</button><button onClick={()=>setPage('privacy')}>Privacidad</button></div><span>● {error ? 'Sin conexión' : 'Listo'}</span></footer>
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

function SiteHeader({page, user, navigate}: {page: Page; user: {username:string}|null; navigate: (page: Page)=>void}) {
  return <header className="site-header"><button className="wordmark" onClick={()=>navigate('home')}>◈ AIVerse</button><nav aria-label="Navegación principal"><button className={page==='home'?'active':''} onClick={()=>navigate('home')}>Inicio</button><button className={page==='feed'?'active':''} onClick={()=>navigate('feed')}>Explorar</button><button className={page==='pricing'?'active':''} onClick={()=>navigate('pricing')}>Precios</button></nav><div className="site-header-actions">{user?<button className="account-link" onClick={()=>navigate('account')}>@{user.username}</button>:<button className="site-login" onClick={()=>navigate('login')}>Iniciar sesión</button>}<button className="action site-cta" onClick={()=>navigate(user?'workspace':'register')}>{user?'Abrir espacio':'Crear cuenta'} <span>→</span></button></div></header>;
}

function SiteFooter({navigate}: {navigate: (page: Page)=>void}) {
  return <footer className="site-footer"><div className="footer-main"><div className="footer-brand"><button className="wordmark" onClick={()=>navigate('home')}>◈ AIVerse</button><p>Una mejor forma de construir, revisar y compartir software.</p></div><div className="footer-links"><div><b>Explora</b><button onClick={()=>navigate('feed')}>Proyectos</button><button onClick={()=>navigate('pricing')}>Planes</button></div><div><b>Cuenta</b><button onClick={()=>navigate('login')}>Iniciar sesión</button><button onClick={()=>navigate('register')}>Crear cuenta</button></div><div><b>Información</b><button onClick={()=>navigate('terms')}>Términos de servicio</button><button onClick={()=>navigate('privacy')}>Política de privacidad</button></div></div></div><div className="footer-bottom"><span>© 2026 AIVerse · Beta</span><span>Versionamiento · Revisión · Colaboración</span></div></footer>;
}

function LegalPage({kind}: {kind: 'terms'|'privacy'}) {
  const privacy = kind === 'privacy';
  return <article className="legal-page"><p className="eyebrow">AIVERSE · INFORMACIÓN LEGAL</p><h1>{privacy?'Política de privacidad':'Términos de servicio'}</h1><p className="legal-updated">Última actualización: 7 de noviembre de 2026 · Servicio en beta</p>{privacy?<>
    <p>Esta política explica qué datos procesa AIVerse y cómo se usan. AIVerse está en beta; antes de abrir el servicio al público, el operador debe publicar su nombre legal, país y un correo de contacto para solicitudes de privacidad.</p>
    <h2>Datos que procesamos</h2><ul><li>Datos de cuenta: nombre de usuario, nombre visible, correo electrónico y contraseña almacenada como hash seguro.</li><li>Datos de uso: sesiones, preferencias guardadas en el navegador, metadatos de repositorios, actividad y pull requests.</li><li>Código: el contenido versionado se guarda en almacenamiento persistente del backend; los metadatos se guardan en MongoDB.</li><li>Datos técnicos básicos, como dirección IP, registros de error y uso de seguridad, pueden procesarse en la infraestructura de Render, Vercel y MongoDB Atlas.</li></ul>
    <h2>Revisiones con IA</h2><p>Si solicitas una revisión con IA, el diff o texto que envíes se transmite desde el backend a Google Gemini usando la clave configurada por el operador de AIVerse. No envíes contraseñas, tokens, claves privadas ni datos personales en el código. El tratamiento por Google está sujeto a sus propias condiciones y políticas.</p>
    <h2>Cookies y preferencias</h2><p>Usamos cookies necesarias para mantener la sesión y proteger las acciones contra solicitudes no autorizadas. El tema y el idioma seleccionados se guardan localmente en tu navegador.</p>
    <h2>Visibilidad y conservación</h2><p>Los repositorios públicos pueden mostrarse en Explorar. Mantén privado cualquier contenido que no quieras compartir. Conservamos los datos mientras la cuenta o el repositorio sigan activos; el borrado de cuenta aún no está disponible desde la interfaz durante esta beta.</p>
    <h2>Tus solicitudes</h2><p>Para consultar, corregir o solicitar la eliminación de información, contacta al operador del servicio mediante el canal de soporte que se publicará antes del lanzamiento. No compartas datos privados en issues públicos.</p>
    <h2>Servicios de terceros</h2><p>La aplicación puede depender de Render para el backend y almacenamiento persistente, Vercel para servir la interfaz, MongoDB Atlas para la base de datos y Google Gemini para la IA cuando está habilitada. Cada proveedor puede procesar datos técnicos necesarios para prestar su servicio.</p>
  </>:<>
    <p>Estos términos cubren el uso de AIVerse, una plataforma de versionamiento y colaboración que actualmente se ofrece en beta. Al crear una cuenta o usar el servicio, aceptas seguir estas reglas.</p>
    <h2>Tu cuenta</h2><p>Proporciona un correo válido, protege tus credenciales y avísanos si sospechas que alguien accedió a tu cuenta. Eres responsable de la actividad realizada desde tu sesión.</p>
    <h2>Tu código y tus repositorios</h2><p>Conservas los derechos sobre el código que subes. Nos autorizas a almacenarlo, procesarlo y mostrarlo para operar AIVerse según la visibilidad que elijas. Los repositorios públicos pueden aparecer en Explorar; no subas información que no tengas derecho a compartir.</p>
    <h2>Uso aceptable</h2><p>No uses AIVerse para distribuir malware, vulnerar sistemas, abusar de otros usuarios, infringir derechos de terceros o interrumpir el servicio. Podemos limitar o suspender cuentas que representen un riesgo para la plataforma o la comunidad.</p>
    <h2>Planes y facturación</h2><p>Free, Plus y Pro aparecen en la página de precios. Durante la beta solo está habilitado Free; los planes pagados y sus precios de referencia no generan cobros ni activan funciones hasta que se publique la facturación.</p>
    <h2>Beta y disponibilidad</h2><p>La plataforma cambia con frecuencia y algunas funciones pueden fallar, cambiar o dejar de estar disponibles. No prometemos disponibilidad continua ni que el servicio esté libre de errores. Mantén copias independientes de tu trabajo importante.</p>
    <h2>Terminación</h2><p>Puedes dejar de usar el servicio en cualquier momento. Durante la beta, solicita al operador el cierre de cuenta y eliminación de datos usando el canal de soporte que se publicará antes del lanzamiento.</p>
    <h2>Cambios y contacto</h2><p>Podemos actualizar estos términos a medida que el producto evolucione. La fecha de actualización aparecerá al comienzo de esta página. El operador debe publicar datos de contacto antes de abrir AIVerse al público.</p>
  </>}<div className="legal-beta-note"><b>Nota de beta:</b> estos textos describen las funciones actuales y requieren revisión legal y los datos de contacto del operador antes de un lanzamiento público.</div></article>;
}
