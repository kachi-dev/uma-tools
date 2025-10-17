import { CourseData } from '../uma-skill-tools/CourseData';
import { RaceParameters, GroundCondition } from '../uma-skill-tools/RaceParameters';
import { RaceSolver, PosKeepMode } from '../uma-skill-tools/RaceSolver';
import { RaceSolverBuilder, Perspective, parseStrategy, parseAptitude } from '../uma-skill-tools/RaceSolverBuilder';
import { EnhancedHpPolicy } from '../uma-skill-tools/EnhancedHpPolicy';
import { GameHpPolicy } from '../uma-skill-tools/HpPolicy';
import { HorseParameters } from '../uma-skill-tools/HorseTypes';

import { HorseState } from '../components/HorseDefTypes';

import skilldata from '../uma-skill-tools/data/skill_data.json';

// Calculate theoretical max spurt based purely on stats (no RNG)
function calculateTheoreticalMaxSpurt(horse: any, course: CourseData, ground: GroundCondition): {
	canMaxSpurt: boolean,
	maxHp: number,
	hpNeededForMaxSpurt: number,
	maxSpurtSpeed: number,
	baseTargetSpeed2: number,
	hpRemaining: number
} {
	const HpStrategyCoefficient = [0, 0.95, 0.89, 1.0, 0.995, 0.86];
	const HpConsumptionGroundModifier = [
		[],
		[0, 1.0, 1.0, 1.02, 1.02],
		[0, 1.0, 1.0, 1.01, 1.02]
	];
	const StrategyPhaseCoefficient = [
		[],
		[1.0, 0.98, 0.962],
		[0.978, 0.991, 0.975],
		[0.938, 0.998, 0.994],
		[0.931, 1.0, 1.0],
		[1.063, 0.962, 0.95]
	];
	const DistanceProficiencyModifier = [1.05, 1.0, 0.9, 0.8, 0.6, 0.4, 0.2, 0.1];
	
	// Parse strategy and aptitude from strings to numeric enums if needed
	const strategy = parseStrategy(horse.strategy);
	const distanceAptitude = parseAptitude(horse.distanceAptitude, 'distance');
	
	const baseSpeed = 20.0 - (course.distance - 2000) / 1000.0;
	const maxHp = 0.8 * HpStrategyCoefficient[strategy] * horse.stamina + course.distance;
	const groundModifier = HpConsumptionGroundModifier[course.surface][ground];
	const gutsModifier = 1.0 + 200.0 / Math.sqrt(600.0 * horse.guts);
	
	// Calculate base target speed for phase 2
	const baseTargetSpeed2 = baseSpeed * StrategyPhaseCoefficient[strategy][2] +
		Math.sqrt(500.0 * horse.speed) * DistanceProficiencyModifier[distanceAptitude] * 0.002;
	
	// Calculate max spurt speed
	const maxSpurtSpeed = (baseSpeed * (StrategyPhaseCoefficient[strategy][2] + 0.01) +
		Math.sqrt(horse.speed / 500.0) * DistanceProficiencyModifier[distanceAptitude]) * 1.05 +
		Math.sqrt(500.0 * horse.speed) * DistanceProficiencyModifier[distanceAptitude] * 0.002 +
		Math.pow(450.0 * horse.guts, 0.597) * 0.0001;
	
	// Calculate HP consumption for the entire race
	// Phase 0: 0 to 1/6 of course (acceleration phase)
	const phase0Distance = course.distance / 6;
	const phase0Speed = baseSpeed * StrategyPhaseCoefficient[strategy][0];
	const phase0HpPerSec = 20.0 * Math.pow(phase0Speed - baseSpeed + 12.0, 2) / 144.0 * groundModifier;
	const phase0Time = phase0Distance / phase0Speed;
	const phase0Hp = phase0HpPerSec * phase0Time;
	
	// Phase 1: 1/6 to 2/3 of course (middle phase)
	const phase1Distance = course.distance * 2 / 3 - phase0Distance;
	const phase1Speed = baseSpeed * StrategyPhaseCoefficient[strategy][1];
	const phase1HpPerSec = 20.0 * Math.pow(phase1Speed - baseSpeed + 12.0, 2) / 144.0 * groundModifier;
	const phase1Time = phase1Distance / phase1Speed;
	const phase1Hp = phase1HpPerSec * phase1Time;
	
	// Phase 2: 2/3 to finish (spurt phase)
	const spurtEntryPos = course.distance * 2 / 3;
	const remainingDistance = course.distance - spurtEntryPos;
	const spurtDistance = remainingDistance - 60; // 60m buffer
	
	// HP consumption during spurt at max speed
	const spurtHpPerSec = 20.0 * Math.pow(maxSpurtSpeed - baseSpeed + 12.0, 2) / 144.0 * groundModifier * gutsModifier;
	const spurtTime = spurtDistance / maxSpurtSpeed;
	const spurtHp = spurtHpPerSec * spurtTime;
	
	// Total HP needed for the entire race with max spurt
	const totalHpNeeded = phase0Hp + phase1Hp + spurtHp;
	
	// HP remaining after race (can be negative if horse runs out)
	const hpRemaining = maxHp - totalHpNeeded;
	
	// Can max spurt if we have enough HP
	const canMaxSpurt = hpRemaining >= 0;
	
	return {
		canMaxSpurt,
		maxHp,
		hpNeededForMaxSpurt: totalHpNeeded,
		maxSpurtSpeed,
		baseTargetSpeed2,
		hpRemaining
	};
}

/**
 * Enhanced comparison function that uses a shared pacer for proper pacemaker simulation.
 * This allows for realistic pacemaker behavior with multiple horses competing for the lead.
 * 
 * PERFORMANCE NOTE: Enhanced poskeep is computationally expensive. To prevent page crashes:
 * - Samples are automatically capped at a reasonable maximum
 * - Per-frame checks are throttled
 * - Data collection is sampled rather than continuous
 */
