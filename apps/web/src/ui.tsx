import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {FormEvent} from 'react';
import {useI18n} from './i18n';
import type {Language, MessageKey, TranslationValues} from './i18n';

type Commit = {hash: string; commit: {message: string; date: string; parents: string[]}};
type Entry = {path: string; hash: string};
type Status = {branch: string; staged: Entry[]; untracked: string[]; modified: string[]};
type Change = {path: string; status: 'modified' | 'deleted' | 'untracked'; oldText: string; newText: string; lines: string[]};
type AITask = {id: string; kind: string; state: 'pending' | 'processing' | 'ready' | 'error'; result?: string; error?: string; attempts: number};
type Health = {ok: boolean; root?: string; provider: string; sharedRepositoryApiEnabled: boolean; userRepositoriesEnabled?: boolean};
type AccountUser = {id: string; username: string; display_name: string; email: string; plan?: string; repositoryCount?: number};
type UserRepository = {id: string; name: string; description: string; isPublic: boolean; stars_count: number; created_at?: string};

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

async function postNoContent(route: string, t: Translator): Promise<void> {
  const {csrfToken} = await getJSON<{csrfToken: string}>('/api/auth/csrf', t);
  let response: Response;
  try { response = await fetch(api + route, {method: 'POST', credentials: 'include', headers: {'X-CSRF-Token': csrfToken}}); }
  catch { throw new Error(t('error.backendConnection')); }
  if (response.ok) return;
  const result = await response.json().catch(() => ({error: response.statusText})) as {error?: string};
  throw new Error(result.error ?? response.statusText);
}

function passwordMeetsPolicy(value: string): boolean {
  return value.length >= 12 && value.length <= 128 && /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value) && /[^A-Za-z0-9\s]/.test(value) && !/(password|contraseña)/i.test(value);
}

function emailMeetsPolicy(value: string): boolean {
  const email = value.trim().toLowerCase();
  const emailPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
  const localPart = email.split('@')[0] ?? '';
  return email.length <= 254 && emailPattern.test(email) && !localPart.startsWith('.') && !localPart.endsWith('.') && !localPart.includes('..');
}

