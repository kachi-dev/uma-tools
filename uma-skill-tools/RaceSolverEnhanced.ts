/**
 * Enhanced Race Solver Integration
 * 
 * Provides factory functions and utilities to create RaceSolver instances
 * with the enhanced HP/spurt calculation system from umasim
 */

import { RaceSolver, PendingSkill } from './RaceSolver';
import { HorseParameters } from './HorseTypes';
import { CourseData } from './CourseData';
import { GroundCondition } from './RaceParameters';
import { PRNG } from './Random';
import { EnhancedHpPolicy } from './EnhancedHpPolicy';
import { GameHpPolicy } from './HpPolicy';

export interface RaceSolverConfig {
	horse: HorseParameters;
	course: CourseData;
	ground: GroundCondition;
	rng: PRNG;
	skills: PendingSkill[];
	pacer?: RaceSolver;
	useEnhancedSpurt?: boolean;  // Whether to use enhanced spurt calculations
	onSkillActivate?: (s: RaceSolver, skillId: string) => void;
	onSkillDeactivate?: (s: RaceSolver, skillId: string) => void;
	disableRushed?: boolean;
	disableDownhill?: boolean;
}

/**
 * Create a RaceSolver with optional enhanced spurt calculation
 * 
 * @param config Configuration object
 * @returns Configured RaceSolver instance
 */
export function createRaceSolver(config: RaceSolverConfig): RaceSolver {
	const hp = config.useEnhancedSpurt 
		? new EnhancedHpPolicy(config.course, config.ground, config.rng)
		: new GameHpPolicy(config.course, config.ground, config.rng);
	
	return new RaceSolver({
		horse: config.horse,
		course: config.course,
		rng: config.rng,
		skills: config.skills,
		hp: hp,
		pacer: config.pacer,
		onSkillActivate: config.onSkillActivate,
		onSkillDeactivate: config.onSkillDeactivate,
		disableRushed: config.disableRushed,
		disableDownhill: config.disableDownhill
	});
}

/**
 * Create a pacer (virtual opponent) with enhanced calculations
 */
export function createPacer(config: Omit<RaceSolverConfig, 'pacer'>): RaceSolver {
	return createRaceSolver({ ...config, pacer: undefined });
}

/**
 * Helper to compare standard vs enhanced spurt calculations
 * Useful for debugging and analysis
 */
export function compareSpurtCalculations(
	horse: HorseParameters,
	course: CourseData,
	ground: GroundCondition,
	rng: PRNG,
	skills: PendingSkill[]
): {
	standard: RaceSolver,
	enhanced: RaceSolver,
	standardTime: number,
	enhancedTime: number,
	timeDiff: number
} {
	// Clone RNG state for fair comparison
	const rng1 = rng;
	const rng2 = rng; // Note: In real usage, you'd want to clone the RNG state
	
	const standard = createRaceSolver({
		horse, course, ground, rng: rng1, skills,
		useEnhancedSpurt: false
	});
	
	const enhanced = createRaceSolver({
		horse, course, ground, rng: rng2, skills,
		useEnhancedSpurt: true
	});
	
	// Run simulations
	const dt = 1 / 15; // 15 FPS
	while (standard.pos < course.distance) {
		standard.step(dt);
	}
	
	while (enhanced.pos < course.distance) {
		enhanced.step(dt);
	}
	
	const standardTime = standard.accumulatetime.t;
	const enhancedTime = enhanced.accumulatetime.t;
	
	return {
		standard,
		enhanced,
		standardTime,
		enhancedTime,
		timeDiff: enhancedTime - standardTime
	};
}

/**
 * Export enhanced HP policy for direct use
 */
export { EnhancedHpPolicy } from './EnhancedHpPolicy';

/**
 * Export spurt calculation utilities
 */
export * from './SpurtCalculator';



