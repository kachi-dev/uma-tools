import { strict as assert } from 'node:assert';

import { Strategy, Aptitude, HorseParameters, StrategyHelpers } from './HorseTypes';
import { CourseData, CourseHelpers, Phase } from './CourseData';
import { Region } from './Region';
import { PRNG, Rule30CARng } from './Random';
import type { HpPolicy } from './HpPolicy';
import { ApproximateCondition } from './ApproximateConditions';
import { createBlockedSideCondition, createOvertakeCondition } from './SpecialConditions';

declare var CC_GLOBAL: boolean

// for the browser builds, CC_GLOBAL is defined by esbuild as true/false
// for node however we have to manually define it as false
// annoyingly we can't use `var` here to define it locally because esbuild rewrites all uses of that to not be
// replaced by the define
// not entirely happy with this solution
if (typeof CC_GLOBAL == "undefined") global.CC_GLOBAL = false;


namespace Speed {
	export const StrategyPhaseCoefficient = Object.freeze([
		[], // strategies start numbered at 1
		[1.0, 0.98, 0.962],
		[0.978, 0.991, 0.975],
		[0.938, 0.998, 0.994],
		[0.931, 1.0, 1.0],
		[1.063, 0.962, 0.95]
	].map(a => Object.freeze(a)));
	export const DistanceProficiencyModifier = Object.freeze([1.05, 1.0, 0.9, 0.8, 0.6, 0.4, 0.2, 0.1]);
}

function baseSpeed(course: CourseData) {
	return 20.0 - (course.distance - 2000) / 1000.0;
}

function baseTargetSpeed(horse: HorseParameters, course: CourseData, phase: Phase) {
	return baseSpeed(course) * Speed.StrategyPhaseCoefficient[horse.strategy][phase] +
		+(phase == 2) * Math.sqrt(500.0 * horse.speed) *
		Speed.DistanceProficiencyModifier[horse.distanceAptitude] *
		0.002;
}

function lastSpurtSpeed(horse: HorseParameters, course: CourseData) {
	let v = (baseTargetSpeed(horse, course, 2) + 0.01 * baseSpeed(course)) * 1.05 +
		Math.sqrt(500.0 * horse.speed) * Speed.DistanceProficiencyModifier[horse.distanceAptitude] * 0.002;
	v += Math.pow(450.0 * horse.guts, 0.597) * 0.0001;
	return v;
}

namespace Acceleration {
	export const StrategyPhaseCoefficient = Object.freeze([
		[],
		[1.0, 1.0, 0.996],
		[0.985, 1.0, 0.996],
		[0.975, 1.0, 1.0],
		[0.945, 1.0, 0.997],
		[1.17, 0.94, 0.956]
	].map(a => Object.freeze(a)));
	export const GroundTypeProficiencyModifier = Object.freeze([1.05, 1.0, 0.9, 0.8, 0.7, 0.5, 0.3, 0.1]);
	export const DistanceProficiencyModifier = Object.freeze([1.0, 1.0, 1.0, 1.0, 1.0, 0.6, 0.5, 0.4]);
}

const BaseAccel = 0.0006;
const UphillBaseAccel = 0.0004;

function baseAccel(baseAccel: number, horse: HorseParameters, phase: Phase) {
	return baseAccel * Math.sqrt(500.0 * horse.power) *
	  Acceleration.StrategyPhaseCoefficient[horse.strategy][phase] *
	  Acceleration.GroundTypeProficiencyModifier[horse.surfaceAptitude] *
	  Acceleration.DistanceProficiencyModifier[horse.distanceAptitude];
}

const PhaseDeceleration = [-1.2, -0.8, -1.0];

namespace PositionKeep {
	export const BaseMinimumThreshold = Object.freeze([0, 0, 3.0, 6.5, 7.5]);
	export const BaseMaximumThreshold = Object.freeze([0, 0, 5.0, 7.0, 8.0]);

	export function courseFactor(distance: number) {
		return 0.0008 * (distance - 1000) + 1.0;
	}

	export function minThreshold(strategy: Strategy, distance: number) {
		// senkou minimum threshold is a constant 3.0 independent of the course factor for some reason
		return BaseMinimumThreshold[strategy] * (strategy == Strategy.Senkou ? 1.0 : courseFactor(distance));
	}

	export function maxThreshold(strategy: Strategy, distance: number) {
		return BaseMaximumThreshold[strategy] * courseFactor(distance);
	}
}

// these are commonly initialized with a negative number and then checked >= 0 to see if a duration is up
// (the reason for doing that instead of initializing with 0 and then checking against the duration is if
// the code that checks for the duration expiring is separate from the code that initializes the timer and
// has to deal with different durations)
export class Timer {
	constructor(public t: number) {}
}

export class CompensatedAccumulator {
	constructor(public acc: number, public err: number = 0.0) {}

	add(n: number) {
		const t = this.acc + n;
		if (Math.abs(this.acc) >= Math.abs(n)) {
			this.err += (this.acc - t) + n;
		} else {
			this.err += (n - t) + this.acc;
		}
		this.acc = t;
	}
}

export interface RaceState {
	readonly accumulatetime: Readonly<Timer>
	readonly activateCount: readonly number[]
	readonly activateCountHeal: number
	readonly currentSpeed: number
	readonly isLastSpurt: boolean
	readonly lastSpurtSpeed: number
	readonly lastSpurtTransition: number
	readonly positionKeepState: PositionKeepState
	readonly isDownhillMode: boolean
	readonly phase: Phase
	readonly pos: number
	readonly hp: Readonly<HpPolicy>
	readonly randomLot: number
	readonly startDelay: number
	readonly gateRoll: number
	readonly usedSkills: ReadonlySet<string>
	readonly leadCompetition: boolean
	readonly posKeepStrategy: Strategy
}

export type DynamicCondition = (state: RaceState) => boolean;

export const enum Perspective {
	Self = 1,
	Other = 2,
	Any = 3
}

export const enum SkillType {
	SpeedUp = 1,
	StaminaUp = 2,
	PowerUp = 3,
	GutsUp = 4,
	WisdomUp = 5,
	Recovery = 9,
	MultiplyStartDelay = 10,
	SetStartDelay = 14,
	CurrentSpeed = 21,
	CurrentSpeedWithNaturalDeceleration = 22,
	TargetSpeed = 27,
	LaneMovementSpeed = 28,
	Accel = 31,
	ChangeLane = 35,
	ActivateRandomGold = 37,
	ExtendEvolvedDuration = 42
}

export const enum SkillRarity { White = 1, Gold, Unique, Evolution = 6 }

export const enum PositionKeepState {
	None = 0,
	PaceUp = 1,
	PaceDown = 2,
	SpeedUp = 3,
	Overtake = 4,
}

export function getPositionKeepStateName(state: PositionKeepState): string {
	switch (state) {
		case PositionKeepState.None: return 'None';
		case PositionKeepState.PaceUp: return 'PaceUp';
		case PositionKeepState.PaceDown: return 'PaceDown';
		case PositionKeepState.SpeedUp: return 'SpeedUp';
		case PositionKeepState.Overtake: return 'Overtake';
		default: return 'Unknown';
	}
}

export const enum PosKeepMode { None, Approximate, Virtual }

