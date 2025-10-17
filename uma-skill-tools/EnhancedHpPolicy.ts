/**
 * Enhanced HP Policy with advanced spurt/stamina calculations
 * Ported from umasim RaceCalculator.kt by mee1080
 * 
 * This implementation provides more sophisticated spurt calculation that:
 * - Calculates optimal spurt speed based on remaining HP
 * - Considers multiple speed candidates and selects the fastest completion time
 * - Uses wisdom-based random selection for suboptimal spurt decisions
 * - Includes proper HP consumption modeling for different race phases
 */

import type { RaceState } from './RaceSolver';
import { HorseParameters } from './HorseTypes';
import { CourseData, CourseHelpers, Phase } from './CourseData';
import { GroundCondition } from './RaceParameters';
import { PRNG } from './Random';

const HpStrategyCoefficient = Object.freeze([0, 0.95, 0.89, 1.0, 0.995, 0.86]);
const HpConsumptionGroundModifier = Object.freeze([
	[],
	[0, 1.0, 1.0, 1.02, 1.02],
	[0, 1.0, 1.0, 1.01, 1.02]
].map(o => Object.freeze(o)));

interface SpurtParameters {
	distance: number;
	speed: number;
	spDiff: number;
	time: number;
}

export class EnhancedHpPolicy {
	distance: number;
	baseSpeed: number;
	maxHp: number;
	hp: number;
	groundModifier: number;
	gutsModifier: number;
	subparAcceptChance: number;
	rng: PRNG;
	
	// Enhanced spurt calculation fields
	private baseTargetSpeed2: number;
	private maxSpurtSpeed: number;
	private spurtParameters: SpurtParameters | null = null;
	
	// Accuracy mode: dynamically recalculate spurt on heals (like Kotlin)
	private recalculateOnHeal: boolean;
	private recalculationCount: number = 0;
	
	// Track if max spurt was achieved on FIRST calculation (matches Kotlin behavior)
	private maxSpurtAchieved: boolean = false;
	private hasCalculatedSpurtOnce: boolean = false;

	constructor(course: CourseData, ground: GroundCondition, rng: PRNG, recalculateOnHeal: boolean = false) {
		this.distance = course.distance;
		this.baseSpeed = 20.0 - (course.distance - 2000) / 1000.0;
		this.groundModifier = HpConsumptionGroundModifier[course.surface][ground];
		this.rng = rng;
		this.maxHp = 1.0;
		this.hp = 1.0;
		this.baseTargetSpeed2 = 0;
		this.maxSpurtSpeed = 0;
		this.recalculateOnHeal = recalculateOnHeal;
	}

	init(horse: HorseParameters) {
		this.maxHp = 0.8 * HpStrategyCoefficient[horse.strategy] * horse.stamina + this.distance;
		this.hp = this.maxHp;
		this.gutsModifier = 1.0 + 200.0 / Math.sqrt(600.0 * horse.guts);
		this.subparAcceptChance = Math.round((15.0 + 0.05 * horse.wisdom) * 1000);
		
		// Pre-calculate spurt speeds for enhanced calculation
		this.baseTargetSpeed2 = this.calculateBaseTargetSpeed(horse, 2);
		this.maxSpurtSpeed = this.calculateMaxSpurtSpeed(horse);
		
		// Reset spurt tracking for each race
		this.spurtParameters = null;
		this.recalculationCount = 0;
		this.maxSpurtAchieved = false;
		this.hasCalculatedSpurtOnce = false;
	}

	private calculateBaseTargetSpeed(horse: HorseParameters, phase: Phase): number {
		const StrategyPhaseCoefficient = [
			[],
			[1.0, 0.98, 0.962],
			[0.978, 0.991, 0.975],
			[0.938, 0.998, 0.994],
			[0.931, 1.0, 1.0],
			[1.063, 0.962, 0.95]
		];
		const DistanceProficiencyModifier = [1.05, 1.0, 0.9, 0.8, 0.6, 0.4, 0.2, 0.1];
		
		return this.baseSpeed * StrategyPhaseCoefficient[horse.strategy][phase] +
			(phase == 2 ? Math.sqrt(500.0 * horse.speed) * DistanceProficiencyModifier[horse.distanceAptitude] * 0.002 : 0);
	}

