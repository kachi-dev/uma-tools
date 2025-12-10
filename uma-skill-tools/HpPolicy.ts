import type { RaceState } from './RaceSolver';
import { PositionKeepState } from './RaceSolver';
import { HorseParameters, Strategy, StrategyHelpers } from './HorseTypes';
import { CourseData, CourseHelpers, Phase } from './CourseData';
import { GroundCondition } from './RaceParameters';
import { PRNG } from './Random';

export interface HpPolicy {
	init(horse: HorseParameters): void
	tick(state: RaceState, dt: number): void
	hasRemainingHp(): boolean
	hpRatioRemaining(): number  // separate methods as the former can be much cheaper to check
	recover(modifier: number): void
	getLastSpurtPair(state: RaceState, maxSpeed: number, baseTargetSpeed2: number): [number, number]
}

export const NoopHpPolicy: HpPolicy = {
	init(_: HorseParameters) {},
	tick(_0: RaceState, _1: number) {},
	hasRemainingHp() { return true; },
	hpRatioRemaining() { return 1.0; },
	recover(_: number) {},
	getLastSpurtPair(_0: RaceState, maxSpeed: number, _1: number) { return [-1, maxSpeed] as [number, number]; }
}

const HpStrategyCoefficient = Object.freeze([0, 0.95, 0.89, 1.0, 0.995, 0.86]);
const HpConsumptionGroundModifier = Object.freeze([
	[],
	[0, 1.0, 1.0, 1.02, 1.02],
	[0, 1.0, 1.0, 1.01, 1.02]
].map(o => Object.freeze(o)));

export class GameHpPolicy {
	distance: number
	baseSpeed: number
	maxHp: number
	hp: number
	groundModifier: number
	gutsModifier: number
	subparAcceptChance: number
	rng: PRNG
	private achievedMaxSpurt: boolean = false

	constructor(course: CourseData, ground: GroundCondition, rng: PRNG) {
		this.distance = course.distance;
		this.baseSpeed = 20.0 - (course.distance - 2000) / 1000.0;
		this.groundModifier = HpConsumptionGroundModifier[course.surface][ground];
		this.rng = rng;
		this.maxHp = 1.0;  // the first round of skill activations happens before init() is called (so we can get the correct stamina after greens)
		this.hp = 1.0;     // but there are some conditions that access HpPolicy methods which can run in the first round (e.g. is_hp_empty_onetime)
		                   // so we have to be "initialized enough" for them
		this.achievedMaxSpurt = false;
	}

	init(horse: HorseParameters) {
		this.maxHp = 0.8 * HpStrategyCoefficient[horse.strategy] * horse.stamina + this.distance;
		this.hp = this.maxHp;
		this.gutsModifier = 1.0 + 200.0 / Math.sqrt(600.0 * horse.guts);
		this.subparAcceptChance = Math.round((15.0 + 0.05 * horse.wisdom) * 1000);
		this.achievedMaxSpurt = false; // Reset for each race
	}

	getStatusModifier(state: {positionKeepState: PositionKeepState, isRushed?: boolean, isDownhillMode?: boolean, leadCompetition?: boolean, posKeepStrategy?: Strategy}) {
		let modifier = 1.0;

		if (state.isDownhillMode) {
			modifier *= 0.4;
		}
		
		if (state.leadCompetition) {
			const isOonige = state.posKeepStrategy === Strategy.Oonige;
			if (state.isRushed) {
				modifier *= isOonige ? 7.7 : 3.6;
			} else {
				modifier *= isOonige ? 3.5 : 1.4;
			}
		}
		else if (state.isRushed) {
			modifier *= 1.6;
		}

		if (state.positionKeepState === PositionKeepState.PaceDown) {
			modifier *= 0.6;
		}
		
		return modifier;
	}

	hpPerSecond(state: {phase: Phase, positionKeepState: PositionKeepState, isRushed?: boolean, isDownhillMode?: boolean, leadCompetition?: boolean, posKeepStrategy?: Strategy}, velocity: number) {
		const gutsModifier = state.phase >= 2 ? this.gutsModifier : 1.0;
		return 20.0 * Math.pow(velocity - this.baseSpeed + 12.0, 2) / 144.0 *
			this.getStatusModifier(state) * this.groundModifier * gutsModifier;
	}

	tick(state: RaceState, dt: number) {
		// NOTE unsure whether hp is consumed by `amount*dt` per frame or `amount` once every second
		// i think it is actually the latter
		this.hp -= this.hpPerSecond(state, state.currentSpeed) * dt;
	}

	hasRemainingHp() {
		return this.hp > 0.0;
	}

	hpRatioRemaining() {
		return Math.max(0.0, this.hp / this.maxHp);
	}

	recover(modifier: number) {
		this.hp = Math.min(this.maxHp, this.hp + this.maxHp * modifier);
	}

	getLastSpurtPair(state: RaceState, maxSpeed: number, baseTargetSpeed2: number) {
		const maxDist = this.distance - CourseHelpers.phaseStart(this.distance, 2);
		const s = (maxDist - 60) / maxSpeed;
		const lastleg = {phase: 2 as Phase, positionKeepState: PositionKeepState.None, leadCompetition: false, posKeepStrategy: state.posKeepStrategy};
		const hpNeeded = this.hpPerSecond(lastleg, maxSpeed) * s;
		
		if (this.hp >= hpNeeded) {
			// Only set on first call (when not already set)
			// This matches Kotlin behavior: track initial decision, not later changes
			if (!this.achievedMaxSpurt) {
				this.achievedMaxSpurt = true;
			}
			return [-1, maxSpeed] as [number, number];
		}
		const candidates: [number, number][] = [];
		const remainDistance = this.distance - 60 - state.pos;
		const statusModifier = this.getStatusModifier(lastleg);
		for (let speed = maxSpeed - 0.1; speed >= baseTargetSpeed2; speed -= 0.1) {
			// solve:
			//   s1 * speed + s2 * baseTargetSpeed2 = remainDistance
			//   s2 = (remainDistance - s1 * speed) / baseTargetSpeed2
			// for s1
			const spurtDuration = Math.min(
				remainDistance / speed,
				Math.max(0,
					(baseTargetSpeed2 * this.hp - this.hpPerSecond(lastleg, baseTargetSpeed2) * remainDistance) /
					(baseTargetSpeed2 * this.hpPerSecond(lastleg, speed) - this.hpPerSecond(lastleg, baseTargetSpeed2) * speed)
				)
			);
			const spurtDistance = spurtDuration * speed;
			candidates.push([this.distance - spurtDistance - 60, speed]);
		}
		candidates.sort((a,b) =>
			((a[0] - state.pos) / baseTargetSpeed2 + (this.distance - a[0]) / a[1]) -
			((b[0] - state.pos) / baseTargetSpeed2 + (this.distance - b[0]) / b[1]));
		
		for (let i = 0; i < candidates.length; ++i) {
			if (this.rng.uniform(100000) <= this.subparAcceptChance) {
				return candidates[i];
			}
		}
		return candidates[candidates.length-1];
	}
	
	/**
	 * Check if max spurt was achieved
	 */
	isMaxSpurt(): boolean {
		return this.achievedMaxSpurt;
	}
}