export function getPosKeepModeName(mode: PosKeepMode): string {
	switch (mode) {
		case PosKeepMode.None: return 'None';
		case PosKeepMode.Approximate: return 'Approximate';
		case PosKeepMode.Virtual: return 'Virtual';
		default: return 'Unknown';
	}
}

export interface SkillEffect {
	type: SkillType
	baseDuration: number
	modifier: number
}

export interface PendingSkill {
	skillId: string
	perspective?: Perspective
	rarity: SkillRarity
	trigger: Region
	extraCondition: DynamicCondition
	effects: SkillEffect[]
	originWisdom?: number
}

interface ActiveSkill {
	skillId: string
	perspective?: Perspective
	durationTimer: Timer
	modifier: number
}

function noop(x: unknown) {}

export class RaceSolver {
	accumulatetime: Timer
	pos: number
	minSpeed: number
	currentSpeed: number
	targetSpeed: number
	accel: number
	baseTargetSpeed: number[]
	lastSpurtSpeed: number
	lastSpurtTransition: number
	sectionModifier: number[]
	baseAccel: number[]
	horse: { -readonly[P in keyof HorseParameters]: HorseParameters[P] }
	course: CourseData
	hp: HpPolicy
	rng: PRNG
	syncRng: PRNG
	gorosiRng: PRNG
	rushedRng: PRNG
	downhillRng: PRNG
	wisdomRollRng: PRNG
	posKeepRng: PRNG
	laneMovementRng: PRNG
	specialConditionRng: PRNG
	timers: Timer[]
	startDash: boolean
	startDelay: number
	startDelayAccumulator: number
	gateRoll: number
	randomLot: number
	isLastSpurt: boolean
	phase: Phase
	nextPhaseTransition: number
	activeTargetSpeedSkills: ActiveSkill[]
	activeCurrentSpeedSkills: (ActiveSkill & {naturalDeceleration: boolean})[]
	activeAccelSkills: ActiveSkill[]
	activeLaneMovementSkills: ActiveSkill[]
	activeChangeLaneSkills: ActiveSkill[]
	pendingSkills: PendingSkill[]
	pendingRemoval: Set<string>
	usedSkills: Set<string>
	nHills: number
	hillIdx: number
	hillStart: number[]
	hillEnd: number[]
	activateCount: number[]
	activateCountHeal: number
	onSkillActivate: (s: RaceSolver, skillId: string, perspective: Perspective) => void
	onSkillDeactivate: (s: RaceSolver, skillId: string, perspective: Perspective) => void
	sectionLength: number
	umas: RaceSolver[]
	isPacer: boolean
	pacerOverride: boolean
	posKeepMinThreshold: number
	posKeepMaxThreshold: number
	posKeepCooldown: Timer
	posKeepNextTimer: Timer
	posKeepExitPosition: number;
	posKeepExitDistance: number;
	posKeepEnd: number
	positionKeepState: PositionKeepState
	posKeepMode: PosKeepMode
	posKeepSpeedCoef: number
	posKeepStrategy: Strategy
	mode: string | undefined
	pacer: RaceSolver | null

	// Rushed state
	isRushed: boolean
	hasBeenRushed: boolean  // Track if horse has already been rushed this race (can only happen once)
	rushedSection: number  // Which section (2-9) the rushed state activates in
	rushedEnterPosition: number  // Position where rushed state should activate
	rushedTimer: Timer  // Tracks time in rushed state
	rushedMaxDuration: number  // Maximum duration (12s + extensions)
	rushedActivations: Array<[number, number]>  // Track [start, end] positions for UI
	positionKeepActivations: Array<[number, number, PositionKeepState]>  // Track [start, end, state] positions for UI

	speedUpProbability: number  // 0-100, probability of entering speed-up mode
	
	//downhill mode
	isDownhillMode: boolean
	disableDownhill: boolean
	downhillModeStart: number | null  // Frame when downhill mode started
	lastDownhillCheckFrame: number  // Last frame we checked for downhill mode changes

	//skill check chance
	skillCheckChance: boolean

	// Compete Fight
	competeFight: boolean
	competeFightStart: number | null
	competeFightEnd: number | null
	competeFightTimer: Timer

	// Lead Competition
	leadCompetition: boolean
	leadCompetitionStart: number | null
	leadCompetitionEnd: number | null
	leadCompetitionTimer: Timer
	
	// lane movement..........
	currentLane: number
    targetLane: number
    laneChangeSpeed: number
    extraMoveLane: number
    forceInSpeed: number

	firstUmaInLateRace: boolean

	hpDied: boolean
	fullSpurt: boolean

	modifiers: {
		targetSpeed: CompensatedAccumulator
		currentSpeed: CompensatedAccumulator
		accel: CompensatedAccumulator
		oneFrameAccel: number
		specialSkillDurationScaling: number
	}

	private conditionTimer: Timer
	private conditionValues: Map<string, number> = new Map()
	private conditions: Map<string, ApproximateCondition> = new Map()

