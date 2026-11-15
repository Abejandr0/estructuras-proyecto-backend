import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {FormEvent} from 'react';
import {useI18n} from './i18n';
import type {Language, MessageKey, TranslationValues} from './i18n';

type Commit = {hash: string; commit: {message: string; date: string; parents: string[]}};
type Entry = {path: string; hash: string};
type Status = {branch: string; staged: Entry[]; untracked: string[]; modified: string[]};
type Change = {path: string; status: 'modified' | 'deleted' | 'untracked'; oldText: string; newText: string; lines: string[]};
type AITask = {id: string; kind: string; state: 'pending' | 'processing' | 'ready' | 'error'; result?: string; error?: string; attempts: number};
type Health = {ok: boolean; root?: string; provider: string; sharedRepositoryApiEnabled: boolean};

const api = (import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://127.0.0.1:4179' : '')).replace(/\/$/, '');
const eventsUrl = new URL('/api/events', api || window.location.origin);
eventsUrl.protocol = eventsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = eventsUrl.toString();

type Page = 'home'|'feed'|'docs'|'workspace'|'login'|'register'|'account'|'settings'|'prs'|'pricing'|'terms'|'privacy'|'legal'|'cookies'|'notFound';
type Theme = 'system'|'light'|'dark';
type RoutePage = Exclude<Page, 'notFound'>;
const pageRoutes: Record<RoutePage, string> = {home: '/', feed: '/explore', docs: '/docs', workspace: '/workspace', login: '/login', register: '/signup', account: '/account', settings: '/settings', prs: '/pull-requests', pricing: '/pricing', terms: '/terms', privacy: '/privacy', legal: '/aviso-legal', cookies: '/cookies'};
function readThemePreference(): Theme {
  try {
    const stored = localStorage.getItem('theme') ?? localStorage.getItem('aiverse-theme');
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {}
  return 'system';
}

function systemPrefersDark(): boolean {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; }
  catch { return false; }
}

function pageFromLocation(): Page {
  const legacyRoute = window.location.pathname === '/' && window.location.hash.startsWith('#/')
    ? window.location.hash.slice(1).split('?')[0]
    : '';
  if (legacyRoute) window.history.replaceState(window.history.state, '', legacyRoute + window.location.search);
  const route = legacyRoute || window.location.pathname.replace(/\/$/, '') || '/';
  return (Object.entries(pageRoutes).find(([, value]) => value === route)?.[0] as RoutePage | undefined) ?? 'notFound';
}

type Translator = (key: MessageKey, values?: TranslationValues) => string;

function missingApiError(t: Translator): Error | null {
  // Production may intentionally use a same-origin /api proxy, so an empty
  // VITE_API_URL is valid there. Local development still needs an API target.
  return api || import.meta.env.PROD ? null : new Error(t('error.apiConfig'));
}

async function getJSON<T>(route: string, t: Translator): Promise<T> {
  const configError = missingApiError(t);
  if (configError) throw configError;
  let response: Response;
  try { response = await fetch(api + route, {credentials: 'include'}); }
  catch { throw new Error(t('error.backendConnection')); }
  if (!response.ok) throw new Error((await response.json() as {error?: string}).error ?? response.statusText);
  return response.json() as Promise<T>;
}

async function postJSON<T>(route: string, body: unknown, t: Translator): Promise<T> {
  const configError = missingApiError(t);
  if (configError) throw configError;
  let csrfResponse: Response;
  try { csrfResponse = await fetch(api + '/api/auth/csrf', {credentials: 'include'}); }
  catch { throw new Error(t('error.backendConnection')); }
  if (!csrfResponse.ok) throw new Error(t('error.csrf'));
  const {csrfToken} = await csrfResponse.json() as {csrfToken: string};
  let response: Response;
  try { response = await fetch(api + route, {method: 'POST', credentials: 'include', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken}, body: JSON.stringify(body)}); }
  catch { throw new Error(t('error.backendConnection')); }
  const result = await response.json() as T & {error?: string};
  if (!response.ok) throw new Error(result.error ?? response.statusText);
  return result;
}