	private calculateMaxSpurtSpeed(horse: HorseParameters): number {
		const DistanceProficiencyModifier = [1.05, 1.0, 0.9, 0.8, 0.6, 0.4, 0.2, 0.1];
		
		let v = (this.baseTargetSpeed2 + 0.01 * this.baseSpeed) * 1.05 +
			Math.sqrt(500.0 * horse.speed) * DistanceProficiencyModifier[horse.distanceAptitude] * 0.002;
		
		// Add guts contribution (commented out for CC_GLOBAL compatibility, but leaving the logic)
		// v += Math.pow(450.0 * horse.guts, 0.597) * 0.0001;
		
		return v;
	}

	getStatusModifier(state: {isPaceDown: boolean, isRushed?: boolean, isDownhillMode?: boolean}) {
		let modifier = 1.0;
		if (state.isPaceDown) {
			modifier *= 0.6;
		}
		if (state.isRushed) {
			modifier *= 1.6;
		}
		if (state.isDownhillMode) {
			// Downhill accel mode reduces HP consumption by 60%
			modifier *= 0.4;
		}
		return modifier;
	}

	hpPerSecond(state: {phase: Phase, isPaceDown: boolean, isRushed?: boolean, isDownhillMode?: boolean}, velocity: number) {
		const gutsModifier = state.phase >= 2 ? this.gutsModifier : 1.0;
		return 20.0 * Math.pow(velocity - this.baseSpeed + 12.0, 2) / 144.0 *
			this.getStatusModifier(state) * this.groundModifier * gutsModifier;
	}

	tick(state: RaceState, dt: number) {
		this.hp -= this.hpPerSecond(state, state.currentSpeed) * dt;
	}

	hasRemainingHp() {
		return this.hp > 0.0;
	}

	hpRatioRemaining() {
		return Math.max(0.0, this.hp / this.maxHp);
	}

	recover(modifier: number, state?: RaceState) {
		this.hp = Math.min(this.maxHp, this.hp + this.maxHp * modifier);
		
		// Accuracy mode: Recalculate spurt parameters after heal in phase 2+
		// This matches the Kotlin implementation's dynamic recalculation behavior
		if (this.recalculateOnHeal && state && state.phase >= 2 && this.spurtParameters) {
			// Kotlin REPLACES spurtParameters, not clears to null
			// We need to recalculate immediately to avoid breaking the null check
			this.recalculationCount++;
			
			// Get last spurt speeds from state for recalculation
			// We need to recalculate inline here, matching Kotlin's behavior
			const maxDistance = this.distance - state.pos;
			const spurtDistance = this.calcSpurtDistance(state, this.maxSpurtSpeed);
			
			if (spurtDistance >= maxDistance) {
				// Can max spurt now (after heal)
				// But DON'T set maxSpurtAchieved flag - that was already locked at first calc
				this.spurtParameters = {
					distance: maxDistance,
					speed: this.maxSpurtSpeed,
					spDiff: this.hp - this.calcRequiredHp(this.maxSpurtSpeed, maxDistance - 60, true, false),
					time: 0
				};
			} else {
				// Need to compute suboptimal spurt
				const totalConsumeV3 = this.calcRequiredHp(this.baseTargetSpeed2, maxDistance - 60, true, false);
				const excessHp = this.hp - totalConsumeV3;
				
				if (excessHp < 0) {
					this.spurtParameters = {
						distance: 0.0,
						speed: this.baseTargetSpeed2,
						spDiff: this.hp - this.calcRequiredHp(this.maxSpurtSpeed, maxDistance - 60, true, false),
						time: 0
					};
				} else {
					// Generate candidates and select optimal
					const candidates: SpurtParameters[] = [];
					for (let speed = this.baseTargetSpeed2; speed < this.maxSpurtSpeed; speed += 0.1) {
						const distanceV = Math.min(maxDistance, this.calcSpurtDistance(state, speed));
						const time = distanceV / speed + (maxDistance - distanceV) / this.baseTargetSpeed2;
						candidates.push({
							distance: distanceV,
							speed: speed,
							spDiff: this.hp - this.calcRequiredHp(this.maxSpurtSpeed, maxDistance - 60, true, false),
							time: time
						});
					}
					candidates.sort((a, b) => a.time - b.time);
					
					const randomRoll = this.rng.uniform(100000);
					let selected = candidates[candidates.length - 1];
					for (const candidate of candidates) {
						if (randomRoll <= this.subparAcceptChance) {
							selected = candidate;
							break;
						}
					}
					this.spurtParameters = selected;
				}
			}
		}
	}

