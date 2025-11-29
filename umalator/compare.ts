import { CourseData } from '../uma-skill-tools/CourseData';
import { RaceParameters, GroundCondition } from '../uma-skill-tools/RaceParameters';
import { RaceSolver, PosKeepMode } from '../uma-skill-tools/RaceSolver';
import { RaceSolverBuilder, Perspective, parseStrategy, parseAptitude, buildBaseStats, buildAdjustedStats } from '../uma-skill-tools/RaceSolverBuilder';
import { EnhancedHpPolicy } from '../uma-skill-tools/EnhancedHpPolicy';
import { GameHpPolicy } from '../uma-skill-tools/HpPolicy';
import { HorseParameters } from '../uma-skill-tools/HorseTypes';

import { HorseState } from '../components/HorseDefTypes';

import skilldata from '../uma-skill-tools/data/skill_data.json';
import { Rule30CARng } from '../uma-skill-tools/Random';

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
		.posKeepMode(options.posKeepMode)
		.mode(options.mode);
	if (racedef.orderRange != null) {
		standard
			.order(racedef.orderRange[0], racedef.orderRange[1])
			.numUmas(racedef.numUmas);
	}
	// Fork to share RNG - both horses face the same random events for fair comparison
	const compare = standard.fork();
	
	if (options.mode === 'compare') {
		standard.desync();
	}
	
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
	
	const uma1Horse = uma1.toJS();
	const uma1BaseStats = buildBaseStats(uma1Horse, uma1Horse.mood);
	const uma1AdjustedStats = buildAdjustedStats(uma1BaseStats, course, racedef.groundCondition);
	const uma1Wisdom = uma1AdjustedStats.wisdom;
	
	const uma2Horse = uma2.toJS();
	const uma2BaseStats = buildBaseStats(uma2Horse, uma2Horse.mood);
	const uma2AdjustedStats = buildAdjustedStats(uma2BaseStats, course, racedef.groundCondition);
	const uma2Wisdom = uma2AdjustedStats.wisdom;
	
	// Note for future self as to why we only add perspective other in non-chart mode:
	// 1) this sucks
	// 2) this is to fix a trigger region desync bug caused by skills that affect other umas (i.e. HRice unique)
	uma1.skills.toArray().sort(sort).forEach(id => {
		const skillId = id.split('-')[0];
		const forcedPos = uma1.forcedSkillPositions.get(id);
		if (forcedPos != null) {
			standard.addSkillAtPosition(skillId, forcedPos, Perspective.Self);
			if (options.mode === 'compare') { compare.addSkillAtPosition(skillId, forcedPos, Perspective.Other, uma1Wisdom); }
		} else {
			standard.addSkill(skillId, Perspective.Self);
			if (options.mode === 'compare') { compare.addSkill(skillId, Perspective.Other, undefined, uma1Wisdom); }
		}
	});
	uma2.skills.toArray().sort(sort).forEach(id => {
		const skillId = id.split('-')[0];
		const forcedPos = uma2.forcedSkillPositions.get(id);
		if (forcedPos != null) {
			compare.addSkillAtPosition(skillId, forcedPos, Perspective.Self);
			if (options.mode === 'compare') { standard.addSkillAtPosition(skillId, forcedPos, Perspective.Other, uma2Wisdom); }
		} else {
			compare.addSkill(skillId, Perspective.Self);
			if (options.mode === 'compare') { standard.addSkill(skillId, Perspective.Other, undefined, uma2Wisdom); }
		}
	});
	if (!CC_GLOBAL) {
		standard.withAsiwotameru().withStaminaSyoubu();
		compare.withAsiwotameru().withStaminaSyoubu();
	}

	let pacerHorse = null;

	if (options.posKeepMode === PosKeepMode.Approximate) {
		pacerHorse = standard.useDefaultPacer(true);
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
	
	const leadCompetitionStats = {
		uma1: { lengths: [], count: 0 },
		uma2: { lengths: [], count: 0 }
	};
	
	// Track stamina survival and full spurt statistics
	const staminaStats = {
		uma1: { 
			hpDiedCount: 0, 
			fullSpurtCount: 0, 
			total: 0, 
			hpDiedPositionsFullSpurt: [] as number[],
			hpDiedPositionsNonFullSpurt: [] as number[],
			nonFullSpurtVelocityDiffs: [] as number[],
			nonFullSpurtDelayDistances: [] as number[]
		},
		uma2: { 
			hpDiedCount: 0, 
			fullSpurtCount: 0, 
			total: 0, 
			hpDiedPositionsFullSpurt: [] as number[],
			hpDiedPositionsNonFullSpurt: [] as number[],
			nonFullSpurtVelocityDiffs: [] as number[],
			nonFullSpurtDelayDistances: [] as number[]
		}
	};
	
	// Track last spurt 1st place frequency
	// This is primarily useful for front runners where we want to evaluate how effective
	// they are at getting angling & scheming
	//
	// note: eventually we could also even limit angling & scheming proc to only occur
	// when the uma is *actually* 1st place in the sim instead of using a probability estimate?
	const firstUmaStats = {
		uma1: { firstPlaceCount: 0, total: 0 },
		uma2: { firstPlaceCount: 0, total: 0 }
	};
	
	// Track which generator corresponds to which uma (flips when we swap generators)
	let aIsUma1 = true; // 'a' starts as standard builder (uma1)

	let basePacerRng = new Rule30CARng(options.seed + 1);
	
	for (let i = 0; i < nsamples; ++i) {
		let pacers = [];

		for (let j = 0; j < options.pacemakerCount; ++j) {
			let pacerRng = new Rule30CARng(basePacerRng.int32());
			const pacer: RaceSolver | null = pacerHorse != null ? standard.buildPacer(pacerHorse, i, pacerRng) : null;
			pacers.push(pacer);
		}

		const pacer: RaceSolver | null = pacers.length > 0 ? pacers[0] : null;

		const s1 = a.next(retry).value as RaceSolver;
		const s2 = b.next(retry).value as RaceSolver;
		const data = {t: [[], []], p: [[], []], v: [[], []], hp: [[], []], currentLane: [[], []], pacerGap: [[], []], sk: [null,null], sdly: [0,0], rushed: [[], []], posKeep: [[], []], competeFight: [[], []], leadCompetition: [[], []], pacerV: [[], [], []], pacerP: [[], [], []], pacerT: [[], [], []], pacerPosKeep: [[], [], []], pacerLeadCompetition: [[], [], []]};

		s1.initUmas([s2, ...pacers]);
		s2.initUmas([s1, ...pacers]);

		pacers.forEach(p => {
			p?.initUmas([s1, s2, ...pacers.filter(p2 => p2 !== p)]);
		});

		let s1Finished = false;
		let s2Finished = false;
		let posDifference = 0;

		while (!s1Finished || !s2Finished) {
			let currentPacer = null;

			if (pacer) {
				currentPacer = pacer.getPacer();

				pacer.umas.forEach(u => {
					u.updatePacer(currentPacer);
				});
			}

			if (s2.pos < course.distance) {
				data.pacerGap[ai].push(currentPacer ? currentPacer.pos - s2.pos : undefined);
			}
			if (s1.pos < course.distance) {
				data.pacerGap[bi].push(currentPacer ? currentPacer.pos - s1.pos : undefined);
			}

			for (let j = 0; j < options.pacemakerCount; j++) {
				const p = j < pacers.length ? pacers[j] : null;
				if (!p || p.pos >= course.distance) continue;
				p.step(1/15);
				data.pacerV[j].push(p ? (p.currentSpeed + (p.modifiers.currentSpeed.acc + p.modifiers.currentSpeed.err)) : undefined);
				data.pacerP[j].push(p ? p.pos : undefined);
				data.pacerT[j].push(p ? p.accumulatetime.t : undefined);
			}

			if (s2.pos < course.distance) {
				s2.step(1/15);

				data.t[ai].push(s2.accumulatetime.t);
				data.p[ai].push(s2.pos);
				data.v[ai].push(s2.currentSpeed + (s2.modifiers.currentSpeed.acc + s2.modifiers.currentSpeed.err));
				data.hp[ai].push((s2.hp as any).hp);
				data.currentLane[ai].push(s2.currentLane);
			}
			else if (!s2Finished) {
				s2Finished = true;

				data.sdly[ai] = s2.startDelay;
				data.rushed[ai] = s2.rushedActivations.slice();
				data.posKeep[ai] = s2.positionKeepActivations.slice();
				if (s2.competeFightStart != null) {
					data.competeFight[ai] = [s2.competeFightStart, s2.competeFightEnd != null ? s2.competeFightEnd : course.distance];
				}
				if (s2.leadCompetitionStart != null) {
					data.leadCompetition[ai] = [s2.leadCompetitionStart, s2.leadCompetitionEnd != null ? s2.leadCompetitionEnd : course.distance];
				}
			}

			if (s1.pos < course.distance) {
				s1.step(1/15);

				data.t[bi].push(s1.accumulatetime.t);
				data.p[bi].push(s1.pos);
				data.v[bi].push(s1.currentSpeed + (s1.modifiers.currentSpeed.acc + s1.modifiers.currentSpeed.err));
				data.hp[bi].push((s1.hp as any).hp);
				data.currentLane[bi].push(s1.currentLane);
			}
			else if (!s1Finished) {
				s1Finished = true;

				data.sdly[bi] = s1.startDelay;
				data.rushed[bi] = s1.rushedActivations.slice();
				data.posKeep[bi] = s1.positionKeepActivations.slice();
				if (s1.competeFightStart != null) {
					data.competeFight[bi] = [s1.competeFightStart, s1.competeFightEnd != null ? s1.competeFightEnd : course.distance];
				}
				if (s1.leadCompetitionStart != null) {
					data.leadCompetition[bi] = [s1.leadCompetitionStart, s1.leadCompetitionEnd != null ? s1.leadCompetitionEnd : course.distance];
				}
			}

			s2.updatefirstUmaInLateRace();
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

		pacers.forEach(p => {
			if (p && p.pos < course.distance) {
				p.step(1/15);

				for (let pacemakerIndex = 0; pacemakerIndex < 3; pacemakerIndex++) {
					if (pacemakerIndex < pacers.length && pacers[pacemakerIndex] === p) {
						data.pacerV[pacemakerIndex].push(p ? (p.currentSpeed + (p.modifiers.currentSpeed.acc + p.modifiers.currentSpeed.err)) : undefined);
						data.pacerP[pacemakerIndex].push(p ? p.pos : undefined);
						data.pacerT[pacemakerIndex].push(p ? p.accumulatetime.t : undefined);
					}
				}
			}
		});

		for (let j = 0; j < options.pacemakerCount; j++) {
			const p = j < pacers.length ? pacers[j] : null;
			data.pacerPosKeep[j] = p ? p.positionKeepActivations.slice() : [];
			if (p && p.leadCompetitionStart != null) {
				data.pacerLeadCompetition[j] = [p.leadCompetitionStart, p.leadCompetitionEnd != null ? p.leadCompetitionEnd : course.distance];
			} else {
				data.pacerLeadCompetition[j] = [];
			}
		}

		// Clean up skills that are still active when the race ends
		// This ensures skills that activate near the finish line get proper end positions
		// Also handles skills with very short durations that might deactivate in the same frame
		const cleanupActiveSkills = (solver, selfSkillSet, otherSkillSet) => {
			const allActiveSkills = [
				...solver.activeTargetSpeedSkills,
				...solver.activeCurrentSpeedSkills,
				...solver.activeAccelSkills
			];
			
			allActiveSkills.forEach(skill => {
				// Call the deactivator to set the end position to course.distance
				// This handles both race-end cleanup and very short duration skills
				// Use the correct skill position maps for this solver
				getDeactivator(selfSkillSet, otherSkillSet)(solver, skill.skillId, skill.perspective);
			});
		};

		// Clean up active skills for both horses
		// s1 comes from generator 'a' (standard), s2 comes from generator 'b' (compare)
		// standard uses skillPos1 for self, skillPos2 for other
		// compare uses skillPos2 for self, skillPos1 for other
		cleanupActiveSkills(s1, skillPos1, skillPos2);
		cleanupActiveSkills(s2, skillPos2, skillPos1);

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
		
		const trackSolverStats = (solver: RaceSolver, isUma1: boolean) => {
			const staminaStat = isUma1 ? staminaStats.uma1 : staminaStats.uma2;
			staminaStat.total++;
			
			if (solver.hpDied) {
				staminaStat.hpDiedCount++;
				if (solver.hpDiedPosition != null) {
					if (solver.fullSpurt) {
						staminaStat.hpDiedPositionsFullSpurt.push(solver.hpDiedPosition);
					} else {
						staminaStat.hpDiedPositionsNonFullSpurt.push(solver.hpDiedPosition);
					}
				}
			}
			
			if (solver.fullSpurt) {
				staminaStat.fullSpurtCount++;
			} else {
				if (solver.nonFullSpurtVelocityDiff != null) {
					staminaStat.nonFullSpurtVelocityDiffs.push(solver.nonFullSpurtVelocityDiff);
				}
				if (solver.nonFullSpurtDelayDistance != null) {
					staminaStat.nonFullSpurtDelayDistances.push(solver.nonFullSpurtDelayDistance);
				}
			}
			
			const firstUmaStat = isUma1 ? firstUmaStats.uma1 : firstUmaStats.uma2;
			firstUmaStat.total++;
			if (solver.firstUmaInLateRace) {
				firstUmaStat.firstPlaceCount++;
			}
			
			if (solver.rushedActivations.length > 0) {
				const [start, end] = solver.rushedActivations[0];
				const length = end - start;
				const rushedStat = isUma1 ? rushedStats.uma1 : rushedStats.uma2;
				rushedStat.lengths.push(length);
				rushedStat.count++;
			}
			
			if (solver.leadCompetitionStart != null) {
				const start = solver.leadCompetitionStart;
				const end = solver.leadCompetitionEnd != null ? solver.leadCompetitionEnd : course.distance;
				const length = end - start;
				const leadCompStat = isUma1 ? leadCompetitionStats.uma1 : leadCompetitionStats.uma2;
				leadCompStat.lengths.push(length);
				leadCompStat.count++;
			}
		};
		
		trackSolverStats(s1, s1IsUma1);
		trackSolverStats(s2, s2IsUma1);

		// Cleanup AFTER stat tracking
		s2.cleanup();
		s1.cleanup();
		
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
	
	const leadCompetitionStatsSummary = {
		uma1: calculateStats(leadCompetitionStats.uma1),
		uma2: calculateStats(leadCompetitionStats.uma2)
	};
	
	const calculateHpDiedPositionStats = (positions: number[]) => {
		if (positions.length === 0) {
			return { count: 0, min: null, max: null, mean: null, median: null };
		}
		const sorted = [...positions].sort((a, b) => a - b);
		const min = sorted[0];
		const max = sorted[sorted.length - 1];
		const mean = positions.reduce((a, b) => a + b, 0) / positions.length;
		const mid = Math.floor(sorted.length / 2);
		const median = sorted.length % 2 === 0 
			? (sorted[mid - 1] + sorted[mid]) / 2 
			: sorted[mid];
		return { count: positions.length, min, max, mean, median };
	};
	
	// Calculate stamina survival and full spurt rates
	const staminaStatsSummary = {
		uma1: {
			staminaSurvivalRate: staminaStats.uma1.total > 0 ? ((staminaStats.uma1.total - staminaStats.uma1.hpDiedCount) / staminaStats.uma1.total * 100) : 0,
			fullSpurtRate: staminaStats.uma1.total > 0 ? (staminaStats.uma1.fullSpurtCount / staminaStats.uma1.total * 100) : 0,
			hpDiedPositionStatsFullSpurt: calculateHpDiedPositionStats(staminaStats.uma1.hpDiedPositionsFullSpurt),
			hpDiedPositionStatsNonFullSpurt: calculateHpDiedPositionStats(staminaStats.uma1.hpDiedPositionsNonFullSpurt),
			nonFullSpurtVelocityStats: calculateHpDiedPositionStats(staminaStats.uma1.nonFullSpurtVelocityDiffs),
			nonFullSpurtDelayStats: calculateHpDiedPositionStats(staminaStats.uma1.nonFullSpurtDelayDistances)
		},
		uma2: {
			staminaSurvivalRate: staminaStats.uma2.total > 0 ? ((staminaStats.uma2.total - staminaStats.uma2.hpDiedCount) / staminaStats.uma2.total * 100) : 0,
			fullSpurtRate: staminaStats.uma2.total > 0 ? (staminaStats.uma2.fullSpurtCount / staminaStats.uma2.total * 100) : 0,
			hpDiedPositionStatsFullSpurt: calculateHpDiedPositionStats(staminaStats.uma2.hpDiedPositionsFullSpurt),
			hpDiedPositionStatsNonFullSpurt: calculateHpDiedPositionStats(staminaStats.uma2.hpDiedPositionsNonFullSpurt),
			nonFullSpurtVelocityStats: calculateHpDiedPositionStats(staminaStats.uma2.nonFullSpurtVelocityDiffs),
			nonFullSpurtDelayStats: calculateHpDiedPositionStats(staminaStats.uma2.nonFullSpurtDelayDistances)
		}
	};
	
	const firstUmaStatsSummary = {
		uma1: {
			firstPlaceRate: firstUmaStats.uma1.total > 0 ? (firstUmaStats.uma1.firstPlaceCount / firstUmaStats.uma1.total * 100) : 0
		},
		uma2: {
			firstPlaceRate: firstUmaStats.uma2.total > 0 ? (firstUmaStats.uma2.firstPlaceCount / firstUmaStats.uma2.total * 100) : 0
		}
	};
	
	// Each run (min, max, mean, median) already has its own rushed data from its actual simulation
	// We don't need to overwrite it - just ensure the rushed field is properly formatted
	// The rushed data comes from the RaceSolver.rushedActivations collected during each specific run
	
	return {
		results: diff, 
		runData: {minrun, maxrun, meanrun, medianrun},
		rushedStats: rushedStatsSummary,
		leadCompetitionStats: leadCompetitionStatsSummary,
		spurtInfo: options.useEnhancedSpurt ? { uma1: spurtInfo1, uma2: spurtInfo2 } : null,
		staminaStats: staminaStatsSummary,
		firstUmaStats: firstUmaStatsSummary
	};
}