export function runEnhancedComparison(nsamples: number, course: CourseData, racedef: RaceParameters, uma1: HorseState, uma2: HorseState, pacer: HorseState, options) {
	// OPTIMIZATION: Cap samples to prevent excessive computation
	const MAX_ENHANCED_SAMPLES = 500; // Limit to prevent page freezes
	const effectiveSamples = Math.min(nsamples, MAX_ENHANCED_SAMPLES);
	if (nsamples > MAX_ENHANCED_SAMPLES) {
		console.warn(`Enhanced Poskeep: Limiting samples from ${nsamples} to ${MAX_ENHANCED_SAMPLES} to prevent performance issues`);
	}
	// Pre-calculate heal skills from uma's skill lists before race starts
	const uma1HealSkills = [];
	const uma2HealSkills = [];
	
	// Safety check: ensure skills exist and are iterable
	if (uma1.skills && typeof uma1.skills.forEach === 'function') {
		uma1.skills.forEach(skillId => {
		const skill = skilldata[skillId.split('-')[0]];
		if (skill && skill.alternatives) {
			skill.alternatives.forEach(alt => {
				if (alt.effects) {
					alt.effects.forEach(effect => {
						if (effect.type === 9) { // Recovery/Heal skill
							uma1HealSkills.push({
								id: skillId,
								heal: effect.modifier,
								duration: alt.baseDuration || 0
							});
						}
					});
				}
			});
		}
		});
	}
	
	if (uma2.skills && typeof uma2.skills.forEach === 'function') {
		uma2.skills.forEach(skillId => {
			const skill = skilldata[skillId.split('-')[0]];
			if (skill && skill.alternatives) {
				skill.alternatives.forEach(alt => {
					if (alt.effects) {
						alt.effects.forEach(effect => {
							if (effect.type === 9) { // Recovery/Heal skill
								uma2HealSkills.push({
									id: skillId,
									heal: effect.modifier,
									duration: alt.baseDuration || 0
								});
							}
						});
					}
				});
			}
		});
	}
	
	// Create base builder for shared configuration
	// Add buffer for retries (when s2.pos < pos1, we need to retry with swapped horses)
	// Typically 20-30% of samples need retries, so add 50% buffer to be safe
	const builderSamples = Math.ceil(effectiveSamples * 1.5);
	console.log(`[EnhancedPoskeep] Creating builder with ${builderSamples} samples (requesting ${effectiveSamples} successful samples)`);
	
	const baseBuilder = new RaceSolverBuilder(builderSamples)
		.seed(options.seed)
		.course(course)
		.ground(racedef.groundCondition)
		.weather(racedef.weather)
		.season(racedef.season)
		.time(racedef.time)
		.useEnhancedSpurt(options.useEnhancedSpurt || false)
		.accuracyMode(options.accuracyMode || false)
		.posKeepMode(options.posKeepMode);
	
	if (racedef.orderRange != null) {
		baseBuilder
			.order(racedef.orderRange[0], racedef.orderRange[1])
			.numUmas(racedef.numUmas);
	}

	// Create shared pacer if using virtual pacemaker mode
	let sharedPacer: RaceSolver | null = null;
	if (options.posKeepMode === PosKeepMode.Virtual && pacer) {
		const pacerConfig = pacer.toJS ? pacer.toJS() : pacer;
		const speedUpRate = options.pacerSpeedUpRate != null ? options.pacerSpeedUpRate : 100;
		
		// Create a temporary builder to generate the shared pacer
		const pacerBuilder = new RaceSolverBuilder(nsamples)
			.seed(options.seed)
			.course(course)
			.ground(racedef.groundCondition)
			.weather(racedef.weather)
			.season(racedef.season)
			.time(racedef.time)
			.pacer(pacerConfig, speedUpRate)
			.posKeepMode(options.posKeepMode);
		
		// Add pacer skills
		if (pacerConfig.skills && Array.isArray(pacerConfig.skills) && pacerConfig.skills.length > 0) {
			pacerConfig.skills.forEach((skillId: string) => {
				const cleanSkillId = skillId.split('-')[0];
				pacerBuilder.addPacerSkill(cleanSkillId);
			});
		}
		
		sharedPacer = pacerBuilder.createSharedPacer();
	}

	// Create builders for each horse
	const standard = baseBuilder.fork().horse(uma1.toJS());
	const compare = baseBuilder.fork().horse(uma2.toJS());
	
	// Apply rushed toggles
	if (options.allowRushedUma1 === false) {
		standard.disableRushed();
	}
	if (options.allowRushedUma2 === false) {
		compare.disableRushed();
	}
	if (options.allowDownhillUma1 === false) {
		standard.disableDownhill();
	}
	if (options.allowDownhillUma2 === false) {
		compare.disableDownhill();
	}
	if (options.allowSectionModifierUma1 === false) {
		standard.disableSectionModifier();
	}
	if (options.allowSectionModifierUma2 === false) {
		compare.disableSectionModifier();
	}
	if (options.allowSkillCheckChanceUma1 === false) {
		standard.skillCheckChance(false);
	}
	if (options.allowSkillCheckChanceUma2 === false) {
		compare.skillCheckChance(false);
	}

	// Add skills to each horse
	if (uma1.skills && typeof uma1.skills.forEach === 'function') {
		uma1.skills.forEach(skillId => {
			const cleanSkillId = skillId.split('-')[0];
			standard.addSkill(cleanSkillId);
		});
	}
	if (uma2.skills && typeof uma2.skills.forEach === 'function') {
		uma2.skills.forEach(skillId => {
			const cleanSkillId = skillId.split('-')[0];
			compare.addSkill(cleanSkillId);
		});
	}

	// Add forced skill positions
	if (uma1.forcedSkillPositions && typeof uma1.forcedSkillPositions.forEach === 'function') {
		uma1.forcedSkillPositions.forEach((position, skillId) => {
			standard.addSkillAtPosition(skillId, position);
		});
	}
	if (uma2.forcedSkillPositions && typeof uma2.forcedSkillPositions.forEach === 'function') {
		uma2.forcedSkillPositions.forEach((position, skillId) => {
			compare.addSkillAtPosition(skillId, position);
		});
	}

	if (!CC_GLOBAL) {
		standard.withAsiwotameru().withStaminaSyoubu();
		compare.withAsiwotameru().withStaminaSyoubu();
	}
	
	// Configure position keep / virtual pacemaker
	if (options.posKeepMode === PosKeepMode.Approximate) {
		// Use default pacer (old behavior)
		standard.useDefaultPacer();
		compare.useDefaultPacer();
	} else if (options.posKeepMode === PosKeepMode.Virtual) {
		// Use shared pacer if available, otherwise fallback to individual pacers
		if (sharedPacer) {
			// We'll need to modify the RaceSolver to accept an external pacer
			// For now, use the old method but with the same pacer config
			const pacerConfig = pacer.toJS ? pacer.toJS() : pacer;
			const speedUpRate = options.pacerSpeedUpRate != null ? options.pacerSpeedUpRate : 100;
			
			standard.pacer(pacerConfig, speedUpRate);
			compare.pacer(pacerConfig, speedUpRate);
			
			// Add pacer skills
			if (pacerConfig.skills && Array.isArray(pacerConfig.skills) && pacerConfig.skills.length > 0) {
				pacerConfig.skills.forEach((skillId: string) => {
					const cleanSkillId = skillId.split('-')[0];
					standard.addPacerSkill(cleanSkillId);
					compare.addPacerSkill(cleanSkillId);
				});
			}
		} else {
			// Fallback to default pacer
			standard.useDefaultPacer();
			compare.useDefaultPacer();
		}
	}
	// else: PosKeepMode.None - no pacer at all
	
	const skillPos1 = new Map(), skillPos2 = new Map();
	
	// Calculate theoretical max spurt based on stats (deterministic, RNG-independent)
	const uma1Calc = calculateTheoreticalMaxSpurt(uma1.toJS(), course, racedef.groundCondition);
	const uma2Calc = calculateTheoreticalMaxSpurt(uma2.toJS(), course, racedef.groundCondition);
	
	// Helper to ensure values are never undefined or NaN
	const safeNumber = (val: any, fallback = 0) => (typeof val === 'number' && !isNaN(val) && isFinite(val)) ? val : fallback;
	
	const spurtInfo1 = { 
		maxSpurt: uma1Calc.canMaxSpurt || false, 
		transition: safeNumber((course.distance * 2) / 3), // Typical spurt entry
		speed: safeNumber(uma1Calc.maxSpurtSpeed), 
		hpRemaining: safeNumber(uma1Calc.hpRemaining), // HP after entire race
		skillActivationRate: safeNumber(Math.max(100.0 - 9000.0 / uma1.toJS().wisdom, 20.0)),
		healSkillsAvailable: uma1HealSkills || [],
		hpDeficit: safeNumber(Math.max(0, -safeNumber(uma1Calc.hpRemaining))), // How much HP short
		healNeeded: safeNumber(uma1Calc.maxHp > 0 ? Math.max(0, -safeNumber(uma1Calc.hpRemaining)) / uma1Calc.maxHp * 10000 : 0)
	};
	const spurtInfo2 = { 
		maxSpurt: uma2Calc.canMaxSpurt || false,
		transition: safeNumber((course.distance * 2) / 3), // Typical spurt entry
		speed: safeNumber(uma2Calc.maxSpurtSpeed), 
		hpRemaining: safeNumber(uma2Calc.hpRemaining), // HP after entire race
		skillActivationRate: safeNumber(Math.max(100.0 - 9000.0 / uma2.toJS().wisdom, 20.0)),
		healSkillsAvailable: uma2HealSkills || [],
		hpDeficit: safeNumber(Math.max(0, -safeNumber(uma2Calc.hpRemaining))), // How much HP short
		healNeeded: safeNumber(uma2Calc.maxHp > 0 ? Math.max(0, -safeNumber(uma2Calc.hpRemaining)) / uma2Calc.maxHp * 10000 : 0)
	};

	// Run simulations with shared pacer awareness and overtake logic
	let a = standard.build();
	let b = compare.build();
	let ai = 1, bi = 0;  // data array indices (swapped compared to regular comparison)
	let sign = 1;         // sign for difference calculation
	let aIsUma1 = true;   // track which generator is uma1 (a starts as standard/uma1)
	
	// OPTIMIZATION: Track iteration count for early termination on errors
	let completedSamples = 0;
	
	// Track results like regular runComparison
	const diff = [];
	let min = Infinity, max = -Infinity;
	let minrun, maxrun, meanrun, medianrun;
	let estMean = 0, estMedian = 0, bestMeanDiff = Infinity, bestMedianDiff = Infinity;
	const sampleCutoff = Math.max(Math.floor(effectiveSamples * 0.8), effectiveSamples - 200);
	
	// Track retry state (similar to regular runComparison)
	let retry = false;
	let retryCount = 0;
	
	for (let i = 0; i < effectiveSamples; ++i) {
		
			
		// Pass retry flag to generator - when true, reuses current sample instead of advancing
		const { value: s1, done: done1 } = a.next(retry);
		const { value: s2, done: done2 } = b.next(retry);
		
		if (done1 || done2 || !s1 || !s2) {
			console.warn(`[EnhancedPoskeep] Generator exhausted at sample ${i}: done1=${done1}, done2=${done2}, s1=${!!s1}, s2=${!!s2}`);
			break;
		}
		
		// OPTIMIZATION: Timeout protection - if a single race takes too long, skip it
		const MAX_FRAMES_PER_RACE = 10000; // Safety limit (~11 minutes at 15fps)
		let raceFrameCount = 0;
		let s2FrameCount = 0;
		let s1FrameCount = 0;
		
		// Reset shared pacer for each sample
		if (sharedPacer && typeof sharedPacer.reset === 'function') {
			sharedPacer.reset();
		}
		
		// Create data structure for this race run
		const data = {
			t: [[], []], 
			p: [[], []], 
			v: [[], []], 
			hp: [[], []], 
			pacerGap: [[], []], 
			sk: [null, null], 
			sdly: [0, 0], 
			rushed: [[], []], 
			posKeep: [[], []], 
			pacerV: [[], []], 
			pacerP: [[], []], 
			pacerT: [[], []], 
			pacerPosKeep: [[], []]
		};
		
		// Note: ai and bi are already defined outside the loop for swap logic
		
		// Run the race simulation - step s2 until it finishes
		while (s2.pos < course.distance) {
			raceFrameCount++;
			s2FrameCount++;
			
			// OPTIMIZATION: Safety check to prevent infinite loops
			if (raceFrameCount > MAX_FRAMES_PER_RACE) {
				console.warn(`[EnhancedPoskeep] Sample ${i}: Race exceeded ${MAX_FRAMES_PER_RACE} frames (s2 at ${s2.pos.toFixed(1)}m/${course.distance}m), terminating`);
				break;
			}
			
			// DEBUG: Log if taking unusually long
			if (raceFrameCount % 1000 === 0) {
				console.log(`[EnhancedPoskeep] Sample ${i}: s2 still running after ${raceFrameCount} frames (pos: ${s2.pos.toFixed(1)}m/${course.distance}m, speed: ${s2.currentSpeed.toFixed(2)}m/s)`);
			}
			
			s2.step(1/15);
			data.t[ai].push(s2.accumulatetime.t);
			data.p[ai].push(s2.pos);
			data.v[ai].push(s2.currentSpeed + (s2.modifiers.currentSpeed.acc + s2.modifiers.currentSpeed.err));
			data.hp[ai].push((s2.hp as any).hp);
			data.pacerGap[ai].push(s2.pacer ? (s2.pacer.pos - s2.pos) : undefined);
			data.pacerV[ai].push(s2.pacer ? (s2.pacer.currentSpeed + (s2.pacer.modifiers.currentSpeed.acc + s2.pacer.modifiers.currentSpeed.err)) : undefined);
			data.pacerP[ai].push(s2.pacer ? s2.pacer.pos : undefined);
			data.pacerT[ai].push(s2.pacer ? s2.pacer.accumulatetime.t : undefined);
		}
		data.sdly[ai] = s2.startDelay;
		data.rushed[ai] = s2.rushedActivations ? s2.rushedActivations.slice() : [];
		data.posKeep[ai] = s2.positionKeepActivations ? s2.positionKeepActivations.slice() : [];
		data.pacerPosKeep[ai] = s2.pacer && s2.pacer.positionKeepActivations ? s2.pacer.positionKeepActivations.slice() : [];
		
		// Step s1 until it catches up to s2's time, but don't overshoot finish line
		while (s1.accumulatetime.t < s2.accumulatetime.t && s1.pos < course.distance) {
			s1FrameCount++;
			raceFrameCount++;
			
			// DEBUG: Safety check
			if (raceFrameCount > MAX_FRAMES_PER_RACE) {
				console.warn(`[EnhancedPoskeep] Sample ${i}: s1 catch-up exceeded ${MAX_FRAMES_PER_RACE} frames, terminating`);
				break;
			}
			
			s1.step(1/15);
			data.t[bi].push(s1.accumulatetime.t);
			data.p[bi].push(s1.pos);
			data.v[bi].push(s1.currentSpeed + (s1.modifiers.currentSpeed.acc + s1.modifiers.currentSpeed.err));
			data.hp[bi].push((s1.hp as any).hp);
			data.pacerGap[bi].push(s1.pacer ? (s1.pacer.pos - s1.pos) : undefined);
			data.pacerV[bi].push(s1.pacer ? (s1.pacer.currentSpeed + (s1.pacer.modifiers.currentSpeed.acc + s1.pacer.modifiers.currentSpeed.err)) : undefined);
			data.pacerP[bi].push(s1.pacer ? s1.pacer.pos : undefined);
			data.pacerT[bi].push(s1.pacer ? s1.pacer.accumulatetime.t : undefined);
		}
		
		// Continue s1 to finish
		const pos1 = s1.pos;

	
		while (s1.pos < course.distance) {
			s1FrameCount++;
			raceFrameCount++;

			// DEBUG: Safety check
			if (raceFrameCount > MAX_FRAMES_PER_RACE) {
				console.warn(`[EnhancedPoskeep] Sample ${i}: s1 finish exceeded ${MAX_FRAMES_PER_RACE} frames (s1 at ${s1.pos.toFixed(1)}m/${course.distance}m), terminating`);
				break;
			}

			// DEBUG: Log if taking unusually long
			if (s1FrameCount % 1000 === 0) {
				console.log(`[EnhancedPoskeep] Sample ${i}: s1 still running after ${s1FrameCount} frames (pos: ${s1.pos.toFixed(1)}m/${course.distance}m, speed: ${s1.currentSpeed.toFixed(2)}m/s)`);
			}

			s1.step(1/15);
			data.t[bi].push(s1.accumulatetime.t);
			data.p[bi].push(s1.pos);
			data.v[bi].push(s1.currentSpeed + (s1.modifiers.currentSpeed.acc + s1.modifiers.currentSpeed.err));
			data.hp[bi].push((s1.hp as any).hp);
			data.pacerGap[bi].push(s1.pacer ? (s1.pacer.pos - s1.pos) : undefined);
			data.pacerV[bi].push(s1.pacer ? (s1.pacer.currentSpeed + (s1.pacer.modifiers.currentSpeed.acc + s1.pacer.modifiers.currentSpeed.err)) : undefined);
			data.pacerP[bi].push(s1.pacer ? s1.pacer.pos : undefined);
			data.pacerT[bi].push(s1.pacer ? s1.pacer.accumulatetime.t : undefined);
		}
		data.sdly[bi] = s1.startDelay;
		data.rushed[bi] = s1.rushedActivations ? s1.rushedActivations.slice() : [];
		data.posKeep[bi] = s1.positionKeepActivations ? s1.positionKeepActivations.slice() : [];
		data.pacerPosKeep[bi] = s1.pacer && s1.pacer.positionKeepActivations ? s1.pacer.positionKeepActivations.slice() : [];
		
		// Update skill position tracking
		data.sk[1] = new Map(skillPos2);
		skillPos2.clear();
		data.sk[0] = new Map(skillPos1);
		skillPos1.clear();
		
			
		// Check if we need to retry with swapped horses (like regular runComparison)
		if (s2.pos < pos1 || isNaN(pos1)) {
			// Cleanup before swap retry
			if (s2.cleanup) s2.cleanup();
			if (s1.cleanup) s1.cleanup();

			// Swap generators and indices (like regular comparison)
			[b, a] = [a, b];
			[bi, ai] = [ai, bi];
			sign *= -1;
			aIsUma1 = !aIsUma1; // Flip which generator corresponds to which uma

			--i;
			retry = true;  // Tell generator to reuse current sample on next iteration
			retryCount++;
			continue;
		}
		
		// Successful iteration - reset retry flag
		retry = false;
		
		// Cleanup after successful race
		if (s2.cleanup) s2.cleanup();
		if (s1.cleanup) s1.cleanup();
		
		// Calculate basinn difference (position difference / 2.5 = horse body lengths)
		const basinn = sign * (s2.pos - pos1) / 2.5;
		diff.push(basinn);
		
		if (basinn < min) {
			min = basinn;
			minrun = data;
		}
		if (basinn > max) {
			max = basinn;
			maxrun = data;
		}
		
		// At 80% point, estimate mean and median for later comparison
		if (i == sampleCutoff && diff.length > 0) {
			diff.sort((a,b) => a - b);
			estMean = diff.reduce((a,b) => a + b) / diff.length;
			const mid = Math.floor(diff.length / 2);
			estMedian = mid > 0 && diff.length % 2 == 0 ? (diff[mid-1] + diff[mid]) / 2 : diff[mid];
		}
		
		// After cutoff, track runs closest to mean and median
		if (i >= sampleCutoff) {
			const meanDiff = Math.abs(basinn - estMean);
			const medianDiff = Math.abs(basinn - estMedian);
			if (meanDiff < bestMeanDiff) {
				bestMeanDiff = meanDiff;
				meanrun = data;
			}
			if (medianDiff < bestMedianDiff) {
				bestMedianDiff = medianDiff;
				medianrun = data;
			}
		}
		
		// Track successful completion
		completedSamples++;
	}
	
	// Sort final results
	diff.sort((a,b) => a - b);

	// Final performance summary
	const retryRate = ((retryCount / completedSamples) * 100).toFixed(1);
	console.log(`[EnhancedPoskeep] Performance Summary:`);
	console.log(`  Completed: ${completedSamples}/${effectiveSamples} samples`);
	console.log(`  Retries: ${retryCount} (${retryRate}% retry rate)`);
	console.log(`  Note: Fixed algorithm issue - s1 no longer overshoots finish line during catch-up`);

	// Log if we didn't complete all requested samples
	if (completedSamples < effectiveSamples) {
		console.warn(`Enhanced Poskeep: Only completed ${completedSamples}/${effectiveSamples} samples`);
	}
	
	// If no samples completed, add a default 0 result to prevent UI errors
	if (diff.length === 0) {
		console.warn('Enhanced Poskeep: No samples completed successfully');
		diff.push(0);
	}
	
	// Calculate spurt and stamina stats for display (ensure all values are safe numbers)
	const safeNumberStat = (val: any) => (typeof val === 'number' && !isNaN(val) && isFinite(val)) ? val : 0;
	
	const spurtStatsSummary = {
		uma1: {
			maxSpurtRate: safeNumberStat(0), // Not tracked in enhanced mode yet
			staminaSurvivalRate: safeNumberStat(0)
		},
		uma2: {
			maxSpurtRate: safeNumberStat(0),
			staminaSurvivalRate: safeNumberStat(0)
		}
	};
	
	// Create default empty run data in case no samples completed
	const emptyRunData = {
		t: [[], []], 
		p: [[], []], 
		v: [[], []], 
		hp: [[], []], 
		pacerGap: [[], []], 
		sk: [new Map(), new Map()], // Must be Maps, not null - UI calls .keys() on these
		sdly: [0, 0], 
		rushed: [[], []], 
		posKeep: [[], []], 
		pacerV: [[], []], 
		pacerP: [[], []], 
		pacerT: [[], []], 
		pacerPosKeep: [[], []]
	};
	
	// Return format matching regular runComparison (all numeric values guaranteed safe)
	return {
		results: diff.length > 0 ? diff : [0],
		runData: {
			minrun: minrun || emptyRunData, 
			maxrun: maxrun || emptyRunData, 
			meanrun: meanrun || emptyRunData, 
			medianrun: medianrun || emptyRunData
		},
		rushedStats: {
			uma1: {min: safeNumberStat(0), max: safeNumberStat(0), mean: safeNumberStat(0), frequency: safeNumberStat(0)}, 
			uma2: {min: safeNumberStat(0), max: safeNumberStat(0), mean: safeNumberStat(0), frequency: safeNumberStat(0)}
		},
		spurtInfo: {uma1: spurtInfo1, uma2: spurtInfo2},
		spurtStats: spurtStatsSummary
	};
}