	/**
	 * Calculate required HP for a given velocity and distance
	 * Ported from RaceState.calcRequiredSp in Kotlin
	 */
	private calcRequiredHp(
		velocity: number, 
		length: number = this.distance - 60,
		spurtPhase: boolean = true,
		applyStatusModifier: boolean = false
	): number {
		const state = {phase: 2 as Phase, isPaceDown: false};
		const baseConsumption = 20.0 * Math.pow(velocity - this.baseSpeed + 12.0, 2) / 144.0;
		const gutsModifier = spurtPhase ? this.gutsModifier : 1.0;
		const statusModifier = applyStatusModifier ? this.getStatusModifier(state) : 1.0;
		
		return (length / velocity) * baseConsumption * this.groundModifier * gutsModifier * statusModifier;
	}

	/**
	 * Calculate how far the horse can spurt at a given speed
	 * Ported from RaceState.calcSpurtDistance in Kotlin
	 */
	private calcSpurtDistance(state: RaceState, targetSpeed: number): number {
		const remainingDistance = this.distance - state.pos;
		const v3 = this.baseTargetSpeed2;
		
		// Calculate HP required to reach 60m before finish at v3
		const hpForBase = ((remainingDistance - 60) * 
			20 * 
			this.groundModifier * 
			this.gutsModifier * 
			Math.pow(v3 - this.baseSpeed + 12, 2)) / 
			144 / 
			v3;
		
		// Calculate how much further we can spurt
		const excessHp = this.hp - hpForBase;
		const consumptionDiff = 20 * 
			this.groundModifier * 
			this.gutsModifier * 
			((Math.pow(targetSpeed - this.baseSpeed + 12, 2) / 144 / targetSpeed) -
			 (Math.pow(v3 - this.baseSpeed + 12, 2) / 144 / v3));
		
		return (excessHp / consumptionDiff) + 60;
	}