export default function App() {
  const {lang, setLanguage, t, formatDate, formatNumber, formatPrice} = useI18n();
  const [page, setCurrentPage] = useState<Page>(pageFromLocation);
  const [feed, setFeed] = useState<Array<{id:string;name:string;description:string;stars_count:number;username:string;created_at?:string}>>([]);
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedError, setFeedError] = useState('');
  const [postsLoading, setPostsLoading] = useState(true);
  const [postsError, setPostsError] = useState('');
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
  const [aiQuestion, setAiQuestion] = useState('');
  const [showMobileAI, setShowMobileAI] = useState(false);
  const [theme, setTheme] = useState<Theme>(readThemePreference);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const [feedSearch, setFeedSearch] = useState('');
  const [feedSort, setFeedSort] = useState<'popular'|'recent'>('popular');
  const [communityPosts, setCommunityPosts] = useState<Array<{id:string;text:string;created_at:string;username:string;display_name:string}>>([]);
  const [postText, setPostText] = useState('');
  const [postError, setPostError] = useState('');
  const [postSubmitting, setPostSubmitting] = useState(false);
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [buckets, setBuckets] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  const setPage = (nextPage: RoutePage) => {
    const destination = nextPage === 'settings' && !user ? 'login' : nextPage;
    window.history.pushState({page: destination}, '', pageRoutes[destination]);
    setCurrentPage(destination);
    window.scrollTo({top: 0, behavior: 'auto'});
  };

  useEffect(() => {
    const updatePage = () => setCurrentPage(pageFromLocation());
    window.addEventListener('popstate', updatePage);
    return () => window.removeEventListener('popstate', updatePage);
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.themePreference = theme;
    root.style.colorScheme = dark ? 'dark' : 'light';
    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (themeColor) themeColor.content = dark ? '#1c1d29' : '#fbfaf7';
  }, [dark, theme]);

  const updateTheme = (nextTheme: Theme) => {
    setTheme(nextTheme);
    const root = document.documentElement;
    root.dataset.themeTransition = 'true';
    window.setTimeout(() => delete root.dataset.themeTransition, 220);
    try {
      localStorage.setItem('theme', nextTheme);
      localStorage.removeItem('aiverse-theme');
    } catch {}
  };
  const toggleTheme = () => updateTheme(dark ? 'light' : 'dark');

  const refresh = useCallback(async () => {
    try {
      const nextHealth = await getJSON<Health>('/api/health', t);
      setHealth(nextHealth);
      if (!nextHealth.sharedRepositoryApiEnabled) {
        setError(t('error.publicRepository'));
        return;
      }
      const [nextLog, nextFiles, nextStatus, nextBranches, nextChanges, structures] = await Promise.all([
        getJSON<Commit[]>('/api/repo/log', t), getJSON<Entry[]>('/api/repo/tree', t), getJSON<Status>('/api/repo/status', t),
        getJSON<string[]>('/api/repo/branches', t), getJSON<Change[]>('/api/repo/diff', t),
        getJSON<{objectBuckets: number[]}>('/api/structures', t),
      ]);
      setLog(nextLog); setFiles(nextFiles); setStatus(nextStatus); setBranches(nextBranches);
      setChanges(nextChanges); setBuckets(structures.objectBuckets); setError('');
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally { setLoading(false); }
  }, []);

  const loadFeed = useCallback(async () => {
    setFeedLoading(true);
    setFeedError('');
    try { const result = await getJSON<{repositories: typeof feed}>('/api/feed', t); setFeed(result.repositories); }
    catch (cause) { setFeedError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setFeedLoading(false); }
  }, []);

  const loadPosts = useCallback(async () => {
    setPostsLoading(true);
    setPostsError('');
    try { const result = await getJSON<{posts: typeof communityPosts}>('/api/feed/posts', t); setCommunityPosts(result.posts); }
    catch (cause) { setPostsError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPostsLoading(false); }
  }, []);

  useEffect(() => {
    void refresh();
    void getJSON('/api/auth/csrf', t).catch(()=>undefined);
    void getJSON<{user: typeof user}>('/api/auth/me', t).then(result=>setUser(result.user)).catch(()=>setUser(null)).finally(()=>setAuthChecked(true));
    void loadFeed();
    void loadPosts();
    void getJSON<{enabled:boolean}>('/api/billing/status', t).then(result=>setBillingEnabled(result.enabled)).catch(()=>setBillingEnabled(false));
  }, [refresh, loadFeed, loadPosts, lang]);

  useEffect(() => {
    if (!api || (!user && !import.meta.env.DEV)) return;
    let socket: WebSocket | undefined;
    let cancelled = false;
    void getJSON<Health>('/api/health', t).then(result => {
      if (!result.sharedRepositoryApiEnabled || cancelled) return;
      socket = new WebSocket(wsUrl);
      socket.onmessage = event => {
        const message = JSON.parse(event.data as string) as {type?: string; task?: AITask};
        if (message.type === 'ai-task' && message.task) setAiTask(current => current?.id === message.task?.id ? message.task ?? current : current);
        if (message.type === 'filesystem') void refresh();
      };
    }).catch(()=>undefined);
    return () => { cancelled = true; socket?.close(); };
  }, [user, refresh]);

  useEffect(() => {
    if (authChecked && (page === 'settings' || page === 'account') && !user) setPage('login');
  }, [authChecked, page, user]);

  useLayoutEffect(() => {
    const metadata: Record<Page, {title: string; description: string}> = {
      home: {title: t('meta.home.title'), description: t('meta.home.description')},
      feed: {title: t('meta.feed.title'), description: t('meta.feed.description')},
      docs: {title: t('meta.docs.title'), description: t('meta.docs.description')},
      workspace: {title: t('meta.workspace.title'), description: t('meta.workspace.description')},
      login: {title: t('meta.login.title'), description: t('meta.login.description')},
      register: {title: t('meta.register.title'), description: t('meta.register.description')},
      account: {title: t('meta.account.title'), description: t('meta.account.description')},
      settings: {title: t('meta.settings.title'), description: t('meta.settings.description')},
      prs: {title: t('meta.prs.title'), description: t('meta.prs.description')},
      pricing: {title: t('meta.pricing.title'), description: t('meta.pricing.description')},
      terms: {title: t('meta.terms.title'), description: t('meta.terms.description')},
      privacy: {title: t('meta.privacy.title'), description: t('meta.privacy.description')},
      legal: {title: t('meta.legal.title'), description: t('meta.legal.description')},
      cookies: {title: t('meta.cookies.title'), description: t('meta.cookies.description')},
      notFound: {title: t('meta.notFound.title'), description: t('meta.notFound.description')},
    };
    const content = metadata[page];
    document.title = content.title;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (description) description.content = content.description;
    for (const [selector, value] of [
      ['meta[property="og:title"]', content.title],
      ['meta[property="og:description"]', content.description],
      ['meta[name="twitter:title"]', content.title],
      ['meta[name="twitter:description"]', content.description],
    ] as const) {
      const tag = document.querySelector<HTMLMetaElement>(selector);
      if (tag) tag.content = value;
    }
    const robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (robots) robots.content = ['workspace', 'login', 'register', 'account', 'settings', 'notFound'].includes(page) ? 'noindex, nofollow' : 'index, follow';
    let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.rel = 'canonical';
      document.head.append(canonical);
    }
    canonical.href = `${window.location.origin}${page === 'notFound' ? '/' : pageRoutes[page]}`;
  }, [page, lang, t]);

  const selectedChange = useMemo(() => changes.find(change => change.path === selected), [changes, selected]);
  const allPaths = useMemo(() => [...new Set([...files.map(file => file.path), ...changes.map(change => change.path)])].sort(), [files, changes]);
  const filteredFeed = useMemo(() => feed
    .filter(item => `${item.name} ${item.username} ${item.description}`.toLowerCase().includes(feedSearch.trim().toLowerCase()))
    .sort((a,b) => feedSort === 'popular' ? b.stars_count-a.stars_count : new Date(b.created_at ?? 0).getTime()-new Date(a.created_at ?? 0).getTime()), [feed, feedSearch, feedSort]);

  const publishPost = async (event: FormEvent) => {
    event.preventDefault(); setPostError(''); setPostSubmitting(true);
    try {
      const result = await postJSON<{post: typeof communityPosts[number]}>('/api/feed/posts', {text: postText}, t);
      setCommunityPosts(posts => [result.post, ...posts]); setPostText('');
    } catch (cause) { setPostError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPostSubmitting(false); }
  };

  const startCheckout = async (plan: 'starter'|'plus'|'pro') => {
    try { const result = await postJSON<{url:string}>('/api/billing/checkout', {plan}, t); window.location.assign(result.url); }
    catch (cause) { setFormError(cause instanceof Error ? cause.message : String(cause)); }
  };

  useEffect(() => {
    if (!selected || selectedChange) { setContent(''); return; }
    void getJSON<{content: string}>('/api/repo/file?path=' + encodeURIComponent(selected), t)
      .then(result => setContent(result.content)).catch(fetchError => setContent(String(fetchError)));
  }, [selected, selectedChange]);

  useEffect(() => {
    if (!aiTask || aiTask.state === 'ready' || aiTask.state === 'error') return;
    const timer = window.setTimeout(() => {
      void getJSON<AITask>('/api/ai/tasks/' + aiTask.id, t).then(setAiTask).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [aiTask]);

  const run = async () => {
    const [command, ...args] = terminal.trim().split(/\s+/);
    if (!command) return;
    try {
      let result: unknown;
      if (command === 'status') result = await getJSON('/api/repo/status', t);
      else if (command === 'log') result = await getJSON('/api/repo/log', t);
      else if (command === 'add') result = await postJSON('/api/repo/add', {paths: args.length ? args : ['.']}, t);
      else if (command === 'commit') result = await postJSON('/api/repo/commit', {message: args[0] === '-m' ? args.slice(1).join(' ') : args.join(' ')}, t);
      else if (command === 'branch') result = await postJSON('/api/repo/branch', {name: args[0]}, t);
      else if (command === 'checkout') result = await postJSON('/api/repo/checkout', {name: args[0]}, t);
      else if (command === 'merge') result = await postJSON('/api/repo/merge', {name: args[0]}, t);
      else if (command === 'stash') result = await postJSON('/api/repo/stash', {action: args[0] ?? 'push'}, t);
      else throw new Error(t('error.commands'));
      setOutput(history => [JSON.stringify(result), ...history]);
      await refresh();
    } catch (runError) { setOutput(history => [runError instanceof Error ? runError.message : String(runError), ...history]); }
    setTerminal('');
  };

  const requestAI = async (kind: 'review' | 'commit-msg' | 'ask') => {
    try {
      const diff = changes.map(change => `diff -- ${change.path}\n${change.lines.join('\n')}`).join('\n');
      const context = selected ? `${selected}\n${content}` : diff;
      setAiTask(await postJSON<AITask>('/api/ai/' + kind, {text: kind === 'ask' ? `${t('workspace.aiQuestionPrefix')} ${aiQuestion}\n\n${t('workspace.aiContextPrefix')}\n${context}` : context, diff: context}, t));
      if (kind === 'ask') setAiQuestion('');
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
      if (!policyOk) { setFormError(t('error.passwordRequirements')); return; }
      if (data.get('confirmPassword') !== password) { setFormError(t('error.passwordMismatch')); return; }
    }
    if (!email) { setFormError(t('error.emailRequired')); return; }
    setAuthSubmitting(true);
    try {
      const route = page === 'register' ? '/api/auth/register' : '/api/auth/login';
      const body = page === 'register' ? {username:data.get('username'),displayName:data.get('displayName'),email,password,confirmPassword:data.get('confirmPassword')} : {email,password};
      const result = await postJSON<{user: typeof user}>(route,body, t);
      setUser(result.user);
      setAuthChecked(true);
      setPage('account');
    } catch (cause) { setFormError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setAuthSubmitting(false); }
  };

  const passwordChecks = [
    {label:t('auth.passwordLength'), valid:passwordValue.length >= 12},
    {label:t('auth.passwordUpper'), valid:/[A-Z]/.test(passwordValue)},
    {label:t('auth.passwordLower'), valid:/[a-z]/.test(passwordValue)},
    {label:t('auth.passwordNumber'), valid:/[0-9]/.test(passwordValue)},
    {label:t('auth.passwordSymbol'), valid:/[^A-Za-z0-9\s]/.test(passwordValue)},
    {label:t('auth.passwordAvoid'), valid:passwordValue.length>0&&!/(password|contraseña)/i.test(passwordValue)},
  ];
  const passwordValid = passwordChecks.every(check => check.valid) && !/password|contraseña/i.test(passwordValue);

  if (page === 'notFound') return <main className={dark?'app marketing-app dark':'app marketing-app'}><SiteHeader page={page} user={user} navigate={setPage} theme={theme} dark={dark} onThemeToggle={toggleTheme} onThemeChange={updateTheme}/><section className="not-found-page"><p className="eyebrow">{t('error.notFoundEyebrow')}</p><span className="not-found-code" aria-hidden="true">404</span><h1>{t('error.notFoundTitle')}</h1><p>{t('error.notFoundBody')}</p><button className="action" onClick={()=>setPage('home')}>{t('common.backHome')}{' '}<span>→</span></button></section><SiteFooter navigate={setPage}/></main>;

  if (page === 'feed') return <main className={dark?'app marketing-app dark':'app marketing-app'}>
    <SiteHeader page={page} user={user} navigate={setPage} theme={theme} dark={dark} onThemeToggle={toggleTheme} onThemeChange={updateTheme}/>
    <section className="explore-hero"><p className="eyebrow">{t('feed.eyebrow')}</p><h1>{t('feed.titleFirst')}<br/><span>{t('feed.titleSecond')}</span></h1><p>{t('feed.intro')}</p><div className="explore-search"><span>⌕</span><input value={feedSearch} onChange={event=>setFeedSearch(event.target.value)} placeholder={t('feed.searchPlaceholder')} aria-label={t('feed.searchLabel')}/><button onClick={()=>setFeedSearch('')} disabled={!feedSearch}>{t('common.clear')}</button></div><div className="explore-metrics" aria-live="polite"><span><b>{feedLoading?'…':formatNumber(feed.length)}</b> {t('feed.publicRepositories')}</span><span><b>{feedLoading?'…':formatNumber(new Set(feed.map(item=>item.username)).size)}</b> {t('feed.developers')}</span><span>{t('feed.updated')}</span></div></section>
    <section className="explore-content"><div className="community-layout"><div><div className="community-composer"><p className="eyebrow">{t('feed.shareEyebrow')}</p><h2>{t('feed.composerTitle')}</h2>{user?<form onSubmit={event=>void publishPost(event)}><textarea maxLength={1200} value={postText} onChange={event=>setPostText(event.target.value)} placeholder={t('feed.composerPlaceholder')}/><div><small>{formatNumber(postText.length)}/1.200</small><button className="action" disabled={postSubmitting||!postText.trim()}>{postSubmitting?t('feed.publishing'):t('feed.publish')}</button></div>{postError&&<p className="form-error" role="alert">{postError}</p>}</form>:<><p>{t('feed.loginToPost')}</p><button className="action" onClick={()=>setPage('login')}>{t('feed.loginAction')}</button></>}</div><div className="community-posts"><p className="eyebrow">{t('feed.recentEyebrow')}</p>{postsLoading?<div className="feed-skeleton" role="status" aria-label={t('feed.loadingPosts')}><i/><i/><i/></div>:postsError?<div className="feed-error" role="alert"><p>{t('feed.postsError', {error:postsError})}</p><button onClick={()=>void loadPosts()}>{t('common.retry')}</button></div>:communityPosts.length?communityPosts.map(post=><article className="community-post" key={post.id}><div className="post-avatar">{post.display_name?.[0]?.toUpperCase()||'A'}</div><div><strong>{post.display_name||post.username}</strong><small>@{post.username} · {formatDate(post.created_at, {dateStyle:'medium',timeStyle:'short'})}</small><p>{post.text}</p></div></article>):<div className="explore-empty"><h3>{t('feed.startConversation')}</h3><p>{t('feed.firstPostHint')}</p></div>}</div></div><div><div className="explore-heading"><div><p className="eyebrow">{t('feed.directory')}</p><h2>{t('feed.projectsTitle')}</h2><p>{t('feed.repositoriesHint')}</p></div><label className="sort-select">{t('feed.sort')}<select value={feedSort} onChange={event=>setFeedSort(event.target.value as 'popular'|'recent')}><option value="popular">{t('feed.popular')}</option><option value="recent">{t('feed.recent')}</option></select></label></div>
      <div className="explore-tags"><span>{t('feed.trySearch')}</span>{['api','web','ia','typescript','open source'].map(term=><button key={term} onClick={()=>setFeedSearch(term)}>{term}</button>)}</div>
      {feedLoading?<div className="explore-loading" role="status"><span className="loading-spinner" aria-hidden="true"/><p>{t('feed.loadingProjects')}</p><div className="feed-skeleton"><i/><i/><i/></div></div>:feedError?<div className="feed-error" role="alert"><p>{t('feed.projectsError', {error:feedError})}</p><button onClick={()=>void loadFeed()}>{t('common.retry')}</button></div>:filteredFeed.length>0?<div className="repo-grid explore-repos">{filteredFeed.map(item=><article className="repo-card explore-repo" key={item.id}><div className="explore-repo-title"><span className="repo-mark">◈</span><div><small>{item.username}</small><b>{item.username}/{item.name}</b></div><span className="repo-public">{t('feed.public')}</span></div><p>{item.description||t('feed.sharedRepository')}</p><div className="repo-meta"><span>☆ {formatNumber(item.stars_count)} {t('feed.stars')}</span><span>{item.created_at?formatDate(item.created_at, {dateStyle:'medium'}):t('feed.projectLabel')}</span></div></article>)}</div>
      :<div className="explore-empty"><span>⌕</span><h3>{feed.length?t('feed.noResults'):t('feed.communityStarting')}</h3><p>{feed.length?t('feed.tryAnotherSearch'):t('feed.emptyHint')}</p>{feedSearch?<button className="secondary action" onClick={()=>setFeedSearch('')}>{t('feed.clearSearch')}</button>:<button className="action" onClick={()=>setPage(user?'workspace':'register')}>{t('feed.createFirst')}</button>}</div>}
    </div></div></section><section className="explore-invite"><div><p className="eyebrow">{t('feed.inviteEyebrow')}</p><h2>{t('feed.inviteTitle')}</h2><p>{t('feed.inviteBody')}</p></div><button className="action" onClick={()=>setPage(user?'workspace':'register')}>{t('feed.startBuilding')}{' '}<span>→</span></button></section>
    <SiteFooter navigate={setPage}/>
  </main>;

  if (page === 'login' || page === 'register') return <main className={dark?'auth-page dark':'auth-page'}>
    <div className="auth-aside"><button className="wordmark" onClick={()=>setPage('home')}><AIVerseMark/><span>A<span className="wordmark-i">I</span>Verse</span></button><div><p className="eyebrow">{t('auth.brandEyebrow')}</p><h2>{t('auth.brandTitle')}</h2><p>{t('footer.tagline')}</p></div><span>{t('auth.brandFooter')}</span></div>
    <section className="auth-card"><button className="auth-back" onClick={()=>setPage('home')}>← {t('common.backHome')}</button><p className="eyebrow">{page==='login'?t('auth.welcomeEyebrow'):t('auth.registerEyebrow')}</p><h1>{page==='login'?t('auth.loginTitle'):t('auth.registerTitle')}</h1><p className="auth-intro">{page==='login'?t('auth.loginIntro'):t('auth.registerIntro')}</p>
      <form onSubmit={event=>void submitAuth(event)} noValidate={false}>
        {page==='register'&&<><label>{t('auth.username')}<input name="username" placeholder={t('auth.usernamePlaceholder')} required minLength={1} maxLength={39} autoComplete="username" pattern="[A-Za-z0-9][A-Za-z0-9-]{0,37}[A-Za-z0-9]?"/><small>{t('auth.usernameHint')}</small></label><label>{t('auth.displayName')}<input name="displayName" placeholder={t('auth.displayNamePlaceholder')} required maxLength={80} autoComplete="name"/></label></>}
        <label>{t('auth.email')}<input name="email" type="email" inputMode="email" placeholder={t('auth.emailPlaceholder')} required maxLength={254} autoComplete="email"/></label>
        <label>{t('auth.password')}<div className="password-field"><input name="password" type={showPassword?'text':'password'} placeholder={page==='register'?t('auth.passwordCreatePlaceholder'):t('auth.passwordPlaceholder')} required minLength={page==='register'?12:1} maxLength={page==='register'?128:256} autoComplete={page==='register'?'new-password':'current-password'} value={page==='register'?passwordValue:undefined} onChange={event=>{if(page==='register')setPasswordValue(event.target.value)}}/><button type="button" className="password-toggle" onClick={()=>setShowPassword(!showPassword)} aria-label={showPassword?t('auth.hidePassword'):t('auth.showPassword')}>{showPassword?t('auth.hidePassword'):t('auth.showPassword')}</button></div></label>
        {page==='register'&&<><ul className="password-checks" aria-label={t('auth.passwordRequirements')}>{passwordChecks.map(check=><li key={check.label} className={check.valid?'passed':''}><span aria-hidden="true">{check.valid?'✓':'○'}</span>{check.label}</li>)}</ul><label>{t('auth.confirmPassword')}<input name="confirmPassword" type={showPassword?'text':'password'} placeholder={t('auth.confirmPlaceholder')} required minLength={12} maxLength={128} autoComplete="new-password"/></label><p className="password-match" aria-live="polite">{passwordValue&&passwordValid?t('auth.passwordStrong'):t('auth.passwordUse')}</p></>}
        {formError&&<p className="form-error" role="alert">{formError}</p>}
        <button className="action auth-submit" disabled={authSubmitting || (page==='register'&&!passwordValid)}>{authSubmitting?t('auth.connecting'):page==='login'?t('nav.login'):t('auth.createFree')}{!authSubmitting&&<span>→</span>}</button>
      </form>
      <p className="auth-switch">{page==='login'?t('auth.firstTime'):t('auth.alreadyHaveAccount')} <button className="inline-button" onClick={()=>{setFormError('');setPasswordValue('');setPage(page==='login'?'register':'login')}}>{page==='login'?t('auth.registerTitle'):t('auth.switchLogin')}</button></p><p className="auth-legal">{t('auth.legalIntro')}{' '}<button onClick={()=>setPage('terms')}>{t('footer.terms')}</button> {t('auth.and')}{' '}<button onClick={()=>setPage('privacy')}>{t('footer.privacy')}</button>.</p>
    </section></main>;

  if (page === 'home' || page === 'account' || page === 'settings' || page === 'prs' || page === 'docs' || page === 'pricing' || page === 'terms' || page === 'privacy' || page === 'legal' || page === 'cookies') return <main className={dark?'app marketing-app dark':'app marketing-app'}><SiteHeader page={page} user={user} navigate={setPage} theme={theme} dark={dark} onThemeToggle={toggleTheme} onThemeChange={updateTheme}/>
    {page==='settings'?<section className="product-page settings-page"><p className="eyebrow">{t('settings.eyebrow')}</p><h1>{t('settings.title')}</h1><p>{t('settings.intro')}</p><div className="settings-card"><label>{t('language.menu')}<select value={lang} onChange={event=>setLanguage(event.target.value as Language)}><option value="es">{t('language.spanish')}</option><option value="en">{t('language.english')}</option></select></label><label>{t('settings.theme')}<select value={theme} onChange={event=>updateTheme(event.target.value as Theme)}><option value="system">{t('settings.followSystem')}</option><option value="light">{t('theme.light')}</option><option value="dark">{t('theme.dark')}</option></select></label><p className="system-theme-note">{t('settings.systemNow')}{' '}<b>{systemDark?t('theme.modeDark'):t('theme.modeLight')}</b>. {theme==='system'?t('settings.systemFollow'):t('settings.manualTheme')}</p></div><button className="secondary action" onClick={()=>setPage('account')}>{t('settings.backAccount')}</button></section>
    :page==='account'?<section className="product-page account-panel"><p className="eyebrow">{t('account.eyebrow')}</p><div className="account-heading"><span className="avatar">{user?.display_name?.[0]?.toUpperCase()??'A'}</span><div><h1>{user?.display_name??t('account.title')}</h1><p>@{user?.username} · {user?.email}</p></div></div><div className="account-plan"><div><b>{t('account.freePlan')}</b><p>{t('account.freeDescription')}</p></div><button className="action" onClick={()=>setPage('pricing')}>{t('account.seePlans')}</button></div><button className="secondary action" onClick={()=>setPage('settings')}>{t('account.editPreferences')}</button></section>
    :page==='docs'?<DocumentationPage navigate={setPage}/>
    :page==='prs'?<section className="product-page"><p className="eyebrow">{t('prs.eyebrow')}</p><h1>{t('prs.title')}</h1><p>{t('prs.intro')}</p><div className="feature-row"><article><b>{t('prs.contextReview')}</b><p>{t('prs.contextReviewBody')}</p></article><article><b>{t('prs.decisions')}</b><p>{t('prs.decisionsBody')}</p></article><article><b>{t('prs.aiHelp')}</b><p>{t('prs.aiHelpBody')}</p></article></div><button className="action" onClick={()=>setPage(user?'workspace':'register')}>{t('prs.start')}</button></section>
    :page==='terms'||page==='privacy'||page==='legal'||page==='cookies'?<><LegalPage kind={page}/><SiteFooter navigate={setPage}/></>
    :page==='pricing'?<PricingPage user={user} billingEnabled={billingEnabled} navigate={setPage} startCheckout={startCheckout}/>
    :<>{feedError&&<div className="feed-error home-feed-error" role="alert"><p>{t('feed.projectsError', {error:feedError})}</p><button onClick={()=>void loadFeed()}>{t('common.retry')}</button></div>}<Homepage feed={feed} feedLoading={feedLoading} feedError={feedError} user={user} navigate={setPage}/><SiteFooter navigate={setPage}/></>}</main>;

  return <main className={dark ? 'app dark' : 'app'}>
    <header>
      <div className="brand"><span className="logo"><AIVerseMark/></span><div><b>{t('workspace.productName')}</b><small>{t('workspace.tagline')}</small></div></div>
      <div className="header-right"><span className={error ? 'connection offline' : 'connection'}>● {error ? t('workspace.offline') : t('workspace.connected')}</span><span className="branch">⌘ {status.branch}</span>{user&&<button className="workspace-nav" onClick={()=>setPage('settings')}>{t('settings.title')}</button>}<LanguageControl compact/><ThemeControl theme={theme} dark={dark} onToggle={toggleTheme} onSelect={updateTheme} compact/>{user&&<button className="workspace-account" onClick={()=>setPage('account')}>@{user.username}</button>}</div>
    </header>
    {error && <div className="error-banner" role="alert"><span>{health?.sharedRepositoryApiEnabled === false ? error : t('error.workspaceConnection', {error})}</span><button onClick={()=>{setLoading(true);void refresh()}}>{t('common.retry')}</button></div>}
    {loading && <div className="workspace-loading" role="status" aria-live="polite"><span className="loading-spinner" aria-hidden="true"/><span>{t('workspace.loading')}</span><div className="loading-track"><i/></div></div>}
    <section className="workspace">
      <aside className="sidebar">
        <div className="workspace-side-nav" aria-label={t('workspace.navigation')}>
          <button className="selected" onClick={()=>setPage('workspace')}><span>⌂</span> {t('workspace.summary')}</button>
          <button onClick={()=>setPage('feed')}><span>◉</span> {t('nav.community')}</button>
          <button onClick={()=>setPage('docs')}><span>▤</span> {t('workspace.guides')}</button>
          <button onClick={()=>setPage('prs')}><span>⑂</span> {t('prs.title')}</button>
        </div>
        <div className="workspace-sidebar-rule"/>
        <div className="side-title">{t('workspace.explorer')}{' '}<span>{formatNumber(allPaths.length)}</span></div>
        {allPaths.map(file => { const change = changes.find(item => item.path === file); return <button className={selected === file ? 'file active' : 'file'} key={file} onClick={() => setSelected(file)}><span className={`dot ${change?.status ?? 'clean'}`}/>{file}</button>; })}
        {!allPaths.length && <p className="muted">{loading ? t('common.loading') : t('workspace.addFiles')}</p>}
        <div className="side-title branch-heading">{t('workspace.branches')}{' '}<span>{formatNumber(branches.length)}</span></div>
        {branches.map(branch => <div className={branch === status.branch ? 'file current' : 'file'} key={branch}>◉ {branch}</div>)}
      </aside>
      <section className="center">
        <div className="workspace-overview">
          <div className="workspace-greeting">
            <div><p className="workspace-kicker">{t('workspace.kicker')}</p><h1>{t('workspace.project')}</h1><p>{t('workspace.projectIntro')}</p></div>
            <div className="workspace-quick-actions"><button className="mobile-ai-toggle" onClick={()=>setShowMobileAI(true)}>{t('workspace.openCopilot')}{' '}<span>✦</span></button><button onClick={()=>setPage('feed')}>{t('workspace.exploreCommunity')}{' '}<span>↗</span></button><button className="quick-primary" onClick={()=>setPage('docs')}>{t('workspace.openGuides')}{' '}<span>→</span></button></div>
          </div>
          <div className="workspace-metrics">
            <article><span className="metric-icon violet">⌘</span><div><b>{formatNumber(log.length)}</b><small>{t('workspace.commits')}</small></div></article>
            <article><span className="metric-icon amber">✎</span><div><b>{formatNumber(changes.length)}</b><small>{t('workspace.pendingChanges')}</small></div></article>
            <article><span className="metric-icon green">▤</span><div><b>{formatNumber(files.length)}</b><small>{t('workspace.trackedFiles')}</small></div></article>
            <article className="workspace-branch-card"><span>{t('workspace.currentBranch')}</span><b>⑂ {status.branch}</b><small>{error ? t('workspace.syncPaused') : t('workspace.repositoryConnected')}</small></article>
          </div>
          <div className="workspace-section-label"><div><span className="section-spark">✦</span><b>{t('workspace.activity')}</b><small> {t('workspace.activityHint')}</small></div><span className="activity-count">{t('workspace.historyCount', {count:formatNumber(log.length)})}</span></div>
        </div>
        <div className="graph">
          <div className="panel-head"><span>{t('workspace.commitHistory')}</span><small>{t('workspace.branch', {branch:status.branch})}</small></div>
          {log.length ? <div className="commit-timeline">{log.slice(0, 5).map((item,index)=><article className={index===0?'commit-item latest':'commit-item'} key={item.hash}><span className="commit-node"/><div><div className="commit-item-title"><b>{item.commit.message}</b>{index===0&&<span>{t('workspace.latest')}</span>}</div><p><code>{item.hash.slice(0,8)}</code><i/>{formatDate(item.commit.date, {dateStyle:'medium',timeStyle:'short'})}</p></div></article>)}</div> : loading ? <div className="timeline-loading" aria-hidden="true"><i/><i/><i/></div> : <div className="timeline-empty"><span>✦</span><div><b>{t('workspace.historyEmptyTitle')}</b><p>{t('workspace.historyEmptyBody')}</p></div></div>}
        </div>
        <div className="editor">
          <div className="panel-head"><span>{selected || t('workspace.changesTree')}</span><small>{selectedChange ? selectedChange.status : t('workspace.confirmedContent')}</small></div>
          {selectedChange ? <div className="diff-grid"><DiffColumn title={t('workspace.before')} text={selectedChange.oldText}/><DiffColumn title={t('workspace.after')} text={selectedChange.newText}/></div> : <pre>{selected ? content : t('workspace.selectFile')}</pre>}
        </div>
      </section>
      <aside className={showMobileAI ? 'right mobile-ai-open' : 'right'}>
        <button className="mobile-ai-close" onClick={()=>setShowMobileAI(false)}>{t('workspace.closeCopilot')}{' '}<span>×</span></button>
        <div className="ai-panel-heading"><span className="ai-spark">✦</span><div><b>{t('workspace.copilot')}</b><small>{t('workspace.aiConnected')}</small></div><span className="online">●</span></div>
        <div className="ai-welcome"><span>✧</span><b>{t('workspace.discover')}</b><p>{t('workspace.aiIntro')}</p></div>
        <div className="ai-action-label">{t('workspace.quickActions')}</div>
        <button className="action" onClick={() => void requestAI('review')} disabled={!changes.length}>{t('workspace.reviewChanges', {count:formatNumber(changes.length),plural:changes.length === 1?'':'s'})}</button>
        <button className="action secondary" onClick={() => void requestAI('commit-msg')} disabled={!changes.length}>{t('workspace.suggestCommit')}</button>
        <div className="ai-suggestions" aria-label={t('workspace.suggestedQuestions')}>
          <button onClick={()=>setAiQuestion(t('workspace.questionUnderstand'))}>{t('workspace.understandProject')}</button>
          <button onClick={()=>setAiQuestion(t('workspace.questionRisks'))}>{t('workspace.findRisks')}</button>
          <button onClick={()=>setAiQuestion(t('workspace.questionNext'))}>{t('workspace.nextStep')}</button>
        </div>
        <label className="ai-ask-label">{t('workspace.askAiverse')}<textarea value={aiQuestion} onChange={event=>setAiQuestion(event.target.value)} onKeyDown={event=>event.key==='Enter'&&(event.metaKey||event.ctrlKey)&&void requestAI('ask')} maxLength={1000} placeholder={t('workspace.askPlaceholder')}/><small className="ai-input-hint">{t('workspace.askHint', {count:formatNumber(aiQuestion.length)})}</small></label>
        <button className="action ai-submit" onClick={() => void requestAI('ask')} disabled={!aiQuestion.trim()}>{t('workspace.sendQuestion')}{' '}<span>↑</span></button>
        <div className={`task-state ${aiTask?.state ?? ''}`}>{aiTask ? `${t(`task.${aiTask.state}`)} · ${t('workspace.attempt', {count:formatNumber(aiTask.attempts)})}` : t('workspace.answersHere')}</div>
        {aiTask&&<pre className="ai-result">{aiTask.result ?? aiTask.error ?? t('workspace.preparingAnswer')}</pre>}
        <div className="ai-provider-note"><span>✧</span> {t('workspace.model', {model:health?.provider ?? t('workspace.productName')})}</div>
        <div className="inspector"><div className="panel-head">{t('workspace.inspector')}</div><small>{t('workspace.hashTable')}</small><div className="buckets">{buckets.slice(0, 32).map((count, index) => <div key={index} title={t('workspace.bucketTitle', {index:formatNumber(index),count:formatNumber(count)})} style={{height: Math.max(4, count * 12)}}/>)}</div><small>{t('workspace.buckets', {count:formatNumber(buckets.length)})} {t('workspace.trackedFilesCount', {count:formatNumber(files.length)})}</small></div>
        <div className="panel-head state-heading">{t('workspace.status')}</div><div className="stats"><span>{formatNumber(status.staged.length)}<small>{t('workspace.staged')}</small></span><span>{formatNumber(status.modified.length)}<small>{t('workspace.modified')}</small></span><span>{formatNumber(status.untracked.length)}<small>{t('workspace.untracked')}</small></span></div>
      </aside>
    </section>
    <section className="terminal"><div className="terminal-head"><span><i/> {t('workspace.terminal')}</span><small>{t('workspace.terminalTagline')}</small><button onClick={()=>setPage('docs')}>{t('workspace.commands')}</button></div><div className="terminal-body"><div className="terminal-history">{output.slice(0, 5).map((line, index) => <div key={index}>{line}</div>)}</div><div className="prompt"><b>aiverse ❯</b><input value={terminal} onChange={event => setTerminal(event.target.value)} onKeyDown={event => event.key === 'Enter' && void run()} placeholder={t('workspace.terminalPlaceholder')}/><button onClick={() => void run()}>↵</button></div></div></section>
    <footer className="workspace-footer"><span><AIVerseMark/> {t('workspace.productName')}{' '}<i/> {t('workspace.changesOnBranch', {count:formatNumber(changes.length),branch:status.branch})}</span><div><button onClick={()=>setPage('home')}>{t('nav.home')}</button><button onClick={()=>setPage('feed')}>{t('nav.community')}</button><button onClick={()=>setPage('docs')}>{t('nav.guides')}</button><button onClick={()=>setPage('terms')}>{t('workspace.terms')}</button><button onClick={()=>setPage('privacy')}>{t('workspace.privacy')}</button></div><span>● {error ? t('workspace.offline') : t('workspace.allUpdated')}</span></footer>
  </main>;
}

function Homepage({feed,feedLoading,feedError,user,navigate}: {feed: Array<{id:string;name:string;description:string;stars_count:number;username:string}>;feedLoading:boolean;feedError:string;user:{username:string}|null;navigate:(page:RoutePage)=>void}) {
  const {t} = useI18n();
  return <>
    <section className="home-hero"><div className="home-hero-inner">
      <div className="home-hero-copy">
        <p className="eyebrow">{t('home.heroEyebrow')}</p>
        <h1><span>{t('home.heroTitleFirst')}</span><span className="hero-title-accent">{t('home.heroTitleSecond')}</span></h1>
        <p className="home-hero-lead">{t('home.heroLead')}</p>
        <div className="home-hero-actions">
          <button className="action hero-primary" onClick={()=>navigate(user?'workspace':'register')}>{t('nav.register')} <span aria-hidden="true">→</span></button>
          <button className="home-text-link" onClick={()=>navigate('feed')}>{t('home.exploreProjects')} <span aria-hidden="true">→</span></button>
        </div>
        <div className="home-proof"><span>{t('home.heroTrust')}</span></div>
      </div>
      <div className="home-hero-visual">
        <svg className="hero-commit-graph" viewBox="0 0 680 520" aria-hidden="true" focusable="false">
          <path d="M48 132h128c45 0 39 62 86 62h65"/>
          <path d="M154 395h110c48 0 49-62 98-62h112"/>
          <path d="M262 194v74c0 37 42 65 83 65"/>
          <path d="M327 194v-84c0-46 51-55 95-55h83"/>
          <circle cx="48" cy="132" r="7"/><circle cx="327" cy="194" r="8"/>
          <circle cx="481" cy="333" r="7"/><circle cx="505" cy="55" r="7"/>
        </svg>
        <span className="hero-orb hero-orb-one" aria-hidden="true"/>
        <span className="hero-orb hero-orb-two" aria-hidden="true"/>
        <span className="hero-orb hero-orb-three" aria-hidden="true"/>
        <div className="home-demo" aria-label={t('home.demoLabel')}>
          <div className="home-demo-top"><div><span className="demo-dot"/><b>{t('home.demoTitle')}</b></div><span className="demo-status">{t('home.pendingDecision')}</span></div>
          <div className="home-demo-branch"><span>⑂</span> feature/session-refresh <small>{t('home.demoTime')}</small></div>
          <div className="home-diff"><div className="demo-file"><span>src/auth/session.ts</span><span>+2 −1</span></div><div className="diff-line removed"><code>−</code><span>return refresh(token);</span></div><div className="diff-line added"><code>+</code><span>if (isExpired(token)) {'{'} return null; {'}'}</span></div><div className="diff-line added"><code>+</code><span>return refresh(token);</span></div></div>
          <div className="home-ai-note"><span className="note-icon">✦</span><div><b>{t('home.aiExplanation')}</b><p>{t('home.aiExplanationBody')}</p></div></div>
          <div className="home-demo-decision"><span><i/> {t('home.yourDecision')}</span><button onClick={()=>navigate(user?'workspace':'register')}>{t('home.reviewChanges')}</button></div>
        </div>
      </div>
    </div></section>
    <section className="home-process"><div className="home-section-intro"><p className="eyebrow">{t('home.processEyebrow')}</p><h2>{t('home.processTitleFirst')}<br/>{t('home.processTitleSecond')}</h2><p>{t('home.processIntro')}</p></div>
      <div className="home-process-grid">
        <article className="bento-card bento-observe">
          <span className="bento-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d="M6 4v9a5 5 0 0 0 5 5h7"/><circle cx="6" cy="4" r="2.2"/><circle cx="6" cy="13" r="2.2"/><circle cx="18" cy="18" r="2.2"/></svg></span>
          <h3>{t('home.observeTitle')}</h3><p>{t('home.observeBody')}</p>
          <svg className="bento-flow-art bento-branch-art" viewBox="0 0 320 70" fill="none" aria-hidden="true" focusable="false"><path d="M8 35h76c34 0 28-23 64-23h62m-126 23c34 0 28 23 64 23h116"/><circle cx="8" cy="35" r="5"/><circle cx="84" cy="35" r="5"/><circle cx="148" cy="12" r="5"/><circle cx="148" cy="58" r="5"/><circle cx="210" cy="12" r="5"/><circle cx="264" cy="58" r="5"/></svg>
        </article>
        <article className="bento-card bento-understand">
          <div className="bento-understand-copy">
            <span className="bento-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z"/></svg></span>
            <h3>{t('home.understandTitle')}</h3><p>{t('home.understandBody')}</p>
          </div>
          <div className="bento-ai-preview">
            <div className="bento-ai-preview-head"><span className="bento-ai-symbol" aria-hidden="true">✦</span><strong>{t('home.bentoReviewLabel')}</strong><span className="bento-ai-badge">{t('home.bentoReviewBadge')}</span></div>
            <p>{t('home.bentoReviewSummary')}</p>
            <div className="bento-ai-detail"><span aria-hidden="true">✓</span>{t('home.bentoReviewDetail')}</div>
            <div className="bento-ai-signals" aria-hidden="true"><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/></div>
          </div>
        </article>
        <article className="bento-card bento-collaborate">
          <span className="bento-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d="M15 20v-1.6a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20"/><circle cx="8.5" cy="7" r="4"/><path d="M16 11a4 4 0 1 0 0-8m6 17v-1.6a4 4 0 0 0-3-3.9"/></svg></span>
          <h3>{t('home.collaborateTitle')}</h3><p>{t('home.collaborateBody')}</p>
          <svg className="bento-flow-art bento-merge-art" viewBox="0 0 320 70" fill="none" aria-hidden="true" focusable="false"><path d="M8 12h63c37 0 29 23 68 23h72c27 0 26 23 61 23h40M8 58h63c37 0 29-23 68-23"/><circle cx="8" cy="12" r="5"/><circle cx="8" cy="58" r="5"/><circle cx="139" cy="35" r="5"/><circle cx="211" cy="35" r="5"/><circle cx="272" cy="58" r="5"/></svg>
        </article>
      </div>
    </section>
    {feedLoading||feed.length>=3?<section className="home-community"><div className="home-community-copy"><p className="eyebrow">{t('home.communityEyebrow')}</p><h2>{t('home.communityTitleFirst')}<br/>{t('home.communityTitleSecond')}</h2><p>{t('home.communityIntro')}</p><button className="home-text-link" onClick={()=>navigate('feed')}>{t('home.exploreCommunity')}{' '}<span>→</span></button></div><div className="home-project-rail" aria-busy={feedLoading} id="home-project-rail">{feedLoading?<div className="home-feed-skeleton" role="status" aria-label={t('home.loadingProjects')}><i/><i/><i/></div>:feed.slice(0,5).map((item,index)=><article className="home-project-card" key={item.id}><div className="project-card-top"><span>0{index+1}</span><small>{t('home.projectBadge')}</small></div><b>{item.username}/{item.name}</b><p>{item.description||t('home.projectFallback')}</p><div className="project-card-foot"><span>☆ {item.stars_count}</span><button onClick={()=>navigate('feed')}>{t('home.viewProject')}</button></div></article>)}</div>{feed.length>2&&<div className="rail-controls"><span>{t('feed.exploreMore')}</span><button aria-label={t('feed.searchPrevious')} onClick={()=>document.getElementById('home-project-rail')?.scrollBy({left:-280,behavior:'smooth'})}>←</button><button aria-label={t('feed.searchMore')} onClick={()=>document.getElementById('home-project-rail')?.scrollBy({left:280,behavior:'smooth'})}>→</button></div>}</section>:feedError?null:<section className="home-community-empty"><div><p className="eyebrow">{t('feed.eyebrow')}</p><h2>{t('home.emptyTitleFirst')}<br/>{t('home.emptyTitleSecond')}</h2><p>{t('home.emptyBody')}</p></div><button className="action" onClick={()=>navigate(user?'workspace':'register')}>{t('nav.register')}{' '}<span>→</span></button></section>}
    <section className="home-learning"><div><p className="eyebrow">{t('home.learningEyebrow')}</p><h2>{t('home.learningTitle')}</h2><p>{t('home.learningBody')}</p></div><button onClick={()=>navigate('docs')}>{t('home.openDocs')}{' '}<span>→</span></button></section>
    <section className="home-plans">
      <div className="home-plans-copy"><p className="eyebrow">{t('home.plansEyebrow')}</p><h2>{t('home.plansTitleFirst')}<br/><span>{t('home.plansTitleSecond')}</span></h2><button className="action home-plans-cta" onClick={()=>navigate('pricing')}>{t('home.comparePlans')} <span aria-hidden="true">→</span></button></div>
      <div className="home-growth-visual" aria-hidden="true"><svg viewBox="0 0 560 330" fill="none" focusable="false"><rect className="growth-panel growth-panel-one" x="30" y="120" width="118" height="148" rx="18"/><rect className="growth-panel growth-panel-two" x="174" y="72" width="118" height="148" rx="18"/><rect className="growth-panel growth-panel-three" x="318" y="24" width="118" height="148" rx="18"/><rect className="growth-line growth-accent" x="51" y="151" width="45" height="7" rx="3.5"/><rect className="growth-line" x="51" y="170" width="72" height="5" rx="2.5"/><rect className="growth-line growth-accent" x="195" y="103" width="45" height="7" rx="3.5"/><rect className="growth-line" x="195" y="122" width="72" height="5" rx="2.5"/><rect className="growth-line growth-accent" x="339" y="55" width="45" height="7" rx="3.5"/><rect className="growth-line" x="339" y="74" width="72" height="5" rx="2.5"/><path className="growth-path" d="M55 259c66 0 63-46 132-46s67-50 135-50 64-49 128-49"/><circle className="growth-node" cx="55" cy="259" r="7"/><circle className="growth-node" cx="187" cy="213" r="7"/><circle className="growth-node" cx="322" cy="163" r="7"/><circle className="growth-node" cx="450" cy="114" r="7"/></svg></div>
    </section>
    <section className="home-final-cta"><div className="home-final-cta-inner"><div className="home-final-copy"><h2>{t('home.finalTitleFirst')}<br/><span>{t('home.finalTitleSecond')}</span></h2><button className="action home-final-primary" onClick={()=>navigate(user?'workspace':'register')}>{t('nav.register')} <span aria-hidden="true">→</span></button><small>{t('home.trustLine')}</small></div><div className="home-final-visual" aria-hidden="true"><svg viewBox="0 0 520 360" fill="none" focusable="false"><path className="final-branch-line" d="M29 88h94c43 0 45 44 92 44h53m-154 0v91c0 34 37 44 70 44h54m30-135h78c45 0 47-45 92-45h66m-236 180h105c39 0 43-41 82-41h49"/><circle className="final-node" cx="29" cy="88" r="7"/><circle className="final-node" cx="122" cy="88" r="7"/><circle className="final-node" cx="122" cy="132" r="7"/><circle className="final-node" cx="184" cy="267" r="7"/><circle className="final-node" cx="267" cy="132" r="8"/><circle className="final-node" cx="362" cy="132" r="7"/><circle className="final-node" cx="456" cy="87" r="7"/><circle className="final-node" cx="393" cy="232" r="7"/><circle className="final-node" cx="493" cy="232" r="7"/></svg><span className="final-orb final-orb-one"/><span className="final-orb final-orb-two"/><span className="final-orb final-orb-three"/></div></div></section>
  </>;
}

function DiffColumn({title, text}: {title: string; text: string}) {
  return <section className="diff-column"><div>{title}</div><pre>{text || '∅'}</pre></section>;
}

function PricingPage({user,billingEnabled,navigate,startCheckout}: {user:{username:string}|null;billingEnabled:boolean;navigate:(page:RoutePage)=>void;startCheckout:(plan:'starter'|'plus'|'pro')=>Promise<void>}) {
  const {t,formatPrice} = useI18n();
  const choosePlan = (plan:'starter'|'plus'|'pro') => user ? void startCheckout(plan) : navigate('login');
  return <>
    <section className="pricing-hero"><p className="eyebrow">{t('pricing.eyebrow')}</p><h1>{t('pricing.titleFirst')}<br/><span>{t('pricing.titleSecond')}</span></h1><p>{t('pricing.intro')}</p><div className="billing-note">{billingEnabled?t('pricing.paymentsEnabled'):t('pricing.paymentsSoon')}</div></section>
    <section className="pricing-section"><div className="pricing-grid">
      <PlanCard name="Free" price={formatPrice(0)} cadence={t('pricing.perAccountForever')} description={t('pricing.freeDescription')} features={[t('pricing.repos3'),t('pricing.publicRepos'),t('pricing.history'),t('pricing.feedProfile')]} action={t('pricing.createFree')} onClick={()=>navigate(user?'account':'register')}/>
      <PlanCard name="Starter" price={formatPrice(3300)} cadence={t('pricing.perAccountMonth')} description={t('pricing.starterDescription')} features={[t('pricing.repos10'),t('pricing.publicPrivate'),t('pricing.allFree')]} action={t('pricing.chooseStarter')} highlighted disabled={!billingEnabled} onClick={()=>choosePlan('starter')}/>
      <PlanCard name="Plus" price={formatPrice(26500)} cadence={t('pricing.perAccountMonth')} description={t('pricing.plusDescription')} features={[t('pricing.repos20'),t('pricing.publicPrivate'),t('pricing.allStarter')]} action={t('pricing.choosePlus')} disabled={!billingEnabled} onClick={()=>choosePlan('plus')}/>
      <PlanCard name="Pro" price={formatPrice(59600)} cadence={t('pricing.perAccountMonth')} description={t('pricing.proDescription')} features={[t('pricing.reposUnlimited'),t('pricing.publicPrivate'),t('pricing.allPlus')]} action={t('pricing.choosePro')} disabled={!billingEnabled} onClick={()=>choosePlan('pro')}/>
    </div><p className="pricing-footnote">{t('pricing.footnote')}</p></section>
    <section className="pricing-faq"><p className="eyebrow">{t('pricing.faqEyebrow')}</p><h2>{t('pricing.faqTitle')}</h2><div><article><h3>{t('pricing.faqPayments')}</h3><p>{t('pricing.faqPaymentsBody')}</p></article><article><h3>{t('pricing.faqAccount')}</h3><p>{t('pricing.faqAccountBody')}</p></article><article><h3>{t('pricing.faqAi')}</h3><p>{t('pricing.faqAiBody')}</p></article></div></section>
  </>;
}

function PlanCard({name, price, cadence, description, features, action, highlighted = false, disabled = false, onClick}: {
  name: string; price: string; cadence: string; description: string; features: string[]; action: string; highlighted?: boolean; disabled?: boolean; onClick: () => void;
}) {
  const {t} = useI18n();
  return <article className={highlighted ? 'plan-card featured-plan' : 'plan-card'}>{highlighted&&<span className="plan-badge">{t('pricing.recommended')}</span>}<p className="plan-name">{name}</p><div className="plan-price">{price}</div><p className="plan-cadence">{cadence}</p><p className="plan-description">{description}</p><button className={highlighted?'action':'secondary action'} onClick={onClick} disabled={disabled}>{disabled&&name!=='Free'?t('pricing.soon'):action}{!disabled&&<span>→</span>}</button><div className="plan-divider"/><p className="included-label">{t('pricing.included')}</p><ul>{features.map(feature=><li key={feature}><span>✓</span>{feature}</li>)}</ul></article>;
}

function AIVerseMark() {
  return <svg className="aiverse-mark" viewBox="0 0 40 40" aria-hidden="true"><path d="M7 32 20 19 33 32M20 19V7"/><circle cx="7" cy="32" r="2.5"/><circle cx="33" cy="32" r="2.5"/><circle className="mark-core" cx="20" cy="19" r="3"/><circle cx="20" cy="7" r="2.5"/></svg>;
}

function ThemeControl({theme,dark,onToggle,onSelect,compact=false}: {theme:Theme;dark:boolean;onToggle:()=>void;onSelect:(theme:Theme)=>void;compact?:boolean}) {
  const {t} = useI18n();
  const [open,setOpen] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const mode = dark ? t('theme.modeDark') : t('theme.modeLight');
  const currentLabel = theme === 'system' ? t('theme.systemCurrent', {mode}) : t(`theme.${theme}`);
  const options: Array<{value:Theme;label:string}> = [{value:'system',label:t('theme.system')},{value:'light',label:t('theme.light')},{value:'dark',label:t('theme.dark')}];
  return <div className={`theme-control${compact?' is-compact':''}`} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setOpen(false)}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();setOpen(false);menuTrigger.current?.focus()}}}>
    <button type="button" className="theme-toggle" onClick={onToggle} aria-label={t('theme.switchTo', {mode: dark ? t('theme.modeLight') : t('theme.modeDark'), current: currentLabel})} aria-pressed={dark} title={t('theme.current', {current: currentLabel})}>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{dark?<><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></>:<path d="M20.1 15.1A8.5 8.5 0 0 1 8.9 3.9 8.5 8.5 0 1 0 20.1 15.1Z"/>}</svg>
      <span className="theme-current" aria-live="polite">{currentLabel}</span>
    </button>
    <button type="button" ref={menuTrigger} className="theme-menu-trigger" aria-label={t('theme.choose')} aria-expanded={open} aria-controls="theme-options" onClick={()=>setOpen(value=>!value)}>⌄</button>
    {open&&<div className="theme-menu" id="theme-options" role="group" aria-label={t('theme.menu')}>{options.map(option=><button type="button" key={option.value} aria-pressed={theme===option.value} onClick={()=>{onSelect(option.value);setOpen(false)}}><span>{option.label}{option.value==='system'&&theme==='system'?` · ${mode}`:''}</span>{theme===option.value&&<span aria-hidden="true">✓</span>}</button>)}</div>}
  </div>;
}

