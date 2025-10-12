/**
 * Spurt Calculation Utilities
 * 
 * Provides advanced spurt calculation functions ported from umasim RaceCalculator.kt
 * These utilities can be used standalone or integrated with EnhancedHpPolicy
 */

import { HorseParameters } from './HorseTypes';
import { CourseData, CourseHelpers, Phase } from './CourseData';
import { GroundCondition } from './RaceParameters';

export interface SpurtCandidate {
	transitionPosition: number;  // Position where spurt begins
	speed: number;                // Spurt speed
	distance: number;             // Distance of spurt
	time: number;                 // Total time to complete race
	hpDiff: number;               // HP remaining after race
}

/**
 * Calculate HP consumption coefficient based on ground type and condition
 */
export function getGroundConsumptionCoef(surface: number, condition: GroundCondition): number {
	const coefficients = [
		[],
		[0, 1.0, 1.0, 1.02, 1.02],  // Turf
		[0, 1.0, 1.0, 1.01, 1.02]   // Dirt
	];
	return coefficients[surface]?.[condition] ?? 1.0;
}

/**
 * Calculate base speed for a course
 */
export function calculateBaseSpeed(distance: number): number {
	return 20.0 - (distance - 2000) / 1000.0;
}

/**
 * Calculate HP consumption per second at a given velocity
 * 
 * @param velocity Current speed
 * @param baseSpeed Base speed for the course
 * @param groundCoef Ground consumption coefficient
 * @param gutsModifier Guts-based modifier (applied in phase 2+)
 * @param statusModifier Status modifiers (pace down, rushed, etc)
 * @param inSpurtPhase Whether in spurt phase (phase 2+)
 */
export function calculateHpPerSecond(
	velocity: number,
	baseSpeed: number,
	groundCoef: number,
	gutsModifier: number,
	statusModifier: number = 1.0,
	inSpurtPhase: boolean = false
): number {
	const guts = inSpurtPhase ? gutsModifier : 1.0;
	return 20.0 * Math.pow(velocity - baseSpeed + 12.0, 2) / 144.0 * 
		   statusModifier * groundCoef * guts;
}

/**
 * Calculate required HP to cover a distance at a given speed
 * 
 * @param velocity Target speed
 * @param distance Distance to cover
 * @param baseSpeed Base speed for course
 * @param groundCoef Ground consumption coefficient
 * @param gutsModifier Guts modifier
 * @param inSpurtPhase Whether in spurt phase
 */
export function calculateRequiredHp(
	velocity: number,
	distance: number,
	baseSpeed: number,
	groundCoef: number,
	gutsModifier: number,
	inSpurtPhase: boolean = true
): number {
	const time = distance / velocity;
	const hpPerSec = calculateHpPerSecond(velocity, baseSpeed, groundCoef, gutsModifier, 1.0, inSpurtPhase);
	return hpPerSec * time;
}

/**
 * Calculate the maximum distance a horse can spurt at a given speed
 * 
 * This solves for how far the horse can maintain targetSpeed before
 * having to drop to baseSpeed to reach the finish line.
 * 
 * @param currentHp Current HP
 * @param currentPosition Current position on track
 * @param courseDistance Total course distance
 * @param targetSpeed Desired spurt speed
 * @param baseSpeed Fallback speed
 * @param baseSpeedCourse Base speed of course
 * @param groundCoef Ground consumption coefficient
 * @param gutsModifier Guts modifier
 */
export function calculateSpurtDistance(
	currentHp: number,
	currentPosition: number,
	courseDistance: number,
	targetSpeed: number,
	baseSpeed: number,
	baseSpeedCourse: number,
	groundCoef: number,
	gutsModifier: number
): number {
	const remainingDistance = courseDistance - currentPosition;
	const bufferDistance = 60; // Game uses 60m buffer before finish
	
	// Calculate HP needed to reach buffer at base speed
	const distanceAtBase = remainingDistance - bufferDistance;
	const hpForBase = calculateRequiredHp(baseSpeed, distanceAtBase, baseSpeedCourse, groundCoef, gutsModifier, true);
	
	// Calculate excess HP available for spurting
	const excessHp = currentHp - hpForBase;
	
	if (excessHp <= 0) {
		return 0;
	}
	
	// Calculate consumption difference between target and base speed
	const consumptionAtTarget = calculateHpPerSecond(targetSpeed, baseSpeedCourse, groundCoef, gutsModifier, 1.0, true);
	const consumptionAtBase = calculateHpPerSecond(baseSpeed, baseSpeedCourse, groundCoef, gutsModifier, 1.0, true);
	const consumptionDiff = (consumptionAtTarget / targetSpeed) - (consumptionAtBase / baseSpeed);
	
	if (consumptionDiff <= 0) {
		// Target speed is more efficient, can use for full distance
		return remainingDistance;
	}
	
	// Calculate spurt distance
	const spurtDistance = (excessHp / consumptionDiff) + bufferDistance;
	return Math.min(spurtDistance, remainingDistance);
}

/**
 * Find optimal spurt strategy given current race state
 * 
 * Returns an array of candidates sorted by completion time (fastest first)
 * The game uses wisdom-based random selection from this list
 * 
 * @param currentHp Current HP
 * @param currentPosition Current position
 * @param courseDistance Total course distance
 * @param baseSpeed Base target speed (v3)
 * @param maxSpeed Maximum spurt speed
 * @param baseSpeedCourse Base speed of course
 * @param groundCoef Ground coefficient
 * @param gutsModifier Guts modifier
 * @param speedIncrement Speed increment for candidates (default 0.1)
 */