	constructor(params: {
		horse: HorseParameters,
		course: CourseData,
		rng: PRNG,
		skills: PendingSkill[],
		hp: HpPolicy,
		onSkillActivate?: (s: RaceSolver, skillId: string) => void,
		onSkillDeactivate?: (s: RaceSolver, skillId: string) => void,
		disableRushed?: boolean,
		disableDownhill?: boolean,
		disableSectionModifier?: boolean,
		speedUpProbability?: number,
		skillCheckChance?: boolean,
		posKeepMode?: PosKeepMode,
		mode?: string,
		isPacer?: boolean,
	}) {
		// clone since green skills may modify the stat values
		this.horse = Object.assign({}, params.horse);
		this.course = params.course;
		this.hp = params.hp;
		this.rng = params.rng;
		this.pendingSkills = params.skills.slice();  // copy since we remove from it
		this.pendingRemoval = new Set();
		this.usedSkills = new Set();
		this.syncRng = new Rule30CARng(this.rng.int32());
		this.gorosiRng = new Rule30CARng(this.rng.int32());
		this.rushedRng = new Rule30CARng(this.rng.int32());
		this.downhillRng = new Rule30CARng(this.rng.int32());
		this.wisdomRollRng = new Rule30CARng(this.rng.int32());
		this.posKeepRng = new Rule30CARng(this.rng.int32());
		this.laneMovementRng = new Rule30CARng(this.rng.int32());
		this.specialConditionRng = new Rule30CARng(this.rng.int32());
		this.timers = [];
		this.conditionTimer = this.getNewTimer(-1.0);
		this.accumulatetime = this.getNewTimer();
		// bit of a hack because implementing post_number is surprisingly annoying, since we don't have RaceParameters.numUmas available here
		// and can't draw random numbers in the conditions. instead what we do is draw a random number here that decides the gate, and then
		// in the post_number dynamic condition we mod that by the number of umas to figure out our starting position, and then figure out
		// which gate block that is in. however, n%k is not in general uniformly distributed for a random n, and we can't/don't want to instantiate
		// a new rng instance in the dynamic condition for rejection sampling. fortunately n%k IS uniformly distributed when n_max ≡ k - 1 (mod k)
		// the smallest n_max where that is true for every k in [1,18] is lcm(1, 2, … 18) - 1 (n_max ≡ k-1 (mod k) means k divides n_max+1. the
		// smallest n_max where this is true for every k = 1, 2, … 18 is lcm(1, 2, … 18) - 1), which is 12252239. since PRNG#uniform excludes its
		// upper bound, just generate up to lcm(1, 2, … 18) = 12252240
		this.gateRoll = this.rng.uniform(12252240);
		this.randomLot = this.rng.uniform(100);
		this.phase = 0;
		this.nextPhaseTransition = CourseHelpers.phaseStart(this.course.distance, 1);
		this.activeTargetSpeedSkills = [];
		this.activeCurrentSpeedSkills = [];
		this.activeAccelSkills = [];
		this.activeLaneMovementSkills = [];
		this.activeChangeLaneSkills = [];
		this.activateCount = [0,0,0];
		this.activateCountHeal = 0;
		this.onSkillActivate = params.onSkillActivate || noop;
		this.onSkillDeactivate = params.onSkillDeactivate || noop;
		this.sectionLength = this.course.distance / 24.0;
		this.posKeepMinThreshold = PositionKeep.minThreshold(this.horse.strategy, this.course.distance);
		this.posKeepMaxThreshold = PositionKeep.maxThreshold(this.horse.strategy, this.course.distance);
		this.posKeepNextTimer = this.getNewTimer();
		this.positionKeepState = PositionKeepState.None;
		this.posKeepMode = params.posKeepMode || PosKeepMode.None;
		this.posKeepStrategy = this.horse.strategy;
		this.mode = params.mode;
		// For skill chart we want to minimize poskeep skewing results
		// (i.e. in rare situations, an uma can proc a velocity skill, and gain initial positioning
		// but then lose that positioning because they are too far forward to proc Pace Up)
		// this then results in -L in the charts
		this.posKeepEnd = this.sectionLength * (this.mode === 'compare' ? 10.0 : 3.0);
		this.posKeepSpeedCoef = 1.0;
		this.isPacer = params.isPacer || false;
		this.pacerOverride = false;
		this.umas = [];
		this.pacer = null;

		//init timer
		this.speedUpProbability = params.speedUpProbability != null ? params.speedUpProbability : 100
		
		// Initialize rushed state
		this.isRushed = false;
		this.hasBeenRushed = false;
		this.rushedSection = -1;
		this.rushedEnterPosition = -1;
		this.rushedTimer = this.getNewTimer();
		this.rushedMaxDuration = 12.0;
		
		// Initialize downhill mode
		this.isDownhillMode = false;
		this.disableDownhill = params.disableDownhill || false;
		this.downhillModeStart = null;
		this.lastDownhillCheckFrame = 0;
		
		// Initialize skill check chance
		this.skillCheckChance = params.skillCheckChance !== false; // Default to true
		this.rushedActivations = [];
		this.positionKeepActivations = [];
		this.firstUmaInLateRace = false;
		this.hpDied = false;
		this.fullSpurt = false;
		// Calculate rushed chance and determine if/when it activates
		this.initRushedState(params.disableRushed || false);

		this.competeFight = false;
		this.competeFightStart = null;
		this.competeFightEnd = null;
		this.competeFightTimer = this.getNewTimer();

		this.leadCompetition = false;
		this.leadCompetitionStart = null;
		this.leadCompetitionEnd = null;
		this.leadCompetitionTimer = this.getNewTimer();

		const gateNumberRaw = this.gateRoll % 9;
		const gateNumber = gateNumberRaw < 9 ? gateNumberRaw : 1 + (24 - gateNumberRaw) % 8;
		const initialLane = gateNumber * this.course.horseLane;

		this.currentLane = initialLane;
		this.targetLane = initialLane;
		this.laneChangeSpeed = 0.0;
		this.extraMoveLane = -1.0;
		this.forceInSpeed = 0.0;

		this.modifiers = {
			targetSpeed: new CompensatedAccumulator(0.0),
			currentSpeed: new CompensatedAccumulator(0.0),
			accel: new CompensatedAccumulator(0.0),
			oneFrameAccel: 0.0,
			specialSkillDurationScaling: 1.0
		};

		this.initHills();

		this.startDelay = 0.1 * this.rng.random();

		this.pos = 0.0;
		this.accel = 0.0;
		this.currentSpeed = 3.0;
		this.targetSpeed = 0.85 * baseSpeed(this.course);
		this.processSkillActivations();  // activate gate skills (must come before setting minimum speed because green skills can modify guts)
		this.minSpeed = 0.85 * baseSpeed(this.course) + Math.sqrt(200.0 * this.horse.guts) * 0.001;
		this.startDash = true;
		this.modifiers.accel.add(24.0);  // start dash accel

		this.startDelayAccumulator = this.startDelay;

		// similarly this must also come after the first round of skill activations
		this.baseTargetSpeed = ([0,1,2] as Phase[]).map(phase => baseTargetSpeed(this.horse, this.course, phase));
		this.lastSpurtSpeed = lastSpurtSpeed(this.horse, this.course);
		this.lastSpurtTransition = -1;

		this.sectionModifier = Array.from({length: 24}, () => {
			if (params.disableSectionModifier) {
				return 0.0;
			}
			const max = this.horse.wisdom / 5500.0 * Math.log10(this.horse.wisdom * 0.1);
			const factor = (max - 0.65 + this.wisdomRollRng.random() * 0.65) / 100.0;
			return baseSpeed(this.course) * factor;
		});
		this.sectionModifier.push(0.0);  // last tick after the race is done, or in a comparison in case one uma runs off the end of the track

		this.hp.init(this.horse);

		this.baseAccel = ([0,1,2,0,1,2] as Phase[]).map((phase,i) => baseAccel(i > 2 ? UphillBaseAccel : BaseAccel, this.horse, phase));

		this.registerCondition("blocked_side", createBlockedSideCondition());
		this.registerCondition("overtake", createOvertakeCondition());
	}

	initUmas(umas: RaceSolver[]) {
		this.umas = [...umas.filter(uma => uma != null), this];
	}

	initHills() {
		// note that slopes are not always sorted by start location in course_data.json
		// sometimes (?) they are sorted by hill type and then by start
		// require this here because the code relies on encountering them sequentially
		assert(CourseHelpers.isSortedByStart(this.course.slopes), 'slopes must be sorted by start location');

		this.nHills = this.course.slopes.length;
		this.hillStart = this.course.slopes.map(s => s.start).reverse();
		this.hillEnd = this.course.slopes.map(s => s.start + s.length).reverse();
		this.hillIdx = -1;
		if (this.hillStart.length > 0 && this.hillStart[this.hillStart.length - 1] == 0) {
			// Only set hillIdx for uphills with >1.0% grade
			if (this.course.slopes[0].slope > 100) {
				this.hillIdx = 0;
			} else {
				this.hillEnd.pop();
			}
			this.hillStart.pop();
		}
	}

	getNewTimer(t: number = 0) {
		const tm = new Timer(t);
		this.timers.push(tm);
		return tm;
	}
	