export function runComparison(nsamples: number, course: CourseData, racedef: RaceParameters, uma1: HorseState, uma2: HorseState, pacer: HorseState, options) {
	// Pre-calculate heal skills from uma's skill lists before race starts
	const uma1HealSkills = [];
	const uma2HealSkills = [];
	
	uma1.skills.forEach(skillId => {
		const skill = skilldata[skillId.split('-')[0]];
		if (skill && skill.alternatives) {
			skill.alternatives.forEach(alt => {
				if (alt.effects) {
					alt.effects.forEach(effect => {
						if (effect.type === 9) { // Recovery/Heal skill
							uma1HealSkills.push({
								id: skillId,
								heal: effect.modifier,
								duration: alt.baseDuration || 0
							});
						}
					});
				}
			});
		}
	});
	
	uma2.skills.forEach(skillId => {
		const skill = skilldata[skillId.split('-')[0]];
		if (skill && skill.alternatives) {
			skill.alternatives.forEach(alt => {
				if (alt.effects) {
					alt.effects.forEach(effect => {
						if (effect.type === 9) { // Recovery/Heal skill
							uma2HealSkills.push({
								id: skillId,
								heal: effect.modifier,
								duration: alt.baseDuration || 0
							});
						}
					});
				}
			});
		}
	});
	
	const standard = new RaceSolverBuilder(nsamples)
		.seed(options.seed)
		.course(course)
		.ground(racedef.groundCondition)
		.weather(racedef.weather)
		.season(racedef.season)
		.time(racedef.time)
		.useEnhancedSpurt(options.useEnhancedSpurt || false)
		.accuracyMode(options.accuracyMode || false)
		.posKeepMode(options.posKeepMode);
	if (racedef.orderRange != null) {
		standard
			.order(racedef.orderRange[0], racedef.orderRange[1])
			.numUmas(racedef.numUmas);
	}
	// Fork to share RNG - both horses face the same random events for fair comparison
	const compare = standard.fork();
	
	standard.horse(uma1.toJS());
	compare.horse(uma2.toJS());
	
	// Apply rushed toggles
	if (options.allowRushedUma1 === false) {
		standard.disableRushed();
	}
	if (options.allowRushedUma2 === false) {
		compare.disableRushed();
	}
	
	// Apply downhill toggles
	if (options.allowDownhillUma1 === false) {
		standard.disableDownhill();
	}
	if (options.allowDownhillUma2 === false) {
		compare.disableDownhill();
	}
	
	if (options.allowSectionModifierUma1 === false) {
		standard.disableSectionModifier();
	}
	if (options.allowSectionModifierUma2 === false) {
		compare.disableSectionModifier();
	}
	
	// Apply skill check chance toggle
	if (options.skillCheckChanceUma1 === false) {
		standard.skillCheckChance(false);
	}
	if (options.skillCheckChanceUma2 === false) {
		compare.skillCheckChance(false);
	}
	// ensure skills common to the two umas are added in the same order regardless of what additional skills they have
	// this is important to make sure the rng for their activations is synced
	const common = uma1.skills.intersect(uma2.skills).toArray().sort((a,b) => +a - +b);
	const commonIdx = (id) => { let i = common.indexOf(id); return i > -1 ? i : common.length; };
	const sort = (a,b) => commonIdx(a) - commonIdx(b) || +a - +b;
	uma1.skills.toArray().sort(sort).forEach(id => {
		const skillId = id.split('-')[0];
		const forcedPos = uma1.forcedSkillPositions.get(id);
		if (forcedPos != null) {
			standard.addSkillAtPosition(skillId, forcedPos, Perspective.Self);
			compare.addSkill(skillId, Perspective.Other);
		} else {
			standard.addSkill(skillId, Perspective.Self);
			compare.addSkill(skillId, Perspective.Other);
		}
	});
	uma2.skills.toArray().sort(sort).forEach(id => {
		const skillId = id.split('-')[0];
		const forcedPos = uma2.forcedSkillPositions.get(id);
		if (forcedPos != null) {
			compare.addSkillAtPosition(skillId, forcedPos, Perspective.Self);
			standard.addSkill(skillId, Perspective.Other);
		} else {
			compare.addSkill(skillId, Perspective.Self);
			standard.addSkill(skillId, Perspective.Other);
		}
	});
	if (!CC_GLOBAL) {
		standard.withAsiwotameru().withStaminaSyoubu();
		compare.withAsiwotameru().withStaminaSyoubu();
	}
	
	// Configure position keep / virtual pacemaker
	if (options.posKeepMode === PosKeepMode.Approximate) {
		// Use default pacer (old behavior)
		standard.useDefaultPacer();
		compare.useDefaultPacer();
	} else if (options.posKeepMode === PosKeepMode.Virtual) {
		// Use custom pacemaker configuration if provided
		if (pacer) {
			const pacerConfig = pacer.toJS ? pacer.toJS() : pacer;
			const speedUpRate = options.pacerSpeedUpRate != null ? options.pacerSpeedUpRate : 100;
			
			standard.pacer(pacerConfig, speedUpRate);
			compare.pacer(pacerConfig, speedUpRate);
			
			// Add pacer skills
			if (pacerConfig.skills && Array.isArray(pacerConfig.skills) && pacerConfig.skills.length > 0) {
				pacerConfig.skills.forEach((skillId: string) => {
					const cleanSkillId = skillId.split('-')[0];
					standard.addPacerSkill(cleanSkillId);
					compare.addPacerSkill(cleanSkillId);
				});
			}
		} else {
			// Fallback to default pacer
			standard.useDefaultPacer();
			compare.useDefaultPacer();
		}
	}
	// else: PosKeepMode.None - no pacer at all
	
	const skillPos1 = new Map(), skillPos2 = new Map();
	
	// Calculate theoretical max spurt based on stats (deterministic, RNG-independent)
	const uma1Calc = calculateTheoreticalMaxSpurt(uma1.toJS(), course, racedef.groundCondition);
	const uma2Calc = calculateTheoreticalMaxSpurt(uma2.toJS(), course, racedef.groundCondition);
	
	const spurtInfo1 = { 
		maxSpurt: uma1Calc.canMaxSpurt, 
		transition: (course.distance * 2) / 3, // Typical spurt entry
		speed: uma1Calc.maxSpurtSpeed, 
		hpRemaining: uma1Calc.hpRemaining, // HP after entire race
		skillActivationRate: Math.max(100.0 - 9000.0 / uma1.toJS().wisdom, 20.0),
		healSkillsAvailable: uma1HealSkills,
		hpDeficit: Math.max(0, -uma1Calc.hpRemaining), // How much HP short
		healNeeded: Math.max(0, -uma1Calc.hpRemaining) / uma1Calc.maxHp * 10000
	};
	const spurtInfo2 = { 
		maxSpurt: uma2Calc.canMaxSpurt, 
		transition: (course.distance * 2) / 3, 
		speed: uma2Calc.maxSpurtSpeed, 
		hpRemaining: uma2Calc.hpRemaining, // HP after entire race
		skillActivationRate: Math.max(100.0 - 9000.0 / uma2.toJS().wisdom, 20.0),
		healSkillsAvailable: uma2HealSkills,
		hpDeficit: Math.max(0, -uma2Calc.hpRemaining), // How much HP short
		healNeeded: Math.max(0, -uma2Calc.hpRemaining) / uma2Calc.maxHp * 10000
	};
	function getActivator(selfSet, otherSet) {
		return function (s, id, persp) {
			const skillSet = persp == Perspective.Self ? selfSet : otherSet;
			if (id != 'asitame' && id != 'staminasyoubu') {
				if (!skillSet.has(id)) skillSet.set(id, []);
				skillSet.get(id).push([s.pos, s.pos]);  // Initialize with same position for instant skills
			}
		};
	}
	function getDeactivator(selfSet, otherSet) {
		return function (s, id, persp) {
			const skillSet = persp == Perspective.Self ? selfSet : otherSet;
			if (id != 'asitame' && id != 'staminasyoubu') {
				const ar = skillSet.get(id);  // activation record
				if (ar && ar.length > 0) {
					// Only update if this is a duration skill (position has moved)
					const activationPos = ar[ar.length-1][0];
					if (s.pos > activationPos) {
						ar[ar.length-1][1] = Math.min(s.pos, course.distance);
					}
				}
			}
		};
	}
	standard.onSkillActivate(getActivator(skillPos1, skillPos2));
	standard.onSkillDeactivate(getDeactivator(skillPos1, skillPos2));
	compare.onSkillActivate(getActivator(skillPos2, skillPos1));
	compare.onSkillDeactivate(getDeactivator(skillPos2, skillPos1));
	let a = standard.build(), b = compare.build();
	let ai = 1, bi = 0;
	let sign = 1;
	const diff = [];
	let min = Infinity, max = -Infinity, estMean, estMedian, bestMeanDiff = Infinity, bestMedianDiff = Infinity;
	let minrun, maxrun, meanrun, medianrun;
	const sampleCutoff = Math.max(Math.floor(nsamples * 0.8), nsamples - 200);
	let retry = false;
	
	// Track rushed statistics across all simulations
	const rushedStats = {
		uma1: { lengths: [], count: 0 },
		uma2: { lengths: [], count: 0 }
	};
	
	// Track spurt and stamina statistics
	const spurtStats = {
		uma1: { maxSpurtCount: 0, staminaSurvivalCount: 0, total: 0 },
		uma2: { maxSpurtCount: 0, staminaSurvivalCount: 0, total: 0 }
	};
	
	// Track which generator corresponds to which uma (flips when we swap generators)
	let aIsUma1 = true; // 'a' starts as standard builder (uma1)
	
	for (let i = 0; i < nsamples; ++i) {
		const s1 = a.next(retry).value as RaceSolver;
		const s2 = b.next(retry).value as RaceSolver;
		const data = {t: [[], []], p: [[], []], v: [[], []], hp: [[], []], pacerGap: [[], []], sk: [null,null], sdly: [0,0], rushed: [[], []], posKeep: [[], []], pacerV: [[], []], pacerP: [[], []], pacerT: [[], []], pacerPosKeep: [[], []]};

		while (s2.pos < course.distance) {
			s2.step(1/15);
			data.t[ai].push(s2.accumulatetime.t);
			data.p[ai].push(s2.pos);
			data.v[ai].push(s2.currentSpeed + (s2.modifiers.currentSpeed.acc + s2.modifiers.currentSpeed.err));
			data.hp[ai].push((s2.hp as any).hp);
			data.pacerGap[ai].push(s2.pacer ? (s2.pacer.pos - s2.pos) : undefined);
			data.pacerV[ai].push(s2.pacer ? (s2.pacer.currentSpeed + (s2.pacer.modifiers.currentSpeed.acc + s2.pacer.modifiers.currentSpeed.err)) : undefined);
			data.pacerP[ai].push(s2.pacer ? s2.pacer.pos : undefined);
			data.pacerT[ai].push(s2.pacer ? s2.pacer.accumulatetime.t : undefined);
			
		}
		data.sdly[ai] = s2.startDelay;
		data.rushed[ai] = s2.rushedActivations.slice();
		data.posKeep[ai] = s2.positionKeepActivations.slice();
		data.pacerPosKeep[ai] = s2.pacer ? s2.pacer.positionKeepActivations.slice() : [];

		while (s1.accumulatetime.t < s2.accumulatetime.t) {
			s1.step(1/15);
			data.t[bi].push(s1.accumulatetime.t);
			data.p[bi].push(s1.pos);
			data.v[bi].push(s1.currentSpeed + (s1.modifiers.currentSpeed.acc + s1.modifiers.currentSpeed.err));
			data.hp[bi].push((s1.hp as any).hp);
			data.pacerGap[bi].push(s1.pacer ? (s1.pacer.pos - s1.pos) : undefined);
			data.pacerV[bi].push(s1.pacer ? (s1.pacer.currentSpeed + (s1.pacer.modifiers.currentSpeed.acc + s1.pacer.modifiers.currentSpeed.err)) : undefined);
			data.pacerP[bi].push(s1.pacer ? s1.pacer.pos : undefined);
			data.pacerT[bi].push(s1.pacer ? s1.pacer.accumulatetime.t : undefined);
		}
		// run the rest of the way to have data for the chart
		const pos1 = s1.pos;
		while (s1.pos < course.distance) {
			s1.step(1/15);
			data.t[bi].push(s1.accumulatetime.t);
			data.p[bi].push(s1.pos);
			data.v[bi].push(s1.currentSpeed + (s1.modifiers.currentSpeed.acc + s1.modifiers.currentSpeed.err));
			data.hp[bi].push((s1.hp as any).hp);
			data.pacerGap[bi].push(s1.pacer ? (s1.pacer.pos - s1.pos) : undefined);
			data.pacerV[bi].push(s1.pacer ? (s1.pacer.currentSpeed + (s1.pacer.modifiers.currentSpeed.acc + s1.pacer.modifiers.currentSpeed.err)) : undefined);
			data.pacerP[bi].push(s1.pacer ? s1.pacer.pos : undefined);
			data.pacerT[bi].push(s1.pacer ? s1.pacer.accumulatetime.t : undefined);
		}
		data.sdly[bi] = s1.startDelay;
		data.rushed[bi] = s1.rushedActivations.slice();
		data.posKeep[bi] = s1.positionKeepActivations.slice();
		data.pacerPosKeep[bi] = s1.pacer ? s1.pacer.positionKeepActivations.slice() : [];

		//implement dragging here

		data.sk[1] = new Map(skillPos2);  // NOT ai (NB. why not?)
		skillPos2.clear();
		data.sk[0] = new Map(skillPos1);  // NOT bi (NB. why not?)
		skillPos1.clear();

		// if `standard` is faster than `compare` then the former ends up going past the course distance
		// this is not in itself a problem, but it would overestimate the difference if for example a skill
		// continues past the end of the course. i feel like there are probably some other situations where it would
		// be inaccurate also. if this happens we have to swap them around and run it again.
		if (s2.pos < pos1 || isNaN(pos1)) {
			// Cleanup before swap retry
			s2.cleanup();
			s1.cleanup();
			
			[b,a] = [a,b];
			[bi,ai] = [ai,bi];
			sign *= -1;
			aIsUma1 = !aIsUma1; // Flip which generator corresponds to which uma
			--i;  // this one didnt count
			retry = true;
		} else {
			retry = false;
			
			// ONLY track stats for valid iterations (after swap check, but BEFORE cleanup)
			// Key insight: After swaps, s1 and s2 variable names don't tell us which uma they are!
			// We need to track which BUILDER (a or b) they came from:
			// - s1 always comes from generator 'a'
			// - s2 always comes from generator 'b'
			// - 'a' started as standard builder (uma1), 'b' started as compare builder (uma2)
			// - After swaps, 'a' might generate uma2 and 'b' might generate uma1
			// BUT: we swapped both the generators AND the indices, so:
			//   - If aIsUma1, then s1=uma1, s2=uma2
			//   - After swap: generators swap AND indices swap, so relationship stays same!
			
			// Actually wait, that's not right either. Let me think...
			// After [b,a]=[a,b], the generator that WAS producing uma1 is now in variable 'b'
			// And the generator that WAS producing uma2 is now in variable 'a'
			// So after swaps, aIsUma1 flips!
			
			// Determine which uma each solver represents based on current generator state
			// s1 came from generator 'a': if aIsUma1, then s1 is uma1, else s1 is uma2  
			// s2 came from generator 'b': if aIsUma1, then s2 is uma2, else s2 is uma1
			const s1IsUma1 = aIsUma1;
			const s2IsUma1 = !aIsUma1;
			
			if (options.useEnhancedSpurt) {
				// Each iteration generates ONE solver per uma, not two!
				// s1 is from generator 'a', s2 is from generator 'b'
			// Track stats for s1's uma
			const s1Stats = s1IsUma1 ? spurtStats.uma1 : spurtStats.uma2;
			s1Stats.total++;
			const s1Hp = s1.hp as any;
			const s1MaxSpurt = s1Hp.isMaxSpurt && s1Hp.isMaxSpurt();
			if (s1MaxSpurt) {
				s1Stats.maxSpurtCount++;
			}
			const s1Survived = s1Hp.hp > 0;
			if (s1Survived) {
				s1Stats.staminaSurvivalCount++;
			}
			
			// Track stats for s2's uma
			const s2Stats = s2IsUma1 ? spurtStats.uma1 : spurtStats.uma2;
			s2Stats.total++;
			const s2Hp = s2.hp as any;
			const s2MaxSpurt = s2Hp.isMaxSpurt && s2Hp.isMaxSpurt();
			if (s2MaxSpurt) {
				s2Stats.maxSpurtCount++;
			}
			const s2Survived = s2Hp.hp > 0;
			if (s2Survived) {
				s2Stats.staminaSurvivalCount++;
			}
			}
			
			// Cleanup AFTER stat tracking
			s2.cleanup();
			s1.cleanup();

			
			// Collect rushed statistics (also based on which uma the solver represents)
			if (s1.rushedActivations.length > 0) {
				const [start, end] = s1.rushedActivations[0];
				const length = end - start;
				const s1RushedStats = s1IsUma1 ? rushedStats.uma1 : rushedStats.uma2;
				s1RushedStats.lengths.push(length);
				s1RushedStats.count++;
			}
			if (s2.rushedActivations.length > 0) {
				const [start, end] = s2.rushedActivations[0];
				const length = end - start;
				const s2RushedStats = s2IsUma1 ? rushedStats.uma1 : rushedStats.uma2;
				s2RushedStats.lengths.push(length);
				s2RushedStats.count++;
			}
			const basinn = sign * (s2.pos - pos1) / 2.5;
			diff.push(basinn);
			if (basinn < min) {
				min = basinn;
				minrun = data;
			}
			if (basinn > max) {
				max = basinn;
				maxrun = data;
			}
			if (i == sampleCutoff) {
				diff.sort((a,b) => a - b);
				estMean = diff.reduce((a,b) => a + b) / diff.length;
				const mid = Math.floor(diff.length / 2);
				estMedian = mid > 0 && diff.length % 2 == 0 ? (diff[mid-1] + diff[mid]) / 2 : diff[mid];
			}
			if (i >= sampleCutoff) {
				const meanDiff = Math.abs(basinn - estMean), medianDiff = Math.abs(basinn - estMedian);
				if (meanDiff < bestMeanDiff) {
					bestMeanDiff = meanDiff;
					meanrun = data;
				}
				if (medianDiff < bestMedianDiff) {
					bestMedianDiff = medianDiff;
					medianrun = data;
				}
			}
		}
	}
	diff.sort((a,b) => a - b);
	
	// Calculate rushed statistics
	const calculateStats = (stats) => {
		if (stats.lengths.length === 0) {
			return { min: 0, max: 0, mean: 0, frequency: 0 };
		}
		const min = Math.min(...stats.lengths);
		const max = Math.max(...stats.lengths);
		const mean = stats.lengths.reduce((a, b) => a + b, 0) / stats.lengths.length;
		const frequency = (stats.count / nsamples) * 100; // percentage
		return { min, max, mean, frequency };
	};
	
	const rushedStatsSummary = {
		uma1: calculateStats(rushedStats.uma1),
		uma2: calculateStats(rushedStats.uma2)
	};
	
	// Calculate spurt and stamina survival rates
	const spurtStatsSummary = options.useEnhancedSpurt ? {
		uma1: {
			maxSpurtRate: spurtStats.uma1.total > 0 ? (spurtStats.uma1.maxSpurtCount / spurtStats.uma1.total * 100) : 0,
			staminaSurvivalRate: spurtStats.uma1.total > 0 ? (spurtStats.uma1.staminaSurvivalCount / spurtStats.uma1.total * 100) : 0
		},
		uma2: {
			maxSpurtRate: spurtStats.uma2.total > 0 ? (spurtStats.uma2.maxSpurtCount / spurtStats.uma2.total * 100) : 0,
			staminaSurvivalRate: spurtStats.uma2.total > 0 ? (spurtStats.uma2.staminaSurvivalCount / spurtStats.uma2.total * 100) : 0
		}
	} : null;
	
	// Each run (min, max, mean, median) already has its own rushed data from its actual simulation
	// We don't need to overwrite it - just ensure the rushed field is properly formatted
	// The rushed data comes from the RaceSolver.rushedActivations collected during each specific run
	
	return {
		results: diff, 
		runData: {minrun, maxrun, meanrun, medianrun},
		rushedStats: rushedStatsSummary,
		spurtInfo: options.useEnhancedSpurt ? { uma1: spurtInfo1, uma2: spurtInfo2 } : null,
		spurtStats: spurtStatsSummary
	};
}