function LanguageControl({compact=false}: {compact?:boolean}) {
  const {lang,setLanguage,t} = useI18n();
  const [open,setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const options: Array<{value:Language;label:string}> = [{value:'es',label:t('language.spanish')},{value:'en',label:t('language.english')}];
  return <div className={`language-control${compact?' is-compact':''}`} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setOpen(false)}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();setOpen(false);trigger.current?.focus()}}}>
    <button type="button" ref={trigger} className="language-toggle" aria-label={t('language.choose')} aria-expanded={open} aria-controls="language-options" onClick={()=>setOpen(value=>!value)}>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>
      <span>{lang.toUpperCase()}</span><span className="language-caret" aria-hidden="true">⌄</span>
    </button>
    {open&&<div className="language-menu" id="language-options" role="group" aria-label={t('language.menu')}>{options.map(option=><button type="button" key={option.value} aria-pressed={lang===option.value} onClick={()=>{setLanguage(option.value);setOpen(false)}}><span>{option.label}</span><span>{option.value.toUpperCase()}{lang===option.value&&<span aria-hidden="true"> · ✓</span>}</span></button>)}</div>}
  </div>;
}

function SiteHeader({page,user,navigate,theme,dark,onThemeToggle,onThemeChange}: {page:Page;user:{username:string}|null;navigate:(page:RoutePage)=>void;theme:Theme;dark:boolean;onThemeToggle:()=>void;onThemeChange:(theme:Theme)=>void}) {
  const {t} = useI18n();
  const [menuOpen,setMenuOpen] = useState(false);
  useEffect(()=>setMenuOpen(false),[page]);
  const closeMenu = () => setMenuOpen(false);
  return <header className={`site-header${menuOpen?' is-menu-open':''}`}><button className="wordmark" onClick={()=>{closeMenu();navigate('home')}}><AIVerseMark/><span>A<span className="wordmark-i">I</span>Verse</span></button><button type="button" className="mobile-menu-toggle" aria-label={menuOpen?t('nav.closeMenu'):t('nav.openMenu')} aria-expanded={menuOpen} aria-controls="primary-navigation" onClick={()=>setMenuOpen(value=>!value)}><span aria-hidden="true">{menuOpen?'×':'☰'}</span></button><nav id="primary-navigation" aria-label={t('nav.label')}><button className={page==='home'?'active':''} onClick={()=>{closeMenu();navigate('home')}}>{t('nav.home')}</button><button className={page==='feed'?'active':''} onClick={()=>{closeMenu();navigate('feed')}}>{t('nav.community')}</button><button className={page==='docs'?'active':''} onClick={()=>{closeMenu();navigate('docs')}}>{t('nav.guides')}</button><button className={page==='pricing'?'active':''} onClick={()=>{closeMenu();navigate('pricing')}}>{t('nav.plans')}</button><button className="mobile-nav-action" onClick={()=>{closeMenu();navigate(user?'account':'login')}}>{user?t('nav.myAccount'):t('nav.login')}</button><button className="mobile-nav-action mobile-nav-primary" onClick={()=>{closeMenu();navigate(user?'workspace':'register')}}>{user?t('nav.openWorkspace'):t('nav.register')} →</button></nav><div className="site-header-actions"><LanguageControl compact/><ThemeControl theme={theme} dark={dark} onToggle={onThemeToggle} onSelect={onThemeChange} compact/>{user?<button className="account-link" onClick={()=>navigate('account')}>@{user.username}</button>:<button className="site-login" onClick={()=>navigate('login')}>{t('nav.login')}</button>}<button className="action site-cta" onClick={()=>navigate(user?'workspace':'register')}>{user?t('nav.openWorkspace'):t('nav.register')} <span>→</span></button></div></header>;
}