	/**
	 * Enhanced last spurt calculation using Kotlin algorithm
	 * Ported from RaceState.calcSpurtParameter in Kotlin
	 * 
	 * This method:
	 * 1. Checks if we have enough HP to spurt at max speed
	 * 2. If not, calculates optimal suboptimal speed
	 * 3. Uses wisdom-based random selection for suboptimal choices
	 * 
	 * IMPORTANT: To ensure consistent RNG consumption for fair comparisons,
	 * this method consumes exactly ONE RNG call regardless of the outcome.
	 * This prevents "cross-contamination" where different horses consume
	 * different numbers of random values, desynchronizing comparison runs.
	 * 
	 * In accuracy mode (recalculateOnHeal=true), this will be called multiple
	 * times if heals occur in phase 2+, matching Kotlin's dynamic behavior.
	 */
	getLastSpurtPair(state: RaceState, maxSpeed: number, baseTargetSpeed2: number): [number, number] {
		// Update internal values
		this.maxSpurtSpeed = maxSpeed;
		this.baseTargetSpeed2 = baseTargetSpeed2;
		
		// Only calculate once per spurt phase (unless recalculation mode is enabled)
		if (state.phase < 2) {
			return [-1, maxSpeed];
		}
		
		// In recalculation mode, allow re-computing if spurtParameters was cleared by heal
		if (this.spurtParameters !== null && !this.recalculateOnHeal) {
			// Return cached result in comparison mode
			return [this.distance - this.spurtParameters.distance, this.spurtParameters.speed];
		}
		
		const isFirstCalcEver = !this.hasCalculatedSpurtOnce;
		
		const maxDistance = this.distance - state.pos;
		const spurtDistance = this.calcSpurtDistance(state, this.maxSpurtSpeed);
		const totalConsume = this.calcRequiredHp(this.maxSpurtSpeed, maxDistance - 60, true, false);
		
		// Can spurt at max speed for the whole distance
		if (spurtDistance >= maxDistance) {
			// Match Kotlin: Only set maxSpurt flag on FIRST calculation EVER
			// NOT on recalculations after heals!
			const inEarlyPhase2 = state.pos <= (this.distance * 2.0 / 3.0 + 5);
			
			if (inEarlyPhase2 && isFirstCalcEver) {
				this.maxSpurtAchieved = true;
			}
			
			// Mark that we've calculated at least once (AFTER checking max spurt)
			if (isFirstCalcEver) {
				this.hasCalculatedSpurtOnce = true;
			}
			
			this.spurtParameters = {
				distance: maxDistance,
				speed: this.maxSpurtSpeed,
				spDiff: this.hp - totalConsume,
				time: 0
			};
			return [-1, this.maxSpurtSpeed];
		}
		
		// Mark that we've calculated at least once (even if can't max spurt)
		if (isFirstCalcEver) {
			this.hasCalculatedSpurtOnce = true;
		}
		
		// Can't even maintain base speed
		const totalConsumeV3 = this.calcRequiredHp(this.baseTargetSpeed2, maxDistance - 60, true, false);
		const excessHp = this.hp - totalConsumeV3;
		
		if (excessHp < 0) {
			this.spurtParameters = {
				distance: 0.0,
				speed: this.baseTargetSpeed2,
				spDiff: this.hp - totalConsume,
				time: 0
			};
			return [-1, this.baseTargetSpeed2];
		}
		
		// Calculate candidates for suboptimal spurt
		const candidates: SpurtParameters[] = [];
		const remainDistance = maxDistance - 60;
		
		// Try speeds from v3 to maxSpurtSpeed in 0.1 increments
		for (let speed = this.baseTargetSpeed2; speed < this.maxSpurtSpeed; speed += 0.1) {
			const distanceV = Math.min(maxDistance, this.calcSpurtDistance(state, speed));
			const time = distanceV / speed + (maxDistance - distanceV) / this.baseTargetSpeed2;
			
			candidates.push({
				distance: distanceV,
				speed: speed,
				spDiff: this.hp - totalConsume,
				time: time
			});
		}
		
		// Sort by completion time (fastest first)
		candidates.sort((a, b) => a.time - b.time);
		
		// PRE-ROLL the random value to ensure fixed RNG consumption
		// This guarantees both horses in a comparison consume exactly 1 RNG call,
		// preventing desynchronization of the random number streams
		const randomRoll = this.rng.uniform(100000);
		
		// Use wisdom-based random selection with pre-rolled value
		for (let i = 0; i < candidates.length; ++i) {
			if (randomRoll <= this.subparAcceptChance) {
				const candidate = candidates[i];
				this.spurtParameters = candidate;
				return [this.distance - candidate.distance, candidate.speed];
			}
		}
		
		// Fallback to slowest candidate
		const lastCandidate = candidates[candidates.length - 1];
		this.spurtParameters = lastCandidate;
		return [this.distance - lastCandidate.distance, lastCandidate.speed];
	}
	
	/**
	 * Get current spurt parameters (for debugging/analysis)
	 */
	getSpurtParameters(): SpurtParameters | null {
		return this.spurtParameters;
	}
	
	/**
	 * Check if currently in max spurt mode
	 */
	isMaxSpurt(): boolean {
		// Match Kotlin behavior: return whether max spurt was achieved on FIRST calculation
		// Not whether we're currently max spurting after recalculations
		return this.maxSpurtAchieved;
	}
	
	getRecalculationCount(): number {
		return this.recalculationCount;
	}
}

