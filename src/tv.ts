import fs from 'fs';
import { chromium, type Browser, type Page, type Request, type Response as PlaywrightResponse } from 'playwright-core';
import { fetch as undiciFetch } from 'undici';

// ========= Config fichiers =========
const M3U_FILEPATH = "./tv.m3u";
const INTERMEDIATE_JSON = "./tv-merged.json";
const STATE_FILE = "./.state.json"; // lastRun, lastFull, lock
const SCRAPE_TEST_URL = 'https://www.livehdtv.com/ch123/';
const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY?.trim();
const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY?.trim();

// Intervalles
const UPDATE_INTERVAL_MS = 2 * 60 * 60 * 1000;  // 2h
const FULL_INTERVAL_MS   = 24 * 60 * 60 * 1000; // 24h
const AUTO_TIME_ZONE = 'Europe/Paris';
const AUTO_QUIET_START_HOUR = 22;
const AUTO_QUIET_END_HOUR = 6;
const STREAM_TEST_CONCURRENCY = 4;
const LOCK_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

// ========= Types =========
type Country = 'FR' | 'USA';

type Channel = {
    nom: string;
    identifiant: string | string[];
    logo: string;
    group: string;
    url: string;
    tvgId: string;
    scrapUrl?: string;
    country?: Country;
};

type RemoteChannel = {
    name: string;
    url: string;
    group: string;
    tvgId?: string;
    sourceNumber: number;
    sourceFormat: 'JSON' | 'M3U';
};

type ParsedRemoteChannel = Omit<RemoteChannel, 'sourceNumber' | 'sourceFormat'>;

// ========= Sources =========
const SOURCES = {
    fr: {
        localFile: './src/tv-fr.json',
        remoteUrls: [
            'https://raw.githubusercontent.com/bugsfreeweb/LiveTVCollector/refs/heads/main/LiveTV/France/LiveTV.json',
            'https://raw.githubusercontent.com/iptv-ch/iptv-ch.github.io/refs/heads/master/webtv.m3u',
        ],
    },
    usa: {
        localFile: './src/tv-usa.json',
        remoteUrls: [
            'https://raw.githubusercontent.com/bugsfreeweb/LiveTVCollector/refs/heads/main/LiveTV/USA/LiveTV.json',
        ],
    },
};

// ========= Utilitaires =========
function parseJsonRemoteChannels(content: string): ParsedRemoteChannel[] {
    const data = JSON.parse(content) as any;
    if (!data.channels || typeof data.channels !== 'object') {
        throw new Error('format JSON invalide : propriété channels manquante');
    }

    const all: ParsedRemoteChannel[] = [];
    for (const group in data.channels) {
        const groupChannels = data.channels[group];
        if (Array.isArray(groupChannels)) {
            groupChannels.forEach((ch: any) => {
                if (ch.name && ch.url) {
                    all.push({
                        name: String(ch.name).trim(),
                        url: String(ch.url).trim(),
                        group,
                        tvgId: ch.tvgId ? String(ch.tvgId).trim() : undefined,
                    });
                }
            });
        }
    }
    return all;
}

function findM3UInfoSeparator(line: string): number {
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '"' && line[i - 1] !== '\\') quoted = !quoted;
        if (line[i] === ',' && !quoted) return i;
    }
    return -1;
}

function readM3UAttribute(info: string, attribute: string): string {
    const match = info.match(new RegExp(`${attribute}="([^"]*)"`, 'i'));
    return match?.[1]?.trim() ?? '';
}

function parseM3URemoteChannels(content: string): ParsedRemoteChannel[] {
    const channels: ParsedRemoteChannel[] = [];
    let pending: Omit<ParsedRemoteChannel, 'url'> | null = null;

    for (const rawLine of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith('#EXTINF:')) {
            const separator = findM3UInfoSeparator(line);
            const info = separator >= 0 ? line.slice(0, separator) : line;
            const displayName = separator >= 0 ? line.slice(separator + 1).trim() : '';
            const tvgName = readM3UAttribute(info, 'tvg-name');

            pending = {
                name: displayName || tvgName,
                group: readM3UAttribute(info, 'group-title') || 'M3U',
                tvgId: readM3UAttribute(info, 'tvg-id') || undefined,
            };
            continue;
        }

        if (line.startsWith('#')) continue;
        if (pending?.name) {
            channels.push({ ...pending, url: line });
        }
        pending = null;
    }

    return channels;
}

async function fetchRemoteSource(remoteUrl: string): Promise<{
    channels: ParsedRemoteChannel[];
    format: RemoteChannel['sourceFormat'];
}> {
    const response = await fetch(remoteUrl);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const content = await response.text();
    if (content.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')) {
        return { channels: parseM3URemoteChannels(content), format: 'M3U' };
    }

    return { channels: parseJsonRemoteChannels(content), format: 'JSON' };
}

async function fetchRemoteSources(remoteUrls: string[], country: Country): Promise<RemoteChannel[]> {
    if (remoteUrls.length === 0) {
        throw new Error(`Aucune source distante configurée pour ${country}`);
    }

    const results = await Promise.allSettled(
        remoteUrls.map((url) => fetchRemoteSource(url))
    );
    const merged: RemoteChannel[] = [];
    const seenUrls = new Set<string>();
    let successfulSources = 0;

    results.forEach((result, index) => {
        const sourceNumber = index + 1;
        if (result.status === 'rejected') {
            console.warn(`⚠️ Source ${country} #${sourceNumber} indisponible (${remoteUrls[index]}) : ${String(result.reason)}`);
            return;
        }

        successfulSources++;
        const { channels, format } = result.value;
        console.log(`📥 Source ${country} #${sourceNumber} (${format}) : ${channels.length} flux chargés`);
        channels.forEach((channel) => {
            if (!seenUrls.has(channel.url)) {
                seenUrls.add(channel.url);
                merged.push({ ...channel, sourceNumber, sourceFormat: format });
            }
        });
    });

    if (successfulSources === 0) {
        throw new Error(`Toutes les sources distantes ${country} sont indisponibles`);
    }

    console.log(`🔗 ${country} : ${merged.length} flux uniques issus de ${successfulSources}/${remoteUrls.length} source(s)`);
    return merged;
}