	initRushedState(disabled: boolean) {
		// Skip rushed calculation if disabled
		if (disabled) {
			return;
		}
		
		// Calculate rushed chance based on wisdom
		// Formula: RushedChance = (6.5 / log10(0.1 * WizStat + 1))²%
		const wisdomStat = this.horse.wisdom;
		const rushedChance = Math.pow(6.5 / Math.log10(0.1 * wisdomStat + 1), 2) / 100;

		// Check if horse has 自制心 (Self-Control) skill - ID 202161
		// This reduces rushed chance by flat 3%
		const hasSelfControl = this.pendingSkills.some(s => s.skillId === '202161');
		const finalRushedChance = Math.max(0, rushedChance - (hasSelfControl ? 0.03 : 0));
		
		// Roll for rushed state
		if (this.rushedRng.random() < finalRushedChance) {
			// Determine which section (2-9) the rushed state activates in
			this.rushedSection = 2 + this.rushedRng.uniform(8);  // Random int from 2 to 9
			this.rushedEnterPosition = this.sectionLength * this.rushedSection;
		}
	}
	
	updateRushedState() {
		// Check if we should enter rushed state (can only happen once per race)
		if (this.rushedSection >= 0 && !this.isRushed && !this.hasBeenRushed && this.pos >= this.rushedEnterPosition) {
			this.isRushed = true;
			this.hasBeenRushed = true;  // Mark that this horse has been rushed
			this.rushedTimer.t = 0;
			this.rushedActivations.push([this.pos, -1]);  // Start tracking, end will be filled later
		}
		
		// Update rushed state if active
		if (this.isRushed) {
			// Check for recovery every 3 seconds
			if (this.rushedTimer.t > 0 && Math.floor(this.rushedTimer.t / 3) > Math.floor((this.rushedTimer.t - 0.017) / 3)) {
				// 55% chance to snap out of it
				if (this.rushedRng.random() < 0.55) {
					this.endRushedState();
					return;
				}
			}
			
			// Force end after max duration
			if (this.rushedTimer.t >= this.rushedMaxDuration) {
				this.endRushedState();
			}
		}
	}
	
	endRushedState() {
		this.isRushed = false;
		// Mark the end position for UI display
		if (this.rushedActivations.length > 0) {
			const lastIdx = this.rushedActivations.length - 1;
			if (this.rushedActivations[lastIdx][1] === -1) {
				this.rushedActivations[lastIdx][1] = this.pos;
			}
		}
	}

	getMaxStartDashSpeed() {
		return Math.min(this.targetSpeed, 0.85 * baseSpeed(this.course));
	}

	logVelocityData(dt: number) {
		console.log('frame: ', this.accumulatetime.t);
		console.log('current speed: ', this.currentSpeed);
		console.log('accel: ', this.accel);
		console.log('dist:', this.pos);
		console.log('--------------------------------');
	}

	step(dt: number) {
		let dtAfterDelay = dt

		this.timers.forEach(tm => tm.t += dt);

		if (this.conditionTimer.t >= 0.0) {
			this.tickConditions();
			this.conditionTimer.t = -1.0;
		}

		if (this.startDelayAccumulator > 0.0) {
			this.startDelayAccumulator -= dt;

			if (this.startDelayAccumulator > 0.0) {
				return;
			}
		}
		
		this.updateHills();
		this.updatePhase();
		this.updateRushedState();
		this.updateDownhillMode();
		this.processSkillActivations();
		this.applyPositionKeepStates();
		this.updatePositionKeepCoefficient();
		// this.updateCompeteFight();
		this.updateLeadCompetition();
		this.updateLastSpurtState();
		this.updateTargetSpeed();
		this.applyForces();
		this.applyLaneMovement();

		let newSpeed = undefined;

		if (this.currentSpeed < this.targetSpeed) {
			newSpeed = Math.min(this.currentSpeed + this.accel * dt, this.targetSpeed);
		}
		else {
			newSpeed = Math.max(this.currentSpeed + this.accel * dt, this.targetSpeed);
		}

		if (this.startDash && newSpeed > this.getMaxStartDashSpeed()) {
			newSpeed = this.getMaxStartDashSpeed();
		}
		
		if (!this.startDash && this.currentSpeed < this.minSpeed) {
			newSpeed = this.minSpeed;
		}

		this.currentSpeed = newSpeed;

		const displacement = this.currentSpeed + this.modifiers.currentSpeed.acc + this.modifiers.currentSpeed.err;

		if (this.startDelayAccumulator < 0.0) {
			dtAfterDelay = Math.abs(this.startDelayAccumulator);
			this.startDelayAccumulator = 0.0;
		}

		this.pos += displacement * dtAfterDelay;
		this.hp.tick(this, dt);

		if (!this.hp.hasRemainingHp() && !this.hpDied) {
			this.hpDied = true;
		}

		if (this.startDash && this.currentSpeed >= 0.85 * baseSpeed(this.course)) {
			this.startDash = false;
			this.modifiers.accel.add(-24.0);
		}

		this.modifiers.oneFrameAccel = 0.0;
	}

	applyLaneMovement() {
		const currentLane = this.currentLane
		const sideBlocked = this.getConditionValue("blocked_side") === 1;
		const overtake = this.getConditionValue("overtake") === 1;
		// TODO: Simulate 'overtake' condition to prevent umas from getting stuck on inside rail late-race
		// At the moment this doesn't matter because all we care about is early-race behavior.

		if (this.extraMoveLane < 0.0 && this.isAfterFinalCornerOrInFinalStraight()) {
			this.extraMoveLane = Math.min(currentLane / 0.1, this.course.maxLaneDistance) * 0.5 + (this.laneMovementRng.random() * 0.1);
		}

		if (this.activeChangeLaneSkills.length > 0) {
			this.targetLane = 9.5 * this.course.horseLane;
		}
		else if (overtake) {
			this.targetLane = Math.max(this.targetLane, this.course.horseLane, this.extraMoveLane);
		}
		else if (!this.hp.hasRemainingHp()) {
			this.targetLane = currentLane;
		}
		else if (this.positionKeepState === PositionKeepState.PaceDown) {
			this.targetLane = 0.18;
		}
		else if (this.extraMoveLane > currentLane) {
			this.targetLane = this.extraMoveLane;
		}
		else if (this.phase <= 1 && !sideBlocked) {
			this.targetLane = Math.max(0.0, currentLane - 0.05);
		}
		else {
			this.targetLane = currentLane;
		}

		if ((sideBlocked && this.targetLane < currentLane) || Math.abs(this.targetLane - currentLane) < 0.00001) {
			this.laneChangeSpeed = 0.0
		} else {
			let targetSpeed = 0.02 * (0.3 + 0.001 * this.horse.power);

			if (this.pos < this.course.moveLanePoint) {
				targetSpeed *= (1 + currentLane / this.course.maxLaneDistance * 0.05);
			}

			this.laneChangeSpeed = Math.min(this.laneChangeSpeed + this.course.laneChangeAccelerationPerFrame, targetSpeed);

			let actualSpeed = Math.min(this.laneChangeSpeed + this.activeLaneMovementSkills.reduce((sum, skill) => sum + skill.modifier, 0), 0.6);
			
			if (this.targetLane > currentLane) {
				this.currentLane = Math.min(this.targetLane, currentLane + actualSpeed);
			} else {
				this.currentLane = Math.max(this.targetLane, currentLane - actualSpeed * (1.0 + currentLane));
			}
		}
	}

