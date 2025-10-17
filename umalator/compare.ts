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
	baseTargetSpeed2: number
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

	let pacerHorse = null;

	if (options.posKeepMode === PosKeepMode.Approximate) {
		pacerHorse = standard.useDefaultPacer();
	} 
	else if (options.posKeepMode === PosKeepMode.Virtual) {
		if (pacer) {
			const pacerConfig = pacer.toJS ? pacer.toJS() : pacer;
			pacerHorse = standard.pacer(pacerConfig);

			if (pacerConfig.skills && Array.isArray(pacerConfig.skills) && pacerConfig.skills.length > 0) {
				pacerConfig.skills.forEach((skillId: string) => {
					const cleanSkillId = skillId.split('-')[0];
					standard.addPacerSkill(cleanSkillId);
				});
			}
		}
		else {
			pacerHorse = standard.useDefaultPacer();
		}
	}
	
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
	let retryCount = 0;
	
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
		const pacer: RaceSolver | null = pacerHorse != null ? standard.buildPacer(pacerHorse, i) : null;

		const s1 = a.next(retry).value as RaceSolver;
		const s2 = b.next(retry).value as RaceSolver;
		const data = {t: [[], []], p: [[], []], v: [[], []], hp: [[], []], pacerGap: [[], []], sk: [null,null], sdly: [0,0], rushed: [[], []], posKeep: [[], []], pacerV: [[], []], pacerP: [[], []], pacerT: [[], []], pacerPosKeep: [[], []]};

		s1.initUmas([s2, pacer]);
		s2.initUmas([s1, pacer]);
		pacer?.initUmas([s1, s2]);

		let s1Finished = false;
		let s2Finished = false;
		let posDifference = 0;

		while (!s1Finished || !s2Finished) {
			let currentPacer = null;

			if (pacer) {
				currentPacer = pacer.getPacer();
			}

			if (pacer && pacer.pos < course.distance) {
				pacer.step(1/15);
			}

			if (s2.pos < course.distance) {
				s2.step(1/15);

				data.t[ai].push(s2.accumulatetime.t);
				data.p[ai].push(s2.pos);
				data.v[ai].push(s2.currentSpeed + (s2.modifiers.currentSpeed.acc + s2.modifiers.currentSpeed.err));
				data.hp[ai].push((s2.hp as any).hp);
				data.pacerGap[ai].push(currentPacer ? (currentPacer.pos - s2.pos) : undefined);
				data.pacerV[ai].push(pacer ? (pacer.currentSpeed + (pacer.modifiers.currentSpeed.acc + pacer.modifiers.currentSpeed.err)) : undefined);
				data.pacerP[ai].push(pacer ? pacer.pos : undefined);
				data.pacerT[ai].push(pacer ? pacer.accumulatetime.t : undefined);
			}
			else if (!s2Finished) {
				s2Finished = true;

				data.sdly[ai] = s2.startDelay;
				data.rushed[ai] = s2.rushedActivations.slice();
				data.posKeep[ai] = s2.positionKeepActivations.slice();
				data.pacerPosKeep[ai] = pacer ? pacer.positionKeepActivations.slice() : [];
			}

			if (s1.pos < course.distance) {
				s1.step(1/15);

				data.t[bi].push(s1.accumulatetime.t);
				data.p[bi].push(s1.pos);
				data.v[bi].push(s1.currentSpeed + (s1.modifiers.currentSpeed.acc + s1.modifiers.currentSpeed.err));
				data.hp[bi].push((s1.hp as any).hp);
				data.pacerGap[bi].push(currentPacer ? (currentPacer.pos - s1.pos) : undefined);
				data.pacerV[bi].push(pacer ? (pacer.currentSpeed + (pacer.modifiers.currentSpeed.acc + pacer.modifiers.currentSpeed.err)) : undefined);
				data.pacerP[bi].push(pacer ? pacer.pos : undefined);
				data.pacerT[bi].push(pacer ? pacer.accumulatetime.t : undefined);
			}
			else if (!s1Finished) {
				s1Finished = true;

				data.sdly[bi] = s1.startDelay;
				data.rushed[bi] = s1.rushedActivations.slice();
				data.posKeep[bi] = s1.positionKeepActivations.slice();
				data.pacerPosKeep[bi] = pacer ? pacer.positionKeepActivations.slice() : [];
			}
		}

		// ai took less time to finish (less frames to finish)
		if (data.p[ai].length <= data.p[bi].length) {
			let aiFrames = data.p[ai].length;
			posDifference = data.p[ai][aiFrames - 1] - data.p[bi][aiFrames - 1];
		}
		else {
			let biFrames = data.p[bi].length;
			posDifference = data.p[ai][biFrames - 1] - data.p[bi][biFrames - 1];
		}

		if (pacer && pacer.pos < course.distance) {
			while (pacer.pos < course.distance) {
				pacer.step(1/15);

				data.pacerV[bi].push(pacer ? (pacer.currentSpeed + (pacer.modifiers.currentSpeed.acc + pacer.modifiers.currentSpeed.err)) : undefined);
				data.pacerP[bi].push(pacer ? pacer.pos : undefined);
				data.pacerT[bi].push(pacer ? pacer.accumulatetime.t : undefined);
			}
		}

		data.sk[1] = new Map(skillPos2);  // NOT ai (NB. why not?)
		skillPos2.clear();
		data.sk[0] = new Map(skillPos1);  // NOT bi (NB. why not?)
		skillPos1.clear();

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
		const basinn = sign * posDifference / 2.5;
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