function SiteFooter({navigate}: {navigate: (page: RoutePage)=>void}) {
  const {t} = useI18n();
  return <footer className="site-footer"><div className="footer-main"><div className="footer-brand"><button className="wordmark" onClick={()=>navigate('home')}><AIVerseMark/><span>A<span className="wordmark-i">I</span>Verse</span></button><p>{t('footer.tagline')}</p></div><div className="footer-links"><div><b>{t('nav.community')}</b><button onClick={()=>navigate('feed')}>{t('footer.feed')}</button><button onClick={()=>navigate('docs')}>{t('footer.documentation')}</button></div><div><b>{t('footer.account')}</b><button onClick={()=>navigate('login')}>{t('nav.login')}</button><button onClick={()=>navigate('register')}>{t('nav.register')}</button><button onClick={()=>navigate('pricing')}>{t('nav.plans')}</button></div><div><b>{t('footer.information')}</b><button onClick={()=>navigate('legal')}>{t('footer.legal')}</button><button onClick={()=>navigate('terms')}>{t('footer.terms')}</button><button onClick={()=>navigate('privacy')}>{t('footer.privacy')}</button><button onClick={()=>navigate('cookies')}>{t('footer.cookies')}</button></div></div></div><div className="footer-bottom"><span>{t('footer.copyright')}</span><span>{t('footer.closing')}</span></div></footer>;
}