const STREAM_HEADERS: HeadersInit = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
    'Accept': '*/*',
};

const SCRAPE_HEADERS: HeadersInit = {
    ...STREAM_HEADERS,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
};

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
    url: string,
    init: RequestInit = {},
    timeoutMs = 12000
): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await undiciFetch(url, {
            ...init,
            signal: controller.signal,
            redirect: 'follow',
        } as Parameters<typeof undiciFetch>[1]);
        return response as unknown as Response;
    } finally {
        clearTimeout(timeout);
    }
}

async function testUrl(
    url: string,
    timeoutMs = 3000,
    retries = 2,
    extraHeaders: HeadersInit = {}
): Promise<boolean> {
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
            const isM3u8 = url.toLowerCase().includes('.m3u8');

            if (isM3u8) {
                const response = await fetchWithTimeout(url, {
                    method: 'GET',
                    headers: { ...STREAM_HEADERS, ...extraHeaders },
                }, timeoutMs);

                if (!response.ok) {
                    console.warn(`⚠️ Test échoué ${url} → HTTP ${response.status}`);
                    await response.body?.cancel();
                    throw new Error(`HTTP ${response.status}`);
                }

                const text = await response.text();

                if (text.includes('#EXTM3U')) {
                    return true;
                }

                console.warn(`⚠️ Test échoué ${url} → réponse non M3U8`);
                throw new Error('Not an M3U8 playlist');
            }

            // Pour les flux non-m3u8 : on ne télécharge qu’un petit morceau
            const response = await fetchWithTimeout(url, {
                method: 'GET',
                headers: {
                    ...STREAM_HEADERS,
                    ...extraHeaders,
                    'Range': 'bytes=0-1024',
                },
            }, timeoutMs);

            if (response.status >= 200 && response.status < 400) {
                await response.body?.cancel();
                return true;
            }

            console.warn(`⚠️ Test échoué ${url} → HTTP ${response.status}`);
            await response.body?.cancel();
            throw new Error(`HTTP ${response.status}`);

        } catch (e) {
            if (attempt <= retries) {
                await sleep(1000 * attempt);
                continue;
            }
            return false;
        }
    }

    return false;
}


function getPriority(group: string, isUSA: boolean): number {
    if (!isUSA) return 100;
    if (group === 'Premium Channels') return 1;
    if (group === 'Canadian Channels') return 2;
    return 99;
}

function createConcurrencyLimiter(concurrency: number) {
    let active = 0;
    const queue: Array<() => void> = [];

    return async function limit<T>(task: () => Promise<T>): Promise<T> {
        if (active >= concurrency) {
            await new Promise<void>((resolve) => queue.push(resolve));
        }

        active++;
        try {
            return await task();
        } finally {
            active--;
            queue.shift()?.();
        }
    };
}

const limitBrowserScrape = createConcurrencyLimiter(1);
const browserScrapeCache = new Map<string, Promise<ScrapedStream[]>>();

type BrowserbaseRuntime = {
    browser: Browser;
    page: Page;
};

let browserbaseRuntimePromise: Promise<BrowserbaseRuntime> | undefined;
let browserlessRuntimePromise: Promise<BrowserbaseRuntime> | undefined;
let browserbaseDisabledReason: string | undefined;

function fetchScrapedStreamsCached(pageUrl: string): Promise<ScrapedStream[]> {
    const cached = browserScrapeCache.get(pageUrl);
    if (cached) {
        console.log(`♻️ Réutilisation du scraping navigateur → ${pageUrl}`);
        return cached;
    }

    const scraping = limitBrowserScrape(() => fetchScrapedStreamsWithFallback(pageUrl));
    browserScrapeCache.set(pageUrl, scraping);
    return scraping;
}

async function findFirstValidScrapedStream(scrapUrl: string): Promise<{
    streams: ScrapedStream[];
    selected: ScrapedStream | null;
}> {
    const streams = await fetchScrapedStreamsCached(scrapUrl);
    for (const stream of streams) {
        const valid = await testUrl(stream.url, 5000, 1, {
            Referer: stream.referer ?? scrapUrl,
        });
        if (valid) return { streams, selected: stream };
    }
    return { streams, selected: null };
}

async function findFirstValidStream(
    candidates: RemoteChannel[],
    testStream: (url: string) => Promise<boolean>,
    concurrency = STREAM_TEST_CONCURRENCY
): Promise<RemoteChannel | null> {
    for (let start = 0; start < candidates.length; start += concurrency) {
        const batch = candidates.slice(start, start + concurrency);
        const results = await Promise.all(
            batch.map(async (candidate) => ({
                candidate,
                valid: await testStream(candidate.url),
            }))
        );
        const firstValid = results.find((result) => result.valid);
        if (firstValid) return firstValid.candidate;
    }

    return null;
}