	// Slightly scuffed way of ensuring all umas use the same pacemaker
	// in compare.ts, call .getPacer() on any uma (doesn't matter which)
	// and then call .updatePacer(result) on all umas to update pacer reference
	updatePacer(pacemaker: RaceSolver) {
		this.pacer = pacemaker;
	}

	getPacer(): RaceSolver | null {
		// Select furthest-forward front runner
		for (const strategy of [Strategy.Oonige, Strategy.Nige]) {
			var umas = this.umas.filter(uma => uma.posKeepStrategy === strategy);

			if (umas.length > 0) {
				var uma = umas.reduce((max, uma) => {
					return uma.pos > max.pos ? uma : max;
				}, umas[0]);

				return uma;
			}
		}

		// Get pacerOverride uma
		var pacerOverrideUma = this.umas.find(uma => uma.pacerOverride);

		if (pacerOverrideUma) {
			return pacerOverrideUma;
		}

		// Otherwise, lucky pace (set pacerOverride)
		for (const strategy of [Strategy.Senkou, Strategy.Sasi, Strategy.Oikomi]) {
			var umas = this.umas.filter(uma => StrategyHelpers.strategyMatches(uma.posKeepStrategy, strategy));

			if (umas.length > 0) {
				var uma = umas.reduce((max, uma) => {
					return uma.pos > max.pos ? uma : max;
				}, umas[0]);

				uma.pacerOverride = true;
				uma.posKeepStrategy = Strategy.Nige;

				return uma;
			}
		}

		// Otherwise, get virtual pacemaker
		// (this should never happen though)
		var pacer = this.umas.find(uma => uma.isPacer);

		if (pacer) {
			pacer.posKeepStrategy = Strategy.Nige;
			return pacer;
		}
	}

	getUmaByDistanceDescending(): RaceSolver[] {
		return this.umas.sort((a, b) => b.pos - a.pos);
	}

	isOnlyFrontRunner(): boolean {
		var frontRunners = this.umas.filter(uma => StrategyHelpers.strategyMatches(uma.posKeepStrategy, Strategy.Nige));
		return frontRunners.length === 1 && frontRunners[0] === this;
	}

	// In Virtual Pacemaker mode, we care about the effects of position keep and the way
	// umas react during poskeep based on their wit
	//
	// In Approximate mode, we don't really care about poskeep - it's just a way to give out
	// PDM/PUM early-race to mimic what actually happens in game so we limit poskeep to 5 sections
	// and use synced rng to make skill comparison possible.
	speedUpOvertakeWitCheck(): boolean {
		return this.posKeepRng.random() < 0.2 * Math.log10(0.1 * this.horse.wisdom);
	}

	paceUpWitCheck(): boolean {
		return this.posKeepRng.random() < 0.15 * Math.log10(0.1 * this.horse.wisdom);
	}

	applyPositionKeepStates() {
		if (this.pos >= this.posKeepEnd || this.posKeepMode === PosKeepMode.None) {
			// State change triggered by poskeep end
			if (this.positionKeepState !== PositionKeepState.None && this.positionKeepActivations.length > 0) {
				this.positionKeepActivations[this.positionKeepActivations.length - 1][1] = this.pos;
			}

			this.positionKeepState = PositionKeepState.None;
			return;
		}

		if (!this.pacer) {
			return;
		}

		var pacer = this.pacer;
		var behind = pacer.pos - this.pos;
		var myStrategy = this.posKeepStrategy;

		switch (this.positionKeepState) {
			case PositionKeepState.None:
				if (this.posKeepNextTimer.t < 0) { return; }

				if (StrategyHelpers.strategyMatches(myStrategy, Strategy.Nige)) {
					// Speed Up
					if (pacer === this) {
						var umas = this.getUmaByDistanceDescending();
						var secondPlaceUma = umas[1];
						var distanceAhead = pacer.pos - secondPlaceUma.pos;
						let threshold = myStrategy === Strategy.Oonige ? 17.5 : 4.5;
						
						if (this.posKeepNextTimer.t < 0) { return; }

						if (distanceAhead < threshold && this.speedUpOvertakeWitCheck()) {
							this.positionKeepActivations.push([this.pos, 0, PositionKeepState.SpeedUp]);
							this.positionKeepState = PositionKeepState.SpeedUp;
							this.posKeepExitPosition = this.pos + Math.floor(this.sectionLength);
						}
					}
					// Overtake
					else if (this.speedUpOvertakeWitCheck()) {
						this.positionKeepState = PositionKeepState.Overtake;
						this.positionKeepActivations.push([this.pos, 0, PositionKeepState.Overtake]);
					}
				}
				else {
					// Pace Up
					if (behind > this.posKeepMaxThreshold) {
						if (this.paceUpWitCheck()) {
							this.positionKeepState = PositionKeepState.PaceUp;
							this.positionKeepActivations.push([this.pos, 0, PositionKeepState.PaceUp]);
							this.posKeepExitDistance = this.syncRng.random() * (this.posKeepMaxThreshold - this.posKeepMinThreshold) + this.posKeepMinThreshold;
						}
					}
					// Pace Down
					else if (behind < this.posKeepMinThreshold) {
						if (this.activeTargetSpeedSkills.length == 0 && this.activeCurrentSpeedSkills.length == 0) {
							this.positionKeepState = PositionKeepState.PaceDown;
							this.positionKeepActivations.push([this.pos, 0, PositionKeepState.PaceDown]);
							this.posKeepExitDistance = this.syncRng.random() * (this.posKeepMaxThreshold - this.posKeepMinThreshold) + this.posKeepMinThreshold;
						}
					}
				}

				if (this.positionKeepState == PositionKeepState.None) {
					// console.log(this.pos, "Position keep state is None");
					this.posKeepNextTimer.t = -2;
				}
				else {
					// console.log(this.pos, "Position keep state is", getPositionKeepStateName(this.positionKeepState));
					this.posKeepExitPosition = this.pos + Math.floor(this.sectionLength);
				}

				break;
			case PositionKeepState.SpeedUp:
				if (this.pos >= this.posKeepExitPosition) {
					this.positionKeepState = PositionKeepState.None;
					this.positionKeepActivations[this.positionKeepActivations.length - 1][1] = this.pos;
					this.posKeepNextTimer.t = -3;
				}
				else if (pacer == this) {
					var umas = this.getUmaByDistanceDescending();
					var secondPlaceUma = umas[1];
					var distanceAhead = pacer.pos - secondPlaceUma.pos;
					let threshold = myStrategy === Strategy.Oonige ? 17.5 : 4.5;

					if (distanceAhead >= threshold) {
						this.positionKeepState = PositionKeepState.None;
						this.positionKeepActivations[this.positionKeepActivations.length - 1][1] = this.pos;
						this.posKeepNextTimer.t = -3;
					}
				}

				break;
			case PositionKeepState.Overtake:
				if (this.pos >= this.posKeepExitPosition) {
					this.positionKeepState = PositionKeepState.None;
					this.positionKeepActivations[this.positionKeepActivations.length - 1][1] = this.pos;
					this.posKeepNextTimer.t = -3;
				}
				else if (pacer == this) {
					var umas = this.getUmaByDistanceDescending();
					var secondPlaceUma = umas[1];
					var distanceAhead = this.pos - secondPlaceUma.pos;
					let threshold = myStrategy === Strategy.Oonige ? 27.5 : 10;

					if (distanceAhead >= threshold) {
						this.positionKeepState = PositionKeepState.None;
						this.positionKeepActivations[this.positionKeepActivations.length - 1][1] = this.pos;
						this.posKeepNextTimer.t = -3;
					}
				}

				break;
			case PositionKeepState.PaceUp:
				if (this.pos >= this.posKeepExitPosition) {
					this.positionKeepState = PositionKeepState.None;
					this.positionKeepActivations[this.positionKeepActivations.length - 1][1] = this.pos;
					this.posKeepNextTimer.t = -3;
				}
				else {
					if (behind < this.posKeepExitDistance) {
						this.positionKeepState = PositionKeepState.None;
						this.positionKeepActivations[this.positionKeepActivations.length - 1][1] = this.pos;
						this.posKeepNextTimer.t = -3;
					}
				}

				break;
			case PositionKeepState.PaceDown:
				if (this.pos >= this.posKeepExitPosition) {
					this.positionKeepState = PositionKeepState.None;
					this.positionKeepActivations[this.positionKeepActivations.length - 1][1] = this.pos;
					this.posKeepNextTimer.t = -3;
				}
				else {
					if (behind > this.posKeepExitDistance || this.activeTargetSpeedSkills.length > 0 || this.activeCurrentSpeedSkills.length > 0) {
						this.positionKeepState = PositionKeepState.None;
						this.positionKeepActivations[this.positionKeepActivations.length - 1][1] = this.pos;
						this.posKeepNextTimer.t = -3;
					}
				}

				break;
			default:
				break;
		}
	}

