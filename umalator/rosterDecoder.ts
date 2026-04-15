const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

class BitVector {
    private readonly bits: number[];
    private pos: number;

    constructor(bits: number[] = []) {
        this.bits = bits;
        this.pos = 0;
    }

    read(n: number): number {
        let v = 0;
        for (let i = 0; i < n; i++) {
            v = (v << 1) | (this.pos < this.bits.length ? this.bits[this.pos++] : 0);
        }
        return v;
    }

    remaining(): number {
        return this.bits.length - this.pos;
    }

    static fromBase64(str: string): BitVector {
        const bits: number[] = [];
        for (const element of str) {
            const v = B64.indexOf(element);
            if (v < 0) continue;
            for (let j = 5; j >= 0; j--) bits.push((v >> j) & 1);
        }
        return new BitVector(bits);
    }
}

function b64ToBytes(str: string): Uint8Array {
    const result: number[] = [];
    for (let i = 0; i < str.length; i += 4) {
        const a = B64.indexOf(str[i] ?? '');
        const b = B64.indexOf(str[i + 1] ?? '');
        const c = B64.indexOf(str[i + 2] ?? '');
        const d = B64.indexOf(str[i + 3] ?? '');
        if (a >= 0 && b >= 0) result.push((a << 2) | (b >> 4));
        if (b >= 0 && c >= 0 && i + 2 < str.length) result.push(((b & 0xf) << 4) | (c >> 2));
        if (c >= 0 && d >= 0 && i + 3 < str.length) result.push(((c & 0x3) << 6) | d);
    }
    return new Uint8Array(result);
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
    const ds = new globalThis.DecompressionStream('gzip');
    const stream = (new Blob([data as any]).stream() as any).pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function bytesToB64(bytes: Uint8Array): string {
    let result = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i], b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0;
        result += B64[a >> 2];
        result += B64[((a & 3) << 4) | (b >> 4)];
        result += i + 1 < bytes.length ? B64[((b & 0xf) << 2) | (c >> 6)] : '';
        result += i + 2 < bytes.length ? B64[c & 0x3f] : '';
    }
    return result;
}