function DocumentationPage({navigate}: {navigate: (page: RoutePage)=>void}) {
  const {t} = useI18n();
  return <article className="docs-page"><aside className="docs-index"><p className="eyebrow">{t('docs.indexEyebrow')}</p><a href="#quickstart">{t('docs.quickstartNav')}</a><a href="#repositories">{t('docs.repositoriesNav')}</a><a href="#terminal-guide">{t('docs.terminalNav')}</a><a href="#ai-guide">{t('docs.aiNav')}</a><a href="#reviews">{t('docs.reviewsNav')}</a><a href="#privacy-guide">{t('docs.privacyNav')}</a><a href="#troubleshooting">{t('docs.troubleshootingNav')}</a></aside><div className="docs-content"><p className="eyebrow">{t('docs.eyebrow')}</p><h1>{t('docs.title')}</h1><p className="docs-lead">{t('docs.lead')}</p><div className="docs-callout"><b>{t('docs.startHere')}</b><p>{t('docs.startHereBody')}</p><button className="action" onClick={()=>navigate('workspace')}>{t('docs.openWorkspace')}</button></div>
    <section id="quickstart"><h2>{t('docs.quickstartTitle')}</h2><p>{t('docs.quickstartBody')}</p><ol><li>{t('docs.quickstart1')}</li><li>{t('docs.quickstart2')}</li><li>{t('docs.quickstart3')}</li><li>{t('docs.quickstart4')}</li><li>{t('docs.quickstart5')}</li></ol><pre><code>aiverse status<br/>aiverse add .<br/>aiverse commit -m "Agrega página de inicio"</code></pre></section>
    <section id="repositories"><h2>{t('docs.repositoriesTitle')}</h2><p>{t('docs.repositoriesBody')}</p><ul><li><b>{t('docs.publicLabel')}</b> {t('docs.publicBody')}</li><li><b>{t('docs.privateLabel')}</b> {t('docs.privateBody')}</li><li><b>{t('docs.descriptionLabel')}</b> {t('docs.descriptionBody')}</li><li><b>{t('docs.commitsLabel')}</b> {t('docs.commitsBody')}</li></ul><p>{t('docs.secretsWarning')}</p></section>
    <section id="terminal-guide"><h2>{t('docs.terminalTitle')}</h2><p>{t('docs.terminalBody')}</p><pre><code>aiverse init<br/>aiverse status<br/>aiverse add src/<br/>aiverse commit -m "Explica el cambio"<br/>aiverse log<br/>aiverse push https://tu-servidor</code></pre><p>{t('docs.cloneIntro')}</p><pre><code>aiverse clone https://tu-servidor ./mi-proyecto<br/>cd mi-proyecto<br/>aiverse status</code></pre><p>{t('docs.terminalTips')}</p></section>
    <section id="ai-guide"><h2>{t('docs.aiTitle')}</h2><p>{t('docs.aiIntro')}</p><ul><li><b>{t('docs.reviewChangesLabel')}</b> {t('docs.reviewChangesBody')}</li><li><b>{t('docs.explainCodeLabel')}</b> {t('docs.explainCodeBody')}</li><li><b>{t('docs.learnLabel')}</b> {t('docs.learnBody')}</li><li><b>{t('docs.commitsImproveLabel')}</b> {t('docs.commitsImproveBody')}</li><li><b>{t('docs.conflictsLabel')}</b> {t('docs.conflictsBody')}</li></ul><p>{t('docs.promptTips')}</p><div className="docs-callout"><b>{t('docs.protectTitle')}</b><p>{t('docs.protectBody')}</p></div></section>
    <section id="reviews"><h2>{t('docs.reviewsTitle')}</h2><p>{t('docs.reviewsIntro')}</p><ol><li>{t('docs.reviews1')}</li><li>{t('docs.reviews2')}</li><li>{t('docs.reviews3')}</li><li>{t('docs.reviews4')}</li><li>{t('docs.reviews5')}</li></ol><p>{t('docs.reviewsClosing')}</p></section>
    <section id="privacy-guide"><h2>{t('docs.privacyTitle')}</h2><ul><li>{t('docs.privacy1')}</li><li>{t('docs.privacy2')}</li><li>{t('docs.privacy3')}</li><li>{t('docs.privacy4')}</li><li>{t('docs.privacy5')}</li><li>{t('docs.privacy6')}</li></ul></section>
    <section id="troubleshooting"><h2>{t('docs.troubleshootingTitle')}</h2><h3>{t('docs.backendProblem')}</h3><p>{t('docs.backendFix')}</p><h3>{t('docs.sessionProblem')}</h3><p>{t('docs.sessionFix')}</p><h3>{t('docs.aiProblem')}</h3><p>{t('docs.aiFix')}</p><h3>{t('docs.postProblem')}</h3><p>{t('docs.postFix')}</p><p className="docs-updated">{t('docs.updated')}</p></section></div></article>;
}

