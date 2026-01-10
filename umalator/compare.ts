import { CourseData } from '../uma-skill-tools/CourseData';
import { RaceParameters, GroundCondition } from '../uma-skill-tools/RaceParameters';
import { RaceSolver, PosKeepMode } from '../uma-skill-tools/RaceSolver';
import { RaceSolverBuilder, Perspective, parseStrategy, parseAptitude, buildBaseStats, buildAdjustedStats } from '../uma-skill-tools/RaceSolverBuilder';
import { EnhancedHpPolicy } from '../uma-skill-tools/EnhancedHpPolicy';
import { GameHpPolicy } from '../uma-skill-tools/HpPolicy';
import { HorseParameters } from '../uma-skill-tools/HorseTypes';

import { HorseState } from '../components/HorseDefTypes';

import skilldata from '../uma-skill-tools/data/skill_data.json';
import skillmeta from '../skill_meta.json';
import { Rule30CARng } from '../uma-skill-tools/Random';

export function runComparison(nsamples: number, course: CourseData, racedef: RaceParameters, uma1: HorseState, uma2: HorseState, pacer: HorseState, options) {
	const standard = new RaceSolverBuilder(nsamples)
		.seed(options.seed)
		.course(course)
		.ground(racedef.groundCondition)
		.weather(racedef.weather)
		.season(racedef.season)
		.time(racedef.time)
		.posKeepMode(options.posKeepMode)
		.mode(options.mode);
	if (racedef.orderRange != null) {
		standard
			.order(racedef.orderRange[0], racedef.orderRange[1])
			.numUmas(racedef.numUmas);
	}
	// Fork to share RNG - both horses face the same random events for fair comparison
	const compare = standard.fork();
	
	if (options.mode === 'compare' && !options.syncRng) {
		standard.desync();
	}
	
	const uma1_ = uma1.update('skills', sk => Array.from(sk.values())).toJS();
	const uma2_ = uma2.update('skills', sk => Array.from(sk.values())).toJS();
	standard.horse(uma1_);
	compare.horse(uma2_);
	
	if (options.skillWisdomCheck === false) {
		standard.skillWisdomCheck(false);
		compare.skillWisdomCheck(false);
	}
	
	if (options.rushedKakari === false) {
		standard.rushedKakari(false);
		compare.rushedKakari(false);
	}
	
	if (options.competeFight !== undefined) {
		standard.competeFight(options.competeFight);
		compare.competeFight(options.competeFight);
	}
	
	if (options.duelingRates) {
		standard.duelingRates(options.duelingRates);
		compare.duelingRates(options.duelingRates);
	}
	
	if (options.leadCompetition !== undefined) {
		standard.leadCompetition(options.leadCompetition);
		compare.leadCompetition(options.leadCompetition);
	}
	
	// ensure skills common to the two umas are added in the same order regardless of what additional skills they have
	// this is important to make sure the rng for their activations is synced
	// sort first by groupId so that white and gold versions of a skill get added in the same order
	const common = uma1.skills.keySeq().toSet().intersect(uma2.skills.keySeq().toSet()).toArray().sort((a,b) => +a - +b);
	const commonIdx = (id) => { let i = common.indexOf(skillmeta[id].groupId); return i > -1 ? i : common.length; };
	const sort = (a,b) => commonIdx(a) - commonIdx(b) || +a - +b;
	
	const uma1Horse = uma1.toJS();
	const uma1BaseStats = buildBaseStats(uma1Horse, uma1Horse.mood);
	const uma1AdjustedStats = buildAdjustedStats(uma1BaseStats, course, racedef.groundCondition);
	const uma1Wisdom = uma1AdjustedStats.wisdom;
	
	const uma2Horse = uma2.toJS();
	const uma2BaseStats = buildBaseStats(uma2Horse, uma2Horse.mood);
	const uma2AdjustedStats = buildAdjustedStats(uma2BaseStats, course, racedef.groundCondition);
	const uma2Wisdom = uma2AdjustedStats.wisdom;
	
	uma1_.skills.sort(sort).forEach(id => {
		const forcedPos = uma1.forcedSkillPositions.get(id);
		if (forcedPos != null) {
			standard.addSkillAtPosition(id, forcedPos, Perspective.Self);
		} else {
			standard.addSkill(id, Perspective.Self);
		}
	});
	uma2_.skills.sort(sort).forEach(id => {
		const forcedPos = uma2.forcedSkillPositions.get(id);
		if (forcedPos != null) {
			compare.addSkillAtPosition(id, forcedPos, Perspective.Self);
		} else {
			compare.addSkill(id, Perspective.Self);
		}
	});
	uma1_.skills.forEach(id => {
		const forcedPos = uma1.forcedSkillPositions.get(id);
		if (forcedPos != null) {
			compare.addSkillAtPosition(id, forcedPos, Perspective.Other, uma1Wisdom);
		} else {
			compare.addSkill(id, Perspective.Other, undefined, uma1Wisdom); 
		}
	});
	uma2_.skills.forEach(id => {
		const forcedPos = uma2.forcedSkillPositions.get(id);
		if (forcedPos != null) {
			standard.addSkillAtPosition(id, forcedPos, Perspective.Other, uma2Wisdom);
		} else {
			standard.addSkill(id, Perspective.Other, undefined, uma2Wisdom);
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
			const pacer_ = pacer.update('skills', sk => Array.from(sk.values()));
			pacerHorse = standard.pacer(pacer_);
		}
		else {
			pacerHorse = standard.useDefaultPacer();
		}
	}
	
	const skillPos1 = new Map(), skillPos2 = new Map();
	function getActivator(skillSet) {
		return function (s, id, persp) {
			if (persp == Perspective.Self && id != 'asitame' && id != 'staminasyoubu') {
				if (!skillSet.has(id)) skillSet.set(id, []);
				skillSet.get(id).push([s.pos, -1]);
			}
		};
	}
	function getDeactivator(skillSet) {
		return function (s, id, persp) {
			if (persp == Perspective.Self && id != 'asitame' && id != 'staminasyoubu') {
				const ar = skillSet.get(id);  // activation record
				// in the case of adding multiple copies of speed debuffs a skill can activate again before the first
				// activation has finished (as each copy has the same ID), so we can't just access a specific index
				// (-1).
				// assume that multiple activations of a skill always deactivate in the same order (probably true?) so
				// just seach for the first record that hasn't had its deactivation location filled out yet.
				const r = ar.find(x => x[1] == -1);
				// onSkillDeactivate gets called twice for skills that have both speed and accel components, so the end
				// position could already have been filled out and r will be undefined
				if (r != null) r[1] = Math.min(s.pos, course.distance);
			}
		};
	}
	standard.onSkillActivate(getActivator(skillPos1));
	standard.onSkillDeactivate(getDeactivator(skillPos1));
	compare.onSkillActivate(getActivator(skillPos2));
	compare.onSkillDeactivate(getDeactivator(skillPos2));
	let a = standard.build(), b = compare.build();
	let ai = 1, bi = 0;
	let sign = 1;
	const diff = [];
	let min = Infinity, max = -Infinity, estMean, estMedian, bestMeanDiff = Infinity, bestMedianDiff = Infinity;
	let minrun, maxrun, meanrun, medianrun;
	const allSkillActivations = [new Map<string, number[]>(), new Map<string, number[]>()];
	const allSkillActivationBasinn = [new Map<string, Array<[number, number]>>(), new Map<string, Array<[number, number]>>()];
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
	
	const competeFightStats = {
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
		const data = {t: [[], []], p: [[], []], v: [[], []], hp: [[], []], currentLane: [[], []], pacerGap: [[], []], sk: [null,null], sdly: [0,0], rushed: [[], []], posKeep: [[], []], competeFight: [[], []], leadCompetition: [[], []], downhillActivations: [[], []], pacerV: [[], [], []], pacerP: [[], [], []], pacerT: [[], [], []], pacerPosKeep: [[], [], []], pacerLeadCompetition: [[], [], []]};

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
				data.downhillActivations[ai] = s2.downhillActivations.slice();
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
				data.downhillActivations[bi] = s1.downhillActivations.slice();
				if (s1.competeFightStart != null) {
					data.competeFight[bi] = [s1.competeFightStart, s1.competeFightEnd != null ? s1.competeFightEnd : course.distance];
				}
				if (s1.leadCompetitionStart != null) {
					data.leadCompetition[bi] = [s1.leadCompetitionStart, s1.leadCompetitionEnd != null ? s1.leadCompetitionEnd : course.distance];
				}
			}

			s2.updatefirstUmaInLateRace();
		}

		s2.cleanup();
		s1.cleanup();

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

		data.sk[1] = new Map(skillPos2);  // NOT ai (NB. why not?)
		data.sk[0] = new Map(skillPos1);  // NOT bi (NB. why not?)
		
		const runSkillActivations: Array<{skillId: string, activationPos: number, umaIndex: number}> = [];
		
		skillPos1.forEach((positions, skillId) => {
			if (!allSkillActivations[0].has(skillId)) {
				allSkillActivations[0].set(skillId, []);
			}
			positions.forEach(pos => {
				if (Array.isArray(pos) && pos.length >= 1 && typeof pos[0] === 'number') {
					const activationPos = pos[0];
					allSkillActivations[0].get(skillId)!.push(activationPos);
					runSkillActivations.push({skillId, activationPos, umaIndex: 0});
				}
			});
		});
		
		skillPos2.forEach((positions, skillId) => {
			if (!allSkillActivations[1].has(skillId)) {
				allSkillActivations[1].set(skillId, []);
			}
			positions.forEach(pos => {
				if (Array.isArray(pos) && pos.length >= 1 && typeof pos[0] === 'number') {
					const activationPos = pos[0];
					allSkillActivations[1].get(skillId)!.push(activationPos);
					runSkillActivations.push({skillId, activationPos, umaIndex: 1});
				}
			});
		});
		
		skillPos2.clear();
		skillPos1.clear();

		retry = false;
		
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
			
			if (solver.competeFightStart != null) {
				const start = solver.competeFightStart;
				const end = solver.competeFightEnd != null ? solver.competeFightEnd : course.distance;
				const length = end - start;
				const competeFightStat = isUma1 ? competeFightStats.uma1 : competeFightStats.uma2;
				competeFightStat.lengths.push(length);
				competeFightStat.count++;
			}
		};
		
		trackSolverStats(s1, true);
		trackSolverStats(s2, false);
		
		const basinn = sign * posDifference / 2.5;
		diff.push(basinn);
		
		runSkillActivations.forEach(({skillId, activationPos, umaIndex}) => {
			if (!allSkillActivationBasinn[umaIndex].has(skillId)) {
				allSkillActivationBasinn[umaIndex].set(skillId, []);
			}
			allSkillActivationBasinn[umaIndex].get(skillId)!.push([activationPos, basinn]);
		});
		
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
	
	const competeFightStatsSummary = {
		uma1: calculateStats(competeFightStats.uma1),
		uma2: calculateStats(competeFightStats.uma2)
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
	
	const allRunsData = {
		sk: [
			allSkillActivations[0],
			allSkillActivations[1]
		],
		skBasinn: [
			allSkillActivationBasinn[0],
			allSkillActivationBasinn[1]
		],
		totalRuns: nsamples,
		rushed: [
			rushedStatsSummary.uma1,
			rushedStatsSummary.uma2
		],
		leadCompetition: [
			leadCompetitionStatsSummary.uma1,
			leadCompetitionStatsSummary.uma2
		],
		competeFight: [
			competeFightStatsSummary.uma1,
			competeFightStatsSummary.uma2
		]
	};
	
	return {
		results: diff, 
		runData: {
			minrun, 
			maxrun, 
			meanrun, 
			medianrun, 
			allruns: allRunsData
		},
		staminaStats: staminaStatsSummary,
		firstUmaStats: firstUmaStatsSummary
	};
}