async function gzip(text: string): Promise<Uint8Array> {
    const cs = new globalThis.CompressionStream('gzip');
    const stream = (new Blob([text]).stream() as any).pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function saveRoster(umas: DecodedUma[]): Promise<string> {
    const compressed = await gzip(JSON.stringify(umas));
    return bytesToB64(compressed);
}

export async function loadRoster(stored: string): Promise<DecodedUma[]> {
    const bytes = b64ToBytes(stored);
    const decompressed = await gunzip(bytes);
    const json = new TextDecoder().decode(decompressed);
    return JSON.parse(json);
}

export interface DecodedUma {
    card_id: number;
    talent_level?: number;
    rank_score?: number;
    create_time?: string;
    speed: number;
    stamina: number;
    power: number;
    guts: number;
    wisdom: number;
    // aptitude values: V4 = 1-8, V1 = 0-9
    apt_short: number;
    apt_mile: number;
    apt_middle: number;
    apt_long: number;
    apt_turf: number;
    apt_dirt: number;
    apt_nige: number;
    apt_senko: number;
    apt_sashi: number;
    apt_oikomi: number;
    skills: Array<{ id: number; level: number }>;
}

function readV4Uma(bv: BitVector): DecodedUma | null {
    if (bv.remaining() < 109) return null;

    const card_id = bv.read(20);
    const talent_level = bv.read(3) + 1;
    const has_rank = bv.read(1) === 1;
    const rank_score = has_rank ? bv.read(15) : undefined;

    const speed   = bv.read(11);
    const stamina = bv.read(11);
    const power   = bv.read(11);
    const guts    = bv.read(11);
    const wisdom  = bv.read(11);

    // Stored as aptitude-1 (0-7), actual = value+1 (1-8)
    const apt_short   = bv.read(3) + 1;
    const apt_mile    = bv.read(3) + 1;
    const apt_middle  = bv.read(3) + 1;
    const apt_long    = bv.read(3) + 1;
    const apt_turf    = bv.read(3) + 1;
    const apt_dirt    = bv.read(3) + 1;
    const apt_nige    = bv.read(3) + 1;
    const apt_senko   = bv.read(3) + 1;
    const apt_sashi   = bv.read(3) + 1;
    const apt_oikomi  = bv.read(3) + 1;

    const factor_count = bv.read(4);
    for (let i = 0; i < factor_count; i++) bv.read(24);

    const skill_count = bv.read(6);
    const skills: Array<{ id: number; level: number }> = [];
    for (let i = 0; i < skill_count; i++) {
        const id = bv.read(20);
        const lvl = bv.read(1) === 0 ? 1 : 2;
        skills.push({ id, level: lvl });
    }

    const parent_count = bv.read(2);
    for (let p = 0; p < parent_count; p++) {
        bv.read(20);
        bv.read(3);
        const pfc = bv.read(4);
        for (let i = 0; i < pfc; i++) bv.read(24);
    }

    return {
        card_id, talent_level, rank_score,
        speed, stamina, power, guts, wisdom,
        apt_short, apt_mile, apt_middle, apt_long,
        apt_turf, apt_dirt,
        apt_nige, apt_senko, apt_sashi, apt_oikomi,
        skills,
    };
}

function formatCreateTime(sec: number): string {
    const d = new Date(sec * 1000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const h = String(d.getUTCHours()).padStart(2, '0');
    const min = String(d.getUTCMinutes()).padStart(2, '0');
    const s = String(d.getUTCSeconds()).padStart(2, '0');
    return `${y}-${m}-${day} ${h}:${min}:${s}`;
}

function readV2Uma(bv: BitVector): DecodedUma | null {
    if (bv.remaining() < 162) return null;

    const card_id = bv.read(20);
    const speed   = bv.read(11);
    const stamina = bv.read(11);
    const power   = bv.read(11);
    const guts    = bv.read(11);
    const wisdom  = bv.read(11);

    const apt_short   = bv.read(4);
    const apt_mile    = bv.read(4);
    const apt_middle  = bv.read(4);
    const apt_long    = bv.read(4);
    const apt_turf    = bv.read(4);
    const apt_dirt    = bv.read(4);
    const apt_nige    = bv.read(4);
    const apt_senko   = bv.read(4);
    const apt_sashi   = bv.read(4);
    const apt_oikomi  = bv.read(4);

    const create_time = formatCreateTime(bv.read(32));
    const has_rank = bv.read(1) === 1;
    const rank_score = has_rank ? bv.read(15) : undefined;

    const skill_count = bv.read(6);
    const skills: Array<{ id: number; level: number }> = [];
    for (let i = 0; i < skill_count && bv.remaining() >= 24; i++) {
        const id = bv.read(20);
        const level = bv.read(4) + 1;
        skills.push({ id, level });
    }

    return {
        card_id,
        rank_score,
        create_time,
        speed, stamina, power, guts, wisdom,
        apt_short, apt_mile, apt_middle, apt_long,
        apt_turf, apt_dirt,
        apt_nige, apt_senko, apt_sashi, apt_oikomi,
        skills,
    };
}

function readV1Uma(bv: BitVector): DecodedUma | null {
    if (bv.remaining() < 129) return null;

    const card_id = bv.read(20);
    const speed   = bv.read(11);
    const stamina = bv.read(11);
    const power   = bv.read(11);
    const guts    = bv.read(11);
    const wisdom  = bv.read(11);

    const apt_short   = bv.read(4);
    const apt_mile    = bv.read(4);
    const apt_middle  = bv.read(4);
    const apt_long    = bv.read(4);
    const apt_turf    = bv.read(4);
    const apt_dirt    = bv.read(4);
    const apt_nige    = bv.read(4);
    const apt_senko   = bv.read(4);
    const apt_sashi   = bv.read(4);
    const apt_oikomi  = bv.read(4);

    const skill_count = bv.read(6);
    const skills: Array<{ id: number; level: number }> = [];
    for (let i = 0; i < skill_count; i++) {
        const id = bv.read(20);
        const level = bv.read(4) + 1;
        skills.push({ id, level });
    }

    return {
        card_id,
        speed, stamina, power, guts, wisdom,
        apt_short, apt_mile, apt_middle, apt_long,
        apt_turf, apt_dirt,
        apt_nige, apt_senko, apt_sashi, apt_oikomi,
        skills,
    };
}

export async function decodeRoster(input: string): Promise<DecodedUma[]> {
    let encoded = input.trim();

    const hashIdx = encoded.indexOf('#');
    if (hashIdx >= 0) encoded = encoded.slice(hashIdx + 1);
    encoded = decodeURIComponent(encoded);

    if (!encoded) return [];

    if (encoded.startsWith('z')) {
        try {
            const compressedBytes = b64ToBytes(encoded.slice(1));
            const decompressedBytes = await gunzip(compressedBytes);
            encoded = bytesToB64(decompressedBytes);
        } catch {
            return [];
        }
    }

    const bv = BitVector.fromBase64(encoded);
    const version = bv.read(8);

    if (version === 4) {
        const result: DecodedUma[] = [];

        while (bv.remaining() >= 109) {
            const uma = readV4Uma(bv);
            if (!uma) break;
            result.push(uma);
        }

        return result;
    }

    if (version === 2) {
        const uma = readV2Uma(bv);
        return uma ? [uma] : [];
    }

    if (version === 1) {
        const uma = readV1Uma(bv);
        return uma ? [uma] : [];
    }

    return [];
}
