import Prando from 'prando';

export interface PRNG {
	int32(): number
	random(): number
	uniform(upper: number): number
}

export class SeededRng {
	private prando: Prando;

	constructor(seed: number) {
		this.prando = new Prando(seed);
	}

	int32(): number {
		return Math.floor(this.prando.next() * 0x100000000);
	}

	random(): number {
		return this.prando.next();
	}

	uniform(upper: number): number {
		return this.prando.nextInt(0, upper - 1);
	}
}

export const Rule30CARng = SeededRng;
