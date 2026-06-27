import fs from 'fs';

// ========= Config fichiers =========
const M3U_FILEPATH = "./tv.m3u";
const INTERMEDIATE_JSON = "./tv-merged.json";
const STATE_FILE = "./.state.json"; // lastRun, lastFull, lock
const SCRAPE_TEST_URL = 'https://www.stream4free.tv/tf1-live-streaming';

// Intervalles
const UPDATE_INTERVAL_MS = 2 * 60 * 60 * 1000;  // 2h
const FULL_INTERVAL_MS   = 24 * 60 * 60 * 1000; // 24h
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
        return await fetch(url, {
            ...init,
            signal: controller.signal,
            redirect: 'follow',
        });
    } finally {
        clearTimeout(timeout);
    }
}

async function testUrl(url: string, timeoutMs = 3000, retries = 2): Promise<boolean> {
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
            const isM3u8 = url.toLowerCase().includes('.m3u8');

            if (isM3u8) {
                const response = await fetchWithTimeout(url, {
                    method: 'GET',
                    headers: STREAM_HEADERS,
                }, timeoutMs);

                if (!response.ok) {
                    console.warn(`⚠️ Test échoué ${url} → HTTP ${response.status}`);
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
                    'Range': 'bytes=0-1024',
                },
            }, timeoutMs);

            if (response.status >= 200 && response.status < 400) {
                return true;
            }

            console.warn(`⚠️ Test échoué ${url} → HTTP ${response.status}`);
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

async function findFirstValidStream<T extends { url: string }>(
    candidates: T[],
    testStream: (url: string) => Promise<boolean>,
    concurrency = STREAM_TEST_CONCURRENCY
): Promise<T | null> {
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
        // Le scraping est exclusif : aucun fallback vers url ou les sources distantes.
        if (local.scrapUrl?.trim()) {
            const scrapUrl = local.scrapUrl.trim();
            console.log(`🕸️ [${i + 1}/${localChannels.length}] - ${local.nom} → scraping prioritaire de ${scrapUrl}`);

            try {
                const streams = await fetchScrapedStreams(scrapUrl);
                console.log(`🔎 ${local.nom} → ${streams.length} URL(s) M3U8 extraite(s), recherche classique ignorée`);
                const selected = await findFirstValidStream(streams, testStream);

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

        // URL déjà renseignée
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
    origin: 'source HTML' | 'JSON-LD';
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

    const unique = new Map<string, ScrapedStream>();
    candidates
        .filter((candidate) => candidate.url.toLowerCase().includes('.m3u8'))
        .forEach((candidate) => unique.set(candidate.url, candidate));
    return [...unique.values()];
}

async function fetchScrapedStreams(pageUrl: string): Promise<ScrapedStream[]> {
    const response = await fetchWithTimeout(pageUrl, {
        headers: {
            ...STREAM_HEADERS,
            Accept: 'text/html,application/xhtml+xml',
        },
    }, 15000);
    if (!response.ok) throw new Error(`page inaccessible : HTTP ${response.status}`);

    const streams = extractM3U8UrlsFromHtml(await response.text());
    if (streams.length === 0) throw new Error('aucune URL M3U8 trouvée dans la page');
    return streams;
}

async function runScrapeTest(): Promise<void> {
    console.log(`🧪 Test du scraping : ${SCRAPE_TEST_URL}`);
    const streams = await fetchScrapedStreams(SCRAPE_TEST_URL);

    console.log(`🔎 ${streams.length} URL(s) M3U8 unique(s) trouvée(s)`);
    const testStream = createLimitedStreamTester();
    const results = await Promise.all(streams.map(async (stream, index) => {
        const valid = await testStream(stream.url);
        console.log(`${valid ? '✅' : '❌'} [${index + 1}/${streams.length}] ${stream.origin} → ${stream.url}`);
        return valid;
    }));

    const validCount = results.filter(Boolean).length;
    console.log(`🧪 Résultat : ${validCount}/${streams.length} flux valide(s)`);
    if (validCount === 0) throw new Error('Le scraping fonctionne, mais aucun flux extrait n’est valide');
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
    lastFull?: string;
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

async function elapsedSince(key: "lastRun" | "lastFull"): Promise<number> {
    const state = await loadState();
    const ts = state[key] ? new Date(state[key]!).getTime() : 0;
    return ts ? Date.now() - ts : Number.POSITIVE_INFINITY;
}

async function markRun(): Promise<void> {
    const state = await loadState();
    state.lastRun = new Date().toISOString();
    await saveState(state);
}

async function markFull(): Promise<void> {
    const state = await loadState();
    state.lastFull = new Date().toISOString();
    await saveState(state);
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

    try {
        let chosen: "full" | "update" | "skip" = "skip";

        if (mode === "auto") {
            // 1) Si pas d'intermédiaire -> full
            if (!fs.existsSync(INTERMEDIATE_JSON)) {
                chosen = "full";
            } else {
                const sinceFull = await elapsedSince("lastFull");
                const sinceRun  = await elapsedSince("lastRun");

                if (sinceFull >= FULL_INTERVAL_MS) {
                    chosen = "full";
                } else if (sinceRun >= UPDATE_INTERVAL_MS) {
                    chosen = "update";
                } else {
                    const nextUpdateInMin = Math.max(0, Math.ceil((UPDATE_INTERVAL_MS - sinceRun) / 60000));
                    const nextFullInMin   = Math.max(0, Math.ceil((FULL_INTERVAL_MS   - sinceFull) / 60000));
                    console.log(`⏭️ Auto: rien à faire. Prochain update dans ~${nextUpdateInMin} min, prochain full dans ~${nextFullInMin} min.`);
                    return "skip";
                }
            }
        } else {
            chosen = mode as "full" | "update";
        }

        let channels: Channel[];

        console.log('Mode FULL : reconstruction complète…');
        channels = await buildIntermediateFromScratch();

        writeM3U(channels);

        // Marquages
        await markRun();
        if (chosen === 'full') await markFull();

        return chosen;
    } catch (e) {
        console.error('Erreur fatale :', e);
        return "skip";
    }
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

    try {
        console.log(`🚀 Run démarré le ${new Date().toLocaleString()}`);
        const result = await main();
        if (result === "skip") {
            console.log('⏭️ Skip: aucune action requise');
        } else {
            console.log(`✅ Terminé (${result}) le ${new Date().toLocaleString()}`);
        }
        await release();
        process.exit(0);
    } catch (err) {
        console.error('❌ Run échoué:', err);
        await release();
        process.exit(1);
    }
})();
