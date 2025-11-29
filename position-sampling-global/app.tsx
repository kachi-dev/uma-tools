import { h, render } from 'preact';
import { useState, useMemo, useEffect } from 'preact/hooks';
import { IntlProvider } from 'preact-i18n';

import { Language, useLanguageSelect } from '../components/Language';
import { SkillList } from '../components/SkillList';
import { RaceTrack, TrackSelect, RegionDisplayType } from '../components/RaceTrack';
import { CourseHelpers } from '../uma-skill-tools/CourseData';
import { RaceSolverBuilder } from '../uma-skill-tools/RaceSolverBuilder';
import { Strategy, Aptitude } from '../uma-skill-tools/HorseTypes';
import { TRACKNAMES_en } from '../strings/common';

import skills from '../umalator-global/skill_data.json';
import skillnames from '../umalator-global/skillnames.json';

import '../components/Tooltip.css';
import './app.css';

const DefaultCourseId = 10903;
const NSAMPLES = 10000;

const defaultHorse = Object.freeze({
	speed: 2000,
	stamina: 2000,
	power: 2000,
	guts: 2000,
	wisdom: 2000,
	strategy: Strategy.Nige,
	distanceAptitude: Aptitude.S,
	surfaceAptitude: Aptitude.A,
	strategyAptitude: Aptitude.A,
	rawStamina: 2000,
	mood: 2
});