async function enrichLocalChannelsWithValidStream(
    localPath: string,
    remoteChannels: RemoteChannel[],
    isUSA: boolean = false,
    country: Country = 'FR',
    testStream: (url: string) => Promise<boolean> = createLimitedStreamTester()
): Promise<Channel[]> {
    const localChannels: Channel[] = JSON.parse(fs.readFileSync(localPath, 'utf-8'));

    console.log(`🔎 ${localPath}: ${localChannels.length} chaînes, ${STREAM_TEST_CONCURRENCY} tests de flux max en parallèle`);

    const enriched = await Promise.all(localChannels.map(async (local, i): Promise<Channel> => {
        // Le scraping est exclusif : aucun fallback vers l'URL locale ou les sources distantes.
        if (local.scrapUrl?.trim()) {
            const scrapUrl = local.scrapUrl.trim();
            console.log(`🕸️ [${i + 1}/${localChannels.length}] - ${local.nom} → scraping Browserbase (Browserless en backup) de ${scrapUrl}`);

            try {
                const { streams, selected } = await findFirstValidScrapedStream(scrapUrl);
                console.log(`🔎 ${local.nom} → ${streams.length} URL(s) M3U8 extraite(s), recherche classique ignorée`);

                if (selected) {
                    console.log(`✅ [${i + 1}/${localChannels.length}] - ${local.nom} → ${selected.url} [scraping ${selected.origin}]`);
                    return { ...local, url: selected.url, country };
                }

                console.log(`❌ [${i + 1}/${localChannels.length}] - ${local.nom} → scraping réussi, mais aucun flux valide`);
            } catch (error) {
                console.log(`❌ [${i + 1}/${localChannels.length}] - ${local.nom} → échec du scraping : ${String(error)}`);
            }

            return { ...local, url: '', country };
        }

        //URL déjà renseignée
        if (local.url && local.url.trim() !== '') {
            console.log(`✅ ${local.nom} → ${local.url}`);
            return { ...local, url: local.url, country };
        }

        //Matching distant
        const identifiants = Array.isArray(local.identifiant)
            ? local.identifiant.map((id) => String(id).toLowerCase())
            : [String(local.identifiant).toLowerCase()];

        const allMatches: RemoteChannel[] = [];
        const seenUrls = new Set<string>();
        identifiants.forEach((id) => {
            const matchesForId = remoteChannels
                .filter((rc) => rc.name.toLowerCase() === id)
                .sort((a, b) => getPriority(a.group, isUSA) - getPriority(b.group, isUSA));
            matchesForId.forEach((match) => {
                if (!seenUrls.has(match.url)) {
                    seenUrls.add(match.url);
                    allMatches.push(match);
                }
            });
        });

        // Les playlists M3U utilisent parfois un libellé différent, mais un tvg-id stable.
        const normalizedTvgId = local.tvgId.trim().toLowerCase();
        remoteChannels
            .filter((rc) => rc.tvgId?.toLowerCase() === normalizedTvgId)
            .sort((a, b) => getPriority(a.group, isUSA) - getPriority(b.group, isUSA))
            .forEach((match) => {
                if (!seenUrls.has(match.url)) {
                    seenUrls.add(match.url);
                    allMatches.push(match);
                }
            });

        // Une source précédente est toujours entièrement testée avant ses sources de secours.
        allMatches.sort((a, b) => a.sourceNumber - b.sourceNumber);

        let selectedUrl = '';
        let selectedGroup = '';
        const selected = await findFirstValidStream(allMatches, testStream);
        if (selected) {
            selectedUrl = selected.url;
            selectedGroup = selected.group;

            if (selected.sourceNumber > 1) {
                const earlierMatches = allMatches.filter(
                    (candidate) => candidate.sourceNumber < selected.sourceNumber
                );
                const previousSources = selected.sourceNumber === 2
                    ? `source ${country} #1`
                    : `sources ${country} #1 à #${selected.sourceNumber - 1}`;
                const fallbackReason = earlierMatches.length === 0
                    ? `chaîne absente de ${previousSources}`
                    : `${previousSources} : ${earlierMatches.length} candidat(s), aucun flux valide`;
                console.log(
                    `🔄 ${local.nom} : ${fallbackReason} → trouvée dans source ${country} #${selected.sourceNumber} (${selected.sourceFormat})`
                );
            }
        }

        if (selectedUrl) {
            console.log(
                `✅ [${i + 1}/${localChannels.length}] - ${local.nom} → ${selectedUrl} ` +
                `[source ${country} #${selected!.sourceNumber} ${selected!.sourceFormat}; ${selectedGroup}]`
            );
        } else if (allMatches.length > 0) {
            const candidateCounts = new Map<string, number>();
            allMatches.forEach((candidate) => {
                const source = `source ${country} #${candidate.sourceNumber} ${candidate.sourceFormat}`;
                candidateCounts.set(source, (candidateCounts.get(source) ?? 0) + 1);
            });
            const details = [...candidateCounts]
                .map(([source, count]) => `${count} candidat(s) dans ${source}`)
                .join(', ');
            console.log(`❌ [${i + 1}/${localChannels.length}] - ${local.nom} → ${details}, mais aucun flux valide`);
        } else {
            console.log(`❌ [${i + 1}/${localChannels.length}] - ${local.nom} → aucun candidat trouvé dans les sources`);
        }

        return { ...local, url: selectedUrl, country };
    }));

    return enriched;
}

function createLimitedStreamTester(): (url: string) => Promise<boolean> {
    const limitStreamTest = createConcurrencyLimiter(STREAM_TEST_CONCURRENCY);
    return (url: string) => limitStreamTest(() => testUrl(url, 3000, 2));
}

function generateM3UEntry(channel: Channel): string {
    const tvgId = escapeM3UAttribute(channel.tvgId);
    const logo = escapeM3UAttribute(channel.logo);
    const group = escapeM3UAttribute(`LIVETV;${channel.group}`);
    const name = escapeM3UText(channel.nom);
    const url = escapeM3UText(channel.url);

    return `#EXTINF:-1 tvg-id="${tvgId}" tvg-logo="${logo}" group-title="${group}",${name}
${url}`;
}

