import type { PRNG } from './Random';

export interface ApproximateCondition {
	valueOnStart: number
	update(state: any, currentValue: number): number
}

export class ApproximateStartContinue implements ApproximateCondition {
	constructor(
		public readonly name: string,
		public readonly startRate: number,
		public readonly continuationRate: number
	) {}

	get valueOnStart(): number {
		return 0;
	}

	update(state: any, currentValue: number): number {
		const rng: PRNG = state.simulation?.rng;

		if (currentValue === 0) {
			return rng.random() < this.startRate ? 1 : 0;
		} else {
			return rng.random() < this.continuationRate ? 1 : 0;
		}
	}
}

export interface ConditionEntry {
	condition: ApproximateStartContinue
	predicate: ((state: any) => boolean) | null
}

export class ApproximateMultiCondition implements ApproximateCondition {
	constructor(
		public readonly name: string,
		public readonly conditions: readonly ConditionEntry[],
		public readonly valueOnStart: number = 0
	) {}

	update(state: any, currentValue: number): number {
		let activeCondition: ApproximateStartContinue | null = null;
		let fallbackCondition: ApproximateStartContinue | null = null;

		for (const entry of this.conditions) {
			if (entry.predicate === null) {
				fallbackCondition = entry.condition;
			} else if (entry.predicate(state)) {
				activeCondition = entry.condition;
				break;
			}
		}

		const condition = activeCondition || fallbackCondition;
		if (!condition) {
			return currentValue;
		}

		const rng: PRNG = state.simulation?.rng;

		if (currentValue === 0) {
			return rng.random() < condition.startRate ? 1 : 0;
		} else {
			return rng.random() < condition.continuationRate ? 1 : 0;
		}
	}
}