function LegalPage({kind}: {kind: 'terms'|'privacy'|'legal'|'cookies'}) {
  const {t,formatDate} = useI18n();
  if (kind === 'legal') return <article className="legal-page"><p className="eyebrow">{t('legal.eyebrow')}</p><h1>{t('footer.legal')}</h1><p className="legal-updated">{t('legal.serviceBeta')}</p><p>{t('legal.serviceIntro')}</p><h2>{t('legal.operator')}</h2><div className="legal-beta-note"><b>{t('legal.pendingInfo')}</b> {t('legal.pendingBody')}</div><ul><li>{t('legal.owner')}</li><li>{t('legal.address')}</li><li>{t('legal.email')}</li></ul><h2>{t('legal.ip')}</h2><p>{t('legal.ipBody')}{' '}<a href="/terms">{t('footer.terms')}</a> {t('legal.andThe')} <a href="/privacy">{t('footer.privacy')}</a>.</p><h2>{t('legal.availability')}</h2><p>{t('legal.availabilityBody')}</p><p className="docs-updated">{t('legal.draft')}</p></article>;
  if (kind === 'cookies') return <article className="legal-page"><p className="eyebrow">{t('legal.eyebrow')}</p><h1>{t('footer.cookies')}</h1><p className="legal-updated">{t('legal.updated', {date:formatDate('2026-11-14T12:00:00Z', {dateStyle:'long'})})}</p><p>{t('legal.cookiesIntro')}</p><h2>{t('legal.requiredCookies')}</h2><ul><li><b>aiverse_session:</b> {t('legal.sessionCookie')}</li><li><b>aiverse_csrf:</b> {t('legal.csrfCookie')}</li></ul><h2>{t('legal.browserPrefs')}</h2><p>{t('legal.browserPrefsBody')}</p><h2>{t('legal.control')}</h2><p>{t('legal.controlBody')}</p><div className="legal-beta-note"><b>{t('legal.betaNote')}</b> {t('legal.cookiesBetaBody')}</div></article>;
  const privacy = kind === 'privacy';
  return <article className="legal-page"><p className="eyebrow">{t('legal.eyebrow')}</p><h1>{privacy?t('footer.privacy'):t('footer.terms')}</h1><p className="legal-updated">{t('legal.updated', {date:formatDate('2026-11-14T12:00:00Z', {dateStyle:'long'})})}</p>{privacy?<>
    <p>{t('legal.privacyIntro')}{' '}<a href="/aviso-legal">{t('footer.legal')}</a>.</p>
    <h2>{t('legal.data')}</h2><ul><li>{t('legal.accountData')}</li><li>{t('legal.usageData')}</li><li>{t('legal.codeData')}</li><li>{t('legal.technicalData')}</li></ul>
    <h2>{t('legal.aiReviews')}</h2><p>{t('legal.aiReviewsBody')}</p>
    <h2>{t('legal.cookiesPrefs')}</h2><p>{t('legal.cookiesPrefsBody')}{' '}<a href="/cookies">{t('footer.cookies')}</a>.</p>
    <h2>{t('legal.visibility')}</h2><p>{t('legal.visibilityBody')}</p>
    <h2>{t('legal.requests')}</h2><p>{t('legal.requestsBody')}</p>
    <h2>{t('legal.thirdParties')}</h2><p>{t('legal.thirdPartiesBody')}</p>
  </>:<>
    <p>{t('legal.termsIntro')}</p>
    <h2>{t('account.title')}</h2><p>{t('legal.yourAccountBody')}</p>
    <h2>{t('legal.yourCode')}</h2><p>{t('legal.yourCodeBody')}</p>
    <h2>{t('legal.acceptableUse')}</h2><p>{t('legal.acceptableUseBody')}</p>
    <h2>{t('legal.billing')}</h2><p>{t('legal.billingStart')}{' '}<a href="/pricing">{t('nav.plans')}</a>{t('legal.billingBody')}</p>
    <h2>{t('legal.betaAvailability')}</h2><p>{t('legal.betaAvailabilityBody')}</p>
    <h2>{t('legal.termination')}</h2><p>{t('legal.terminationBody')}</p>
    <h2>{t('legal.changes')}</h2><p>{t('legal.changesBody')}</p>
  </>}<div className="legal-beta-note"><b>{t('legal.betaNote')}</b> {t('legal.betaClosing')}</div></article>;
}