function escapeM3UAttribute(value: string): string {
    return escapeM3UText(value).replace(/"/g, '\\"');
}

function escapeM3UText(value: string): string {
    return String(value).replace(/[\r\n]+/g, ' ').trim();
}

type ScrapedStream = {
    url: string;
    origin: 'source HTML' | 'JSON-LD' | 'script HTML' | 'Browserbase' | 'Browserless';
    referer?: string;
};

type BrowserProvider = 'Browserbase' | 'Browserless';

type BrowserbaseSession = {
    id: string;
    connectUrl: string;
};

function decodeHtmlAttribute(value: string): string {
    return value
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'");
}

function collectContentUrls(value: unknown, urls: string[]): void {
    if (Array.isArray(value)) {
        value.forEach((item) => collectContentUrls(item, urls));
        return;
    }
    if (!value || typeof value !== 'object') return;

    for (const [key, nestedValue] of Object.entries(value)) {
        if (key === 'contentURL' && typeof nestedValue === 'string') {
            urls.push(nestedValue);
        } else {
            collectContentUrls(nestedValue, urls);
        }
    }
}

function extractM3U8UrlsFromHtml(html: string): ScrapedStream[] {
    const candidates: ScrapedStream[] = [];
    const sourcePattern = /<source\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
    const jsonLdPattern = /<script\b[^>]*type\s*=\s*(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi;
    const directUrlPattern = /https?:\\?\/\\?\/[^"'\s<>]+?\.m3u8(?:\?[^"'\s<>]*)?/gi;

    for (const match of html.matchAll(sourcePattern)) {
        candidates.push({ url: decodeHtmlAttribute(match[2]), origin: 'source HTML' });
    }

    for (const match of html.matchAll(jsonLdPattern)) {
        try {
            const urls: string[] = [];
            collectContentUrls(JSON.parse(match[2]), urls);
            urls.forEach((url) => candidates.push({ url, origin: 'JSON-LD' }));
        } catch {
            console.warn('⚠️ Bloc JSON-LD invalide ignoré');
        }
    }

    for (const match of html.matchAll(directUrlPattern)) {
        candidates.push({
            url: decodeHtmlAttribute(match[0].replace(/\\\//g, '/').replace(/\\u0026/gi, '&')),
            origin: 'script HTML',
        });
    }

    const unique = new Map<string, ScrapedStream>();
    candidates
        .filter((candidate) => candidate.url.toLowerCase().includes('.m3u8'))
        .forEach((candidate) => unique.set(candidate.url, candidate));
    return [...unique.values()];
}

function extractEmbeddedPageUrls(html: string, pageUrl: string): string[] {
    const iframePattern = /<iframe\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
    const tokenPattern = /(?:https?:\\?\/\\?\/[^"'\s<>]+)?\/?token\.php\?[^"'\s<>]+/gi;
    const pageOrigin = new URL(pageUrl).origin;
    const urls = new Set<string>();

    const addUrl = (rawUrl: string): void => {
        try {
            const normalized = decodeHtmlAttribute(rawUrl.replace(/\\\//g, '/').replace(/\\u0026/gi, '&'));
            const url = new URL(normalized, pageUrl);
            if (url.origin === pageOrigin) urls.add(url.href);
        } catch {
            // Une URL dynamique incomplète n'est pas exploitable.
        }
    };

    for (const match of html.matchAll(iframePattern)) addUrl(match[2]);
    for (const match of html.matchAll(tokenPattern)) addUrl(match[0]);
    return [...urls];
}

function updateCookieJar(response: Response, cookies: Map<string, string>): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = headers.getSetCookie?.() ?? (headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);

    for (const setCookie of setCookies) {
        const pair = setCookie.split(';', 1)[0];
        const separator = pair.indexOf('=');
        if (separator > 0) cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
}

async function fetchScrapedStreams(
    pageUrl: string,
    depth = 0,
    visited = new Set<string>(),
    referer?: string,
    cookies = new Map<string, string>()
): Promise<ScrapedStream[]> {
    if (visited.has(pageUrl)) return [];
    visited.add(pageUrl);

    const response = await fetchWithTimeout(pageUrl, {
        headers: {
            ...SCRAPE_HEADERS,
            ...(referer ? { Referer: referer } : {}),
            ...(cookies.size > 0 ? { Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
        },
    }, 15000);
    updateCookieJar(response, cookies);

    const body = await response.text();
    const title = body.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
    const isChallengePage = /cf-chl-|just a moment|attention required/i.test(body);
    if (!response.ok || isChallengePage) {
        const server = response.headers.get('server');
        const cfRay = response.headers.get('cf-ray');
        const details = [
            cfRay || server?.toLowerCase().includes('cloudflare') || isChallengePage
                ? 'challenge/blocage Cloudflare probable'
                : null,
            server ? `server=${server}` : null,
            cfRay ? `cf-ray=${cfRay}` : null,
            title ? `titre=${JSON.stringify(title)}` : null,
        ].filter(Boolean).join(', ');
        throw new Error(`page inaccessible : HTTP ${response.status}${details ? ` (${details})` : ''}`);
    }

    const streams = extractM3U8UrlsFromHtml(body);
    if (depth < 3) {
        const embeddedUrls = extractEmbeddedPageUrls(body, pageUrl);
        if (embeddedUrls.length > 0) {
            console.log(`🧭 ${embeddedUrls.length} iframe(s)/lecteur(s) détecté(s) au niveau ${depth + 1}`);
        }

        for (const embeddedUrl of embeddedUrls) {
            try {
                streams.push(...await fetchScrapedStreams(embeddedUrl, depth + 1, visited, pageUrl, cookies));
            } catch (error) {
                console.warn(`⚠️ Lecteur inaccessible ${embeddedUrl} : ${String(error)}`);
            }
        }
    }

    const unique = new Map<string, ScrapedStream>();
    streams.forEach((stream) => unique.set(stream.url, stream));
    if (unique.size === 0) throw new Error('aucune URL M3U8 trouvée dans la page ou ses iframes');
    return [...unique.values()];
}

async function createBrowserbaseRuntime(): Promise<BrowserbaseRuntime> {
    if (!BROWSERBASE_API_KEY) {
        throw new Error('Browserbase nécessite la variable BROWSERBASE_API_KEY');
    }

    let session: BrowserbaseSession | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
        console.log('🌐 Création de la session Browserbase partagée');
        const sessionResponse = await fetchWithTimeout('https://api.browserbase.com/v1/sessions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-BB-API-Key': BROWSERBASE_API_KEY,
            },
            body: JSON.stringify({ region: 'eu-central-1', timeout: 900 }),
        }, 30000);
        const sessionBody = await sessionResponse.text();

        if (sessionResponse.ok) {
            session = JSON.parse(sessionBody) as BrowserbaseSession;
            break;
        }

        if (sessionResponse.status === 429 && attempt < 3) {
            const retryAfterHeader = Number(sessionResponse.headers.get('retry-after'));
            const retryAfterMessage = Number(sessionBody.match(/try again in (\d+) seconds?/i)?.[1]);
            const retryAfterSeconds = Math.max(
                Number.isFinite(retryAfterHeader) ? retryAfterHeader : 0,
                Number.isFinite(retryAfterMessage) ? retryAfterMessage : 0,
                12
            );
            console.warn(`⚠️ Limite Browserbase atteinte, nouvel essai dans ${retryAfterSeconds + 1} s`);
            await sleep((retryAfterSeconds + 1) * 1000);
            continue;
        }

        throw new Error(`création de session Browserbase impossible : HTTP ${sessionResponse.status} - ${sessionBody.slice(0, 300)}`);
    }

    if (!session) throw new Error('création de session Browserbase impossible après 3 tentatives');
    if (!session.id || !session.connectUrl) throw new Error('réponse de session Browserbase incomplète');
    console.log(`🔍 Enregistrement : https://browserbase.com/sessions/${session.id}`);

    const browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 30000 });
    const context = browser.contexts()[0];
    if (!context) {
        await browser.close();
        throw new Error('Browserbase n’a fourni aucun contexte navigateur');
    }
    const page = context.pages()[0] ?? await context.newPage();
    return { browser, page };
}

function getBrowserbaseRuntime(): Promise<BrowserbaseRuntime> {
    if (!browserbaseRuntimePromise) {
        browserbaseRuntimePromise = createBrowserbaseRuntime().catch((error) => {
            browserbaseRuntimePromise = undefined;
            throw error;
        });
    }
    return browserbaseRuntimePromise;
}

async function closeBrowserbaseRuntime(): Promise<void> {
    const runtimePromise = browserbaseRuntimePromise;
    browserbaseRuntimePromise = undefined;
    if (!runtimePromise) return;

    try {
        const { browser } = await runtimePromise;
        await browser.close();
        console.log('🛑 Session Browserbase partagée fermée');
    } catch (error) {
        console.warn(`⚠️ Fermeture Browserbase impossible : ${String(error)}`);
    }
}

async function createBrowserlessRuntime(): Promise<BrowserbaseRuntime> {
    if (!BROWSERLESS_API_KEY) {
        throw new Error('Browserless nécessite la variable BROWSERLESS_API_KEY');
    }

    const endpoint = `wss://production-ams.browserless.io/stealth?token=${encodeURIComponent(BROWSERLESS_API_KEY)}`;
    console.log('🌐 Connexion à la session Browserless de backup (Amsterdam)');
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 30000 });
    const context = browser.contexts()[0];
    if (!context) {
        await browser.close();
        throw new Error('Browserless n’a fourni aucun contexte navigateur');
    }
    const page = context.pages()[0] ?? await context.newPage();
    return { browser, page };
}

function getBrowserlessRuntime(): Promise<BrowserbaseRuntime> {
    if (!browserlessRuntimePromise) {
        browserlessRuntimePromise = createBrowserlessRuntime().catch((error) => {
            browserlessRuntimePromise = undefined;
            throw error;
        });
    }
    return browserlessRuntimePromise;
}

async function closeBrowserlessRuntime(): Promise<void> {
    const runtimePromise = browserlessRuntimePromise;
    browserlessRuntimePromise = undefined;
    if (!runtimePromise) return;

    try {
        const { browser } = await runtimePromise;
        await browser.close();
        console.log('🛑 Session Browserless partagée fermée');
    } catch (error) {
        console.warn(`⚠️ Fermeture Browserless impossible : ${String(error)}`);
    }
}

async function closeBrowserRuntimes(): Promise<void> {
    browserScrapeCache.clear();
    await closeBrowserbaseRuntime();
    await closeBrowserlessRuntime();
}

async function scrapeStreamsFromBrowserPage(
    page: Page,
    pageUrl: string,
    provider: BrowserProvider
): Promise<ScrapedStream[]> {
    await page.goto('about:blank', { waitUntil: 'load', timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(100);

    const streams = new Map<string, ScrapedStream>();
    const addUrl = (url: string, referer?: string): void => {
        if (!url.toLowerCase().includes('.m3u8')) return;
        streams.set(url, { url: decodeHtmlAttribute(url), origin: provider, referer });
    };
    const onRequest = (request: Request): void => addUrl(request.url(), request.headers().referer);
    const onResponse = (response: PlaywrightResponse): void =>
        addUrl(response.url(), response.request().headers().referer);

    page.on('request', onRequest);
    page.on('response', onResponse);
    try {
        console.log(`🌐 Navigation ${provider} → ${pageUrl}`);
        const navigation = await page.goto(pageUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
        if (navigation && !navigation.ok()) {
            console.warn(`⚠️ Navigation LiveHD : HTTP ${navigation.status()}`);
        }
        console.log(`📄 Page chargée : ${JSON.stringify(await page.title())}`);

        const waitForFirstStream = async (timeoutMs: number): Promise<void> => {
            const deadline = Date.now() + timeoutMs;
            while (streams.size === 0 && Date.now() < deadline) {
                await page.waitForTimeout(250);
            }
        };
        const isPlayerFrame = (frameUrl: string): boolean => {
            try {
                const url = new URL(frameUrl);
                return url.hostname === 'www.livehdtv.com' &&
                    (/\/yayin\//.test(url.pathname) || /\/token\.php$/.test(url.pathname));
            } catch {
                return false;
            }
        };

        await waitForFirstStream(6000);
        if (streams.size === 0) {
            const playerFrames = page.frames().filter((frame) => isPlayerFrame(frame.url()));
            console.log(`▶️ Aucun flux automatique, tentative sur ${playerFrames.length} lecteur(s) LiveHD`);
            for (const frame of playerFrames) {
                try {
                    await frame.locator('.jw-icon-display, .jw-display-icon-container, video')
                        .first()
                        .click({ timeout: 750 });
                } catch {
                    // Le lecteur peut ne pas avoir de bouton ou être déjà actif.
                }
            }
            await waitForFirstStream(4000);
        }
        if (streams.size > 0) await page.waitForTimeout(750);

        const relevantFrames = page.frames().filter((frame) =>
            frame === page.mainFrame() || isPlayerFrame(frame.url())
        );
        console.log(`🧭 ${relevantFrames.length} frame(s) utile(s), ${streams.size} requête(s) M3U8 observée(s)`);
        relevantFrames.forEach((frame, index) => {
            console.log(`   ↳ frame ${index + 1}/${relevantFrames.length} : ${frame.url()}`);
        });

        if (streams.size === 0) {
            for (const frame of relevantFrames) {
                try {
                    for (const stream of extractM3U8UrlsFromHtml(await frame.content())) {
                        addUrl(stream.url, frame.url());
                    }
                    const resources = await frame.evaluate(() =>
                        performance.getEntriesByType('resource').map((entry) => entry.name)
                    );
                    resources.forEach((url) => addUrl(url, frame.url()));
                } catch (error) {
                    console.warn(`⚠️ Frame non lisible ${frame.url()} : ${String(error)}`);
                }
            }
        }

        if (streams.size === 0) {
            throw new Error(`${provider} n’a observé aucune URL M3U8 dans la page ou ses iframes`);
        }
        return [...streams.values()];
    } finally {
        page.off('request', onRequest);
        page.off('response', onResponse);
    }
}

async function fetchScrapedStreamsViaBrowserbase(pageUrl: string): Promise<ScrapedStream[]> {
    const { page } = await getBrowserbaseRuntime();
    return scrapeStreamsFromBrowserPage(page, pageUrl, 'Browserbase');
}

async function fetchScrapedStreamsViaBrowserless(pageUrl: string): Promise<ScrapedStream[]> {
    const { page } = await getBrowserlessRuntime();
    return scrapeStreamsFromBrowserPage(page, pageUrl, 'Browserless');
}

function isBrowserbaseProviderFailure(error: unknown): boolean {
    const message = String(error).toLowerCase();
    return [
        'browserbase nécessite',
        'création de session browserbase',
        'browserbase n’a fourni aucun contexte',
        'http 402',
        'http 403',
        'http 429',
        'insufficient credit',
        'credit limit',
        'usage limit',
        'quota',
        'plan limit',
        'browser has been closed',
        'target page, context or browser has been closed',
        'websocket',
        'econnreset',
        'econnrefused',
    ].some((pattern) => message.includes(pattern));
}

async function fetchScrapedStreamsWithFallback(pageUrl: string): Promise<ScrapedStream[]> {
    if (!browserbaseDisabledReason) {
        try {
            return await fetchScrapedStreamsViaBrowserbase(pageUrl);
        } catch (error) {
            if (!BROWSERLESS_API_KEY) throw error;

            const reason = String(error);
            if (isBrowserbaseProviderFailure(error)) {
                browserbaseDisabledReason = reason;
                console.warn(`⚠️ Browserbase indisponible pour ce run (${reason})`);
                console.warn('🔁 Basculement automatique sur Browserless pour les chaînes restantes');
                await closeBrowserbaseRuntime();
            } else {
                console.warn(`⚠️ Browserbase a échoué pour ${pageUrl} (${reason})`);
                console.warn('🔁 Tentative Browserless pour cette chaîne');
            }
        }
    } else {
        console.log(`🔁 Browserless backup actif → ${pageUrl}`);
    }

    return fetchScrapedStreamsViaBrowserless(pageUrl);
}

async function runScrapeTest(): Promise<void> {
    console.log(`🧪 Test LiveHD via Browserless : ${SCRAPE_TEST_URL}`);
    const streams = await fetchScrapedStreamsViaBrowserless(SCRAPE_TEST_URL);

    console.log(`🔎 ${streams.length} URL(s) M3U8 unique(s) trouvée(s)`);
    const results = await Promise.all(streams.map(async (stream, index) => {
        const valid = await testUrl(stream.url, 5000, 1, { Referer: stream.referer ?? SCRAPE_TEST_URL });
        console.log(`${valid ? '✅' : '❌'} [${index + 1}/${streams.length}] ${stream.origin} → ${stream.url}`);
        return valid;
    }));

    const validCount = results.filter(Boolean).length;
    console.log(`🧪 Résultat : ${validCount}/${streams.length} flux valide(s)`);
    if (validCount === 0) console.warn('⚠️ Extraction réussie, mais aucun flux extrait n’est valide');
}

// ========= Construction / MAJ de l'intermédiaire =========
async function buildIntermediateFromScratch(): Promise<Channel[]> {
    const [remoteFR, remoteUSA] = await Promise.all([
        fetchRemoteSources(SOURCES.fr.remoteUrls, 'FR'),
        fetchRemoteSources(SOURCES.usa.remoteUrls, 'USA'),
    ]);
    const testStream = createLimitedStreamTester();

    const [frChannels, usaChannels] = await Promise.all([
        enrichLocalChannelsWithValidStream(SOURCES.fr.localFile, remoteFR, false, 'FR', testStream),
        enrichLocalChannelsWithValidStream(SOURCES.usa.localFile, remoteUSA, true, 'USA', testStream),
    ]);

    const merged = [...frChannels, ...usaChannels];
    fs.writeFileSync(INTERMEDIATE_JSON, JSON.stringify(merged, null, 2), 'utf-8');
    console.log(`🧩 Intermédiaire reconstruit → ${INTERMEDIATE_JSON} (${merged.length} chaînes)`);
    return merged;
}

async function updateScrapedChannels(): Promise<Channel[]> {
    const channels = JSON.parse(await fs.promises.readFile(INTERMEDIATE_JSON, 'utf-8')) as Channel[];
    if (!Array.isArray(channels)) throw new Error(`${INTERMEDIATE_JSON} ne contient pas une liste de chaînes valide`);

    const configuredChannels = ([
        ...JSON.parse(await fs.promises.readFile(SOURCES.fr.localFile, 'utf-8')).map((channel: Channel) => ({ ...channel, country: 'FR' as Country })),
        ...JSON.parse(await fs.promises.readFile(SOURCES.usa.localFile, 'utf-8')).map((channel: Channel) => ({ ...channel, country: 'USA' as Country })),
    ] as Channel[]);
    const configByChannel = new Map(
        configuredChannels.map((channel) => [`${channel.country}:${channel.nom}`, channel])
    );
    const channelsWithCurrentScrapUrls = channels.map((channel): Channel => {
        const configured = configByChannel.get(`${channel.country}:${channel.nom}`);
        const scrapUrl = configured?.scrapUrl?.trim();
        if (scrapUrl) return { ...channel, scrapUrl };
        const { scrapUrl: _removed, ...withoutScrapUrl } = channel;
        return withoutScrapUrl;
    });

    const scrapedCount = channelsWithCurrentScrapUrls.filter((channel) => channel.scrapUrl).length;
    console.log(`🔄 Mode UPDATE : ${scrapedCount} chaîne(s) scrapUrl à actualiser sur ${channels.length}`);

    const updated = await Promise.all(channelsWithCurrentScrapUrls.map(async (channel, index): Promise<Channel> => {
        const scrapUrl = channel.scrapUrl?.trim();
        if (!scrapUrl) return channel;

        console.log(`🕸️ [${index + 1}/${channels.length}] - ${channel.nom} → mise à jour Browserbase (Browserless en backup) de ${scrapUrl}`);
        try {
            const { streams, selected } = await findFirstValidScrapedStream(scrapUrl);
            if (selected) {
                console.log(`✅ [${index + 1}/${channels.length}] - ${channel.nom} → ${selected.url} (${streams.length} extrait(s))`);
                return { ...channel, url: selected.url };
            }
            console.warn(`⚠️ [${index + 1}/${channels.length}] - ${channel.nom} → aucun flux valide, ancien lien conservé`);
        } catch (error) {
            console.warn(`⚠️ [${index + 1}/${channels.length}] - ${channel.nom} → ${String(error)}, ancien lien conservé`);
        }
        return channel;
    }));

    await fs.promises.writeFile(INTERMEDIATE_JSON, JSON.stringify(updated, null, 2), 'utf-8');
    console.log(`🧩 Intermédiaire mis à jour → ${INTERMEDIATE_JSON}`);
    return updated;
}

// ========= Génération M3U =========
function writeM3U(channels: Channel[]): void {
    const valid = channels.filter((ch) => ch.url && ch.url.trim() !== '');
    const lines = ['#EXTM3U', ...valid.map((ch) => generateM3UEntry(ch))];
    fs.writeFileSync(M3U_FILEPATH, lines.join('\n'), 'utf-8');
    console.log(`📺 tv.m3u généré avec ${valid.length} chaînes valides → ${M3U_FILEPATH}`);
}

// ========= State (fichier unique) =========
type State = {
    lastRun?: string;
    lastUpdate?: string;
    lastFull?: string;
    lastMode?: 'full' | 'update';
    lock?: boolean;
    lockStartedAt?: string;
};

async function loadState(): Promise<State> {
    try {
        const data = await fs.promises.readFile(STATE_FILE, "utf-8");
        // @ts-ignore
        return JSON.parse(data) as State;
    } catch {
        return {};
    }
}

async function saveState(state: State): Promise<void> {
    await fs.promises.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function elapsedSince(timestamp?: string, now = Date.now()): number {
    if (!timestamp) return Number.POSITIVE_INFINITY;
    const parsed = new Date(timestamp).getTime();
    return Number.isFinite(parsed) ? Math.max(0, now - parsed) : Number.POSITIVE_INFINITY;
}

function getHourInTimeZone(now: Date, timeZone: string): number {
    const hour = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(now).find((part) => part.type === 'hour')?.value;

    if (hour === undefined) throw new Error(`Impossible de déterminer l'heure dans le fuseau ${timeZone}`);
    return Number(hour);
}

function isAutoQuietHours(now = new Date()): boolean {
    const hour = getHourInTimeZone(now, AUTO_TIME_ZONE);
    return hour >= AUTO_QUIET_START_HOUR || hour < AUTO_QUIET_END_HOUR;
}

function formatAutoLocalTime(now = new Date()): string {
    return new Intl.DateTimeFormat('fr-FR', {
        timeZone: AUTO_TIME_ZONE,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).format(now);
}

async function markCompleted(mode: 'full' | 'update'): Promise<void> {
    const state = await loadState();
    const completedAt = new Date().toISOString();
    state.lastRun = completedAt;
    state.lastUpdate = completedAt;
    state.lastMode = mode;
    if (mode === 'full') state.lastFull = completedAt;
    await saveState(state);
}

function chooseAutoMode(state: State, hasIntermediate: boolean, now = Date.now()): 'full' | 'update' | 'skip' {
    if (!hasIntermediate) return 'full';
    if (elapsedSince(state.lastFull, now) >= FULL_INTERVAL_MS) return 'full';
    if (elapsedSince(state.lastUpdate ?? state.lastRun, now) >= UPDATE_INTERVAL_MS) return 'update';
    return 'skip';
}

async function acquireLock(): Promise<() => Promise<void>> {
    const state = await loadState();
    const lockAgeMs = state.lockStartedAt ? Date.now() - new Date(state.lockStartedAt).getTime() : 0;
    const lockExpired = state.lock && (!state.lockStartedAt || lockAgeMs >= LOCK_TIMEOUT_MS);

    if (state.lock && !lockExpired) {
        const ageMin = Math.max(0, Math.ceil(lockAgeMs / 60000));
        throw new Error(`Lock présent depuis ~${ageMin} min: un run est déjà en cours.`);
    }

    if (lockExpired) {
        const ageMin = state.lockStartedAt ? Math.max(0, Math.ceil(lockAgeMs / 60000)) : 'inconnu';
        console.warn(`⚠️ Lock expiré détecté (${ageMin} min), reprise du run.`);
    }

    state.lock = true;
    state.lockStartedAt = new Date().toISOString();
    await saveState(state);
    return async () => {
        const s = await loadState();
        s.lock = false;
        delete s.lockStartedAt;
        await saveState(s);
    };
}

// ========= Main =========
// Retourne: "full" | "update" | "test" | "skip"
async function main(): Promise<"full" | "update" | "test" | "skip"> {
    const mode = (process.argv[2] || 'full').toLowerCase();
    if (!['full', 'update', 'auto', 'test'].includes(mode)) {
        console.error(`Mode inconnu "${mode}". Utilise "full", "update", "auto" ou "test".`);
        return "skip";
    }

    if (mode === 'test') {
        await runScrapeTest();
        return 'test';
    }

    let chosen: 'full' | 'update' | 'skip';
    if (mode === 'auto') {
        if (isAutoQuietHours()) {
            console.log(
                `Auto: pause nocturne à ${formatAutoLocalTime()} (${AUTO_TIME_ZONE}), ` +
                `aucun scraping entre ${AUTO_QUIET_START_HOUR}h et ${AUTO_QUIET_END_HOUR}h.`,
            );
            return 'skip';
        }

        const state = await loadState();
        chosen = chooseAutoMode(state, fs.existsSync(INTERMEDIATE_JSON));
        if (chosen === 'skip') {
            const sinceUpdate = elapsedSince(state.lastUpdate ?? state.lastRun);
            const sinceFull = elapsedSince(state.lastFull);
            const nextUpdateInMin = Math.max(0, Math.ceil((UPDATE_INTERVAL_MS - sinceUpdate) / 60000));
            const nextFullInMin = Math.max(0, Math.ceil((FULL_INTERVAL_MS - sinceFull) / 60000));
            console.log(`⏭️ Auto: rien à faire. Prochain update dans ~${nextUpdateInMin} min, prochain full dans ~${nextFullInMin} min.`);
            return 'skip';
        }
        console.log(`🤖 Auto sélectionne le mode ${chosen.toUpperCase()}`);
    } else {
        chosen = mode as 'full' | 'update';
    }

    if (chosen === 'update' && !fs.existsSync(INTERMEDIATE_JSON)) {
        console.warn(`⚠️ ${INTERMEDIATE_JSON} absent : bascule du mode UPDATE vers FULL`);
        chosen = 'full';
    }

    let channels: Channel[];
    if (chosen === 'full') {
        console.log('Mode FULL : reconstruction complète…');
        channels = await buildIntermediateFromScratch();
    } else {
        channels = await updateScrapedChannels();
    }

    writeM3U(channels);
    await markCompleted(chosen);
    return chosen;
}

// ========= Launcher (un run puis sortie) =========
(async () => {
    // Anti-chevauchement
    let release = async () => {};
    const isTestMode = (process.argv[2] || 'full').toLowerCase() === 'test';
    if (!isTestMode) {
        try {
            release = await acquireLock();
        } catch (e) {
            console.log(String(e));
            process.exit(0); // réessaiera au prochain tick launchd
        }
    }

    let exitCode = 0;
    try {
        console.log(`🚀 Run démarré le ${new Date().toLocaleString()}`);
        const result = await main();
        if (result === "skip") {
            console.log('⏭️ Skip: aucune action requise');
        } else {
            console.log(`✅ Terminé (${result}) le ${new Date().toLocaleString()}`);
        }
    } catch (err) {
        console.error('❌ Run échoué:', err);
        exitCode = 1;
    } finally {
        await closeBrowserRuntimes();
        await release();
    }
    process.exit(exitCode);
})();