export function findOptimalSpurt(
	currentHp: number,
	currentPosition: number,
	courseDistance: number,
	baseSpeed: number,
	maxSpeed: number,
	baseSpeedCourse: number,
	groundCoef: number,
	gutsModifier: number,
	speedIncrement: number = 0.1
): SpurtCandidate[] {
	const remainingDistance = courseDistance - currentPosition;
	
	// Check if can do max speed for full distance
	const maxSpurtDist = calculateSpurtDistance(
		currentHp, currentPosition, courseDistance,
		maxSpeed, baseSpeed, baseSpeedCourse, groundCoef, gutsModifier
	);
	
	const maxHpRequired = calculateRequiredHp(
		maxSpeed, remainingDistance - 60, baseSpeedCourse, groundCoef, gutsModifier, true
	);
	
	if (maxSpurtDist >= remainingDistance) {
		return [{
			transitionPosition: currentPosition,
			speed: maxSpeed,
			distance: remainingDistance,
			time: remainingDistance / maxSpeed,
			hpDiff: currentHp - maxHpRequired
		}];
	}
	
	// Check if can even maintain base speed
	const baseHpRequired = calculateRequiredHp(
		baseSpeed, remainingDistance - 60, baseSpeedCourse, groundCoef, gutsModifier, true
	);
	
	if (currentHp < baseHpRequired) {
		return [{
			transitionPosition: currentPosition,
			speed: baseSpeed,
			distance: 0,
			time: remainingDistance / baseSpeed,
			hpDiff: currentHp - maxHpRequired
		}];
	}
	
	// Generate candidates between base and max speed
	const candidates: SpurtCandidate[] = [];
	
	for (let speed = baseSpeed; speed <= maxSpeed; speed += speedIncrement) {
		const spurtDist = calculateSpurtDistance(
			currentHp, currentPosition, courseDistance,
			speed, baseSpeed, baseSpeedCourse, groundCoef, gutsModifier
		);
		
		// Calculate completion time
		const timeAtSpeed = spurtDist / speed;
		const timeAtBase = (remainingDistance - spurtDist) / baseSpeed;
		const totalTime = timeAtSpeed + timeAtBase;
		
		candidates.push({
			transitionPosition: courseDistance - spurtDist,
			speed: speed,
			distance: spurtDist,
			time: totalTime,
			hpDiff: currentHp - maxHpRequired
		});
	}
	
	// Sort by completion time (fastest first)
	candidates.sort((a, b) => a.time - b.time);
	
	return candidates;
}

/**
 * Calculate HP required for remaining race in phase 2
 * Used for stamina keep decision making
 * 
 * @param currentHp Current HP
 * @param currentPosition Current position
 * @param courseDistance Total course distance
 * @param phase2Speed Speed in phase 2
 * @param maxSpurtSpeed Maximum spurt speed
 * @param baseSpeedCourse Base speed of course
 * @param groundCoef Ground coefficient
 * @param gutsModifier Guts modifier
 */
export function calculateRequiredHpInPhase2(
	currentHp: number,
	currentPosition: number,
	courseDistance: number,
	phase2Speed: number,
	maxSpurtSpeed: number,
	baseSpeedCourse: number,
	groundCoef: number,
	gutsModifier: number
): number {
	const phase2Length = courseDistance * 2.0 / 3.0 - currentPosition;
	const phase3Length = courseDistance / 3.0;
	
	const hpPhase2 = calculateRequiredHp(phase2Speed, phase2Length, baseSpeedCourse, groundCoef, gutsModifier, false);
	const hpPhase3 = calculateRequiredHp(maxSpurtSpeed, phase3Length, baseSpeedCourse, groundCoef, gutsModifier, true);
	
	return hpPhase2 + hpPhase3;
}

/**
 * Simulate HP consumption over a race segment
 * Useful for analyzing stamina usage patterns
 */
export function simulateHpConsumption(
	startHp: number,
	startPosition: number,
	endPosition: number,
	velocityFunc: (position: number) => number,
	baseSpeed: number,
	groundCoef: number,
	gutsModifier: number,
	statusModifier: (position: number) => number = () => 1.0,
	inSpurtPhase: boolean = false,
	dt: number = 1/15  // Default to 15 FPS
): {finalHp: number, consumptionBySegment: number[]} {
	let hp = startHp;
	const consumption: number[] = [];
	const distance = endPosition - startPosition;
	const segments = Math.ceil(distance / 10); // 10m segments
	
	for (let i = 0; i < segments; i++) {
		const segmentStart = startPosition + (i * distance / segments);
		const segmentEnd = Math.min(segmentStart + distance / segments, endPosition);
		const segmentDistance = segmentEnd - segmentStart;
		
		const velocity = velocityFunc(segmentStart + segmentDistance / 2);
		const status = statusModifier(segmentStart + segmentDistance / 2);
		
		const hpPerSec = calculateHpPerSecond(velocity, baseSpeed, groundCoef, gutsModifier, status, inSpurtPhase);
		const time = segmentDistance / velocity;
		const consumed = hpPerSec * time;
		
		hp -= consumed;
		consumption.push(consumed);
	}
	
	return {
		finalHp: hp,
		consumptionBySegment: consumption
	};
}

/**
 * Calculate equivalent stamina bonus from HP recovery skills
 * 
 * @param healAmount HP recovered (in game units, typically skill modifier)
 * @param maxHp Maximum HP
 * @param strategy Horse strategy (for stamina coefficient)
 */
export function calculateEquivalentStamina(
	healAmount: number,
	maxHp: number,
	strategy: number
): number {
	const HpStrategyCoefficient = [0, 0.95, 0.89, 1.0, 0.995, 0.86];
	const coef = HpStrategyCoefficient[strategy];
	
	// Heal is given in basis points (10000 = 100%)
	const actualHeal = (healAmount / 10000) * maxHp;
	
	// Convert back to equivalent stamina
	return actualHeal / (0.8 * coef);
}



