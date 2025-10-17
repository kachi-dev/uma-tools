import { Option } from 'commander';
import { HorseParameters } from '../HorseTypes';
import { CourseData } from '../CourseData';
import { Region } from '../Region';
import { Rule30CARng } from '../Random';
import { SkillRarity, PendingSkill, RaceSolver } from '../RaceSolver';
import { NoopHpPolicy } from '../HpPolicy';
import { ImmediatePolicy, RandomPolicy } from '../ActivationSamplePolicy';
import { SkillData, ToolCLI, PacerProvider, parseAptitude } from './ToolCLI';

const defaultThresholds = [0.5,1.0,1.5,2.0,2.5];

const cli = new ToolCLI();
cli.options(program => {
	program
		.addOption(new Option('-N, --nsamples <N>', 'number of random samples to use for skills with random conditions')
			.default(500)
			.argParser(x => parseInt(x,10))
		)
		.option('--seed <seed>', 'seed value for pseudorandom number generator', (value,_) => parseInt(value,10) >>> 0)
		.option('--enable-wisdom-checks', 'base skill activation on random checks dependent on wisdom')
		.addOption(new Option('-D, --distance-aptitude <letter>', 'compare with a different distance aptitude from the value in the horse definition')
			.choices(['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'])
			.argParser(a => parseAptitude(a, 'distance'))
		)
		.addOption(new Option('-S, --surface-aptitude <letter>', 'compare with a different surface aptitude from the value in the horse definition')
			.choices(['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'])
			.argParser(a => parseAptitude(a, 'surface'))
		)
		.addOption(new Option('--thresholds <cutoffs>', 'comma-separated list of values; print the percentage of the time they are exceeded')
			.default(defaultThresholds, defaultThresholds.join(','))
			.argParser(t => t.split(',').map(parseFloat))
		)
		.option('--dump', 'instead of printing a summary, dump data. intended to be piped into histogram.py.')
		.option('--csv [first_col]', 'print data as a CSV row (intended for batch scripting)');
});
cli.run((horse: HorseParameters, course: CourseData, defSkills: SkillData[], cliSkills: SkillData[], getPacer: PacerProvider, cliOptions: any) => {
	const nsamples = cliOptions.nsamples;
	const triggers = [];
	const seed = ('seed' in cliOptions ? cliOptions.seed : Math.floor(Math.random() * (-1 >>> 0))) >>> 0;
	const rng = new Rule30CARng(seed);
	const solverRng1 = new Rule30CARng(rng.int32());
	const solverRng2 = new Rule30CARng(rng.int32());
	const pacerRng1 = new Rule30CARng(rng.int32());
	const pacerRng2 = new Rule30CARng(rng.int32());

	// TODO bugged since this will be affected by strategy aptitude—will be fixed once we ditch this mess and use
	// RaceSolverBuilder for gain.ts
	const skillActivationChance = cliOptions.enableWisdomChecks ? Math.max(100.0 - 9000.0 / horse.wisdom) / 100.0 : 1.0;

	function addTriggers(sd: SkillData) {
		triggers.push(sd.samplePolicy.sample(sd.regions, nsamples, rng));
	}

	const debuffs = [];
	for (let i = cliSkills.length; --i >= 0;) {
		const ef = cliSkills[i].effects;
		if (ef.some(e => e.modifier < 0)) {
			const debuffEffects = [];
			debuffs.push(Object.assign({}, cliSkills[i], {effects: debuffEffects}));
			for (let j = ef.length; --j >= 0;) {
				if (ef[j].modifier < 0) {
					debuffEffects.push(ef[j]);
					ef.splice(j,1);
				}
			}
			if (ef.length == 0) {
				cliSkills.splice(i,1);
			}
		}
	}

	defSkills.forEach(addTriggers);
	cliSkills.forEach(addTriggers);
	debuffs.forEach(addTriggers);

	function addSkill(skills: PendingSkill[], sd: SkillData, triggers: Region[], i: number) {
		skills.push({
			skillId: sd.skillId,
			rarity: sd.rarity,
			trigger: triggers[i % triggers.length],
			extraCondition: sd.extraCondition,
			effects: sd.effects
		});
	}

	let testHorse = horse;
	if (cliOptions.distanceAptitude != undefined) {
		testHorse = Object.freeze(Object.assign({}, testHorse, {distanceAptitude: cliOptions.distanceAptitude}));
	}
	if (cliOptions.surfaceAptitude != undefined) {
		testHorse = Object.freeze(Object.assign({}, testHorse, {surfaceAptitude: cliOptions.surfaceAptitude}));
	}

	// NB. if --distance-aptitude or --surface-aptitude are specified the pacer will still have the default aptitudes even when pacing the
	// modified aptitude version.
	// i'm not really sure if that's the expected thing to do or not, but it makes sense (imo)

	const gain = [];
	let min = Infinity, max = 0,
	    minconf = {i: 0},
	    maxconf = {i: 0};
	const dt = cliOptions.timestep;
	for (let i = 0; i < nsamples; ++i) {
		const skillCheckRolls1 = [];
		const skillCheckRolls2 = [];
		for (let i = 0; i < defSkills.length + cliSkills.length + debuffs.length; ++i) {
			skillCheckRolls1.push(solverRng1.random());
			skillCheckRolls2.push(solverRng2.random());
		}
		function wisdomCheck1(sd: SkillData, i: number) {
			return sd.rarity == SkillRarity.Unique || skillCheckRolls1[i] <= skillActivationChance;
		}

		const skills1 = [];
		defSkills.filter(wisdomCheck1).forEach((sd,sdi) => addSkill(skills1, sd, triggers[sdi], i));
		cliSkills
			.filter((sd,sdi) => wisdomCheck1(sd, sdi + defSkills.length))
			.forEach((sd,sdi) => addSkill(skills1, sd, triggers[sdi + defSkills.length], i));
		const s = new RaceSolver({horse: testHorse, course, hp: NoopHpPolicy, skills: skills1, pacer: getPacer(pacerRng1), rng: solverRng1});

		while (s.pos < course.distance) {
			s.step(dt);
		}

		function wisdomCheck2(sd: SkillData, i: number) {
			return sd.rarity == SkillRarity.Unique || skillCheckRolls2[i] <= skillActivationChance;
		}

		const skills2 = [];
		defSkills.filter(wisdomCheck2).forEach((sd,sdi) => addSkill(skills2, sd, triggers[sdi], i));
		debuffs
			.filter((sd,sdi) => wisdomCheck2(sd, sdi + defSkills.length + cliSkills.length))
			.forEach((sd,sdi) => addSkill(skills2, sd, triggers[sdi + defSkills.length + cliSkills.length], i));
		const s2 = new RaceSolver({horse, course, hp: NoopHpPolicy, skills: skills2, pacer: getPacer(pacerRng2), rng: solverRng2});
		while (s2.accumulatetime.t < s.accumulatetime.t) {
			s2.step(dt);
		}
		const diff = (s.pos - s2.pos) / 2.5;
		gain.push(diff);
		if (diff < min) {
			min = diff;
			minconf.i = i;
		}
		if (diff > max) {
			max = diff;
			maxconf.i = i;
		}

	}
	gain.sort((a,b) => a - b);

	if (cliOptions.dump) {
		console.log(JSON.stringify(gain));
		return;
	}

	const mid = Math.floor(gain.length / 2);
	const median = (gain.length % 2 == 0 ? (gain[mid-1] + gain[mid]) / 2 : gain[mid]);
	const mean = (gain.reduce((a,b) => a + b) / gain.length);

	if (cliOptions.csv) {
		const cols = [min.toFixed(2), max.toFixed(2), median.toFixed(2), mean.toFixed(2)];
		cliOptions.thresholds.forEach(n => {
			cols.push((gain.reduce((a,b) => a + +(b >= n), 0) / gain.length * 100).toFixed(2) + '%');
		});
		if (typeof cliOptions.csv == 'string') {
			cols.unshift(cliOptions.csv);
		}
		cols.push(cliSkills.map(sd => {
			const p = sd.samplePolicy;
			return p == ImmediatePolicy ? 'ImmediatePolicy' : p == RandomPolicy ? 'RandomPolicy' : p.constructor.name;
		}).join(';'));
		console.log(cols.join(','));
	} else {
		console.log('min:\t' + min.toFixed(2));
		console.log('max:\t' + max.toFixed(2));
		console.log('median:\t' + median.toFixed(2));
		console.log('mean:\t' + mean.toFixed(2));

		if (cliOptions.thresholds.length > 0) {
			console.log('');
		}
		cliOptions.thresholds.forEach(n => {
		    console.log('≥' + n.toFixed(2) + ' | ' + (gain.reduce((a,b) => a + +(b >= n), 0) / gain.length * 100).toFixed(2) + '%');
		});

		console.log('');
		console.log('seed: ' + seed);

		console.log('');

		const conf = Buffer.alloc(3 * 4);
		const conf32 = new Int32Array(conf.buffer);
		conf32[0] = seed;
		conf32[1] = nsamples;
		conf32[2] = minconf.i;
		console.log('min configuration: ' + conf.toString('base64'))
		conf32[2] = maxconf.i;
		console.log('max configuration: ' + conf.toString('base64'));
	}
});
