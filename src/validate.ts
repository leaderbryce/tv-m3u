import fs from 'fs';

type Channel = {
    nom?: unknown;
    identifiant?: unknown;
    logo?: unknown;
    group?: unknown;
    url?: unknown;
    tvgId?: unknown;
    scrapUrl?: unknown;
};

const CHANNEL_FILES = ['./src/tv-fr.json', './src/tv-usa.json'];
const M3U_FILE = './tv.m3u';

const errors: string[] = [];

function addError(message: string): void {
    errors.push(message);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '';
}

function validateIdentifier(value: unknown): boolean {
    if (isNonEmptyString(value)) return true;
    return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

for (const file of CHANNEL_FILES) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Channel[];

    if (!Array.isArray(parsed)) {
        addError(`${file}: le contenu doit être un tableau`);
        continue;
    }

    parsed.forEach((channel, index) => {
        const label = `${file}[${index}]`;

        if (!isNonEmptyString(channel.nom)) addError(`${label}: nom manquant`);
        if (!validateIdentifier(channel.identifiant)) addError(`${label}: identifiant invalide`);
        if (!isNonEmptyString(channel.logo)) addError(`${label}: logo manquant`);
        if (!isNonEmptyString(channel.group)) addError(`${label}: group manquant`);
        if (typeof channel.tvgId !== 'string') addError(`${label}: tvgId doit être une chaîne`);
        if (typeof channel.url !== 'string') addError(`${label}: url doit être une chaîne`);
        if ('scrapUrl' in channel) addError(`${label}: scrapUrl n'est plus utilisé`);
    });

    console.log(`OK ${file}: ${parsed.length} chaînes`);
}

if (fs.existsSync(M3U_FILE)) {
    const lines = fs.readFileSync(M3U_FILE, 'utf-8').split(/\r?\n/).filter(Boolean);

    if (lines[0] !== '#EXTM3U') addError(`${M3U_FILE}: en-tête #EXTM3U manquant`);

    const extinfCount = lines.filter((line) => line.startsWith('#EXTINF')).length;
    const urlCount = lines.filter((line) => !line.startsWith('#')).length;

    if (extinfCount !== urlCount) {
        addError(`${M3U_FILE}: ${extinfCount} entrées #EXTINF pour ${urlCount} URLs`);
    }

    console.log(`OK ${M3U_FILE}: ${extinfCount} chaînes`);
}

if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join('\n'));
    process.exit(1);
}

console.log('Validation OK');
