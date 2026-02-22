import skilldata from '../uma-skill-tools/data/skill_data.json';
import umas from '../umas.json';

const HORSE_SLOTS_KEY = 'umalator_horse_slots';

const VALID_STRATEGIES = ['Nige', 'Senkou', 'Sasi', 'Oikomi', 'Oonige'];
const VALID_APTITUDES  = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];

export interface UmaState {
    outfitId: string;
    speed: number;
    stamina: number;
    power: number;
    guts: number;
    wisdom: number;
    strategy: string;
    distanceAptitude: string;
    surfaceAptitude: string;
    strategyAptitude: string;
    mood: number;
    skills: string[];
    forcedSkillPositions: Record<string, number>;
}

export function validateAndParseUmaJson(json: any): UmaState | null {
    if (!json || typeof json !== 'object') return null;

    for (const f of ['speed', 'stamina', 'power', 'guts', 'wisdom', 'mood']) {
        if (typeof json[f] !== 'number') return null;
    }
    for (const f of ['strategy', 'distanceAptitude', 'surfaceAptitude', 'strategyAptitude']) {
        if (typeof json[f] !== 'string') return null;
    }

    if (!VALID_STRATEGIES.includes(json.strategy)) return null;
    if (!VALID_APTITUDES.includes(json.distanceAptitude)) return null;
    if (!VALID_APTITUDES.includes(json.surfaceAptitude)) return null;
    if (!VALID_APTITUDES.includes(json.strategyAptitude)) return null;
    if (json.mood < -2 || json.mood > 2) return null;
    if (!Array.isArray(json.skills)) return null;

    const validSkills = json.skills.filter((id: any) => {
        if (typeof id !== 'string') return false;
        return (skilldata as any)[id.split('-')[0]];
    });

    const forcedSkillPositions: Record<string, number> = {};
    if (json.forcedSkillPositions && typeof json.forcedSkillPositions === 'object') {
        for (const [skillId, pos] of Object.entries(json.forcedSkillPositions)) {
            const num = typeof pos === 'number' ? pos : parseFloat(pos as string);
            if (!isNaN(num)) forcedSkillPositions[skillId] = num;
        }
    }

    return {
        outfitId: typeof json.outfitId === 'string' ? json.outfitId : '',
        speed:    Math.max(1, Math.min(2000, json.speed)),
        stamina:  Math.max(1, Math.min(2000, json.stamina)),
        power:    Math.max(1, Math.min(2000, json.power)),
        guts:     Math.max(1, Math.min(2000, json.guts)),
        wisdom:   Math.max(1, Math.min(2000, json.wisdom)),
        strategy:          json.strategy,
        distanceAptitude:  json.distanceAptitude,
        surfaceAptitude:   json.surfaceAptitude,
        strategyAptitude:  json.strategyAptitude,
        mood:              json.mood,
        skills:            validSkills,
        forcedSkillPositions,
    };
}

export interface SavedSlot {
    name: string;
    data: UmaState;
    savedAt: number;
    memo?: string;
}

function getRawSlots(): Record<string, { data: any; savedAt: number; memo?: string }> {
    try {
        const stored = localStorage.getItem(HORSE_SLOTS_KEY);
        return stored ? JSON.parse(stored) : {};
    } catch {
        return {};
    }
}

export function getSavedSlotNames(): string[] {
    const slots = getRawSlots();
    return Object.keys(slots).sort((a, b) => (slots[b].savedAt || 0) - (slots[a].savedAt || 0));
}

export function saveHorseSlot(name: string, horse: UmaState, memo?: string): boolean {
    try {
        const slots = getRawSlots();
        const existingMemo = slots[name]?.memo;
        slots[name] = {
            data: horse,
            savedAt: Date.now(),
            memo: memo !== undefined ? memo : existingMemo || '',
        };
        localStorage.setItem(HORSE_SLOTS_KEY, JSON.stringify(slots));
        return true;
    } catch {
        return false;
    }
}

export function loadHorseSlot(name: string): UmaState | null {
    const slots = getRawSlots();
    if (!slots[name]) return null;
    return validateAndParseUmaJson(slots[name].data);
}

export function deleteHorseSlot(name: string): boolean {
    try {
        const slots = getRawSlots();
        delete slots[name];
        localStorage.setItem(HORSE_SLOTS_KEY, JSON.stringify(slots));
        return true;
    } catch {
        return false;
    }
}

export function downloadHorseJson(horse: UmaState): void {
    const blob = new Blob([JSON.stringify(horse, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    let name = 'horse';
    if (horse.outfitId) {
        const uma = (umas as any)[horse.outfitId.slice(0, 4)];
        if (uma?.name?.[1]) name = uma.name[1].replace(/\s+/g, '_');
    }
    a.download = `${name}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

export function importHorseJson(): Promise<UmaState | null> {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) { resolve(null); return; }
            try {
                const text = await file.text();
                resolve(validateAndParseUmaJson(JSON.parse(text)));
            } catch {
                resolve(null);
            }
        };
        input.oncancel = () => resolve(null);
        input.click();
    });
}

export async function copyHorseToClipboard(horse: UmaState): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(JSON.stringify(horse, null, 2));
        return true;
    } catch {
        return false;
    }
}

export async function pasteHorseFromClipboard(): Promise<UmaState | null> {
    try {
        const text = await navigator.clipboard.readText();
        return validateAndParseUmaJson(JSON.parse(text));
    } catch {
        return null;
    }
}

export function getStoredApiKey(): string | null {
    try { return localStorage.getItem('gemini_api_key'); } catch { return null; }
}
export function storeApiKey(key: string): void {
    try { localStorage.setItem('gemini_api_key', key); } catch {}
}
export function clearStoredApiKey(): void {
    try { localStorage.removeItem('gemini_api_key'); } catch {}
}