export default function App() {
  const {lang, setLanguage, t, formatDate, formatNumber, formatPrice} = useI18n();
  const [page, setCurrentPage] = useState<Page>(pageFromLocation);
  const [feed, setFeed] = useState<Array<{id:string;name:string;description:string;stars_count:number;username:string;created_at?:string}>>([]);
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedError, setFeedError] = useState('');
  const [postsLoading, setPostsLoading] = useState(true);
  const [postsError, setPostsError] = useState('');
  const [user, setUser] = useState<AccountUser|null>(null);
  const [formError, setFormError] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [registrationReady, setRegistrationReady] = useState(false);
  const [accountActionError, setAccountActionError] = useState('');
  const [accountActionLoading, setAccountActionLoading] = useState(false);
  const [cliTokenEnabled, setCliTokenEnabled] = useState(false);
  const [cliTokenCreatedAt, setCliTokenCreatedAt] = useState('');
  const [cliTokenValue, setCliTokenValue] = useState('');
  const [cliTokenCopied, setCliTokenCopied] = useState(false);
  const [cliTokenError, setCliTokenError] = useState('');
  const [cliTokenLoading, setCliTokenLoading] = useState(false);
  const [passwordValue, setPasswordValue] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [log, setLog] = useState<Commit[]>([]);
  const [files, setFiles] = useState<Entry[]>([]);
  const [userRepositories, setUserRepositories] = useState<UserRepository[]>([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState('');
  const [repositoryCreateOpen, setRepositoryCreateOpen] = useState(false);
  const [repositoryCreateName, setRepositoryCreateName] = useState('');
  const [repositoryCreatePublic, setRepositoryCreatePublic] = useState(false);
  const [repositoryCreateError, setRepositoryCreateError] = useState('');
  const [repositoryCreateLoading, setRepositoryCreateLoading] = useState(false);
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
  const [publicRepository, setPublicRepository] = useState<typeof feed[number]|null>(null);
  const [publicRepositoryFiles, setPublicRepositoryFiles] = useState<Entry[]>([]);
  const [publicRepositoryLog, setPublicRepositoryLog] = useState<Commit[]>([]);
  const [publicRepositoryPath, setPublicRepositoryPath] = useState('');
  const [publicRepositoryContent, setPublicRepositoryContent] = useState('');
  const [publicRepositoryLoading, setPublicRepositoryLoading] = useState(false);
  const [publicRepositoryError, setPublicRepositoryError] = useState('');
  const [cloneCommandCopied, setCloneCommandCopied] = useState('');
  const [communityPosts, setCommunityPosts] = useState<Array<{id:string;text:string;created_at:string;username:string;display_name:string}>>([]);
  const [postText, setPostText] = useState('');
  const [postError, setPostError] = useState('');
  const [postSubmitting, setPostSubmitting] = useState(false);
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [buckets, setBuckets] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  const repositoryAccessDisabled = !import.meta.env.DEV && health !== null && !health.userRepositoriesEnabled;
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
    if (themeColor) themeColor.content = dark ? '#111315' : '#f5f6f7';
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

  const refresh = useCallback(async () => {
    try {
      const nextHealth = await getJSON<Health>('/api/health', t);
      setHealth(nextHealth);
      let repositoryBase = '/api/repo';
      if (!import.meta.env.DEV) {
        if (!nextHealth.userRepositoriesEnabled) {
          setError(t('workspace.repositoryStorageUnavailable'));
          return;
        }
        if (!user) { setUserRepositories([]); setError(''); return; }
        const result = await getJSON<{repositories: UserRepository[]}>('/api/repositories', t);
        setUserRepositories(result.repositories);
        const repositoryId = result.repositories.find(item => item.id === selectedRepositoryId)?.id ?? result.repositories[0]?.id ?? '';
        if (repositoryId !== selectedRepositoryId) setSelectedRepositoryId(repositoryId);
        if (!repositoryId) {
          setLog([]); setFiles([]); setStatus({branch:'main',staged:[],untracked:[],modified:[]});
          setBranches([]); setChanges([]); setBuckets([]); setSelected(''); setContent(''); setError('');
          return;
        }
        repositoryBase = `/api/repositories/${encodeURIComponent(repositoryId)}/workspace`;
      } else if (!nextHealth.sharedRepositoryApiEnabled) {
        setError(t('error.publicRepository'));
        return;
      }
      const [nextLog, nextFiles, nextStatus, nextBranches, nextChanges, structures] = await Promise.all([
        getJSON<Commit[]>(`${repositoryBase}/log`, t), getJSON<Entry[]>(`${repositoryBase}/tree`, t), getJSON<Status>(`${repositoryBase}/status`, t),
        getJSON<string[]>(`${repositoryBase}/branches`, t), getJSON<Change[]>(`${repositoryBase}/diff`, t),
        getJSON<{objectBuckets: number[]}>(`${repositoryBase}/structures`, t),
      ]);
      setLog(nextLog); setFiles(nextFiles); setStatus(nextStatus); setBranches(nextBranches);
      setChanges(nextChanges); setBuckets(structures.objectBuckets); setError('');
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally { setLoading(false); }
  }, [user, selectedRepositoryId, t]);

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
    if (page !== 'account' || !user) return;
    void getJSON<{enabled:boolean;createdAt?:string|null}>('/api/auth/cli-token', t)
      .then(result => { setCliTokenEnabled(result.enabled); setCliTokenCreatedAt(result.createdAt ?? ''); setCliTokenError(''); })
      .catch(cause => setCliTokenError(cause instanceof Error ? cause.message : String(cause)));
  }, [page, user, t]);

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
    if (authChecked && (page === 'settings' || page === 'account' || page === 'workspace') && !user && !import.meta.env.DEV) setPage('login');
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
  const selectedUserRepository = useMemo(() => userRepositories.find(item => item.id === selectedRepositoryId) ?? null, [userRepositories, selectedRepositoryId]);
  const selectedRemoteUrl = selectedRepositoryId ? `${api || window.location.origin}/api/repositories/${encodeURIComponent(selectedRepositoryId)}` : '';
  const workspaceHasNoRepository = !import.meta.env.DEV && !repositoryAccessDisabled && !loading && userRepositories.length === 0;
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

  const viewPublicRepository = async (item: typeof feed[number]) => {
    setPublicRepository(item); setPublicRepositoryFiles([]); setPublicRepositoryLog([]);
    setPublicRepositoryPath(''); setPublicRepositoryContent(''); setPublicRepositoryError(''); setPublicRepositoryLoading(true);
    try {
      const base = `/api/repositories/${encodeURIComponent(item.id)}/workspace`;
      const [nextFiles, nextLog] = await Promise.all([
        getJSON<Entry[]>(`${base}/tree`, t), getJSON<Commit[]>(`${base}/log`, t),
      ]);
      setPublicRepositoryFiles(nextFiles); setPublicRepositoryLog(nextLog);
      if (nextFiles[0]) {
        const result = await getJSON<{content:string}>(`${base}/file?path=${encodeURIComponent(nextFiles[0].path)}`, t);
        setPublicRepositoryPath(nextFiles[0].path); setPublicRepositoryContent(result.content);
      }
    } catch (cause) { setPublicRepositoryError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPublicRepositoryLoading(false); }
  };

  const viewPublicFile = async (filePath: string) => {
    if (!publicRepository) return;
    setPublicRepositoryPath(filePath); setPublicRepositoryContent(''); setPublicRepositoryError(''); setPublicRepositoryLoading(true);
    try {
      const result = await getJSON<{content:string}>(`/api/repositories/${encodeURIComponent(publicRepository.id)}/workspace/file?path=${encodeURIComponent(filePath)}`, t);
      setPublicRepositoryContent(result.content);
    } catch (cause) { setPublicRepositoryError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPublicRepositoryLoading(false); }
  };

  const copyCloneCommand = async (item: typeof feed[number]) => {
    const remote = `${api || window.location.origin}/api/repositories/${encodeURIComponent(item.id)}`;
    const command = `aiverse clone ${remote} ./${item.name}`;
    try { await navigator.clipboard.writeText(command); setCloneCommandCopied(item.id); }
    catch { setFeedError(t('feed.cloneCopyError')); }
  };

  const startCheckout = async (plan: 'starter'|'plus'|'pro') => {
    try { const result = await postJSON<{url:string}>('/api/billing/checkout', {plan}, t); window.location.assign(result.url); }
    catch (cause) { setFormError(cause instanceof Error ? cause.message : String(cause)); }
  };

  useEffect(() => {
    if (!selected || selectedChange || (!import.meta.env.DEV && !selectedRepositoryId)) { setContent(''); return; }
    const repositoryBase = import.meta.env.DEV ? '/api/repo' : `/api/repositories/${encodeURIComponent(selectedRepositoryId)}/workspace`;
    void getJSON<{content: string}>(`${repositoryBase}/file?path=${encodeURIComponent(selected)}`, t)
      .then(result => setContent(result.content)).catch(fetchError => setContent(String(fetchError)));
  }, [selected, selectedChange, selectedRepositoryId, t]);

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
      if (!import.meta.env.DEV && !selectedRepositoryId) throw new Error(t('workspace.noRepository'));
      const repositoryBase = import.meta.env.DEV ? '/api/repo' : `/api/repositories/${encodeURIComponent(selectedRepositoryId)}/workspace`;
      let result: unknown;
      if (command === 'status') result = await getJSON(`${repositoryBase}/status`, t);
      else if (command === 'log') result = await getJSON(`${repositoryBase}/log`, t);
      else if (command === 'add') result = await postJSON(`${repositoryBase}/add`, {paths: args.length ? args : ['.']}, t);
      else if (command === 'commit') result = await postJSON(`${repositoryBase}/commit`, {message: args[0] === '-m' ? args.slice(1).join(' ') : args.join(' ')}, t);
      else if (command === 'branch') result = await postJSON(`${repositoryBase}/branch`, {name: args[0]}, t);
      else if (command === 'checkout') result = await postJSON(`${repositoryBase}/checkout`, {name: args[0]}, t);
      else if (command === 'merge') result = await postJSON(`${repositoryBase}/merge`, {name: args[0]}, t);
      else if (command === 'stash') result = await postJSON(`${repositoryBase}/stash`, {action: args[0] ?? 'push'}, t);
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

  const updateRegistrationValidity = (form: HTMLFormElement) => {
    const requiredInputs = Array.from(form.querySelectorAll<HTMLInputElement>('input[required]'));
    const password = form.querySelector<HTMLInputElement>('input[name="password"]')?.value ?? '';
    const confirmation = form.querySelector<HTMLInputElement>('input[name="confirmPassword"]')?.value ?? '';
    const displayName = form.querySelector<HTMLInputElement>('input[name="displayName"]')?.value ?? '';
    const email = form.querySelector<HTMLInputElement>('input[name="email"]')?.value ?? '';
    setRegistrationReady(requiredInputs.every(input => input.validity.valid) && displayName.trim().length > 0 && emailMeetsPolicy(email) && passwordMeetsPolicy(password) && password === confirmation);
  };

  const createRepository = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (repositoryCreateLoading) return;
    setRepositoryCreateError('');
    setRepositoryCreateLoading(true);
    try {
      const result = await postJSON<{repository: {id: string}}>('/api/repositories', {
        name: repositoryCreateName.trim(), description: '', isPublic: repositoryCreatePublic,
      }, t);
      setSelectedRepositoryId(result.repository.id);
      setRepositoryCreateOpen(false);
      setRepositoryCreateName('');
      setRepositoryCreatePublic(false);
    } catch (cause) {
      setRepositoryCreateError(cause instanceof Error ? cause.message : String(cause));
    } finally { setRepositoryCreateLoading(false); }
  };

  const signOut = async () => {
    if (accountActionLoading) return;
    setAccountActionLoading(true);
    setAccountActionError('');
    try {
      await postNoContent('/api/auth/logout', t);
      setUser(null);
      setCliTokenValue(''); setCliTokenEnabled(false); setCliTokenCreatedAt('');
      setAuthChecked(true);
      setPage('home');
    } catch (cause) {
      setAccountActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAccountActionLoading(false);
    }
  };

  const createCliToken = async () => {
    if (cliTokenLoading) return;
    setCliTokenLoading(true); setCliTokenError(''); setCliTokenValue(''); setCliTokenCopied(false);
    try {
      const result = await postJSON<{token:string;createdAt:string}>('/api/auth/cli-token', {}, t);
      setCliTokenValue(result.token); setCliTokenCreatedAt(result.createdAt); setCliTokenEnabled(true);
    } catch (cause) { setCliTokenError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setCliTokenLoading(false); }
  };

  const revokeCliToken = async () => {
    if (cliTokenLoading) return;
    setCliTokenLoading(true); setCliTokenError('');
    try {
      await postNoContent('/api/auth/cli-token/revoke', t);
      setCliTokenEnabled(false); setCliTokenCreatedAt(''); setCliTokenValue(''); setCliTokenCopied(false);
    } catch (cause) { setCliTokenError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setCliTokenLoading(false); }
  };

  const copyCliToken = async () => {
    if (!cliTokenValue) return;
    try { await navigator.clipboard.writeText(cliTokenValue); setCliTokenCopied(true); setCliTokenError(''); }
    catch { setCliTokenError(t('account.cliTokenCopyError')); }
  };

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (authSubmitting) return;
    setFormError('');
    const data = new FormData(event.currentTarget);
    const password = String(data.get('password') ?? '');
    const email = String(data.get('email') ?? '').trim();
    if (page === 'register') {
      const policyOk = passwordMeetsPolicy(password);
      if (!policyOk) { setFormError(t('error.passwordRequirements')); return; }
      if (data.get('confirmPassword') !== password) { setFormError(t('error.passwordMismatch')); return; }
      if (!emailMeetsPolicy(email)) { setFormError(t('error.emailInvalid')); return; }
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
  const accountPlan = user?.plan ?? 'free';
  const accountPlanName = accountPlan.charAt(0).toUpperCase() + accountPlan.slice(1);
  const accountRepositoryLimit = accountPlan === 'pro' ? null : accountPlan === 'plus' ? 20 : accountPlan === 'starter' ? 10 : 3;
  const accountRepositoryCount = Math.max(0, user?.repositoryCount ?? 0);
  const currentThemeLabel = theme === 'system'
    ? t('theme.systemCurrent', {mode:systemDark ? t('theme.modeDark') : t('theme.modeLight')})
    : t(theme === 'dark' ? 'theme.dark' : 'theme.light');

  if (page === 'notFound') return <main className={dark?'app marketing-app dark':'app marketing-app'}><SiteHeader page={page} user={user} navigate={setPage} theme={theme} dark={dark} onThemeChange={updateTheme}/><section className="not-found-page"><p className="eyebrow">{t('error.notFoundEyebrow')}</p><span className="not-found-code" aria-hidden="true">404</span><h1>{t('error.notFoundTitle')}</h1><p>{t('error.notFoundBody')}</p><button className="action" onClick={()=>setPage('home')}>{t('common.backHome')}{' '}<span>→</span></button></section><SiteFooter navigate={setPage}/></main>;

  if (page === 'feed') return <main className={dark?'app marketing-app dark':'app marketing-app'}>
    <SiteHeader page={page} user={user} navigate={setPage} theme={theme} dark={dark} onThemeChange={updateTheme}/>
    <section className="explore-hero"><p className="eyebrow">{t('feed.eyebrow')}</p><h1>{t('feed.titleFirst')}<br/><span>{t('feed.titleSecond')}</span></h1><p>{t('feed.intro')}</p><div className="explore-search"><span>⌕</span><input value={feedSearch} onChange={event=>setFeedSearch(event.target.value)} placeholder={t('feed.searchPlaceholder')} aria-label={t('feed.searchLabel')}/><button onClick={()=>setFeedSearch('')} disabled={!feedSearch}>{t('common.clear')}</button></div><div className="explore-metrics" aria-live="polite"><span><b>{feedLoading?'…':formatNumber(feed.length)}</b> {t('feed.publicRepositories')}</span><span><b>{feedLoading?'…':formatNumber(new Set(feed.map(item=>item.username)).size)}</b> {t('feed.developers')}</span><span>{t('feed.updated')}</span></div></section>
    <section className="explore-content"><div className="community-layout"><div><div className="community-composer"><p className="eyebrow">{t('feed.shareEyebrow')}</p><h2>{t('feed.composerTitle')}</h2>{user?<form onSubmit={event=>void publishPost(event)}><textarea maxLength={1200} value={postText} onChange={event=>setPostText(event.target.value)} placeholder={t('feed.composerPlaceholder')}/><div><small>{formatNumber(postText.length)}/1.200</small><button className="action" disabled={postSubmitting||!postText.trim()}>{postSubmitting?t('feed.publishing'):t('feed.publish')}</button></div>{postError&&<p className="form-error" role="alert">{postError}</p>}</form>:<><p>{t('feed.loginToPost')}</p><button className="action" onClick={()=>setPage('login')}>{t('feed.loginAction')}</button></>}</div><div className="community-posts"><p className="eyebrow">{t('feed.recentEyebrow')}</p>{postsLoading?<div className="feed-skeleton" role="status" aria-label={t('feed.loadingPosts')}><i/><i/><i/></div>:postsError?<div className="feed-error" role="alert"><p>{t('feed.postsError', {error:postsError})}</p><button onClick={()=>void loadPosts()}>{t('common.retry')}</button></div>:communityPosts.length?communityPosts.map(post=><article className="community-post" key={post.id}><div className="post-avatar">{post.display_name?.[0]?.toUpperCase()||'A'}</div><div><strong>{post.display_name||post.username}</strong><small>@{post.username} · {formatDate(post.created_at, {dateStyle:'medium',timeStyle:'short'})}</small><p>{post.text}</p></div></article>):<div className="explore-empty"><h3>{t('feed.startConversation')}</h3><p>{t('feed.firstPostHint')}</p></div>}</div></div><div><div className="explore-heading"><div><p className="eyebrow">{t('feed.directory')}</p><h2>{t('feed.projectsTitle')}</h2><p>{t('feed.repositoriesHint')}</p></div><label className="sort-select">{t('feed.sort')}<select value={feedSort} onChange={event=>setFeedSort(event.target.value as 'popular'|'recent')}><option value="popular">{t('feed.popular')}</option><option value="recent">{t('feed.recent')}</option></select></label></div>
      <div className="explore-tags"><span>{t('feed.trySearch')}</span>{['api','web','ia','typescript','open source'].map(term=><button key={term} onClick={()=>setFeedSearch(term)}>{term}</button>)}</div>
      {feedLoading?<div className="explore-loading" role="status"><span className="loading-spinner" aria-hidden="true"/><p>{t('feed.loadingProjects')}</p><div className="feed-skeleton"><i/><i/><i/></div></div>:feedError?<div className="feed-error" role="alert"><p>{t('feed.projectsError', {error:feedError})}</p><button onClick={()=>void loadFeed()}>{t('common.retry')}</button></div>:filteredFeed.length>0?<div className="repo-grid explore-repos">{filteredFeed.map(item=><article className="repo-card explore-repo" key={item.id}><div className="explore-repo-title"><span className="repo-mark">◈</span><div><small>{item.username}</small><b>{item.username}/{item.name}</b></div><span className="repo-public">{t('feed.public')}</span></div><p>{item.description||t('feed.sharedRepository')}</p><div className="repo-meta"><span>☆ {formatNumber(item.stars_count)} {t('feed.stars')}</span><span>{item.created_at?formatDate(item.created_at, {dateStyle:'medium'}):t('feed.projectLabel')}</span></div><div className="repo-card-actions"><button onClick={()=>publicRepository?.id===item.id?setPublicRepository(null):void viewPublicRepository(item)}>{publicRepository?.id===item.id?t('feed.closeRepository'):t('feed.viewRepository')}</button><button onClick={()=>void copyCloneCommand(item)}>{cloneCommandCopied===item.id?t('feed.cloneCopied'):t('feed.copyCloneCommand')}</button></div></article>)}</div>
      :<div className="explore-empty"><span>⌕</span><h3>{feed.length?t('feed.noResults'):t('feed.communityStarting')}</h3><p>{feed.length?t('feed.tryAnotherSearch'):t('feed.emptyHint')}</p>{feedSearch?<button className="secondary action" onClick={()=>setFeedSearch('')}>{t('feed.clearSearch')}</button>:<button className="action" onClick={()=>setPage(user?'workspace':'register')}>{t('feed.createFirst')}</button>}</div>}
    </div></div>{publicRepository&&<section className="public-repository-viewer"><header><div><p className="eyebrow">{t('feed.publicReadOnly')}</p><h2>{publicRepository.username}/{publicRepository.name}</h2><p>{publicRepository.description}</p></div><button className="secondary action" onClick={()=>setPublicRepository(null)}>{t('feed.closeRepository')}</button></header><div className="public-repository-columns"><aside><h3>{t('feed.files')}</h3>{publicRepositoryLoading&&!publicRepositoryFiles.length?<p>{t('feed.loadingFiles')}</p>:publicRepositoryFiles.length?publicRepositoryFiles.map(file=><button className={publicRepositoryPath===file.path?'active':''} key={file.path} onClick={()=>void viewPublicFile(file.path)}>{file.path}</button>):<p>{t('feed.noFiles')}</p>}</aside><div className="public-repository-file"><div className="public-repository-file-head"><b>{publicRepositoryPath||t('feed.selectFile')}</b><span>{publicRepositoryLoading?t('feed.loadingFiles'):''}</span></div>{publicRepositoryError?<p className="form-error" role="alert">{publicRepositoryError}</p>:publicRepositoryPath?<pre>{publicRepositoryContent}</pre>:<p>{t('feed.selectFile')}</p>}</div></div><div className="public-repository-history"><h3>{t('feed.commitHistory')}</h3>{publicRepositoryLog.length?publicRepositoryLog.slice(0,8).map(item=><p key={item.hash}><code>{item.hash.slice(0,8)}</code> {item.commit.message}<small>{formatDate(item.commit.date,{dateStyle:'medium',timeStyle:'short'})}</small></p>):<p>{t('feed.noFiles')}</p>}</div><div className="public-repository-clone"><span>{t('feed.publicReadOnly')}</span><button className="action" onClick={()=>void copyCloneCommand(publicRepository)}>{cloneCommandCopied===publicRepository.id?t('feed.cloneCopied'):t('feed.copyCloneCommand')}</button></div></section>}</section><section className="explore-invite"><div><p className="eyebrow">{t('feed.inviteEyebrow')}</p><h2>{t('feed.inviteTitle')}</h2><p>{t('feed.inviteBody')}</p></div><button className="action" onClick={()=>setPage(user?'workspace':'register')}>{t('feed.startBuilding')}{' '}<span>→</span></button></section>
    <SiteFooter navigate={setPage}/>
  </main>;

  if (page === 'login' || page === 'register') return <main className={dark?'auth-page dark':'auth-page'}>
    <div className="auth-aside"><button className="wordmark" onClick={()=>setPage('home')}><AIVerseMark/><span>A<span className="wordmark-i">I</span>Verse</span></button><div><p className="eyebrow">{t('auth.brandEyebrow')}</p><h2>{t('auth.brandTitle')}</h2><p>{t('footer.tagline')}</p></div><span>{t('auth.brandFooter')}</span></div>
    <section className="auth-card"><button className="auth-back" onClick={()=>setPage('home')}>← {t('common.backHome')}</button><p className="eyebrow">{page==='login'?t('auth.welcomeEyebrow'):t('auth.registerEyebrow')}</p><h1>{page==='login'?t('auth.loginTitle'):t('auth.registerTitle')}</h1><p className="auth-intro">{page==='login'?t('auth.loginIntro'):t('auth.registerIntro')}</p>
      <form onSubmit={event=>void submitAuth(event)} onInput={event=>{if(page==='register')updateRegistrationValidity(event.currentTarget)}} noValidate={false}>
        {page==='register'&&<><label>{t('auth.username')}<input name="username" placeholder={t('auth.usernamePlaceholder')} required minLength={1} maxLength={39} autoComplete="username" pattern="[A-Za-z0-9](?:[A-Za-z0-9\-]{0,37}[A-Za-z0-9])?"/><small>{t('auth.usernameHint')}</small></label><label>{t('auth.displayName')}<input name="displayName" placeholder={t('auth.displayNamePlaceholder')} required maxLength={80} autoComplete="name"/></label></>}
        <label>{t('auth.email')}<input name="email" type="email" inputMode="email" placeholder={t('auth.emailPlaceholder')} required maxLength={254} autoComplete="email"/></label>
        <label>{t('auth.password')}<div className="password-field"><input name="password" type={showPassword?'text':'password'} placeholder={page==='register'?t('auth.passwordCreatePlaceholder'):t('auth.passwordPlaceholder')} required minLength={page==='register'?12:1} maxLength={page==='register'?128:256} autoComplete={page==='register'?'new-password':'current-password'} value={page==='register'?passwordValue:undefined} onChange={event=>{if(page==='register')setPasswordValue(event.target.value)}}/><button type="button" className="password-toggle" onClick={()=>setShowPassword(!showPassword)} aria-label={showPassword?t('auth.hidePassword'):t('auth.showPassword')}>{showPassword?t('auth.hidePassword'):t('auth.showPassword')}</button></div></label>
        {page==='register'&&<><ul className="password-checks" aria-label={t('auth.passwordRequirements')}>{passwordChecks.map(check=><li key={check.label} className={check.valid?'passed':''}><span aria-hidden="true">{check.valid?'✓':'○'}</span>{check.label}</li>)}</ul><label>{t('auth.confirmPassword')}<input name="confirmPassword" type={showPassword?'text':'password'} placeholder={t('auth.confirmPlaceholder')} required minLength={12} maxLength={128} autoComplete="new-password"/></label><p className="password-match" aria-live="polite">{passwordValue&&passwordValid?t('auth.passwordStrong'):t('auth.passwordUse')}</p></>}
        {formError&&<p className="form-error" role="alert">{formError}</p>}
        <button className="action auth-submit" disabled={authSubmitting || (page==='register'&&!registrationReady)}>{authSubmitting?t('auth.connecting'):page==='login'?t('nav.login'):t('auth.createFree')}{!authSubmitting&&<span>→</span>}</button>
      </form>
      <p className="auth-switch">{page==='login'?t('auth.firstTime'):t('auth.alreadyHaveAccount')} <button className="inline-button" onClick={()=>{setFormError('');setPasswordValue('');setRegistrationReady(false);setPage(page==='login'?'register':'login')}}>{page==='login'?t('auth.registerTitle'):t('auth.switchLogin')}</button></p><p className="auth-legal">{t('auth.legalIntro')}{' '}<button onClick={()=>setPage('terms')}>{t('footer.terms')}</button> {t('auth.and')}{' '}<button onClick={()=>setPage('privacy')}>{t('footer.privacy')}</button>.</p>
    </section></main>;

  if (page === 'home' || page === 'account' || page === 'settings' || page === 'prs' || page === 'docs' || page === 'pricing' || page === 'terms' || page === 'privacy' || page === 'legal' || page === 'cookies') return <main className={dark?'app marketing-app dark':'app marketing-app'}><SiteHeader page={page} user={user} navigate={setPage} theme={theme} dark={dark} onThemeChange={updateTheme}/>
    {page==='settings'?<section className="product-page settings-page">
      <div className="settings-page-heading"><div><p className="eyebrow">{t('settings.eyebrow')}</p><h1>{t('settings.title')}</h1><p>{t('settings.intro')}</p></div><button className="secondary action" onClick={()=>setPage('account')}>{t('settings.backAccount')}</button></div>
      <div className="settings-layout">
        <div className="settings-card settings-preferences-card">
          <div className="settings-section-heading"><span aria-hidden="true">◉</span><div><h2>{t('settings.appearanceTitle')}</h2><p>{t('settings.appearanceBody')}</p></div></div>
          <label>{t('language.menu')}<select value={lang} onChange={event=>setLanguage(event.target.value as Language)}><option value="es">{t('language.spanish')}</option><option value="en">{t('language.english')}</option></select></label>
          <label>{t('settings.theme')}<select value={theme} onChange={event=>updateTheme(event.target.value as Theme)}><option value="system">{t('settings.followSystem')}</option><option value="light">{t('theme.light')}</option><option value="dark">{t('theme.dark')}</option></select></label>
          <div className="system-theme-note" role="status"><span>{t('settings.systemNow')}</span><b>{systemDark?t('theme.modeDark'):t('theme.modeLight')}</b><p>{theme==='system'?t('settings.systemFollow'):t('settings.manualTheme')}</p></div>
        </div>
        <aside className="settings-side">
          <section className="settings-summary-card"><p className="eyebrow">{t('settings.previewEyebrow')}</p><h2>{currentThemeLabel}</h2><p>{t('settings.previewBody')}</p><span className={`settings-preview-swatch${dark?' is-dark':''}`} aria-hidden="true"><i/><i/><i/></span></section>
          <section className="settings-summary-card"><p className="eyebrow">{t('account.profileDetails')}</p><h2>{user?.display_name??t('account.title')}</h2><p>@{user?.username} · {user?.email}</p><button className="secondary action" onClick={()=>setPage('account')}>{t('account.title')}</button></section>
        </aside>
      </div>
    </section>
    :page==='account'?<section className="product-page account-panel">
      <div className="account-page-heading"><div><p className="eyebrow">{t('account.eyebrow')}</p><h1>{t('account.title')}</h1><p>{t('account.intro')}</p></div><button className="action account-open-workspace" onClick={()=>setPage('workspace')}>{t('nav.openWorkspace')}</button></div>
      <div className="account-layout">
        <section className="account-card account-profile-card">
          <div className="account-profile-top"><span className="avatar">{user?.display_name?.[0]?.toUpperCase()??'A'}</span><div><span className="account-status"><i/>{t('account.active')}</span><h2>{user?.display_name??t('account.title')}</h2><p>@{user?.username}</p></div></div>
          <div className="account-section-heading"><div><h3>{t('account.profileDetails')}</h3><p>{t('account.profileDetailsHint')}</p></div></div>
          <dl className="account-details"><div><dt>{t('account.displayName')}</dt><dd>{user?.display_name??'—'}</dd></div><div><dt>{t('account.username')}</dt><dd>@{user?.username??'—'}</dd></div><div><dt>{t('account.email')}</dt><dd>{user?.email??'—'}</dd></div></dl>
        </section>
        <div className="account-side-grid">
          <section className="account-card account-plan-card"><div className="account-card-heading"><div><p className="eyebrow">{t('account.planAndUsage')}</p><h2>{accountPlanName}</h2></div><span className="account-status"><i/>{t('account.active')}</span></div><p>{accountPlan==='free'?t('account.freeDescription'):t('account.paidPlanDescription')}</p><div className="account-usage-heading"><span>{t('account.repositoryUsage')}</span><b>{accountRepositoryLimit===null?t('account.repositoryUnlimited',{used:formatNumber(accountRepositoryCount)}):t('account.repositoryOfLimit',{used:formatNumber(accountRepositoryCount),limit:formatNumber(accountRepositoryLimit)})}</b></div>{accountRepositoryLimit!==null&&<progress className="account-usage-progress" max={accountRepositoryLimit} value={Math.min(accountRepositoryCount,accountRepositoryLimit)} aria-label={t('account.repositoryUsage')}/>}<button className="action" onClick={()=>setPage('pricing')}>{t('account.seePlans')}</button></section>
          <section className="account-card account-preferences-card"><div className="account-card-heading"><div><p className="eyebrow">{t('account.preferences')}</p><h2>{t('account.preferencesTitle')}</h2></div><span className="account-card-icon" aria-hidden="true">◉</span></div><dl className="account-preference-list"><div><dt>{t('account.interfaceLanguage')}</dt><dd>{lang==='es'?t('language.spanish'):t('language.english')}</dd></div><div><dt>{t('account.appearance')}</dt><dd>{currentThemeLabel}</dd></div></dl><button className="secondary action" onClick={()=>setPage('settings')}>{t('account.editPreferences')}</button></section>
          <section className="account-card account-cli-card"><div className="account-card-heading"><div><p className="eyebrow">{t('account.cliAccess')}</p><h2>{t('account.cliAccessTitle')}</h2></div><span className="account-card-icon" aria-hidden="true">⌘</span></div><p>{t('account.cliAccessBody')}</p><div className="account-cli-status"><i className={cliTokenEnabled?'is-active':''}/><span>{cliTokenEnabled?t('account.cliTokenActive'):t('account.cliTokenInactive')}{cliTokenEnabled&&cliTokenCreatedAt?` · ${t('account.cliTokenCreated',{date:formatDate(cliTokenCreatedAt,{dateStyle:'medium'})})}`:''}</span></div><div className="account-cli-token-actions"><button className="action" onClick={()=>void createCliToken()} disabled={cliTokenLoading}>{cliTokenLoading?t('account.cliTokenLoading'):cliTokenEnabled?t('account.rotateCliToken'):t('account.generateCliToken')}</button>{cliTokenEnabled&&<button className="secondary action" onClick={()=>void revokeCliToken()} disabled={cliTokenLoading}>{t('account.revokeCliToken')}</button>}</div>{cliTokenValue&&<div className="account-cli-token-reveal" role="status"><code>{cliTokenValue}</code><button className="secondary action" onClick={()=>void copyCliToken()}>{cliTokenCopied?t('account.cliTokenCopied'):t('account.cliTokenCopy')}</button><small>{t('account.cliTokenOneTime')}</small></div>}{cliTokenError&&<p className="form-error" role="alert">{cliTokenError}</p>}<p className="account-cli-security">{t('account.cliTokenSecurity')}</p><div className="account-cli-setup"><h3>{t('account.cliSetupTitle')}</h3><p>{t('account.cliSetupHint')}</p>{userRepositories.length?<><label>{t('account.chooseRepositoryForCli')}<select value={selectedRepositoryId} onChange={event=>setSelectedRepositoryId(event.target.value)}>{userRepositories.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><pre className="account-cli-commands"><code>{`aiverse init  # only if this folder is not initialized yet\naiverse add .\naiverse commit -m "Import project"\naiverse remote add origin ${selectedRemoteUrl}\naiverse auth login ${api||window.location.origin}\naiverse push main`}</code></pre></>:<p>{t('account.cliNoRepository')}</p>}</div></section>
          <section className="account-card account-security-card"><div className="account-card-heading"><div><p className="eyebrow">{t('account.security')}</p><h2>{t('account.activeSession')}</h2></div><span className="account-card-icon" aria-hidden="true">⌑</span></div><p>{t('account.sessionDescription')}</p><button className="secondary action account-signout" onClick={()=>void signOut()} disabled={accountActionLoading}>{accountActionLoading?t('account.signingOut'):t('account.signOut')}</button></section>
        </div>
      </div>
      {accountActionError&&<p className="form-error account-feedback" role="alert">{accountActionError}</p>}
    </section>
    :page==='docs'?<DocumentationPage navigate={setPage}/>
    :page==='prs'?<section className="product-page"><p className="eyebrow">{t('prs.eyebrow')}</p><h1>{t('prs.title')}</h1><p>{t('prs.intro')}</p><div className="feature-row"><article><b>{t('prs.contextReview')}</b><p>{t('prs.contextReviewBody')}</p></article><article><b>{t('prs.decisions')}</b><p>{t('prs.decisionsBody')}</p></article><article><b>{t('prs.aiHelp')}</b><p>{t('prs.aiHelpBody')}</p></article></div><button className="action" onClick={()=>setPage(user?'workspace':'register')}>{t('prs.start')}</button></section>
    :page==='terms'||page==='privacy'||page==='legal'||page==='cookies'?<><LegalPage kind={page}/><SiteFooter navigate={setPage}/></>
    :page==='pricing'?<PricingPage user={user} billingEnabled={billingEnabled} navigate={setPage} startCheckout={startCheckout}/>
    :<><Homepage user={user} navigate={setPage}/><SiteFooter navigate={setPage}/></>}</main>;

  return <main className={`${dark ? 'app dark' : 'app'}${repositoryAccessDisabled?' workspace-access-disabled':''}`}>
    <header>
      <div className="brand"><span className="logo"><AIVerseMark/></span><div><b>{t('workspace.productName')}</b><small>{t('workspace.tagline')}</small></div></div>
      <div className="header-right">{!import.meta.env.DEV&&user&&userRepositories.length>0&&<label className="workspace-repository-picker"><span>{t('workspace.repository')}</span><select value={selectedRepositoryId} onChange={event=>setSelectedRepositoryId(event.target.value)} aria-label={t('workspace.selectRepository')}>{userRepositories.map(item=><option key={item.id} value={item.id}>{item.name} · {item.isPublic?t('workspace.publicRepository'):t('workspace.privateRepository')}</option>)}</select></label>}{!import.meta.env.DEV&&user&&<button className="workspace-new-repository" onClick={()=>{setRepositoryCreateOpen(!repositoryCreateOpen);setRepositoryCreateError('')}}>{t('workspace.newRepository')}</button>}<span className={repositoryAccessDisabled?'connection setup-needed':error?'connection offline':'connection'}>● {repositoryAccessDisabled?t('workspace.storageUnavailable'):error?t('workspace.offline'):t('workspace.connected')}</span><span className="branch">⌘ {status.branch}</span>{user&&<button className="workspace-nav" onClick={()=>setPage('settings')}>{t('settings.title')}</button>}<LanguageControl compact/><ThemeControl theme={theme} dark={dark} onSelect={updateTheme} compact/>{user&&<button className="workspace-account" onClick={()=>setPage('account')}>@{user.username}</button>}</div>
    </header>
    {repositoryAccessDisabled?<div className="workspace-access-notice" role="status"><span className="workspace-access-icon" aria-hidden="true">i</span><div><b>{t('workspace.storageUnavailableTitle')}</b><p>{t('workspace.storageUnavailableBody')}</p></div></div>:error&&<div className="error-banner" role="alert"><span>{t('error.workspaceConnection', {error})}</span><button onClick={()=>{setLoading(true);void refresh()}}>{t('common.retry')}</button></div>}
    {!import.meta.env.DEV&&user&&(repositoryCreateOpen||userRepositories.length===0)&&<section className="workspace-repository-creator"><div><p className="eyebrow">{userRepositories.length?t('workspace.repositorySettings'):t('workspace.firstRepository')}</p><h2>{userRepositories.length?t('workspace.newRepository'):t('workspace.createFirstRepository')}</h2><p>{t('workspace.repositoryIsolationHint')}</p></div><form onSubmit={event=>void createRepository(event)}><label>{t('workspace.repositoryName')}<input value={repositoryCreateName} onChange={event=>setRepositoryCreateName(event.target.value)} minLength={1} maxLength={100} pattern="[A-Za-z0-9._\\-]{1,100}" placeholder={t('workspace.repositoryNamePlaceholder')} required/></label><label className="workspace-repository-visibility"><input type="checkbox" checked={repositoryCreatePublic} onChange={event=>setRepositoryCreatePublic(event.target.checked)}/><span>{t('workspace.makeRepositoryPublic')}</span></label>{repositoryCreateError&&<p className="form-error" role="alert">{repositoryCreateError}</p>}<div><button className="action" disabled={repositoryCreateLoading||!repositoryCreateName.trim()}>{repositoryCreateLoading?t('workspace.creatingRepository'):t('workspace.createRepository')}</button>{userRepositories.length>0&&<button type="button" className="secondary action" onClick={()=>setRepositoryCreateOpen(false)}>{t('common.cancel')}</button>}</div></form></section>}
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
          <div><p className="workspace-kicker">{t('workspace.kicker')}</p><h1>{selectedUserRepository?.name ?? t('workspace.project')}</h1><p>{selectedUserRepository?.description || t('workspace.projectIntro')}</p></div>
            <div className="workspace-quick-actions"><button className="mobile-ai-toggle" onClick={()=>setShowMobileAI(true)}>{t('workspace.openCopilot')}{' '}<span>✦</span></button><button onClick={()=>setPage('feed')}>{t('workspace.exploreCommunity')}{' '}<span>↗</span></button><button className="quick-primary" onClick={()=>setPage('docs')}>{t('workspace.openGuides')}{' '}<span>→</span></button></div>
          </div>
          <div className="workspace-metrics">
            <article><span className="metric-icon violet">⌘</span><div><b>{formatNumber(log.length)}</b><small>{t('workspace.commits')}</small></div></article>
            <article><span className="metric-icon amber">✎</span><div><b>{formatNumber(changes.length)}</b><small>{t('workspace.pendingChanges')}</small></div></article>
            <article><span className="metric-icon green">▤</span><div><b>{formatNumber(files.length)}</b><small>{t('workspace.trackedFiles')}</small></div></article>
            <article className="workspace-branch-card"><span>{t('workspace.currentBranch')}</span><b>⑂ {status.branch}</b><small>{repositoryAccessDisabled?t('workspace.accessSetup'):error?t('workspace.syncPaused'):t('workspace.repositoryConnected')}</small></article>
          </div>
          <div className="workspace-section-label"><div><span className="section-spark">✦</span><b>{t('workspace.activity')}</b><small> {t('workspace.activityHint')}</small></div><span className="activity-count">{t('workspace.historyCount', {count:formatNumber(log.length)})}</span></div>
        </div>
        {repositoryAccessDisabled?<div className="workspace-disabled-state"><span className="workspace-disabled-symbol" aria-hidden="true">⌑</span><p className="eyebrow">{t('workspace.storageUnavailable')}</p><h2>{t('workspace.storageUnavailableTitle')}</h2><p>{t('workspace.storageUnavailableBody')}</p></div>:workspaceHasNoRepository?<div className="workspace-disabled-state"><span className="workspace-disabled-symbol" aria-hidden="true">⌘</span><p className="eyebrow">{t('workspace.firstRepository')}</p><h2>{t('workspace.createFirstRepository')}</h2><p>{t('workspace.repositoryIsolationHint')}</p><button className="action" onClick={()=>setRepositoryCreateOpen(true)}>{t('workspace.newRepository')}</button></div>:<><div className="graph">
          <div className="panel-head"><span>{t('workspace.commitHistory')}</span><small>{t('workspace.branch', {branch:status.branch})}</small></div>
          {log.length ? <div className="commit-timeline">{log.slice(0, 5).map((item,index)=><article className={index===0?'commit-item latest':'commit-item'} key={item.hash}><span className="commit-node"/><div><div className="commit-item-title"><b>{item.commit.message}</b>{index===0&&<span>{t('workspace.latest')}</span>}</div><p><code>{item.hash.slice(0,8)}</code><i/>{formatDate(item.commit.date, {dateStyle:'medium',timeStyle:'short'})}</p></div></article>)}</div> : loading ? <div className="timeline-loading" aria-hidden="true"><i/><i/><i/></div> : <div className="timeline-empty"><span>✦</span><div><b>{t('workspace.historyEmptyTitle')}</b><p>{t('workspace.historyEmptyBody')}</p></div></div>}
        </div>
        <div className="editor">
          <div className="panel-head"><span>{selected || t('workspace.changesTree')}</span><small>{selectedChange ? selectedChange.status : t('workspace.confirmedContent')}</small></div>
          {selectedChange ? <div className="diff-grid"><DiffColumn title={t('workspace.before')} text={selectedChange.oldText}/><DiffColumn title={t('workspace.after')} text={selectedChange.newText}/></div> : <pre>{selected ? content : t('workspace.selectFile')}</pre>}
        </div></>}
      </section>
      <aside className={showMobileAI ? 'right mobile-ai-open' : 'right'}>
        <button className="mobile-ai-close" onClick={()=>setShowMobileAI(false)}>{t('workspace.closeCopilot')}{' '}<span>×</span></button>
        <div className="ai-panel-heading"><span className="ai-spark">✦</span><div><b>{t('workspace.copilot')}</b><small>{t('workspace.aiConnected')}</small></div><span className="online">●</span></div>
        <div className="ai-welcome"><span>✧</span><b>{t('workspace.discover')}</b><p>{t('workspace.aiIntro')}</p></div>
        <div className="ai-action-label">{t('workspace.quickActions')}</div>
        <button className="action" onClick={() => void requestAI('review')} disabled={!changes.length||repositoryAccessDisabled||workspaceHasNoRepository}>{t('workspace.reviewChanges', {count:formatNumber(changes.length),plural:changes.length === 1?'':'s'})}</button>
        <button className="action secondary" onClick={() => void requestAI('commit-msg')} disabled={!changes.length||repositoryAccessDisabled||workspaceHasNoRepository}>{t('workspace.suggestCommit')}</button>
        <div className="ai-suggestions" aria-label={t('workspace.suggestedQuestions')}>
          <button onClick={()=>setAiQuestion(t('workspace.questionUnderstand'))}>{t('workspace.understandProject')}</button>
          <button onClick={()=>setAiQuestion(t('workspace.questionRisks'))}>{t('workspace.findRisks')}</button>
          <button onClick={()=>setAiQuestion(t('workspace.questionNext'))}>{t('workspace.nextStep')}</button>
        </div>
        <label className="ai-ask-label">{t('workspace.askAiverse')}<textarea value={aiQuestion} onChange={event=>setAiQuestion(event.target.value)} onKeyDown={event=>event.key==='Enter'&&(event.metaKey||event.ctrlKey)&&void requestAI('ask')} maxLength={1000} placeholder={workspaceHasNoRepository?t('workspace.noRepository'):t('workspace.askPlaceholder')} disabled={repositoryAccessDisabled||workspaceHasNoRepository}/><small className="ai-input-hint">{t('workspace.askHint', {count:formatNumber(aiQuestion.length)})}</small></label>
        <button className="action ai-submit" onClick={() => void requestAI('ask')} disabled={!aiQuestion.trim()||repositoryAccessDisabled||workspaceHasNoRepository}>{t('workspace.sendQuestion')}{' '}<span>↑</span></button>
        <div className={`task-state ${aiTask?.state ?? ''}`}>{aiTask ? `${t(`task.${aiTask.state}`)} · ${t('workspace.attempt', {count:formatNumber(aiTask.attempts)})}` : t('workspace.answersHere')}</div>
        {aiTask&&<pre className="ai-result">{aiTask.result ?? aiTask.error ?? t('workspace.preparingAnswer')}</pre>}
        <div className="ai-provider-note"><span>✧</span> {t('workspace.model', {model:health?.provider ?? t('workspace.productName')})}</div>
        <div className="inspector"><div className="panel-head">{t('workspace.inspector')}</div><small>{t('workspace.hashTable')}</small><div className="buckets">{buckets.slice(0, 32).map((count, index) => <div key={index} title={t('workspace.bucketTitle', {index:formatNumber(index),count:formatNumber(count)})} style={{height: Math.max(4, count * 12)}}/>)}</div><small>{t('workspace.buckets', {count:formatNumber(buckets.length)})} {t('workspace.trackedFilesCount', {count:formatNumber(files.length)})}</small></div>
        <div className="panel-head state-heading">{t('workspace.status')}</div><div className="stats"><span>{formatNumber(status.staged.length)}<small>{t('workspace.staged')}</small></span><span>{formatNumber(status.modified.length)}<small>{t('workspace.modified')}</small></span><span>{formatNumber(status.untracked.length)}<small>{t('workspace.untracked')}</small></span></div>
      </aside>
    </section>
    <section className="terminal"><div className="terminal-head"><span><i/> {t('workspace.terminal')}</span><small>{t('workspace.terminalTagline')}</small><button onClick={()=>setPage('docs')}>{t('workspace.commands')}</button></div><div className="terminal-body"><div className="terminal-history">{output.slice(0, 5).map((line, index) => <div key={index}>{line}</div>)}</div><div className="prompt"><b>aiverse ❯</b><input value={terminal} onChange={event => setTerminal(event.target.value)} onKeyDown={event => event.key === 'Enter' && void run()} placeholder={repositoryAccessDisabled?t('workspace.commandAccessDisabled'):workspaceHasNoRepository?t('workspace.noRepository'):t('workspace.terminalPlaceholder')} disabled={repositoryAccessDisabled||workspaceHasNoRepository}/><button onClick={() => void run()} disabled={repositoryAccessDisabled||workspaceHasNoRepository}>↵</button></div></div></section>
    <footer className="workspace-footer"><span><AIVerseMark/> {t('workspace.productName')}{' '}<i/> {t('workspace.changesOnBranch', {count:formatNumber(changes.length),branch:status.branch})}</span><div><button onClick={()=>setPage('home')}>{t('nav.home')}</button><button onClick={()=>setPage('feed')}>{t('nav.community')}</button><button onClick={()=>setPage('docs')}>{t('nav.guides')}</button><button onClick={()=>setPage('terms')}>{t('workspace.terms')}</button><button onClick={()=>setPage('privacy')}>{t('workspace.privacy')}</button></div><span>● {repositoryAccessDisabled?t('workspace.storageUnavailable'):error?t('workspace.offline'):t('workspace.allUpdated')}</span></footer>
  </main>;
}

function Homepage({user,navigate}: {user:{username:string}|null;navigate:(page:RoutePage)=>void}) {
  const {t} = useI18n();
  return <>
    <section className="home-serro-hero">
      <div className="site-container home-serro-hero-inner">
        <div className="home-serro-intro">
          <p className="eyebrow"><span className="hero-signal"/>{t('home.heroEyebrow')}</p>
          <h1>{t('home.heroTitleFirst')}<br/><span>{t('home.heroTitleSecond')}</span></h1>
          <p className="home-serro-lead">{t('home.heroLead')}</p>
          <div className="home-serro-actions">
            <button className="action home-serro-primary" onClick={()=>navigate(user?'workspace':'register')}>{t('nav.register')}</button>
            <button className="home-serro-secondary" onClick={()=>navigate('feed')}>{t('home.exploreProjects')}</button>
          </div>
          <p className="home-serro-trust">{t('home.heroTrust')}</p>
        </div>

        <div className="home-serro-preview" role="group" aria-label={t('home.previewAriaLabel')}>
          <div className="home-serro-preview-bar">
            <div className="home-serro-preview-brand"><AIVerseMark/><b>AIVerse</b><span>/</span><span>{t('home.previewProject')}</span></div>
            <span className="home-serro-preview-label">{t('home.previewLabel')}</span>
            <span className="home-serro-preview-branch">⑂ main</span>
          </div>
          <div className="home-serro-preview-layout">
            <aside className="home-serro-preview-sidebar">
              <p>{t('home.previewRepository')}</p>
              <b>{t('home.previewProject')}</b>
              <span className="is-current">{t('home.previewOverview')}</span>
              <span>{t('home.previewHistory')}</span>
              <span>{t('home.previewBranches')}</span>
              <span>{t('home.previewFiles')}</span>
              <small>{t('home.previewDemo')}</small>
            </aside>
            <div className="home-serro-preview-main">
              <div className="home-serro-preview-heading">
                <div><p>{t('home.previewOverview')}</p><h2>{t('home.previewTitle')}</h2><span>{t('home.previewDescription')}</span></div>
                <span className="home-serro-preview-current">main</span>
              </div>
              <div className="home-serro-preview-metrics">
                <div><span>{t('home.previewCommits')}</span><b>18</b><small>{t('home.previewMetricOne')}</small></div>
                <div><span>{t('home.previewBranches')}</span><b>03</b><small>{t('home.previewMetricTwo')}</small></div>
                <div><span>{t('home.previewFiles')}</span><b>24</b><small>{t('home.previewMetricThree')}</small></div>
              </div>
              <figure className="home-serro-preview-map">
                <figcaption>{t('home.previewBranchMap')}<span>main · feature/context · review</span></figcaption>
                <svg viewBox="0 0 640 155" fill="none" aria-hidden="true" focusable="false">
                  <path className="preview-guide" d="M0 30H640M0 77H640M0 124H640"/>
                  <path className="preview-main-line" d="M22 77H615"/>
                  <path className="preview-branch-line" d="M122 77c54 0 55-47 110-47h135c55 0 55 47 110 47h138"/>
                  <path className="preview-branch-line preview-branch-muted" d="M310 77c42 0 42 47 84 47h100c32 0 30-47 62-47"/>
                  <circle className="preview-node" cx="22" cy="77" r="5"/><circle className="preview-node" cx="122" cy="77" r="5"/>
                  <circle className="preview-node preview-node-active" cx="232" cy="30" r="6"/><circle className="preview-node" cx="367" cy="30" r="5"/>
                  <circle className="preview-node" cx="477" cy="77" r="6"/><circle className="preview-node" cx="615" cy="77" r="5"/>
                  <circle className="preview-node" cx="310" cy="77" r="5"/><circle className="preview-node" cx="394" cy="124" r="5"/><circle className="preview-node" cx="494" cy="124" r="5"/>
                </svg>
              </figure>
              <div className="home-serro-preview-activity">
                <p>{t('home.previewActivity')}</p>
                <div><span className="preview-activity-node is-active"/><b>{t('home.previewChangeOne')}</b><small>feature/context · 8f3a2d1</small></div>
                <div><span className="preview-activity-node"/><b>{t('home.previewChangeTwo')}</b><small>main · 41c8e90</small></div>
              </div>
            </div>
            <aside className="home-serro-preview-context">
              <p className="home-serro-preview-context-label">{t('home.previewContextLabel')}</p>
              <h3>{t('home.previewContextTitle')}</h3>
              <p>{t('home.previewContextBody')}</p>
              <div className="preview-context-rule"/>
              <span>{t('home.previewCurrentBranch')}</span><b>feature/context</b>
              <span>{t('home.previewProjectState')}</span><b>{t('home.previewInProgress')}</b>
            </aside>
          </div>
          <div className="home-serro-preview-foot"><span>{t('home.previewFootnote')}</span><span>{t('home.previewFlow')}</span></div>
        </div>
        <div className="home-serro-ribbon"><span>{t('home.ribbonHistory')}</span><span>{t('home.ribbonBranches')}</span><span>{t('home.ribbonContext')}</span><span>{t('home.ribbonDecisions')}</span></div>
      </div>
    </section>

    <section className="home-serro-story">
      <div className="site-container home-serro-story-inner">
        <div className="home-serro-story-copy">
          <p className="eyebrow">{t('home.thesisEyebrow')}</p>
          <h2>{t('home.thesisTitleFirst')}<br/><span>{t('home.thesisTitleSecond')}</span></h2>
          <p>{t('home.thesisBody')}</p>
          <button className="home-serro-text-link" onClick={()=>navigate('docs')}>{t('home.thesisLink')}</button>
        </div>
        <figure className="home-serro-chart">
          <figcaption><span>{t('home.thesisVisualLabel')}</span><span>{t('home.thesisVisualRange')}</span></figcaption>
          <svg viewBox="0 0 620 250" fill="none" aria-hidden="true" focusable="false">
            <path className="serro-chart-guide" d="M0 50H620M0 110H620M0 170H620M0 230H620"/>
            <path className="serro-chart-path serro-chart-path-muted" d="M0 202C76 199 111 184 165 180S253 174 306 153s76-29 133-37 104-23 181-47"/>
            <path className="serro-chart-path serro-chart-path-blue" d="M0 212C81 207 104 199 165 193s97-1 141-19 74-23 122-25 110-8 192-15"/>
            <circle className="serro-chart-dot serro-chart-dot-blue" cx="428" cy="149" r="5"/><circle className="serro-chart-dot" cx="620" cy="71" r="5"/>
          </svg>
          <div className="home-serro-chart-legend"><span>{t('home.thesisLegendCode')}</span><span>{t('home.thesisLegendContext')}</span><small>{t('home.thesisLegendCaption')}</small></div>
        </figure>
      </div>
    </section>

    <section className="home-serro-connect">
      <div className="site-container">
        <div className="home-serro-section-heading">
          <p className="eyebrow">{t('home.capabilitiesEyebrow')}</p>
          <h2>{t('home.serroConnectTitle')}</h2>
          <p>{t('home.capabilitiesIntro')}</p>
        </div>
        <div className="home-serro-capability-grid">
          <article><span className="serro-capability-code">{t('home.capabilityHistoryCode')}</span><div className="serro-capability-visual capability-history" aria-hidden="true"><i/><i/><i/><i/></div><h3>{t('home.observeTitle')}</h3><p>{t('home.observeBody')}</p></article>
          <article><span className="serro-capability-code">{t('home.capabilityBranchCode')}</span><div className="serro-capability-visual capability-branches" aria-hidden="true"><i/><i/><i/></div><h3>{t('home.branchTitle')}</h3><p>{t('home.branchBody')}</p></article>
          <article><span className="serro-capability-code">{t('home.capabilityContextCode')}</span><div className="serro-capability-visual capability-context" aria-hidden="true"><i/><i/><i/></div><h3>{t('home.understandTitle')}</h3><p>{t('home.understandBody')}</p></article>
          <article><span className="serro-capability-code">{t('home.capabilityTeamCode')}</span><div className="serro-capability-visual capability-team" aria-hidden="true"><i/><i/><i/><i/></div><h3>{t('home.collaborateTitle')}</h3><p>{t('home.collaborateBody')}</p></article>
        </div>
      </div>
    </section>

    <section className="home-serro-shared">
      <div className="site-container home-serro-shared-inner">
        <div className="home-serro-shared-copy">
          <p className="eyebrow">{t('home.sharedEyebrow')}</p>
          <h2>{t('home.sharedTitleFirst')}<br/><span>{t('home.sharedTitleSecond')}</span></h2>
          <p>{t('home.sharedBody')}</p>
          <button className="action home-serro-primary" onClick={()=>navigate(user?'workspace':'register')}>{t('nav.register')}</button>
        </div>
        <div className="home-serro-network" role="img" aria-label={t('home.sharedDiagramLabel')}>
          <svg viewBox="0 0 400 400" fill="none" aria-hidden="true" focusable="false">
            <circle className="network-ring" cx="200" cy="200" r="142"/><circle className="network-ring network-ring-inner" cx="200" cy="200" r="82"/>
            <path className="network-spokes" d="M200 58V142M200 258V342M58 200h84m116 0h84M100 100l59 59m82 82 59 59M300 100l-59 59m-82 82-59 59"/>
            <circle className="network-node" cx="200" cy="58" r="6"/><circle className="network-node" cx="342" cy="200" r="6"/><circle className="network-node" cx="200" cy="342" r="6"/><circle className="network-node" cx="58" cy="200" r="6"/>
            <circle className="network-node network-node-highlight" cx="100" cy="100" r="7"/><circle className="network-node" cx="300" cy="100" r="7"/><circle className="network-node" cx="300" cy="300" r="7"/><circle className="network-node" cx="100" cy="300" r="7"/>
          </svg>
          <span className="network-label network-label-top">{t('home.networkCode')}</span>
          <span className="network-label network-label-right">{t('home.networkHistory')}</span>
          <span className="network-label network-label-bottom">{t('home.networkContext')}</span>
          <span className="network-label network-label-left">{t('home.networkTeam')}</span>
          <span className="network-center"><AIVerseMark/></span>
        </div>
      </div>
    </section>

    <section className="home-serro-cases">
      <div className="site-container">
        <div className="home-serro-cases-heading">
          <p className="eyebrow">{t('home.rolesEyebrow')}</p>
          <h2>{t('home.rolesTitleFirst')}<br/><span>{t('home.rolesTitleSecond')}</span></h2>
          <p>{t('home.rolesIntro')}</p>
        </div>
        <div className="home-serro-role-list">
          <article><span>{t('home.roleDeveloperCode')}</span><h3>{t('home.roleDeveloperTitle')}</h3><p>{t('home.roleDeveloperBody')}</p></article>
          <article><span>{t('home.roleStudentCode')}</span><h3>{t('home.roleStudentTitle')}</h3><p>{t('home.roleStudentBody')}</p></article>
          <article><span>{t('home.roleTeamCode')}</span><h3>{t('home.roleTeamTitle')}</h3><p>{t('home.roleTeamBody')}</p></article>
          <article><span>{t('home.roleMaintainerCode')}</span><h3>{t('home.roleMaintainerTitle')}</h3><p>{t('home.roleMaintainerBody')}</p></article>
        </div>
      </div>
    </section>

    <section className="home-serro-resources">
      <div className="site-container home-serro-resource-grid">
        <article><p className="eyebrow">{t('home.communityEyebrow')}</p><h2>{t('home.communityCardTitle')}</h2><p>{t('home.communityCardBody')}</p><button className="home-serro-text-link" onClick={()=>navigate('feed')}>{t('home.openCommunity')}</button></article>
        <article><p className="eyebrow">{t('home.learningEyebrow')}</p><h2>{t('home.docsCardTitle')}</h2><p>{t('home.docsCardBody')}</p><button className="home-serro-text-link" onClick={()=>navigate('docs')}>{t('home.openDocs')}</button></article>
        <article><p className="eyebrow">{t('home.plansEyebrow')}</p><h2>{t('home.plansTitleFirst')}<br/><span>{t('home.plansTitleSecond')}</span></h2><p>{t('home.plansCardBody')}</p><button className="home-serro-text-link" onClick={()=>navigate('pricing')}>{t('home.comparePlans')}</button></article>
      </div>
    </section>

    <section className="home-serro-cta">
      <div className="site-container home-serro-cta-inner">
        <p className="eyebrow">{t('home.finalEyebrow')}</p>
        <h2>{t('home.finalTitleFirst')}<br/><span>{t('home.finalTitleSecond')}</span></h2>
        <p>{t('home.trustLine')}</p>
        <div className="home-serro-actions"><button className="action home-serro-primary" onClick={()=>navigate(user?'workspace':'register')}>{t('nav.register')}</button><button className="home-serro-secondary" onClick={()=>navigate('login')}>{t('nav.login')}</button></div>
      </div>
    </section>
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

function ThemeControl({theme,dark,onSelect,compact=false}: {theme:Theme;dark:boolean;onSelect:(theme:Theme)=>void;compact?:boolean}) {
  const {t} = useI18n();
  const [open,setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const mode = dark ? t('theme.modeDark') : t('theme.modeLight');
  const currentLabel = theme === 'system' ? t('theme.systemCurrent', {mode}) : t(`theme.${theme}`);
  const options: Array<{value:Theme;label:string}> = [{value:'system',label:t('theme.system')},{value:'light',label:t('theme.light')},{value:'dark',label:t('theme.dark')}];
  useEffect(()=>{
    if (!open) return;
    const closeOutside = (event:PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    return () => document.removeEventListener('pointerdown', closeOutside);
  },[open]);
  const handleMenuKeyDown = (event:React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); return; }
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    event.preventDefault(); items[next]?.focus();
  };
  return <div ref={root} className={`theme-control${compact?' is-compact':''}`}>
    <button type="button" ref={trigger} className="theme-toggle" onClick={()=>setOpen(value=>!value)} aria-label={t('theme.current', {current:currentLabel})} aria-haspopup="menu" aria-expanded={open} aria-controls="theme-options" title={t('theme.current', {current:currentLabel})}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        {theme==='system'?<><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></>:theme==='light'?<><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></>:<path d="M20.1 15.1A8.5 8.5 0 0 1 8.9 3.9 8.5 8.5 0 1 0 20.1 15.1Z"/>}
      </svg><span className="sr-only" aria-live="polite">{currentLabel}</span>
    </button>
    {open&&<div ref={menu} className="theme-menu control-popover" id="theme-options" role="menu" aria-label={t('theme.menu')} onKeyDown={handleMenuKeyDown}>{options.map(option=><button type="button" role="menuitemradio" key={option.value} aria-checked={theme===option.value} onClick={()=>{onSelect(option.value);setOpen(false);trigger.current?.focus()}}><span>{option.label}{option.value==='system'&&theme==='system'?` · ${mode}`:''}</span>{theme===option.value&&<span className="menu-check" aria-hidden="true">✓</span>}</button>)}</div>}
  </div>;
}

function LanguageControl({compact=false}: {compact?:boolean}) {
  const {lang,setLanguage,t} = useI18n();
  const [open,setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const options: Array<{value:Language;label:string}> = [{value:'es',label:t('language.spanish')},{value:'en',label:t('language.english')}];
  useEffect(()=>{
    if (!open) return;
    const closeOutside = (event:PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    return () => document.removeEventListener('pointerdown', closeOutside);
  },[open]);
  const handleMenuKeyDown = (event:React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); return; }
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    event.preventDefault(); items[next]?.focus();
  };
  return <div ref={root} className={`language-control${compact?' is-compact':''}`}>
    <button type="button" ref={trigger} className="language-toggle" aria-label={t('language.current', {language:t(lang==='es'?'language.spanish':'language.english')})} aria-haspopup="menu" aria-expanded={open} aria-controls="language-options" onClick={()=>setOpen(value=>!value)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>
      <span>{lang.toUpperCase()}</span>
    </button>
    {open&&<div ref={menu} className="language-menu control-popover" id="language-options" role="menu" aria-label={t('language.menu')} onKeyDown={handleMenuKeyDown}>{options.map(option=><button type="button" role="menuitemradio" key={option.value} aria-checked={lang===option.value} onClick={()=>{setLanguage(option.value);setOpen(false);trigger.current?.focus()}}><span>{option.label}</span>{lang===option.value&&<span className="menu-check" aria-hidden="true">✓</span>}</button>)}</div>}
  </div>;
}

function SiteHeader({page,user,navigate,theme,dark,onThemeChange}: {page:Page;user:{username:string}|null;navigate:(page:RoutePage)=>void;theme:Theme;dark:boolean;onThemeChange:(theme:Theme)=>void}) {
  const {t} = useI18n();
  const [menuOpen,setMenuOpen] = useState(false);
  useEffect(()=>setMenuOpen(false),[page]);
  const closeMenu = () => setMenuOpen(false);
  return <header className={`site-header${menuOpen?' is-menu-open':''}`}><div className="site-container site-header-inner"><button className="wordmark" onClick={()=>{closeMenu();navigate('home')}}><AIVerseMark/><span>A<span className="wordmark-i">I</span>Verse</span></button><button type="button" className="mobile-menu-toggle" aria-label={menuOpen?t('nav.closeMenu'):t('nav.openMenu')} aria-expanded={menuOpen} aria-controls="primary-navigation" onClick={()=>setMenuOpen(value=>!value)}><span aria-hidden="true">{menuOpen?'×':'☰'}</span></button><nav id="primary-navigation" aria-label={t('nav.label')}><button className={page==='home'?'active':''} onClick={()=>{closeMenu();navigate('home')}}>{t('nav.home')}</button><button className={page==='feed'?'active':''} onClick={()=>{closeMenu();navigate('feed')}}>{t('nav.community')}</button><button className={page==='docs'?'active':''} onClick={()=>{closeMenu();navigate('docs')}}>{t('nav.guides')}</button><button className={page==='pricing'?'active':''} onClick={()=>{closeMenu();navigate('pricing')}}>{t('nav.plans')}</button><button className="mobile-nav-action" onClick={()=>{closeMenu();navigate(user?'account':'login')}}>{user?t('nav.myAccount'):t('nav.login')}</button><button className="mobile-nav-action mobile-nav-primary" onClick={()=>{closeMenu();navigate(user?'workspace':'register')}}>{user?t('nav.openWorkspace'):t('nav.register')}</button></nav><div className="site-header-actions"><div className="header-preferences"><LanguageControl compact/><ThemeControl theme={theme} dark={dark} onSelect={onThemeChange} compact/><span className="header-preferences-divider" aria-hidden="true"/></div>{user?<button className="account-link" onClick={()=>navigate('account')}>@{user.username}</button>:<button className="site-login" onClick={()=>navigate('login')}>{t('nav.login')}</button>}<button className="action site-cta" onClick={()=>navigate(user?'workspace':'register')}>{user?t('nav.openWorkspace'):t('nav.register')}</button></div></div></header>;
}

function SiteFooter({navigate}: {navigate: (page: RoutePage)=>void}) {
  const {t} = useI18n();
  return <footer className="site-footer"><div className="site-container footer-container"><div className="footer-main"><div className="footer-brand"><button className="wordmark" onClick={()=>navigate('home')}><AIVerseMark/><span>A<span className="wordmark-i">I</span>Verse</span></button><p>{t('footer.tagline')}</p></div><div className="footer-links"><div><b>{t('nav.community')}</b><button onClick={()=>navigate('feed')}>{t('footer.feed')}</button><button onClick={()=>navigate('docs')}>{t('footer.documentation')}</button></div><div><b>{t('footer.account')}</b><button onClick={()=>navigate('login')}>{t('nav.login')}</button><button onClick={()=>navigate('register')}>{t('nav.register')}</button><button onClick={()=>navigate('pricing')}>{t('nav.plans')}</button></div><div><b>{t('footer.information')}</b><button onClick={()=>navigate('legal')}>{t('footer.legal')}</button><button onClick={()=>navigate('terms')}>{t('footer.terms')}</button><button onClick={()=>navigate('privacy')}>{t('footer.privacy')}</button><button onClick={()=>navigate('cookies')}>{t('footer.cookies')}</button></div></div></div><div className="footer-bottom"><span>{t('footer.copyright')}</span><span>{t('footer.closing')}</span></div></div></footer>;
}

function DocumentationPage({navigate}: {navigate: (page: RoutePage)=>void}) {
  const {t} = useI18n();
  return <article className="docs-page"><aside className="docs-index"><p className="eyebrow">{t('docs.indexEyebrow')}</p><a href="#quickstart">{t('docs.quickstartNav')}</a><a href="#repositories">{t('docs.repositoriesNav')}</a><a href="#terminal-guide">{t('docs.terminalNav')}</a><a href="#ai-guide">{t('docs.aiNav')}</a><a href="#reviews">{t('docs.reviewsNav')}</a><a href="#privacy-guide">{t('docs.privacyNav')}</a><a href="#troubleshooting">{t('docs.troubleshootingNav')}</a></aside><div className="docs-content"><p className="eyebrow">{t('docs.eyebrow')}</p><h1>{t('docs.title')}</h1><p className="docs-lead">{t('docs.lead')}</p><div className="docs-callout"><b>{t('docs.startHere')}</b><p>{t('docs.startHereBody')}</p><button className="action" onClick={()=>navigate('workspace')}>{t('docs.openWorkspace')}</button></div>
    <section id="quickstart"><h2>{t('docs.quickstartTitle')}</h2><p>{t('docs.quickstartBody')}</p><ol><li>{t('docs.quickstart1')}</li><li>{t('docs.quickstart2')}</li><li>{t('docs.quickstart3')}</li><li>{t('docs.quickstart4')}</li><li>{t('docs.quickstart5')}</li></ol><pre><code>aiverse status<br/>aiverse add .<br/>aiverse commit -m "Agrega página de inicio"</code></pre></section>
    <section id="repositories"><h2>{t('docs.repositoriesTitle')}</h2><p>{t('docs.repositoriesBody')}</p><ul><li><b>{t('docs.publicLabel')}</b> {t('docs.publicBody')}</li><li><b>{t('docs.privateLabel')}</b> {t('docs.privateBody')}</li><li><b>{t('docs.descriptionLabel')}</b> {t('docs.descriptionBody')}</li><li><b>{t('docs.commitsLabel')}</b> {t('docs.commitsBody')}</li></ul><p>{t('docs.secretsWarning')}</p></section>
    <section id="terminal-guide"><h2>{t('docs.terminalTitle')}</h2><p>{t('docs.terminalBody')}</p><p>{t('docs.cliInstallHint')}</p><pre><code>npm install<br/>npm run build<br/>npm link --workspace @aiverse/cli</code></pre><pre><code>aiverse init<br/>aiverse add .<br/>aiverse commit -m "Importa el proyecto"<br/>aiverse remote add origin https://aiverse.example/api/repositories/ID<br/>aiverse auth login https://aiverse.example<br/>aiverse push main</code></pre><p>{t('docs.cloneIntro')}</p><pre><code>aiverse clone https://aiverse.example/api/repositories/ID ./mi-proyecto<br/>cd mi-proyecto<br/>aiverse status</code></pre><p>{t('docs.terminalTips')}</p></section>
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