	updatePositionKeepCoefficient() {
		switch (this.positionKeepState) {
			case PositionKeepState.SpeedUp:
				this.posKeepSpeedCoef = 1.04;
				break;
			case PositionKeepState.Overtake:
				this.posKeepSpeedCoef = 1.05;
			case PositionKeepState.PaceUp:
				this.posKeepSpeedCoef = 1.04;
				break;
			case PositionKeepState.PaceDown:
				this.posKeepSpeedCoef = 0.915; // 0.945x in mid-race post 1st-anniversary
				break;
			default:
				this.posKeepSpeedCoef = 1.0;
				break;
		}
	}
		
	isOnFinalStraight() {
		const lastStraight = this.course.straights[this.course.straights.length - 1];
		return this.pos >= lastStraight.start && this.pos <= lastStraight.end;
	}

	isAfterFinalCorner() {
		const finalCornerStart = this.course.corners.length > 0 ? this.course.corners[this.course.corners.length - 1].start : Infinity;
		return this.pos >= finalCornerStart;
	}

	isAfterFinalCornerOrInFinalStraight() {
		return this.isAfterFinalCorner() || this.isOnFinalStraight();
	}

	updateCompeteFight() {
		if (this.competeFight) {
			if (this.hp.hpRatioRemaining() <= 0.05) {
				this.competeFight = false;
				this.competeFightEnd = this.pos;
			}
			
			return;
		}

		if (StrategyHelpers.strategyMatches(this.posKeepStrategy, Strategy.Nige)) {
			return;
		}

		if (this.hp.hpRatioRemaining() < 0.15 || !this.isOnFinalStraight()) {
			return;
		}

		if (this.competeFightTimer.t >= 2) {
			this.competeFight = true;
			this.competeFightStart = this.pos;
		}
	}

	updateLeadCompetition() {
		if (this.leadCompetition) {
			let leadCompeteDuration = Math.pow(700 * this.horse.guts, 0.5) * 0.012;

			if (this.leadCompetitionTimer.t >= leadCompeteDuration || this.pos >= this.leadCompetitionEnd) {
				this.leadCompetition = false;
				this.leadCompetitionEnd = this.pos;
			}
		}

		if (this.leadCompetitionStart !== null) {
			return;
		}

		if (this.pos >= 150 && this.pos <= Math.floor(this.sectionLength * 5) && (StrategyHelpers.strategyMatches(this.posKeepStrategy, Strategy.Nige))) {
			let otherUmas = this.umas.filter(u => u.posKeepStrategy === this.posKeepStrategy);
			let distanceGap = this.posKeepStrategy === Strategy.Nige ? 3.75 : 5;

			let umasWithinGap = otherUmas.filter(u => Math.abs(u.pos - this.pos) <= distanceGap);

			if (umasWithinGap.length >= 2) {
				for (let uma of umasWithinGap) {
					uma.leadCompetitionTimer.t = 0;
					uma.leadCompetition = true;
					uma.leadCompetitionStart = uma.pos;
					uma.leadCompetitionEnd = uma.pos + Math.floor(this.sectionLength * 8);
				}
			}
		}
	}

	updatefirstUmaInLateRace() {
		let existingFirstPlaceUma = this.umas.find(u => u.firstUmaInLateRace);

		if (existingFirstPlaceUma) {
			return;
		}

		let firstPlaceUma = this.getUmaByDistanceDescending()[0];

		if (firstPlaceUma.pos < this.course.distance * 2/3) {
			return;
		}

		firstPlaceUma.firstUmaInLateRace = true;
	}

	updateLastSpurtState() {
		if (this.isLastSpurt || this.phase < 2) return;
		if (this.lastSpurtTransition == -1) {
			const v = this.hp.getLastSpurtPair(this, this.lastSpurtSpeed, this.baseTargetSpeed[2]);
			this.lastSpurtTransition = v[0];
			this.lastSpurtSpeed = v[1];
			if ((this.hp as any).isMaxSpurt && (this.hp as any).isMaxSpurt()) {
				this.fullSpurt = true;
			}
		}
		if (this.pos >= this.lastSpurtTransition) {
			this.isLastSpurt = true;
		}
	}

	updateDownhillMode() {
		// Check if we should update downhill mode (once per second, at 15 FPS)
		const currentFrame = Math.floor(this.accumulatetime.t * 15);
		const changeSecond = currentFrame % 15 === 14; // Check on the last frame of each second
		
		if (!changeSecond || currentFrame === this.lastDownhillCheckFrame) {
			return; // Not time to check yet, or already checked this second
		}
		
		this.lastDownhillCheckFrame = currentFrame;
		
		// Check if we're on a downhill slope
		const currentSlope = this.course.slopes.find(s => this.pos >= s.start && this.pos <= s.start + s.length);
		const isOnDownhill = currentSlope && currentSlope.slope < -1; // Only on downhills with >1.0% grade
		
		
		if (!this.disableDownhill && isOnDownhill) {
			// Keep rng synced for the virtual pacemaker so that it's the same pacer for both umas
			const rng = (this.posKeepMode === PosKeepMode.Virtual && !this.pacer) ? this.syncRng.random() : this.downhillRng.random();

			if (this.downhillModeStart === null) {
				// Check for entry: Wisdom * 0.0004 chance each second (matching Kotlin implementation)
				if (rng < this.horse.wisdom * 0.0004) {
					this.downhillModeStart = currentFrame;
					this.isDownhillMode = true;
				}
			} else {
				// Check for exit: 20% chance each second to exit downhill mode
				if (rng < 0.2) {
					this.downhillModeStart = null;
					this.isDownhillMode = false;
				}
			}
		} else {
			// Not on a downhill slope, exit downhill mode immediately
			if (this.isDownhillMode) {
				this.downhillModeStart = null;
				this.isDownhillMode = false;
			}
		}
	}