function App(props) {
	const [language, setLanguage] = useLanguageSelect();
	const [courseId, setCourseId] = useState(() => +(/cid=(\d+)/.exec(window.location.hash) || [null, DefaultCourseId])[1]);
	const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
	const [skillsOpen, setSkillsOpen] = useState(false);
	const [isRunning, setIsRunning] = useState(false);
	const [status, setStatus] = useState('');
	const [activationData, setActivationData] = useState(null);

	useEffect(function () {
		window.location.replace(`#cid=${courseId}`);
	}, [courseId]);

	function setSelectedSkillAndClose(id: Set<string>) {
		if (id.size === 0) {
			setSelectedSkill(null);
			setSkillsOpen(false);
			return;
		}
		
		const idArray = Array.from(id);
		const currentSkill = selectedSkill;
		
		if (idArray.length === 1) {
			const singleSkill = idArray[0];
			if (singleSkill === currentSkill) {
				setSelectedSkill(null);
			} else {
				setSelectedSkill(singleSkill);
			}
		} else {
			const newSkills = idArray.filter(skillId => skillId !== currentSkill);
			if (newSkills.length > 0) {
				setSelectedSkill(newSkills[newSkills.length - 1]);
			} else {
				setSelectedSkill(null);
			}
		}
		
		setSkillsOpen(false);
	}
	
	function showSkillSelector(e) {
		setSkillsOpen(true);
	}
	
	function hideSkillSelector(e) {
		setSkillsOpen(false);
	}

	function detectRunningStyleRequirement(skillId: string): Strategy | null {
		if (!(skillId in skills)) return null;
		
		const skill = skills[skillId];
		for (const alt of skill.alternatives) {
			const condition = alt.condition;
			const match = condition.match(/running_style==(\d+)/);
			if (match) {
				const styleValue = parseInt(match[1], 10);
				switch (styleValue) {
					case 1: return Strategy.Nige;
					case 2: return Strategy.Senkou;
					case 3: return Strategy.Sasi;
					case 4: return Strategy.Oikomi;
					default: return null;
				}
			}
		}
		return null;
	}

	async function runSampling() {
		if (!selectedSkill || isRunning) return;
		
		setIsRunning(true);
		setStatus('Running simulations...');
		setActivationData(null);

		const course = CourseHelpers.getCourse(courseId);
		const incrementSize = 10;
		const numBins = Math.ceil(course.distance / incrementSize);
		const activationCounts = new Array(numBins).fill(0);
		let totalRuns = 0;

		const requiredStrategy = detectRunningStyleRequirement(selectedSkill);
		const horse = requiredStrategy ? Object.assign({}, defaultHorse, { strategy: requiredStrategy }) : defaultHorse;

		const builder = new RaceSolverBuilder(NSAMPLES)
			.horse(horse)
			.course(courseId)
			.addSkill(selectedSkill);

		const activationPositions = [];
		
		builder.onSkillActivate((solver, skillId) => {
			if (skillId === selectedSkill) {
				activationPositions.push(solver.pos);
			}
		});

		try {
			const generator = builder.build();
			let runCount = 0;

			for (let i = 0; i < NSAMPLES; i++) {
				const result = generator.next();
				if (result.done || !result.value) break;
				
				const solver = result.value;
				while (solver.pos < course.distance) {
					solver.step(0.1);
				}
				
				runCount++;
				if (runCount % 100 === 0) {
					setStatus(`Running simulations... ${runCount}/${NSAMPLES}`);
					await new Promise(resolve => setTimeout(resolve, 0));
				}
			}

			for (const pos of activationPositions) {
				const binIndex = Math.floor(pos / incrementSize);
				if (binIndex >= 0 && binIndex < numBins) {
					activationCounts[binIndex]++;
				}
			}

			totalRuns = NSAMPLES;
			const percentages = activationCounts.map(count => (count / totalRuns) * 100);

			setActivationData({
				percentages,
				incrementSize,
				numBins
			});
			setStatus(`Complete: ${totalRuns} simulations`);
		} catch (error) {
			setStatus(`Error: ${error.message}`);
			console.error(error);
		} finally {
			setIsRunning(false);
		}
	}

	const course = CourseHelpers.getCourse(courseId);
	const langid = 0;
	const skillName = selectedSkill && skillnames[selectedSkill] ? skillnames[selectedSkill][langid] : '';

	const strings = useMemo(() => {
		const result = {skillnames: {}, tracknames: TRACKNAMES_en};
		Object.keys(skillnames).forEach(id => result.skillnames[id] = skillnames[id][langid]);
		return result;
	}, []);

	const regions = useMemo(() => {
		if (!activationData) return [];
		
		const result = [];
		for (let i = 0; i < activationData.numBins; i++) {
			const start = i * activationData.incrementSize;
			const end = Math.min((i + 1) * activationData.incrementSize, course.distance);
			const percentage = activationData.percentages[i];
			
			if (percentage > 0) {
				const height = Math.min(percentage * 5, 100);
				result.push({
					type: RegionDisplayType.Regions,
					regions: [{ start, end }],
					color: { stroke: 'rgb(76, 175, 80)', fill: 'rgb(76, 175, 80)' },
					height
				});
			}
		}
		return result;
	}, [activationData, course.distance]);
	
	return (
		<Language.Provider value={language}>
			<IntlProvider definition={strings}>
				<div id="overlay" class={skillsOpen ? "skillListWrapper-open" : ""} onClick={hideSkillSelector} />
				<RaceTrack courseid={courseId} width={960} height={240} xOffset={0} yOffset={0} yExtra={0} regions={regions} />
				<div id="buttonsRow">
					<TrackSelect courseid={courseId} setCourseid={setCourseId} />
					<button id="skillSelectButton" onClick={showSkillSelector}>
						{selectedSkill ? `Skill: ${skillName}` : 'Select Skill'}
					</button>
					{selectedSkill && <span id="selectedSkill">{skillName}</span>}
					<button id="runButton" onClick={runSampling} disabled={!selectedSkill || isRunning}>
						{isRunning ? 'Running...' : 'Run Sampling'}
					</button>
					{status && <span id="status">{status}</span>}
				</div>
				<div id="skillListWrapper" class={skillsOpen ? "skillListWrapper-open" : ""}>
					<SkillList ids={Object.keys(skills)} selected={selectedSkill ? new Set([selectedSkill]) : new Set()} setSelected={setSelectedSkillAndClose} />
				</div>
			</IntlProvider>
		</Language.Provider>
	);
}

render(<App lang="ja" />, document.getElementById('app'));

