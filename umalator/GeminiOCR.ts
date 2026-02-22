import skillnames from '../uma-skill-tools/data/skillnames.json';
import skilldata from '../uma-skill-tools/data/skill_data.json';
import umas from '../umas.json';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent';

export interface OCRHorseData {
    name: string;
    outfit: string;
    speed: number;
    stamina: number;
    power: number;
    guts: number;
    wisdom: number;
    surfaceAptitude: string;
    distanceAptitude: string;
    strategyAptitude: string;
    strategy: string;
    skills: string[];
}

export interface OCRResult {
    success: boolean;
    data?: OCRHorseData;
    error?: string;
    rawResponse?: string;
}

function normalizeSkillName(name: string): string {
    return name.toLowerCase()
        .replace(/[◯⭕◦⃝]/g, '○')
        .replace(/[⦿⊚]/g, '◎')
        .replace(/[✕✖]/g, '×')
        .replace(/\s+[Oo0]$/g, '○')
        .replace(/\s+[Xx]$/g, '×')
        .replace(/[\s\-_・!！?？,、.。:：;；'"'"「」『』【】()（）\[\]☆★]/g, '')
        .trim();
}

const skillNameToIdMap: Map<string, string> = new Map();

for (const [skillId, names] of Object.entries(skillnames)) {
    if (!(skilldata as any)[skillId.split('-')[0]]) continue;
    const [jaName, enName] = names as [string, string];
    if (jaName) skillNameToIdMap.set(normalizeSkillName(jaName), skillId);
    if (enName) skillNameToIdMap.set(normalizeSkillName(enName), skillId);
}

export function mapSkillNamesToIds(skillNames: string[]): string[] {
    const result: string[] = [];
    for (const name of skillNames) {
        const normalized = normalizeSkillName(name);
        const id = skillNameToIdMap.get(normalized);
        if (id) {
            result.push(id);
        } else {
            for (const [mapName, mapId] of skillNameToIdMap.entries()) {
                if (mapName.includes(normalized) || normalized.includes(mapName)) {
                    result.push(mapId);
                    break;
                }
            }
        }
    }
    return result;
}

function normalizeEpithet(epithet: string): string {
    return epithet.toLowerCase()
        .replace(/[\[\]「」『』【】]/g, '')
        .replace(/[\s\-_・☆★♪]/g, '')
        .trim();
}

const epithetToOutfitMap: Map<string, string> = new Map();

for (const [, umaData] of Object.entries(umas)) {
    const outfits = (umaData as any).outfits;
    if (!outfits) continue;
    for (const [outfitId, epithet] of Object.entries(outfits)) {
        if (typeof epithet === 'string') {
            epithetToOutfitMap.set(normalizeEpithet(epithet), outfitId);
        }
    }
}

export function mapOutfitNameToId(outfit: string): string {
    if (!outfit) return '';
    const normalized = normalizeEpithet(outfit);
    const id = epithetToOutfitMap.get(normalized);
    if (id) return id;
    for (const [mapEpithet, mapId] of epithetToOutfitMap.entries()) {
        if (mapEpithet.includes(normalized) || normalized.includes(mapEpithet)) return mapId;
    }
    return '';
}

function normalizeCharacterName(name: string): string {
    return name.toLowerCase().replace(/[\s\-_・.]/g, '').trim();
}

const characterNameToOutfitMap: Map<string, string> = new Map();

for (const [, umaData] of Object.entries(umas)) {
    const name = (umaData as any).name?.[1];
    const outfits = (umaData as any).outfits;
    if (!name || !outfits) continue;
    const firstOutfitId = Object.keys(outfits)[0];
    if (firstOutfitId) characterNameToOutfitMap.set(normalizeCharacterName(name), firstOutfitId);
}

export function mapCharacterNameToOutfitId(characterName: string): string {
    if (!characterName) return '';
    const normalized = normalizeCharacterName(characterName);
    const id = characterNameToOutfitMap.get(normalized);
    if (id) return id;
    for (const [mapName, mapId] of characterNameToOutfitMap.entries()) {
        if (mapName.includes(normalized) || normalized.includes(mapName)) return mapId;
    }
    return '';
}

const EXTRACTION_PROMPT = `Analyze this Uma Musume game screenshot and extract the horse's data.

Return ONLY a valid JSON object with this exact structure (no markdown, no explanation):
{
  "name": "character name (e.g., 'El Condor Pasa', 'Taiki Shuttle')",
  "outfit": "outfit name in brackets (e.g., '[El☆Número 1]', '[Wild Frontier]')",
  "speed": <number>,
  "stamina": <number>,
  "power": <number>,
  "guts": <number>,
  "wisdom": <number>,
  "surfaceAptitude": "<S|A|B|C|D|E|F|G for Turf>",
  "distanceAptitude": "<best grade among Sprint/Mile/Medium/Long>",
  "strategyAptitude": "<best grade among Front/Pace/Late/End styles>",
  "strategy": "<style with best grade: 'Nige'=Front, 'Senkou'=Pace, 'Sasi'=Late, 'Oikomi'=End>",
  "skills": ["skill name 1", "skill name 2", ...]
}

Extract ALL visible skill names exactly as shown. Include circle symbols (○, ◎, ×) after skill names — these are grade indicators, not icons.`;

export async function extractHorseDataFromImage(
    imageBase64: string,
    mimeType: string,
    apiKey: string
): Promise<OCRResult> {
    try {
        const body = {
            contents: [{
                parts: [
                    { inline_data: { mime_type: mimeType, data: imageBase64 } },
                    { text: EXTRACTION_PROMPT }
                ]
            }],
            generationConfig: { temperature: 0.1, topK: 1, topP: 0.8, maxOutputTokens: 2048 }
        };

        const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error?.message || `API error ${response.status}`);
        }

        const result = await response.json();
        let text = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error('No response from Gemini API');

        if (text.startsWith('```json')) text = text.slice(7);
        else if (text.startsWith('```')) text = text.slice(3);
        if (text.endsWith('```')) text = text.slice(0, -3);
        text = text.trim();

        let data: OCRHorseData;
        try {
            data = JSON.parse(text);
        } catch (e) {
            throw new Error(`Invalid JSON from AI: ${e instanceof Error ? e.message : 'parse error'}`);
        }

        if (['speed', 'stamina', 'power', 'guts', 'wisdom'].some(f => typeof (data as any)[f] !== 'number')) {
            throw new Error('Invalid stat values in response');
        }

        return { success: true, data, rawResponse: text };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

export function fileToBase64(file: File): Promise<{ base64: string; mimeType: string }> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result as string;
            resolve({ base64: result.split(',')[1], mimeType: file.type });
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
    });
}
