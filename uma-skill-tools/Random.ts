import seedrandom from 'seedrandom';

export interface PRNG {
	int32(): number
	random(): number
	uniform(upper: number): number
}

export class SeededRng {
	private rng: () => number;

	constructor(seed: number) {
		this.rng = seedrandom(seed.toString());
	}

	int32(): number {
		return Math.floor(this.rng() * 0x100000000);
	}

	random(): number {
		return this.rng();
	}

	uniform(upper: number): number {
		const mask = -1 >>> Math.clz32((upper - 1) | 1);
		let n = 0;
		do {
			n = this.int32() & mask;
		} while (n >= upper);
		return n;
	}
}

export const Rule30CARng = SeededRng;