	updateTargetSpeed() {
		if (!this.hp.hasRemainingHp()) {
			this.targetSpeed = this.minSpeed;
		} else if (this.isLastSpurt) {
			this.targetSpeed = this.lastSpurtSpeed;
		} else {
			this.targetSpeed = this.baseTargetSpeed[this.phase] * this.posKeepSpeedCoef;
			this.targetSpeed += this.sectionModifier[Math.floor(this.pos / this.sectionLength)];
		}
		this.targetSpeed += this.modifiers.targetSpeed.acc + this.modifiers.targetSpeed.err;

		if (this.hillIdx != -1) {
			// recalculating this every frame is actually measurably faster than calculating the penalty for each slope ahead of time, somehow
			this.targetSpeed -= this.course.slopes[this.hillIdx].slope / 10000.0 * 200.0 / this.horse.power;
			this.targetSpeed = Math.max(this.targetSpeed, this.minSpeed);
		}

		if (this.competeFight) {
			this.targetSpeed += Math.pow(200 * this.horse.guts, 0.709) * 0.0001;
		}

		if (this.leadCompetition) {
			this.targetSpeed += Math.pow(500 * this.horse.guts, 0.6) * 0.0001;
		}

		// moved logic on every step
		// We need to check the isDownhill every frame so we actually get the speed boost
		if (this.isDownhillMode) {
			const currentSlope = this.course.slopes.find(s => this.pos >= s.start && this.pos <= s.start + s.length);
			if (currentSlope) {
				const downhillBonus = 0.3 + (Math.abs(currentSlope.slope/10000) / 10.0);
				this.targetSpeed += downhillBonus;
			}
		}

		if (this.laneChangeSpeed > 0.0 && this.activeLaneMovementSkills.length > 0) {
			const moveLaneModifier = Math.sqrt(0.0002 * this.horse.power);
			this.targetSpeed += moveLaneModifier;
		}
	}

	applyForces() {
		if (!this.hp.hasRemainingHp()) {
			this.accel = -1.2;
			return;
		}
		if (this.currentSpeed > this.targetSpeed) {
			this.accel = this.positionKeepState === PositionKeepState.PaceDown ? -0.5 : PhaseDeceleration[this.phase];
			return;
		}
		this.accel = this.baseAccel[+(this.hillIdx != -1) * 3 + this.phase];
		this.accel += this.modifiers.accel.acc + this.modifiers.accel.err;

		if (this.competeFight) {
			this.accel += Math.pow(160 * this.horse.guts, 0.59) * 0.0001;
		}
	}

	updateHills() {
		if (this.hillIdx == -1 && this.hillStart.length > 0 && this.pos >= this.hillStart[this.hillStart.length - 1]) {
			// Only set hillIdx for uphills with >1.0% grade (slope > 100, where SlopePer = slope/100)
			if (this.course.slopes[this.nHills - this.hillStart.length].slope > 100) {
				this.hillIdx = this.nHills - this.hillStart.length;
			} else {
				this.hillEnd.pop();
			}
			this.hillStart.pop();
		} else if (this.hillIdx != -1 && this.hillEnd.length > 0 && this.pos > this.hillEnd[this.hillEnd.length - 1]) {
			this.hillIdx = -1;
			this.hillEnd.pop();
		}
	}

	updatePhase() {
		// NB. there is actually a phase 3 which starts at 5/6 distance, but for purposes of
		// strategy phase modifiers, activate_count_end_after, etc it is the same as phase 2
		// and it's easier to treat them together, so cap phase at 2.
		if (this.pos >= this.nextPhaseTransition && this.phase < 2) {
			++this.phase;
			this.nextPhaseTransition = CourseHelpers.phaseStart(this.course.distance, this.phase + 1 as Phase);
		}
	}

	processSkillActivations() {
		for (let i = this.activeTargetSpeedSkills.length; --i >= 0;) {
			const s = this.activeTargetSpeedSkills[i];
			if (s.durationTimer.t >= 0) {
				this.activeTargetSpeedSkills.splice(i,1);
				this.modifiers.targetSpeed.add(-s.modifier);
				this.onSkillDeactivate(this, s.skillId, s.perspective);
			}
		}
		for (let i = this.activeCurrentSpeedSkills.length; --i >= 0;) {
			const s = this.activeCurrentSpeedSkills[i];
			if (s.durationTimer.t >= 0) {
				this.activeCurrentSpeedSkills.splice(i,1);
				this.modifiers.currentSpeed.add(-s.modifier);
				if (s.naturalDeceleration) {
					this.modifiers.oneFrameAccel += s.modifier;
				}
				this.onSkillDeactivate(this, s.skillId, s.perspective);
			}
		}
		for (let i = this.activeAccelSkills.length; --i >= 0;) {
			const s = this.activeAccelSkills[i];
			if (s.durationTimer.t >= 0) {
				this.activeAccelSkills.splice(i,1);
				this.modifiers.accel.add(-s.modifier);
				this.onSkillDeactivate(this, s.skillId, s.perspective);
			}
		}
		for (let i = this.activeLaneMovementSkills.length; --i >= 0;) {
			const s = this.activeLaneMovementSkills[i];
			if (s.durationTimer.t >= 0) {
				this.activeLaneMovementSkills.splice(i,1);
				this.onSkillDeactivate(this, s.skillId, s.perspective);
			}
		}
		for (let i = this.activeChangeLaneSkills.length; --i >= 0;) {
			const s = this.activeChangeLaneSkills[i];
			if (s.durationTimer.t >= 0) {
				this.activeChangeLaneSkills.splice(i,1);
				this.onSkillDeactivate(this, s.skillId, s.perspective);
			}
		}
		for (let i = this.pendingSkills.length; --i >= 0;) {
			const s = this.pendingSkills[i];
			if (this.pos >= s.trigger.end || this.pendingRemoval.has(s.skillId)) {  // NB. `Region`s are half-open [start,end) intervals. If pos == end we are out of the trigger.
				// skill failed to activate
				this.pendingSkills.splice(i,1);
				this.pendingRemoval.delete(s.skillId);
			} else if (this.pos >= s.trigger.start && s.extraCondition(this)) {
				// Check wisdom for skill activation if enabled
				if (this.skillCheckChance && !this.shouldSkipWisdomCheck(s) && !this.checkWisdomForSkill(s)) {
					// Skill fails due to low wisdom
					this.pendingSkills.splice(i,1);
				} else {
					this.activateSkill(s);
					this.pendingSkills.splice(i,1);
				}
			}
		}
	}

	checkWisdomForSkill(skill: PendingSkill): boolean {
		let rngRoll = this.wisdomRollRng.random();
		const wisdom = skill.perspective === Perspective.Other && skill.originWisdom !== undefined 
			? skill.originWisdom 
			: this.horse.wisdom;
		let wisdomCheck = Math.max(100-9000/wisdom,20) * 0.01;
		return rngRoll <= wisdomCheck;
	}

