import fs from 'fs';

// ========= Config fichiers =========
const M3U_FILEPATH = "./tv.m3u";
const INTERMEDIATE_JSON = "./tv-merged.json";
const STATE_FILE = "./.state.json"; // lastRun, lastFull, lock

// Intervalles
const UPDATE_INTERVAL_MS = 2 * 60 * 60 * 1000;  // 2h
const FULL_INTERVAL_MS   = 24 * 60 * 60 * 1000; // 24h

// ========= Types =========
type Country = 'FR' | 'USA';

type Channel = {
    nom: string;
    identifiant: string | string[];
    logo: string;
    group: string;
    url: string;
    tvgId: string;
    scrapUrl: string | null;
    country?: Country;
};

type RemoteChannel = {
    name: string;
    url: string;
    group: string;
};

// ========= Sources =========
const SOURCES = {
    fr: {
        localFile: './src/tv-fr.json',
        remoteUrl: 'https://raw.githubusercontent.com/bugsfreeweb/LiveTVCollector/refs/heads/main/LiveTV/France/LiveTV.json',
    },
    usa: {
        localFile: './src/tv-usa.json',
        remoteUrl: 'https://raw.githubusercontent.com/bugsfreeweb/LiveTVCollector/refs/heads/main/LiveTV/USA/LiveTV.json',
    },
};

// ========= Utilitaires =========
async function fetchAllRemoteChannels(remoteUrl: string): Promise<RemoteChannel[]> {
    const data = await fetch(remoteUrl).then((res) => res.json() as Promise<any>);
    const all: RemoteChannel[] = [];
    for (const group in data.channels) {
        const groupChannels = data.channels[group];
        if (Array.isArray(groupChannels)) {
            groupChannels.forEach((ch: any) => {
                if (ch.name && ch.url) {
                    all.push({ name: String(ch.name).trim(), url: String(ch.url), group });
                }
            });
        }
    }
    return all;
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

async function enrichLocalChannelsWithValidStream(
    localPath: string,
    remoteChannels: RemoteChannel[],
    isUSA: boolean = false,
    country: Country = 'FR'
): Promise<Channel[]> {
    const localChannels: Channel[] = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
    const enriched: Channel[] = [];

    for (let i = 0; i < localChannels.length; i++) {
        const local = localChannels[i];

        // 1) URL déjà renseignée
        if (local.url && local.url.trim() !== '') {
            console.log(`✅ ${local.nom} → ${local.url}`);
            enriched.push({ ...local, url: local.url, country });
            continue;
        }

        // 3) Matching distant
        const identifiants = Array.isArray(local.identifiant)
            ? local.identifiant.map((id) => String(id).toLowerCase())
            : [String(local.identifiant).toLowerCase()];

        const allMatches: RemoteChannel[] = [];
        identifiants.forEach((id) => {
            const matchesForId = remoteChannels
                .filter((rc) => rc.name.toLowerCase() === id)
                .sort((a, b) => getPriority(a.group, isUSA) - getPriority(b.group, isUSA));
            allMatches.push(...matchesForId);
        });

        let selectedUrl = '';
        let selectedGroup = '';
        for (const candidate of allMatches) {
            const valid = await testUrl(candidate.url, 3000, 2);
            if (valid) {
                selectedUrl = candidate.url;
                selectedGroup = candidate.group;
                break;
            }
        }

        if (selectedUrl) {
            console.log(`✅ [${i + 1}/${localChannels.length}] - ${local.nom} → ${selectedUrl} [${selectedGroup}]`);
        } else {
            console.log(`❌ [${i + 1}/${localChannels.length}] - ${local.nom} → aucun flux valide`);
        }

        enriched.push({ ...local, url: selectedUrl, country });
    }

    return enriched;
}

function generateM3UEntry(channel: Channel): string {
    return `#EXTINF:-1 tvg-id="${channel.tvgId}" tvg-logo="${channel.logo}" group-title="LIVETV;${channel.group}",${channel.nom}
${channel.url}`;
}

// ========= Construction / MAJ de l'intermédiaire =========
async function buildIntermediateFromScratch(): Promise<Channel[]> {
    const [remoteFR, remoteUSA] = await Promise.all([
        fetchAllRemoteChannels(SOURCES.fr.remoteUrl),
        fetchAllRemoteChannels(SOURCES.usa.remoteUrl),
    ]);

    const frChannels = await enrichLocalChannelsWithValidStream(SOURCES.fr.localFile, remoteFR, false, 'FR');
    const usaChannels = await enrichLocalChannelsWithValidStream(SOURCES.usa.localFile, remoteUSA, true, 'USA');

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
    if (state.lock) throw new Error('Lock présent: un run est déjà en cours.');
    state.lock = true;
    await saveState(state);
    return async () => {
        const s = await loadState();
        s.lock = false;
        await saveState(s);
    };
}

// ========= Main =========
// Retourne: "full" | "update" | "skip"
async function main(): Promise<"full" | "update" | "skip"> {
    const mode = (process.argv[2] || 'full').toLowerCase();
    if (!['full', 'update', 'auto'].includes(mode)) {
        console.error(`Mode inconnu "${mode}". Utilise "full", "update" ou "auto".`);
        return "skip";
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
    try {
        release = await acquireLock();
    } catch (e) {
        console.log(String(e));
        process.exit(0); // réessaiera au prochain tick launchd
    }

    try {
        console.log(`🚀 Run démarré le ${new Date().toLocaleString()}`);
        const result = await main();
        if (result === "skip") {
            console.log('⏭️ Skip: aucune action requise.');
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