	shouldSkipWisdomCheck(skill: PendingSkill): boolean {
		// Green skills
		if (skill.effects.length > 0 && skill.effects[0].type >= 1 && skill.effects[0].type <= 5) {
			return true;
		}

		// Uniques
		// (Inherited uniques are White rarity so this works fine)
		if (skill.rarity === SkillRarity.Unique) {
			return true;
		}

		return false;
	}


	activateSkill(s: PendingSkill) {
		// sort so that the ExtendEvolvedDuration effect always activates after other effects, since it shouldn't extend the duration of other
		// effects on the same skill
		s.effects.sort((a,b) => +(a.type == 42) - +(b.type == 42)).forEach(ef => {
			const scaledDuration = ef.baseDuration * (this.course.distance / 1000) *
				(s.rarity == SkillRarity.Evolution ? this.modifiers.specialSkillDurationScaling : 1);  // TODO should probably be awakened skills
				                                                                                       // and not just pinks
			switch (ef.type) {
			case SkillType.SpeedUp:
				this.horse.speed = Math.max(this.horse.speed + ef.modifier, 1);
				break;
			case SkillType.StaminaUp:
				this.horse.stamina = Math.max(this.horse.stamina + ef.modifier, 1);
				this.horse.rawStamina = Math.max(this.horse.rawStamina + ef.modifier, 1);
				break;
			case SkillType.PowerUp:
				this.horse.power = Math.max(this.horse.power + ef.modifier, 1);
				break;
			case SkillType.GutsUp:
				this.horse.guts = Math.max(this.horse.guts + ef.modifier, 1);
				break;
			case SkillType.WisdomUp:
				this.horse.wisdom = Math.max(this.horse.wisdom + ef.modifier, 1);
				break;
			case SkillType.MultiplyStartDelay:
				this.startDelay *= ef.modifier;
				break;
			case SkillType.SetStartDelay:
				this.startDelay = ef.modifier;
				break;
			case SkillType.TargetSpeed:
				this.modifiers.targetSpeed.add(ef.modifier);
				this.activeTargetSpeedSkills.push({skillId: s.skillId, perspective: s.perspective, durationTimer: this.getNewTimer(-scaledDuration), modifier: ef.modifier});
				break;
			case SkillType.Accel:
				this.modifiers.accel.add(ef.modifier);
				this.activeAccelSkills.push({skillId: s.skillId, perspective: s.perspective, durationTimer: this.getNewTimer(-scaledDuration), modifier: ef.modifier});
				break;
			case SkillType.LaneMovementSpeed:
				this.activeLaneMovementSkills.push({skillId: s.skillId, perspective: s.perspective, durationTimer: this.getNewTimer(-scaledDuration), modifier: ef.modifier});
				break;
			case SkillType.CurrentSpeed:
			case SkillType.CurrentSpeedWithNaturalDeceleration:
				this.modifiers.currentSpeed.add(ef.modifier);
				this.activeCurrentSpeedSkills.push({
					skillId: s.skillId, perspective: s.perspective, durationTimer: this.getNewTimer(-scaledDuration), modifier: ef.modifier,
					naturalDeceleration: ef.type == SkillType.CurrentSpeedWithNaturalDeceleration
				});
				break;
			case SkillType.Recovery:
				++this.activateCountHeal;
				// Pass state to recover for dynamic spurt recalculation in accuracy mode
				this.hp.recover(ef.modifier, this);
				if (this.phase >= 2 && !this.isLastSpurt) {
					this.updateLastSpurtState();
				}
				break;
			case SkillType.ActivateRandomGold:
				this.doActivateRandomGold(ef.modifier);
				break;
			case SkillType.ExtendEvolvedDuration:
				this.modifiers.specialSkillDurationScaling = ef.modifier;
				break;
			case SkillType.ChangeLane:
				this.activeChangeLaneSkills.push({skillId: s.skillId, perspective: s.perspective, durationTimer: this.getNewTimer(-scaledDuration), modifier: ef.modifier});
				break;
			}
		});
		++this.activateCount[this.phase];
		this.usedSkills.add(s.skillId);
		this.onSkillActivate(this, s.skillId, s.perspective);
	}

	doActivateRandomGold(ngolds: number) {
		const goldIndices = this.pendingSkills.reduce((acc, skill, i) => {
			if ((skill.rarity == SkillRarity.Gold || skill.rarity == SkillRarity.Evolution) && skill.effects.every(ef => ef.type > SkillType.WisdomUp)) acc.push(i);
			return acc;
		}, []);
		for (let i = goldIndices.length; --i >= 0;) {
			const j = this.gorosiRng.uniform(i + 1);
			[goldIndices[i], goldIndices[j]] = [goldIndices[j], goldIndices[i]];
		}
		for (let i = 0; i < Math.min(ngolds, goldIndices.length); ++i) {
			const s = this.pendingSkills[goldIndices[i]];
			this.activateSkill(s);
			// important: we can't actually remove this from pendingSkills directly, since this function runs inside the loop in
			// processSkillActivations. modifying the pendingSkills array here would mess up that loop. this function used to modify
			// the trigger on the skill itself to ensure it was before this.pos and force it to be cleaned up, but mutating the skill
			// is error-prone and undesirable since it means the same PendingSkill instance can't be used with multiple RaceSolvers.
			// instead, flag the skill later to be removed in processSkillActivations (either later in the loop that called us, or
			// the next time processSkillActivations is called).
			this.pendingRemoval.add(s.skillId);
		}
	}

	// deactivate any skills that haven't finished their durations yet (intended to be called at the end of a simulation, when a skill
	// might have activated towards the end of the race and the race finished before the skill's duration)
	cleanup() {
		const callDeactivateHook = (s: {skillId: string, perspective?: Perspective}) => { this.onSkillDeactivate(this, s.skillId, s.perspective); }
		this.activeTargetSpeedSkills.forEach(callDeactivateHook);
		this.activeCurrentSpeedSkills.forEach(callDeactivateHook);
		this.activeAccelSkills.forEach(callDeactivateHook);
		this.activeLaneMovementSkills.forEach(callDeactivateHook);
		this.activeChangeLaneSkills.forEach(callDeactivateHook);
	}

	registerCondition(name: string, condition: ApproximateCondition): void {
		this.conditions.set(name, condition);

		if (!this.conditionValues.has(name)) {
			this.conditionValues.set(name, condition.valueOnStart);
		}
	}

	getConditionValue(name: string): number {
		if (!this.conditionValues.has(name)) {
			if (this.conditions.has(name)) {
				const condition = this.conditions.get(name)!;
				return condition.valueOnStart;
			}

			throw new Error(`Condition "${name}" is not registered`);
		}

		return this.conditionValues.get(name)!;
	}


	tickConditions(): void {
		const state = {
			simulation: this
		};

		for (const [name, condition] of this.conditions.entries()) {
			const currentValue = this.conditionValues.get(name) ?? condition.valueOnStart;
			const newValue = condition.update(state, currentValue);
			this.conditionValues.set(name, newValue);
		}
	}
}
