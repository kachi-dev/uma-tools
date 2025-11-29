import { h, Fragment, render } from 'preact';
import { useState, useReducer, useMemo, useEffect, useRef, useId, useCallback } from 'preact/hooks';
import { Text, IntlProvider } from 'preact-i18n';
import { Record, Set as ImmSet, Map as ImmMap } from 'immutable';
import * as d3 from 'd3';
import { computePosition, flip } from '@floating-ui/dom';

import { CourseHelpers } from '../uma-skill-tools/CourseData';
import { RaceParameters, Mood, GroundCondition, Weather, Season, Time, Grade } from '../uma-skill-tools/RaceParameters';
import { PosKeepMode } from '../uma-skill-tools/RaceSolver';
import type { GameHpPolicy } from '../uma-skill-tools/HpPolicy';

import { Language, LanguageSelect, useLanguageSelect } from '../components/Language';
import { ExpandedSkillDetails, STRINGS_en as SKILL_STRINGS_en } from '../components/SkillList';
import { RaceTrack, TrackSelect, RegionDisplayType } from '../components/RaceTrack';
import { HorseState, SkillSet } from '../components/HorseDefTypes';
import { HorseDef, horseDefTabs } from '../components/HorseDef';
import { TRACKNAMES_ja, TRACKNAMES_en } from '../strings/common';
import { RaceState } from '../uma-skill-tools/RaceSolver';

import { getActivateableSkills, getNullRow, BasinnChart } from './BasinnChart';

import { initTelemetry, postEvent } from './telemetry';

import { IntroText } from './IntroText';

import skilldata from '../uma-skill-tools/data/skill_data.json';
import skillnames from '../uma-skill-tools/data/skillnames.json';
import skill_meta from '../skill_meta.json';



function skillmeta(id: string) {
	// handle the fake skills (e.g., variations of Sirius unique) inserted by make_skill_data with ids like 100701-1
	return skill_meta[id.split('-')[0]];
}

import './app.css';

const DEFAULT_SAMPLES = 500;
const DEFAULT_SEED = 2615953739;



class RaceParams extends Record({
	mood: 2 as Mood,
	ground: GroundCondition.Good,
	weather: Weather.Sunny,
	season: Season.Spring,
	time: Time.Midday,
	grade: Grade.G1
}) {}

const enum EventType { CM, LOH }

const presets = (CC_GLOBAL ? [
	{type: EventType.CM, date: '2025-10', courseId: 10602, season: Season.Summer, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.CM, date: '2025-09', courseId: 10811, season: Season.Spring, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.CM, date: '2025-08', courseId: 10606, season: Season.Spring, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday}
] : [
	{type: EventType.LOH, date: '2025-11', courseId: 11502, season: Season.Autumn, time: Time.Midday},
	{type: EventType.CM, date: '2025-10', courseId: 10302, season: Season.Autumn, ground: GroundCondition.Good, weather: Weather.Cloudy, time: Time.Midday},
	{type: EventType.CM, date: '2025-09-22', courseId: 10807, season: Season.Autumn, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.LOH, date: '2025-08', courseId: 10105, season: Season.Summer, Time: Time.Midday},
	{type: EventType.CM, date: '2025-07-25', courseId: 10906, ground: GroundCondition.Yielding, weather: Weather.Cloudy, season: Season.Summer, time: Time.Midday},
	{type: EventType.CM, date: '2025-06-21', courseId: 10606, ground: GroundCondition.Good, weather: Weather.Sunny, season: Season.Spring, time: Time.Midday}
])
	.map(def => ({
		type: def.type,
		date: new Date(def.date),
		courseId: def.courseId,
		racedef: new RaceParams({
			mood: 2 as Mood,
			ground: def.type == EventType.CM ? def.ground : GroundCondition.Good,
			weather: def.type == EventType.CM ? def.weather : Weather.Sunny,
			season: def.season,
			time: def.time,
			grade: Grade.G1
		})
	}))
	.sort((a,b) => +b.date - +a.date);

const DEFAULT_PRESET = presets[Math.max(presets.findIndex((now => p => new Date(p.date.getFullYear(), p.date.getUTCMonth() + 1, 0) < now)(new Date())) - 1, 0)];
const DEFAULT_COURSE_ID = DEFAULT_PRESET.courseId;

function id(x) { return x; }

function formatTime(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	const secondsStr = remainingSeconds.toFixed(3).padStart(6, '0');
	return `${minutes}:${secondsStr}`;
}

function binSearch(a: number[], x: number) {
	let lo = 0, hi = a.length - 1;
	if (x < a[0]) return 0;
	if (x > a[hi]) return hi - 1;
	while (lo <= hi) {
		const mid = Math.floor((lo + hi) / 2);
		if (x < a[mid]) {
			hi = mid - 1;
		} else if (x > a[mid]) {
			lo = mid + 1;
		} else {
			return mid;
		}
	}
	return Math.abs(a[lo] - x) < Math.abs(a[hi] - x) ? lo : hi;
}

function TimeOfDaySelect(props) {
	function click(e) {
		e.stopPropagation();
		if (!('timeofday' in e.target.dataset)) return;
		props.set(+e.target.dataset.timeofday);
	}
	// + 2 because for some reason the icons are 00-02 (noon/evening/night) but the enum values are 1-4 (morning(?) noon evening night)
	return (
		<div class="timeofdaySelect" onClick={click}>
			{Array(3).fill(0).map((_,i) =>
				<img src={`/uma-tools/icons/utx_ico_timezone_0${i}.png`} title={SKILL_STRINGS_en.skilldetails.time[i+2]}
					class={i+2 == props.value ? 'selected' : ''} data-timeofday={i+2} />)}
		</div>
	);
}

function GroundSelect(props) {
	if (CC_GLOBAL) {
		return (
			<select class="groundSelect" value={props.value} onInput={(e) => props.set(+e.currentTarget.value)}>
				<option value="1">Firm</option>
				<option value="2">Good</option>
				<option value="3">Soft</option>
				<option value="4">Heavy</option>
			</select>
		);
	}
	return (
		<select class="groundSelect" value={props.value} onInput={(e) => props.set(+e.currentTarget.value)}>
			<option value="1">良</option>
			<option value="2">稍重</option>
			<option value="3">重</option>
			<option value="4">不良</option>
		</select>
	);
}

function WeatherSelect(props) {
	function click(e) {
		e.stopPropagation();
		if (!('weather' in e.target.dataset)) return;
		props.set(+e.target.dataset.weather);
	}
	return (
		<div class="weatherSelect" onClick={click}>
			{Array(4).fill(0).map((_,i) =>
				<img src={`/uma-tools/icons/utx_ico_weather_0${i}.png`} title={SKILL_STRINGS_en.skilldetails.weather[i+1]}
					class={i+1 == props.value ? 'selected' : ''} data-weather={i+1} />)}
		</div>
	);
}

function SeasonSelect(props) {
	function click(e) {
		e.stopPropagation();
		if (!('season' in e.target.dataset)) return;
		props.set(+e.target.dataset.season);
	}
	return (
		<div class="seasonSelect" onClick={click}>
			{Array(4 + +!CC_GLOBAL /* global doenst have late spring for some reason */).fill(0).map((_,i) =>
				<img src={`/uma-tools/icons${CC_GLOBAL?'/global':''}/utx_txt_season_0${i}.png`} title={SKILL_STRINGS_en.skilldetails.season[i+1]}
					class={i+1 == props.value ? 'selected' : ''} data-season={i+1} />)}
		</div>
	);
}

function Histogram(props) {
	const {data, width, height} = props;
	const axes = useRef(null);
	const xH = 20;
	const yW = 40;

	const x = d3.scaleLinear().domain(
		data[0] == 0 && data[data.length-1] == 0
			? [-1,1]
			: [Math.min(0,Math.floor(data[0])),Math.ceil(data[data.length-1])]
	).range([yW,width-yW]);
	const bucketize = d3.bin().value(id).domain(x.domain()).thresholds(x.ticks(30));
	const buckets = bucketize(data);
	const y = d3.scaleLinear().domain([0,d3.max(buckets, b => b.length)]).range([height-xH,xH]);

	useEffect(function () {
		const g = d3.select(axes.current);
		g.selectAll('*').remove();
		g.append('g').attr('transform', `translate(0,${height - xH})`).call(d3.axisBottom(x));
		g.append('g').attr('transform', `translate(${yW},0)`).call(d3.axisLeft(y));
	}, [data, width, height]);

	const rects = buckets.map((b,i) =>
		<rect key={i} fill="#2a77c5" stroke="black" x={x(b.x0)} y={y(b.length)} width={x(b.x1) - x(b.x0)} height={height - xH - y(b.length)} />
	);
	return (
		<svg id="histogram" width={width} height={height}>
			<g>{rects}</g>
			<g ref={axes}></g>
		</svg>
	);
}

function BasinnChartPopover(props) {
	const popover = useRef(null);
	useEffect(function () {
		if (popover.current == null) return;
		// bit nasty
		const anchor = document.querySelector(`.basinnChart tr[data-skillid="${props.skillid}"] img`);
		computePosition(anchor, popover.current, {
			placement: 'bottom-start',
			middleware: [flip()]
		}).then(({x,y}) => {
			popover.current.style.transform = `translate(${x}px,${y}px)`;
			popover.current.style.visibility = 'visible';
		});
		popover.current.focus();
	}, [popover.current, props.skillid]);
	return (
		<div class="basinnChartPopover" tabindex="1000" style="visibility:hidden" ref={popover}>
			<ExpandedSkillDetails id={props.skillid} distanceFactor={props.courseDistance} dismissable={false} />
			<Histogram width={500} height={333} data={props.results} />
		</div>
	);
}

function VelocityLines(props) {
	const axes = useRef(null);
	const data = props.data;
	const x = d3.scaleLinear().domain([0,props.courseDistance]).range([0,props.width]);
	const y = data && d3.scaleLinear().domain([0,d3.max(data.v, v => d3.max(v))]).range([props.height,0]);
	const hpY = data && d3.scaleLinear().domain([0,d3.max(data.hp, hp => d3.max(hp))]).range([props.height,0]);
	
	const pacemakerY = data && data.pacerGap && (() => {
		const allValues = data.pacerGap.flatMap(gap => gap.filter(d => d !== undefined));
		if (allValues.length === 0) return null;
		const maxValue = d3.max(allValues);
		const bottom60Percent = props.height * 0.6;
		const domainMax = Math.max(maxValue, 10);
		return d3.scaleLinear().domain([0, domainMax]).range([props.height, bottom60Percent]);
	})();
	
	const laneY = data && data.currentLane && props.horseLane && (() => {
		const gateCount = 9;
		const maxLane = Math.max(gateCount + 1, 11) * props.horseLane;
		const bottom50Percent = props.height * 0.5;
		return d3.scaleLinear().domain([0, maxLane]).range([props.height, bottom50Percent]);
	})();
	
	useEffect(function () {
		if (axes.current == null) return;
		const g = d3.select(axes.current);
		g.selectAll('*').remove();
		g.append('g').attr('transform', `translate(${props.xOffset},${props.height+5})`).call(d3.axisBottom(x));
		if (data) {
			g.append('g').attr('transform', `translate(${props.xOffset},4)`).call(d3.axisLeft(y));
		}
	}, [props.data, props.courseDistance, props.width, props.height]);
	const colors = ['#2a77c5', '#c52a2a'];
	const hpColors = ['#688aab', '#ab6868'];
	const laneColors = ['#87ceeb', '#ff0000'];
	const pacemakerColors = ['#22c55e', '#a855f7', '#ec4899'];
	return (
		<Fragment>
			<g transform={`translate(${props.xOffset},5)`}>
				{data && data.v.map((v,i) =>
					<path fill="none" stroke={colors[i]} stroke-width="2.5" d={
						d3.line().x(j => x(data.p[i][j])).y(j => y(v[j]))(data.p[i].map((_,j) => j))
					} />
				).concat(props.showHp ? data.hp.map((hp,i) =>
					<path fill="none" stroke={hpColors[i]} stroke-width="2.5" d={
						d3.line().x(j => x(data.p[i][j])).y(j => hpY(hp[j]))(data.p[i].map((_,j) => j))
					} />
				) : []).concat(props.showLanes && data.currentLane && laneY ? data.currentLane.map((lanes,i) =>
					<path fill="none" stroke={laneColors[i]} stroke-width="2.5" d={
						d3.line().x(j => x(data.p[i][j])).y(j => laneY(lanes[j]))(data.p[i].map((_,j) => j))
					} />
				) : []).concat(data.pacerGap && pacemakerY ? data.pacerGap.map((gap,i) => {
					const validPoints = data.p[i].map((_,j) => ({x: j, gap: gap[j]})).filter(p => p.gap !== undefined && p.gap >= 0);
					if (validPoints.length === 0) return null;
					
					return <path key={i} fill="none" stroke={colors[i]} stroke-width="2" stroke-dasharray="5,5" d={
						d3.line().x(j => x(data.p[i][j])).y(j => pacemakerY(gap[j]))(validPoints.map(p => p.x))
					} />;
				}).filter(Boolean) : []).concat(props.showVirtualPacemaker && data.pacerV && data.pacerP ? (() => {
					const pacemakerLines = [];
					for (let pacemakerIndex = 0; pacemakerIndex < 3; pacemakerIndex++) {
						if (props.selectedPacemakers && props.selectedPacemakers[pacemakerIndex] && 
							data.pacerV && data.pacerV[pacemakerIndex] && data.pacerP && data.pacerP[pacemakerIndex]) {
							const pacerV = data.pacerV[pacemakerIndex];
							const pacerP = data.pacerP[pacemakerIndex];
							const validPoints = pacerP.map((_,j) => ({x: j, vel: pacerV[j], pos: pacerP[j]})).filter(p => p.vel !== undefined && p.pos !== undefined);
							if (validPoints.length > 0) {
								pacemakerLines.push(
									<path key={`vp-${pacemakerIndex}`} fill="none" stroke={pacemakerColors[pacemakerIndex]} stroke-width="2.5" d={
										d3.line().x(j => x(pacerP[j])).y(j => y(pacerV[j]))(validPoints.map(p => p.x))
									} />
								);
							}
						}
					}
					return pacemakerLines;
				})() : [])}
			</g>
			<g ref={axes} />
		</Fragment>
	);
}

const NO_SHOW = Object.freeze([
	'10011', '10012', '10016', '10021', '10022', '10026', '10031', '10032', '10036',
	'10041', '10042', '10046', '10051', '10052', '10056', '10061', '10062', '10066',
	'40011',
	'20061', '20062', '20066'
]);

const ORDER_RANGE_FOR_STRATEGY = Object.freeze({
	'Nige': [1,1],
	'Senkou': [2,4],
	'Sasi': [5,9],
	'Oikomi': [5,9],
	'Oonige': [1,1]
});

function racedefToParams({mood, ground, weather, season, time, grade}: RaceParams, includeOrder?: string): RaceParameters {
	return {
		mood, groundCondition: ground, weather, season, time, grade,
		popularity: 1,
		skillId: '',
		orderRange: includeOrder != null ? ORDER_RANGE_FOR_STRATEGY[includeOrder] : null,
		numUmas: 9
	};
}

async function serialize(courseId: number, nsamples: number, seed: number, posKeepMode: PosKeepMode, racedef: RaceParams, uma1: HorseState, uma2: HorseState, pacer: HorseState, showVirtualPacemakerOnGraph: boolean, pacemakerCount: number, selectedPacemakers: boolean[], showLanes: boolean, witVarianceSettings: {
	allowRushedUma1: boolean,
	allowRushedUma2: boolean,
	allowDownhillUma1: boolean,
	allowDownhillUma2: boolean,
	allowSectionModifierUma1: boolean,
	allowSectionModifierUma2: boolean,
	allowSkillCheckChanceUma1: boolean,
	allowSkillCheckChanceUma2: boolean,
	simWitVariance: boolean
}) {
	const json = JSON.stringify({
		courseId,
		nsamples,
		seed,
		posKeepMode,
		racedef: racedef.toJS(),
		uma1: uma1.toJS(),
		uma2: uma2.toJS(),
		pacer: pacer.toJS(),
		witVarianceSettings,
		showVirtualPacemakerOnGraph,
		pacemakerCount,
		selectedPacemakers,
		showLanes
	});
	const enc = new TextEncoder();
	const stringStream = new ReadableStream({
		start(controller) {
			controller.enqueue(enc.encode(json));
			controller.close();
		}
	});
	const zipped = stringStream.pipeThrough(new CompressionStream('gzip'));
	const reader = zipped.getReader();
	let buf = new Uint8Array();
	let result;
	while ((result = await reader.read())) {
		if (result.done) {
			return encodeURIComponent(btoa(String.fromCharCode(...buf)));
		} else {
			buf = new Uint8Array([...buf, ...result.value]);
		}
	}
}

async function deserialize(hash) {
	const zipped = atob(decodeURIComponent(hash));
	const buf = new Uint8Array(zipped.split('').map(c => c.charCodeAt(0)));
	const stringStream = new ReadableStream({
		start(controller) {
			controller.enqueue(buf);
			controller.close();
		}
	});
	const unzipped = stringStream.pipeThrough(new DecompressionStream('gzip'));
	const reader = unzipped.getReader();
	const decoder = new TextDecoder();
	let json = '';
	let result;
	while ((result = await reader.read())) {
		if (result.done) {
			try {
				const o = JSON.parse(json);
				return {
					courseId: o.courseId,
					nsamples: o.nsamples,
					seed: o.seed || DEFAULT_SEED,  // field added later, could be undefined when loading state from existing links
					posKeepMode: o.posKeepMode != null ? o.posKeepMode : (o.usePosKeep ? PosKeepMode.Approximate : PosKeepMode.None),  // backward compatibility
					racedef: new RaceParams(o.racedef),
					uma1: new HorseState(o.uma1)
						.set('skills', SkillSet(o.uma1.skills))
						.set('forcedSkillPositions', ImmMap(o.uma1.forcedSkillPositions || {})),
					uma2: new HorseState(o.uma2)
						.set('skills', SkillSet(o.uma2.skills))
						.set('forcedSkillPositions', ImmMap(o.uma2.forcedSkillPositions || {})),
					pacer: o.pacer ? new HorseState(o.pacer)
						.set('skills', SkillSet(o.pacer.skills || []))
						.set('forcedSkillPositions', ImmMap(o.pacer.forcedSkillPositions || {})) : new HorseState({strategy: 'Nige'}),
					witVarianceSettings: o.witVarianceSettings || {
						allowRushedUma1: true,
						allowRushedUma2: true,
						allowDownhillUma1: true,
						allowDownhillUma2: true,
						allowSectionModifierUma1: true,
						allowSectionModifierUma2: true,
						allowSkillCheckChanceUma1: true,
						allowSkillCheckChanceUma2: true,
						simWitVariance: true
					},
					showVirtualPacemakerOnGraph: o.showVirtualPacemakerOnGraph != null ? o.showVirtualPacemakerOnGraph : false,
					pacemakerCount: o.pacemakerCount != null ? o.pacemakerCount : 1,
					selectedPacemakers: o.selectedPacemakers != null ? o.selectedPacemakers : [false, false, false],
					showLanes: o.showLanes != null ? o.showLanes : false
				};
			} catch (_) {
				return {
					courseId: DEFAULT_COURSE_ID,
					nsamples: DEFAULT_SAMPLES,
					seed: DEFAULT_SEED,
					posKeepMode: PosKeepMode.Approximate,
					racedef: new RaceParams(),
					uma1: new HorseState(),
					uma2: new HorseState(),
					pacer: new HorseState({strategy: 'Nige'}),
					witVarianceSettings: {
						allowRushedUma1: true,
						allowRushedUma2: true,
						allowDownhillUma1: true,
						allowDownhillUma2: true,
						allowSectionModifierUma1: true,
						allowSectionModifierUma2: true,
						allowSkillCheckChanceUma1: true,
						allowSkillCheckChanceUma2: true,
						simWitVariance: true
					},
					showVirtualPacemakerOnGraph: false,
					pacemakerCount: 1,
					selectedPacemakers: [false, false, false],
					showLanes: false
				};
			}
		} else {
			json += decoder.decode(result.value);
		}
	}
}

async function saveToLocalStorage(courseId: number, nsamples: number, seed: number, posKeepMode: PosKeepMode, racedef: RaceParams, uma1: HorseState, uma2: HorseState, pacer: HorseState, showVirtualPacemakerOnGraph: boolean, pacemakerCount: number, selectedPacemakers: boolean[], showLanes: boolean, witVarianceSettings: {
	allowRushedUma1: boolean,
	allowRushedUma2: boolean,
	allowDownhillUma1: boolean,
	allowDownhillUma2: boolean,
	allowSectionModifierUma1: boolean,
	allowSectionModifierUma2: boolean,
	allowSkillCheckChanceUma1: boolean,
	allowSkillCheckChanceUma2: boolean,
	simWitVariance: boolean
}) {
	try {
		const hash = await serialize(courseId, nsamples, seed, posKeepMode, racedef, uma1, uma2, pacer, showVirtualPacemakerOnGraph, pacemakerCount, selectedPacemakers, showLanes, witVarianceSettings);
		localStorage.setItem('umalator-settings', hash);
	} catch (error) {
		console.warn('Failed to save settings to localStorage:', error);
	}
}

async function loadFromLocalStorage() {
	try {
		const hash = localStorage.getItem('umalator-settings');
		if (hash) {
			return await deserialize(hash);
		}
	} catch (error) {
		console.warn('Failed to load settings from localStorage:', error);
	}
	return null;
}

const EMPTY_RESULTS_STATE = {courseId: DEFAULT_COURSE_ID, results: [], runData: null, chartData: null, displaying: '', rushedStats: null, leadCompetitionStats: null, spurtInfo: null, staminaStats: null, firstUmaStats: null};
function updateResultsState(state: typeof EMPTY_RESULTS_STATE, o: number | string | {results: any, runData: any, rushedStats?: any, leadCompetitionStats?: any, spurtInfo?: any, staminaStats?: any, firstUmaStats?: any}) {
	if (typeof o == 'number') {
		return {
			courseId: o,
			results: [],
			runData: null,
			chartData: null,
			displaying: '',
			rushedStats: null,
			leadCompetitionStats: null,
			spurtInfo: null,
			staminaStats: null,
			firstUmaStats: null
		};
	} else if (typeof o == 'string') {
		postEvent('setChartData', {display: o});
		return {
			courseId: state.courseId,
			results: state.results,
			runData: state.runData,
			chartData: state.runData != null ? state.runData[o] : null,
			displaying: o,
			rushedStats: state.rushedStats,
			leadCompetitionStats: state.leadCompetitionStats,
			spurtInfo: state.spurtInfo,
			staminaStats: state.staminaStats,
			firstUmaStats: state.firstUmaStats
		};
	} else {
		return {
			courseId: state.courseId,
			results: o.results,
			runData: o.runData,
			chartData: o.runData[state.displaying || 'meanrun'],
			displaying: state.displaying || 'meanrun',
			rushedStats: o.rushedStats || null,
			leadCompetitionStats: o.leadCompetitionStats || null,
			spurtInfo: o.spurtInfo || null,
			staminaStats: o.staminaStats || null,
			firstUmaStats: o.firstUmaStats || null
		};
	}
}

function RacePresets(props) {
	const id = useId();
	return (
		<Fragment>
			<label for={id}>Preset:</label>
			<select id={id} onChange={e => { const i = +e.currentTarget.value; i > -1 && props.set(presets[i].courseId, presets[i].racedef); }}>
				<option value="-1"></option>
				{presets.map((p,i) => <option value={i}>{p.date.getFullYear() + '-' + (100 + p.date.getUTCMonth() + 1).toString().slice(-2) + (p.type == EventType.CM ? ' CM' : ' LOH')}</option>)}
			</select>
		</Fragment>
	);
}

const baseSkillsToTest = Object.keys(skilldata).filter(id => skilldata[id].rarity < 3);

const enum Mode { Compare, Chart, UniquesChart }
const enum UiStateMsg { SetModeCompare, SetModeChart, SetModeUniquesChart, SetCurrentIdx0, SetCurrentIdx1, SetCurrentIdx2, ToggleExpand }

const DEFAULT_UI_STATE = {mode: Mode.Compare, currentIdx: 0, expanded: false};

function nextUiState(state: typeof DEFAULT_UI_STATE, msg: UiStateMsg) {
	switch (msg) {
		case UiStateMsg.SetModeCompare:
			return {...state, mode: Mode.Compare};
		case UiStateMsg.SetModeChart:
			return {...state, mode: Mode.Chart, currentIdx: 0, expanded: false};
		case UiStateMsg.SetModeUniquesChart:
			return {...state, mode: Mode.UniquesChart, currentIdx: 0, expanded: false};
		case UiStateMsg.SetCurrentIdx0:
			return {...state, currentIdx: 0};
		case UiStateMsg.SetCurrentIdx1:
			return {...state, currentIdx: 1};
		case UiStateMsg.SetCurrentIdx2:
			return {...state, currentIdx: 2};
		case UiStateMsg.ToggleExpand:
			return {...state, expanded: !state.expanded};
	}
}

function WitVarianceSettingsPopup({ 
	show, 
	onClose, 
	allowRushedUma1, 
	allowRushedUma2, 
	allowDownhillUma1, 
	allowDownhillUma2, 
	allowSectionModifierUma1,
	allowSectionModifierUma2,
	allowSkillCheckChanceUma1,
	allowSkillCheckChanceUma2,
	toggleRushedUma1,
	toggleRushedUma2,
	toggleDownhillUma1,
	toggleDownhillUma2,
	toggleSectionModifierUma1,
	toggleSectionModifierUma2,
	toggleSkillCheckChanceUma1,
	toggleSkillCheckChanceUma2
}) {
	if (!show) return null;
	
	return (
		<div className="wit-variance-popup-overlay" onClick={onClose}>
			<div className="wit-variance-popup" onClick={(e) => e.stopPropagation()}>
				<div className="wit-variance-popup-header">
					<h3>Wit Variance Settings</h3>
					<button className="wit-variance-popup-close" onClick={onClose}>×</button>
				</div>
				<div className="wit-variance-popup-content">
					<div className="wit-variance-setting">
						<label>Rushed State</label>
						<div className="wit-variance-checkboxes">
							<div className="wit-variance-checkbox-group">
								<label style={{color: 'rgb(42, 119, 197)'}}>Uma 1</label>
								<input type="checkbox" checked={allowRushedUma1} onChange={toggleRushedUma1} />
							</div>
							<div className="wit-variance-checkbox-group">
								<label style={{color: 'rgb(197, 42, 42)'}}>Uma 2</label>
								<input type="checkbox" checked={allowRushedUma2} onChange={toggleRushedUma2} />
							</div>
						</div>
					</div>
					<div className="wit-variance-setting">
						<label>Downhill Mode</label>
						<div className="wit-variance-checkboxes">
							<div className="wit-variance-checkbox-group">
								<label style={{color: 'rgb(42, 119, 197)'}}>Uma 1</label>
								<input type="checkbox" checked={allowDownhillUma1} onChange={toggleDownhillUma1} />
							</div>
							<div className="wit-variance-checkbox-group">
								<label style={{color: 'rgb(197, 42, 42)'}}>Uma 2</label>
								<input type="checkbox" checked={allowDownhillUma2} onChange={toggleDownhillUma2} />
							</div>
						</div>
					</div>
					<div className="wit-variance-setting">
						<label>Section Modifier</label>
						<div className="wit-variance-checkboxes">
							<div className="wit-variance-checkbox-group">
								<label style={{color: 'rgb(42, 119, 197)'}}>Uma 1</label>
								<input type="checkbox" checked={allowSectionModifierUma1} onChange={toggleSectionModifierUma1} />
							</div>
							<div className="wit-variance-checkbox-group">
								<label style={{color: 'rgb(197, 42, 42)'}}>Uma 2</label>
								<input type="checkbox" checked={allowSectionModifierUma2} onChange={toggleSectionModifierUma2} />
							</div>
						</div>
					</div>
					<div className="wit-variance-setting">
						<label>Skill Check Chance</label>
						<div className="wit-variance-checkboxes">
							<div className="wit-variance-checkbox-group">
								<label style={{color: 'rgb(42, 119, 197)'}}>Uma 1</label>
								<input type="checkbox" checked={allowSkillCheckChanceUma1} onChange={toggleSkillCheckChanceUma1} />
							</div>
							<div className="wit-variance-checkbox-group">
								<label style={{color: 'rgb(197, 42, 42)'}}>Uma 2</label>
								<input type="checkbox" checked={allowSkillCheckChanceUma2} onChange={toggleSkillCheckChanceUma2} />
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

function StatsTable({ caption, captionColor, rows }) {
	const formatValue = (value, label) => {
		if (value == null) return 'N/A';
		if (label === 'Velocity') {
			return value.toFixed(3) + ' m/s';
		}
		return value.toFixed(2) + ' m';
	};
	
	return (
		<table style={{borderCollapse: 'collapse', marginTop: '0', width: '100%'}}>
			<caption style={{fontWeight: 'bold', marginBottom: '8px', marginTop: '10px', color: captionColor}}>{caption}</caption>
			<thead>
				<tr>
					<th style={{border: '1px solid #ccc', padding: '8px', textAlign: 'center'}}></th>
					<th style={{border: '1px solid #ccc', padding: '8px', textAlign: 'center'}}>Count</th>
					<th style={{border: '1px solid #ccc', padding: '8px', textAlign: 'center'}}>Min</th>
					<th style={{border: '1px solid #ccc', padding: '8px', textAlign: 'center'}}>Max</th>
					<th style={{border: '1px solid #ccc', padding: '8px', textAlign: 'center'}}>Mean</th>
					<th style={{border: '1px solid #ccc', padding: '8px', textAlign: 'center'}}>Median</th>
				</tr>
			</thead>
			<tbody>
				{rows.map(({ label, stats }) => (
					<tr key={label}>
						<th style={{border: '1px solid #ccc', padding: '8px', textAlign: 'left'}}>{label}</th>
						<td style={{border: '1px solid #ccc', padding: '8px', textAlign: 'center'}}>
							{stats.count != null ? stats.count : 0}
						</td>
						<td style={{border: '1px solid #ccc', padding: '8px', textAlign: 'center'}}>
							{formatValue(stats.min, label)}
						</td>
						<td style={{border: '1px solid #ccc', padding: '8px', textAlign: 'center'}}>
							{formatValue(stats.max, label)}
						</td>
						<td style={{border: '1px solid #ccc', padding: '8px', textAlign: 'center'}}>
							{formatValue(stats.mean, label)}
						</td>
						<td style={{border: '1px solid #ccc', padding: '8px', textAlign: 'center'}}>
							{formatValue(stats.median, label)}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function App(props) {
	//const [language, setLanguage] = useLanguageSelect(); 
	const [darkMode, toggleDarkMode] = useReducer(b=>!b, false);
	const [skillsOpen, setSkillsOpen] = useState(false);
	const [racedef, setRaceDef] = useState(() => DEFAULT_PRESET.racedef);
	const [nsamples, setSamples] = useState(DEFAULT_SAMPLES);
	const [seed, setSeed] = useState(DEFAULT_SEED);
	const [runOnceCounter, setRunOnceCounter] = useState(0);
	const [isSimulationRunning, setIsSimulationRunning] = useState(false);
	const chartWorkersCompletedRef = useRef(0);
	const [posKeepMode, setPosKeepModeRaw] = useState(PosKeepMode.Approximate);
	const [showHp, toggleShowHp] = useReducer((b,_) => !b, false);
	const [showLanes, toggleShowLanes] = useReducer((b,_) => !b, false);
	
	useEffect(() => { document.documentElement.classList.toggle('dark', darkMode);}, [darkMode]);
	//fuck dark mode
	
	// Wrapper to handle mode changes and reset tab if needed
	function setPosKeepMode(mode: PosKeepMode) {
		setPosKeepModeRaw(mode);
		// If switching away from Virtual mode while on the pacemaker tab (index 2), switch back to uma1
		if (mode !== PosKeepMode.Virtual && currentIdx === 2) {
			updateUiState(UiStateMsg.SetCurrentIdx0);
		}
	}

	const [allowRushedUma1, toggleRushedUma1] = useReducer((b,_) => !b, true);
	const [allowRushedUma2, toggleRushedUma2] = useReducer((b,_) => !b, true);
	const [allowDownhillUma1, toggleDownhillUma1] = useReducer((b,_) => !b, true);
	const [allowDownhillUma2, toggleDownhillUma2] = useReducer((b,_) => !b, true);
	const [allowSectionModifierUma1, toggleSectionModifierUma1] = useReducer((b,_) => !b, true);
	const [allowSectionModifierUma2, toggleSectionModifierUma2] = useReducer((b,_) => !b, true);
	const [allowSkillCheckChanceUma1, toggleSkillCheckChanceUma1] = useReducer((b,_) => !b, true);
	const [allowSkillCheckChanceUma2, toggleSkillCheckChanceUma2] = useReducer((b,_) => !b, true);
	const [simWitVariance, toggleSimWitVariance] = useReducer((b,_) => !b, true);
	const [hpDeathPositionTab, setHpDeathPositionTab] = useState(0);
	const [showWitVarianceSettings, setShowWitVarianceSettings] = useState(false);
	const [showVirtualPacemakerOnGraph, toggleShowVirtualPacemakerOnGraph] = useReducer((b,_) => !b, false);
	const [pacemakerCount, setPacemakerCount] = useState(1);
	const [selectedPacemakerIndices, setSelectedPacemakerIndices] = useState([]); // Array of selected pacemaker indices (0, 1, 2), empty means none selected
	const [isPacemakerDropdownOpen, setIsPacemakerDropdownOpen] = useState(false);
	
	function handlePacemakerCountChange(newCount: number) {
		setPacemakerCount(newCount);
		const newSelection = selectedPacemakerIndices.filter(index => index < newCount);
		setSelectedPacemakerIndices(newSelection);
	}
	
	function handlePacemakerSelectionChange(selectedIndices: number[]) {
		setSelectedPacemakerIndices(selectedIndices);
	}
	
	function togglePacemakerSelection(index: number) {
		const newSelection = [...selectedPacemakerIndices];
		const existingIndex = newSelection.indexOf(index);
		if (existingIndex > -1) {
			newSelection.splice(existingIndex, 1);
		} else {
			newSelection.push(index);
		}

		setSelectedPacemakerIndices(newSelection);
	}
	
	function getSelectedPacemakers(): boolean[] {
		const result = [false, false, false];

		selectedPacemakerIndices.forEach(index => {
			if (index >= 0 && index < 3) {
				result[index] = true;
			}
		});

		return result;
	}
	
	function handleSimWitVarianceToggle() {
		toggleSimWitVariance(null);
	}
	
	function autoSaveSettings() {
		saveToLocalStorage(courseId, nsamples, seed, posKeepMode, racedef, uma1, uma2, pacer, showVirtualPacemakerOnGraph, pacemakerCount, getSelectedPacemakers(), showLanes, {
			allowRushedUma1,
			allowRushedUma2,
			allowDownhillUma1,
			allowDownhillUma2,
			allowSectionModifierUma1,
			allowSectionModifierUma2,
			allowSkillCheckChanceUma1,
			allowSkillCheckChanceUma2,
			simWitVariance
		});
	}

	function resetUmas() {
		setUma1(new HorseState());
		setUma2(new HorseState());
		if (posKeepMode === PosKeepMode.Virtual) {
			setPacer(new HorseState({strategy: 'Nige'}));
		}
	}
	
	function resetAllUmas() {
		setUma1(new HorseState());
		setUma2(new HorseState());
		setPacer(new HorseState({strategy: 'Nige'}));
	}
	
	const [{courseId, results, runData, chartData, displaying, rushedStats, leadCompetitionStats, spurtInfo, staminaStats, firstUmaStats}, setSimState] = useReducer(updateResultsState, EMPTY_RESULTS_STATE);
	const setCourseId = setSimState;
	const setResults = setSimState;
	const setChartData = setSimState;

	const [tableData, updateTableData] = useReducer((data,newData) => {
		const merged = new Map();
		if (newData == 'reset') {
			return merged;
		}
		data.forEach((v,k) => merged.set(k,v));
		newData.forEach((v,k) => merged.set(k,v));
		return merged;
	}, new Map());

	const [popoverSkill, setPopoverSkill] = useState('');

	function racesetter(prop) {
		return (value) => setRaceDef(racedef.set(prop, value));
	}

	const course = useMemo(() => CourseHelpers.getCourse(courseId), [courseId]);

	const [uma1, setUma1] = useState(() => new HorseState());
	const [uma2, setUma2] = useState(() => new HorseState());
	const [pacer, setPacer] = useState(() => new HorseState({strategy: 'Nige'}));

	const [{mode, currentIdx, expanded}, updateUiState] = useReducer(nextUiState, DEFAULT_UI_STATE);
	function toggleExpand(e: Event) {
		e.stopPropagation();
		postEvent('toggleExpand', {expand: !expanded});
		updateUiState(UiStateMsg.ToggleExpand);
	}

	const [worker1, worker2] = [1,2].map(_ => useMemo(() => {
		const w = new Worker('./simulator.worker.js');
		w.addEventListener('message', function (e) {
			const {type, results} = e.data;
			switch (type) {
				case 'compare':
					setResults(results);
					break;
				case 'chart':
					updateTableData(results);
					break;
				case 'compare-complete':
					setIsSimulationRunning(false);
					break;
				case 'chart-complete':
					chartWorkersCompletedRef.current += 1;
					if (chartWorkersCompletedRef.current >= 2) {
						setIsSimulationRunning(false);
						chartWorkersCompletedRef.current = 0;
					}
					break;
			}
		});
		return w;
	}, []));

	function loadState() {
		if (window.location.hash) {
			deserialize(window.location.hash.slice(1)).then(o => {
				setCourseId(o.courseId);
				setSamples(o.nsamples);
				setSeed(o.seed);
				setPosKeepModeRaw(o.posKeepMode);
				setRaceDef(o.racedef);
				setUma1(o.uma1);
				setUma2(o.uma2);
				setPacer(o.pacer);
				setPacemakerCount(o.pacemakerCount);
				setSelectedPacemakerIndices(o.selectedPacemakers ? 
					o.selectedPacemakers.map((selected, index) => selected ? index : -1).filter(index => index !== -1) : 
					[]);
				
				if (o.showVirtualPacemakerOnGraph !== undefined && o.showVirtualPacemakerOnGraph !== showVirtualPacemakerOnGraph) {
					toggleShowVirtualPacemakerOnGraph(null);
				}

				if (o.showLanes !== undefined && o.showLanes !== showLanes) {
					toggleShowLanes(null);
				}

				if (o.witVarianceSettings) {
					const settings = o.witVarianceSettings;
					if (settings.allowRushedUma1 !== allowRushedUma1) toggleRushedUma1(null);
					if (settings.allowRushedUma2 !== allowRushedUma2) toggleRushedUma2(null);
					if (settings.allowDownhillUma1 !== allowDownhillUma1) toggleDownhillUma1(null);
					if (settings.allowDownhillUma2 !== allowDownhillUma2) toggleDownhillUma2(null);
					if (settings.allowSectionModifierUma1 !== allowSectionModifierUma1) toggleSectionModifierUma1(null);
					if (settings.allowSectionModifierUma2 !== allowSectionModifierUma2) toggleSectionModifierUma2(null);
					if (settings.allowSkillCheckChanceUma1 !== allowSkillCheckChanceUma1) toggleSkillCheckChanceUma1(null);
					if (settings.allowSkillCheckChanceUma2 !== allowSkillCheckChanceUma2) toggleSkillCheckChanceUma2(null);
					if (settings.simWitVariance !== simWitVariance) toggleSimWitVariance(null);
				}
			});
		} else {
			loadFromLocalStorage().then(o => {
				if (o) {
					setCourseId(o.courseId);
					setSamples(o.nsamples);
					setSeed(o.seed);
					setPosKeepModeRaw(o.posKeepMode);
					setRaceDef(o.racedef);
					setUma1(o.uma1);
					setUma2(o.uma2);
					setPacer(o.pacer);
					setPacemakerCount(o.pacemakerCount);
					setSelectedPacemakerIndices(o.selectedPacemakers ? 
						o.selectedPacemakers.map((selected, index) => selected ? index : -1).filter(index => index !== -1) : 
						[]);
					
					if (o.showVirtualPacemakerOnGraph !== undefined && o.showVirtualPacemakerOnGraph !== showVirtualPacemakerOnGraph) {
						toggleShowVirtualPacemakerOnGraph(null);
					}

					if (o.showLanes !== undefined && o.showLanes !== showLanes) {
						toggleShowLanes(null);
					}

					if (o.witVarianceSettings) {
						const settings = o.witVarianceSettings;
						if (settings.allowRushedUma1 !== allowRushedUma1) toggleRushedUma1(null);
						if (settings.allowRushedUma2 !== allowRushedUma2) toggleRushedUma2(null);
						if (settings.allowDownhillUma1 !== allowDownhillUma1) toggleDownhillUma1(null);
						if (settings.allowDownhillUma2 !== allowDownhillUma2) toggleDownhillUma2(null);
						if (settings.allowSectionModifierUma1 !== allowSectionModifierUma1) toggleSectionModifierUma1(null);
						if (settings.allowSectionModifierUma2 !== allowSectionModifierUma2) toggleSectionModifierUma2(null);
						if (settings.allowSkillCheckChanceUma1 !== allowSkillCheckChanceUma1) toggleSkillCheckChanceUma1(null);
						if (settings.allowSkillCheckChanceUma2 !== allowSkillCheckChanceUma2) toggleSkillCheckChanceUma2(null);
						if (settings.simWitVariance !== simWitVariance) toggleSimWitVariance(null);
					}
				}
			});
		}
	}

	useEffect(function () {
		loadState();
		window.addEventListener('hashchange', loadState);
	}, []);

	// Auto-save settings whenever they change
	useEffect(() => {
		autoSaveSettings();
	}, [courseId, nsamples, seed, posKeepMode, racedef, uma1, uma2, pacer, allowRushedUma1, allowRushedUma2, allowDownhillUma1, allowDownhillUma2, allowSectionModifierUma1, allowSectionModifierUma2, allowSkillCheckChanceUma1, allowSkillCheckChanceUma2, simWitVariance, showVirtualPacemakerOnGraph, pacemakerCount, selectedPacemakerIndices]);
	
	useEffect(() => {
		const shouldShow = posKeepMode === PosKeepMode.Virtual && selectedPacemakerIndices.length > 0;
		if (shouldShow !== showVirtualPacemakerOnGraph) {
			if (shouldShow && !showVirtualPacemakerOnGraph) {
				toggleShowVirtualPacemakerOnGraph(null);
			} else if (!shouldShow && showVirtualPacemakerOnGraph) {
				toggleShowVirtualPacemakerOnGraph(null);
			}
		}
	}, [posKeepMode, selectedPacemakerIndices.length]);

	function copyStateUrl(e) {
		e.preventDefault();
		serialize(courseId, nsamples, seed, posKeepMode, racedef, uma1, uma2, pacer, showVirtualPacemakerOnGraph, pacemakerCount, getSelectedPacemakers(), showLanes, {
			allowRushedUma1,
			allowRushedUma2,
			allowDownhillUma1,
			allowDownhillUma2,
			allowSectionModifierUma1,
			allowSectionModifierUma2,
			allowSkillCheckChanceUma1,
			allowSkillCheckChanceUma2,
			simWitVariance
		}).then(hash => {
			const url = window.location.protocol + '//' + window.location.host + window.location.pathname;
			window.navigator.clipboard.writeText(url + '#' + hash);
		});
	}

	function copyUmaToRight() {
		postEvent('copyUma', {direction: 'to-right'});
		setUma2(uma1);
	}

	function copyUmaToLeft() {
		postEvent('copyUma', {direction: 'to-left'});
		setUma1(uma2);
	}

	function swapUmas() {
		postEvent('copyUma', {direction: 'swap'});
		setUma1(uma2);
		setUma2(uma1);
	}

	const strings = {skillnames: {}, tracknames: TRACKNAMES_en};
	const langid = +(props.lang == 'en');
	Object.keys(skillnames).forEach(id => strings.skillnames[id] = skillnames[id][langid]);

	function doComparison() {
		postEvent('doComparison', {});
		setIsSimulationRunning(true);
		worker1.postMessage({
			msg: 'compare',
			data: {
				nsamples,
				course,
				racedef: racedefToParams(racedef),
				uma1: uma1.toJS(),
				uma2: uma2.toJS(),
				pacer: pacer.toJS(),
				options: {
					seed, 
					posKeepMode, 
					allowRushedUma1: simWitVariance ? allowRushedUma1 : false,
					allowRushedUma2: simWitVariance ? allowRushedUma2 : false,
					allowDownhillUma1: simWitVariance ? allowDownhillUma1 : false,
					allowDownhillUma2: simWitVariance ? allowDownhillUma2 : false,
					allowSectionModifierUma1: simWitVariance ? allowSectionModifierUma1 : false,
					allowSectionModifierUma2: simWitVariance ? allowSectionModifierUma2 : false,
					useEnhancedSpurt: false,
					accuracyMode: false,
					skillCheckChanceUma1: simWitVariance ? allowSkillCheckChanceUma1 : false,
					skillCheckChanceUma2: simWitVariance ? allowSkillCheckChanceUma2 : false,
					pacemakerCount: posKeepMode === PosKeepMode.Virtual ? pacemakerCount : 1
				}
			}
		});
	}

	function doRunOnce() {
		postEvent('doRunOnce', {});
		setIsSimulationRunning(true);
		const effectiveSeed = seed + runOnceCounter;
		setRunOnceCounter(prev => prev + 1);
		worker1.postMessage({
			msg: 'compare',
			data: {
				nsamples: 1,
				course,
				racedef: racedefToParams(racedef),
				uma1: uma1.toJS(),
				uma2: uma2.toJS(),
				pacer: pacer.toJS(),
				options: {
					seed: effectiveSeed, 
					posKeepMode, 
					allowRushedUma1: simWitVariance ? allowRushedUma1 : false,
					allowRushedUma2: simWitVariance ? allowRushedUma2 : false,
					allowDownhillUma1: simWitVariance ? allowDownhillUma1 : false,
					allowDownhillUma2: simWitVariance ? allowDownhillUma2 : false,
					allowSectionModifierUma1: simWitVariance ? allowSectionModifierUma1 : false,
					allowSectionModifierUma2: simWitVariance ? allowSectionModifierUma2 : false,
					useEnhancedSpurt: false,
					accuracyMode: false,
					skillCheckChanceUma1: simWitVariance ? allowSkillCheckChanceUma1 : false,
					skillCheckChanceUma2: simWitVariance ? allowSkillCheckChanceUma2 : false,
					pacemakerCount: posKeepMode === PosKeepMode.Virtual ? pacemakerCount : 1
				}
			}
		});
	}

	function getUniqueSkills() {
		return Object.keys(skilldata).filter(id => {
			const skill = skilldata[id];
			return skill.rarity >= 4 && id.startsWith('1');
		});
	}
	
	function removeUniqueSkills(uma) {
		const uniqueSkills = getUniqueSkills();
		const filteredSkills = uma.skills.filter(skillId => !uniqueSkills.includes(skillId));
		return uma.set('skills', filteredSkills);
	}

	function doBasinnChart() {
		postEvent('doBasinnChart', {});
		chartWorkersCompletedRef.current = 0;
		setIsSimulationRunning(true);
		const params = racedefToParams(racedef, uma1.strategy);

		let skills, uma;
		if (mode === Mode.UniquesChart) {
			const uniqueSkills = getUniqueSkills();
			skills = getActivateableSkills(uniqueSkills, uma1, course, params);
			const umaWithoutUniques = removeUniqueSkills(uma1);
			uma = umaWithoutUniques.toJS();
		} else {
			skills = getActivateableSkills(baseSkillsToTest.filter(s => !uma1.skills.has(s) && (s[0] != '9' || !uma1.skills.has('1' + s.slice(1)))), uma1, course, params);
			uma = uma1.toJS();
		}
		
		const filler = new Map();
		skills.forEach(id => filler.set(id, getNullRow(id)));
		const skills1 = skills.slice(0,Math.floor(skills.length/2));
		const skills2 = skills.slice(Math.floor(skills.length/2));
		updateTableData('reset');
		updateTableData(filler);
		worker1.postMessage({
			msg: 'chart', 
			data: {
				skills: skills1, course, racedef: params, uma, pacer: pacer.toJS(), options: {
					seed, 
					posKeepMode: PosKeepMode.Approximate, 
					allowRushedUma1: false,
					allowRushedUma2: false,
					allowDownhillUma1: false,
					allowDownhillUma2: false,
					allowSectionModifierUma1: false,
					allowSectionModifierUma2: false,
					useEnhancedSpurt: false,
					accuracyMode: false,
					skillCheckChanceUma1: false,
					skillCheckChanceUma2: false,
					pacemakerCount: 1
				}
			}
		});
		worker2.postMessage({
			msg: 'chart', 
			data: {
				skills: skills2, course, racedef: params, uma, pacer: pacer.toJS(), 
				options: {
					seed, 
					posKeepMode: PosKeepMode.Approximate, 
					allowRushedUma1: false,
					allowRushedUma2: false,
					allowDownhillUma1: false,
					allowDownhillUma2: false,
					allowSectionModifierUma1: false,
					allowSectionModifierUma2: false,
					useEnhancedSpurt: false,
					accuracyMode: false,
					skillCheckChanceUma1: false,
					skillCheckChanceUma2: false,
					pacemakerCount: 1
				}
			}
		});
	}

	function basinnChartSelection(skillId) {
		const r = tableData.get(skillId);
		if (r.runData != null) setResults(r);
	}

	function addSkillFromTable(skillId) {
		postEvent('addSkillFromTable', {skillId});
		setUma1(uma1.set('skills', uma1.skills.add(skillId)));
	}

	function showPopover(skillId) {
		postEvent('showPopover', {skillId});
		setPopoverSkill(skillId);
	}

	useEffect(function () {
		document.body.addEventListener('click', function () {
			setPopoverSkill('');
		});
	}, []);
	
	useEffect(function () {
		function handleClickOutside(event) {
			if (isPacemakerDropdownOpen && !event.target.closest('.pacemaker-combobox')) {
				setIsPacemakerDropdownOpen(false);
			}
		}
		
		document.addEventListener('click', handleClickOutside);
		return () => document.removeEventListener('click', handleClickOutside);
	}, [isPacemakerDropdownOpen]);

	function rtMouseMove(pos) {
		if (chartData == null) return;
		document.getElementById('rtMouseOverBox').style.display = 'block';
		const x = pos * course.distance;
		const i0 = binSearch(chartData.p[0], x), i1 = binSearch(chartData.p[1], x);

		
		// Ensure indices are within bounds
		const safeI0 = Math.max(0, Math.min(i0, chartData.v[0].length - 1));
		const safeI1 = Math.max(0, Math.min(i1, chartData.v[1].length - 1));
		
		document.getElementById('rtV1').textContent = `${chartData.v[0][safeI0].toFixed(2)} m/s  t=${chartData.t[0][safeI0].toFixed(2)} s  (${chartData.hp[0][safeI0].toFixed(0)} hp remaining)`;
		document.getElementById('rtV2').textContent = `${chartData.v[1][safeI1].toFixed(2)} m/s  t=${chartData.t[1][safeI1].toFixed(2)} s  (${chartData.hp[1][safeI1].toFixed(0)} hp remaining)`;
	}

	function rtMouseLeave() {
		document.getElementById('rtMouseOverBox').style.display = 'none';
	}

	function handleSkillDrag(skillId, umaIndex, newStart, newEnd){
		console.log('handleSkillDrag called:', {skillId, umaIndex, newStart, newEnd});
		
		// Update the forced skill position for the appropriate horse
		if (umaIndex === 0) {
			setUma1(uma1.set('forcedSkillPositions', uma1.forcedSkillPositions.set(skillId, newStart)));
		} else if (umaIndex === 1) {
			setUma2(uma2.set('forcedSkillPositions', uma2.forcedSkillPositions.set(skillId, newStart)));
		} else if (umaIndex === 2) {
			setPacer(pacer.set('forcedSkillPositions', pacer.forcedSkillPositions.set(skillId, newStart)));
		}
	}

	const mid = Math.floor(results.length / 2);
	const median = results.length % 2 == 0 ? (results[mid-1] + results[mid]) / 2 : results[mid];
	const mean = results.reduce((a,b) => a+b, 0) / results.length;

	const colors = [
		{stroke: 'rgb(42, 119, 197)', fill: 'rgba(42, 119, 197, 0.7)'},
		{stroke: 'rgb(197, 42, 42)', fill: 'rgba(197, 42, 42, 0.7)'}
	];
	const skillActivations = chartData == null ? [] : chartData.sk.flatMap((a,i) => {
		return Array.from(a.keys()).flatMap(id => {
			if (NO_SHOW.indexOf(skillmeta(id).iconId) > -1) return [];
			else return a.get(id).map(ar => ({
				type: RegionDisplayType.Textbox,
				color: colors[i],
				text: skillnames[id][0],
				skillId: id,
				umaIndex: i,
				regions: [{start: ar[0], end: ar[1]}]
			}));
		});
	});
	
	const rushedColors = [
		{stroke: 'rgb(42, 119, 197)', fill: 'rgba(42, 119, 197, 0.8)'},  // Blue for Uma 1
		{stroke: 'rgb(197, 42, 42)', fill: 'rgba(197, 42, 42, 0.8)'}     // Red for Uma 2
	];
	const rushedIndicators = chartData == null ? [] : (chartData.rushed || [[], []]).flatMap((rushArray,i) => {
		return rushArray.map(ar => ({
			type: RegionDisplayType.Textbox,
			color: rushedColors[i],
			text: 'Rushed',
			regions: [{start: ar[0], end: ar[1]}]
		}));
	});

	const posKeepColors = [
		{stroke: 'rgb(42, 119, 197)', fill: 'rgba(42, 119, 197, 0.6)'},
		{stroke: 'rgb(197, 42, 42)', fill: 'rgba(197, 42, 42, 0.6)'}
	];
	
	const posKeepData = chartData == null ? [] : (chartData.posKeep || [[], []]).flatMap((posKeepArray,i) => {
		return posKeepArray.map(ar => {
			const stateName = ar[2] === 1 ? 'PU' : ar[2] === 2 ? 'PDM' : ar[2] === 3 ? 'SU' : ar[2] === 4 ? 'O' : 'Unknown';
			return {
				umaIndex: i,
				text: stateName,
				color: posKeepColors[i],
				start: ar[0],
				end: ar[1],
				duration: ar[1] - ar[0]
			};
		});
	});
	
	const virtualPacemakerPosKeepData = showVirtualPacemakerOnGraph && posKeepMode === PosKeepMode.Virtual && chartData && chartData.pacerPosKeep ? 
		(() => {
			const pacemakerPosKeepData = [];
			const pacemakerColors = [
				{stroke: '#22c55e', fill: 'rgba(34, 197, 94, 0.6)'},   // Green
				{stroke: '#a855f7', fill: 'rgba(168, 85, 247, 0.6)'},  // Purple  
				{stroke: '#ec4899', fill: 'rgba(236, 72, 153, 0.6)'}   // Pink
			];
			
			for (let pacemakerIndex = 0; pacemakerIndex < 3; pacemakerIndex++) {
				if (selectedPacemakerIndices.includes(pacemakerIndex) && 
					chartData.pacerPosKeep && chartData.pacerPosKeep[pacemakerIndex]) {
					const pacerPosKeepArray = chartData.pacerPosKeep[pacemakerIndex];
					pacerPosKeepArray.forEach(ar => {
						const stateName = ar[2] === 1 ? 'PU' : ar[2] === 2 ? 'PDM' : ar[2] === 3 ? 'SU' : ar[2] === 4 ? 'O' : 'Unknown';
						pacemakerPosKeepData.push({
							umaIndex: 2 + pacemakerIndex,
							text: stateName,
							color: pacemakerColors[pacemakerIndex],
							start: ar[0],
							end: ar[1],
							duration: ar[1] - ar[0]
						});
					});
				}
			}
			return pacemakerPosKeepData;
		})() : [];
	
	const competeFightData = chartData == null ? [] : (chartData.competeFight || [[], []]).flatMap((competeFightArray, i) => {
		if (!competeFightArray || competeFightArray.length === 0) return [];
		const start = competeFightArray[0];
		const end = competeFightArray[1];
		return [{
			umaIndex: i,
			text: 'Duel',
			color: posKeepColors[i],
			start: start,
			end: end,
			duration: end - start
		}];
	});
	
	const leadCompetitionData = chartData == null ? [] : (chartData.leadCompetition || [[], []]).flatMap((leadCompetitionArray, i) => {
		if (!leadCompetitionArray || leadCompetitionArray.length === 0) return [];
		const start = leadCompetitionArray[0];
		const end = leadCompetitionArray[1];
		return [{
			umaIndex: i,
			text: 'SS',
			color: posKeepColors[i],
			start: start,
			end: end,
			duration: end - start
		}];
	});
	
	const virtualPacemakerLeadCompetitionData = showVirtualPacemakerOnGraph && posKeepMode === PosKeepMode.Virtual && chartData && chartData.pacerLeadCompetition ? 
		(() => {
			const pacemakerLeadCompetitionData = [];
			const pacemakerColors = [
				{stroke: '#22c55e', fill: 'rgba(34, 197, 94, 0.6)'},
				{stroke: '#a855f7', fill: 'rgba(168, 85, 247, 0.6)'},
				{stroke: '#ec4899', fill: 'rgba(236, 72, 153, 0.6)'}
			];
			
			for (let pacemakerIndex = 0; pacemakerIndex < 3; pacemakerIndex++) {
				if (selectedPacemakerIndices.includes(pacemakerIndex) && 
					chartData.pacerLeadCompetition && chartData.pacerLeadCompetition[pacemakerIndex] && chartData.pacerLeadCompetition[pacemakerIndex].length > 0) {
					const leadCompetitionArray = chartData.pacerLeadCompetition[pacemakerIndex];
					const start = leadCompetitionArray[0];
					const end = leadCompetitionArray[1];
					pacemakerLeadCompetitionData.push({
						umaIndex: 2 + pacemakerIndex,
						text: 'SS',
						color: pacemakerColors[pacemakerIndex],
						start: start,
						end: end,
						duration: end - start
					});
				}
			}
			return pacemakerLeadCompetitionData;
		})() : [];
	
	const posKeepLabels = [];
	
	const tempLabels = [...posKeepData, ...virtualPacemakerPosKeepData, ...competeFightData, ...leadCompetitionData, ...virtualPacemakerLeadCompetitionData].map(posKeep => ({
		...posKeep,
		x: posKeep.start / course.distance * 960,
		width: posKeep.duration / course.distance * 960,
		yOffset: 0
	}));
	
	tempLabels.sort((a, b) => a.x - b.x);
	
	for (let i = 0; i < tempLabels.length; i++) {
		const currentLabel = tempLabels[i];
		let maxYOffset = 40;
		
		for (let j = 0; j < i; j++) {
			const prevLabel = tempLabels[j];
			
			// Check if labels overlap horizontally
			const padding = 0; // Add padding to prevent labels from being too close
			const overlap = !(currentLabel.x + currentLabel.width + padding < prevLabel.x || 
							 currentLabel.x > prevLabel.x + prevLabel.width + padding);
			
			if (overlap) {
				// Labels overlap, need to offset vertically
				maxYOffset = Math.max(maxYOffset, prevLabel.yOffset + 15);
			}
		}
		
		currentLabel.yOffset = maxYOffset;
		posKeepLabels.push(currentLabel);
	}
	

	const umaTabs = (
		<Fragment>
			<div class={`umaTab ${currentIdx == 0 ? 'selected' : ''}`} onClick={() => updateUiState(UiStateMsg.SetCurrentIdx0)}>Umamusume 1</div>
			{mode == Mode.Compare && <div class={`umaTab ${currentIdx == 1 ? 'selected' : ''}`} onClick={() => updateUiState(UiStateMsg.SetCurrentIdx1)}>Umamusume 2{posKeepMode != PosKeepMode.Virtual && <div id="expandBtn" title="Expand panel" onClick={toggleExpand} />}</div>}
			{posKeepMode == PosKeepMode.Virtual && <div class={`umaTab ${currentIdx == 2 ? 'selected' : ''}`} onClick={() => updateUiState(UiStateMsg.SetCurrentIdx2)}>Virtual Pacemaker<div id="expandBtn" title="Expand panel" onClick={toggleExpand} /></div>}
		</Fragment>
	);

	let resultsPane;
	if (mode == Mode.Compare && results.length > 0) {
		resultsPane = (
			<div id="resultsPaneWrapper">
				<div id="resultsPane" class="mode-compare">
					<table id="resultsSummary">
						<tfoot>
							<tr>
								{Object.entries({
									minrun: ['Minimum', 'Set chart display to the run with minimum bashin difference'],
									maxrun: ['Maximum', 'Set chart display to the run with maximum bashin difference'],
									meanrun: ['Mean', 'Set chart display to a run representative of the mean bashin difference'],
									medianrun: ['Median', 'Set chart display to a run representative of the median bashin difference']
								}).map(([k,label]) =>
									<th scope="col" class={displaying == k ? 'selected' : ''} title={label[1]} onClick={() => setChartData(k)}>{label[0]}</th>
								)}
							</tr>
						</tfoot>
						<tbody>
							<tr>
								<td onClick={() => setChartData('minrun')}>{results[0].toFixed(2)}<span class="unit-basinn">{CC_GLOBAL?'lengths':'バ身'}</span></td>
								<td onClick={() => setChartData('maxrun')}>{results[results.length-1].toFixed(2)}<span class="unit-basinn">{CC_GLOBAL?'lengths':'バ身'}</span></td>
								<td onClick={() => setChartData('meanrun')}>{mean.toFixed(2)}<span class="unit-basinn">{CC_GLOBAL?'lengths':'バ身'}</span></td>
								<td onClick={() => setChartData('medianrun')}>{median.toFixed(2)}<span class="unit-basinn">{CC_GLOBAL?'lengths':'バ身'}</span></td>
							</tr>
						</tbody>
					</table>
					<div id="resultsHelp">Negative numbers mean <strong style="color:#2a77c5">Umamusume 1</strong> is faster, positive numbers mean <strong style="color:#c52a2a">Umamusume 2</strong> is faster.</div>
					
					
					{(firstUmaStats || staminaStats) && (
						<div style={{marginTop: '15px', marginBottom: '10px', textAlign: 'center'}}>
							{firstUmaStats && (
								<div style={{marginBottom: '2px', display: 'flex', justifyContent: 'center', gap: '40px'}}>
									<div style={{textAlign: 'right', minWidth: '250px'}}>
										<strong>Uma 1:</strong> Final leg 1st place: <span style={{color: '#2a77c5', fontWeight: 'bold'}}>{firstUmaStats.uma1.firstPlaceRate.toFixed(1)}%</span>
									</div>
									<div style={{textAlign: 'left', minWidth: '250px'}}>
										<strong>Uma 2:</strong> Final leg 1st place: <span style={{color: '#c52a2a', fontWeight: 'bold'}}>{firstUmaStats.uma2.firstPlaceRate.toFixed(1)}%</span>
									</div>
								</div>
							)}
							{staminaStats && (
								<>
									{simWitVariance && (
										<div style={{marginBottom: '2px', display: 'flex', justifyContent: 'center', gap: '40px'}}>
											<div style={{textAlign: 'right', minWidth: '250px'}}>
												<strong>Uma 1:</strong> Spurt Rate: <span style={{color: '#2a77c5', fontWeight: 'bold'}}>{staminaStats.uma1.fullSpurtRate.toFixed(1)}%</span>
											</div>
											<div style={{textAlign: 'left', minWidth: '250px'}}>
												<strong>Uma 2:</strong> Spurt Rate: <span style={{color: '#c52a2a', fontWeight: 'bold'}}>{staminaStats.uma2.fullSpurtRate.toFixed(1)}%</span>
											</div>
										</div>
									)}
									{simWitVariance && (
										<div style={{marginBottom: '2px', display: 'flex', justifyContent: 'center', gap: '40px'}}>
											<div style={{textAlign: 'right', minWidth: '250px'}}>
												<strong>Uma 1:</strong> Survival Rate: <span style={{color: '#2a77c5', fontWeight: 'bold'}}>{staminaStats.uma1.staminaSurvivalRate.toFixed(1)}%</span>
											</div>
											<div style={{textAlign: 'left', minWidth: '250px'}}>
												<strong>Uma 2:</strong> Survival Rate: <span style={{color: '#c52a2a', fontWeight: 'bold'}}>{staminaStats.uma2.staminaSurvivalRate.toFixed(1)}%</span>
											</div>
										</div>
									)}
									{!simWitVariance && (
										<div style={{marginBottom: '2px', display: 'flex', justifyContent: 'center', gap: '40px', color: '#c52a2a'}}>
											<div style={{textAlign: 'right', minWidth: '250px'}}>
												<strong>Please turn on wit variance to see the spurt stats</strong>
											</div>
										</div>
									)}
					
								</>
							)}
						</div>
					)}
					
					<Histogram width={500} height={333} data={results} />
					{simWitVariance && staminaStats && (
						<div style={{marginTop: '20px', width: '500px', paddingBottom: '20px'}}>
							<div style={{display: 'flex', marginBottom: '0'}}>
								<div 
									class={`umaTab staminaTab ${hpDeathPositionTab == 0 ? 'selected' : ''}`} 
									onClick={() => setHpDeathPositionTab(0)}
									style={{cursor: 'pointer'}}
								>
									Uma 1
								</div>
								<div 
									class={`umaTab staminaTab ${hpDeathPositionTab == 1 ? 'selected' : ''}`} 
									onClick={() => setHpDeathPositionTab(1)}
									style={{cursor: 'pointer'}}
								>
									Uma 2
								</div>
							</div>
							{hpDeathPositionTab == 0 && (
								<>
									<StatsTable 
										caption="Stamina Death Stats"
										captionColor="#2a77c5"
										rows={[
											{ label: 'Full Spurt', stats: staminaStats.uma1.hpDiedPositionStatsFullSpurt },
											{ label: 'Non-Full Spurt', stats: staminaStats.uma1.hpDiedPositionStatsNonFullSpurt }
										]}
									/>
									{staminaStats.uma1.nonFullSpurtVelocityStats && staminaStats.uma1.nonFullSpurtDelayStats && (
										<StatsTable 
											caption="Non-Full Spurt Stats"
											captionColor="#2a77c5"
											rows={[
												{ label: 'Velocity', stats: staminaStats.uma1.nonFullSpurtVelocityStats },
												{ label: 'Delay', stats: staminaStats.uma1.nonFullSpurtDelayStats }
											]}
										/>
									)}
								</>
							)}
							{hpDeathPositionTab == 1 && (
								<>
									<StatsTable 
										caption="Stamina Death Stats"
										captionColor="#c52a2a"
										rows={[
											{ label: 'Full Spurt', stats: staminaStats.uma2.hpDiedPositionStatsFullSpurt },
											{ label: 'Non-Full Spurt', stats: staminaStats.uma2.hpDiedPositionStatsNonFullSpurt }
										]}
									/>
									{staminaStats.uma2.nonFullSpurtVelocityStats && staminaStats.uma2.nonFullSpurtDelayStats && (
										<StatsTable 
											caption="Non-Full Spurt Stats"
											captionColor="#c52a2a"
											rows={[
												{ label: 'Velocity', stats: staminaStats.uma2.nonFullSpurtVelocityStats },
												{ label: 'Delay', stats: staminaStats.uma2.nonFullSpurtDelayStats }
											]}
										/>
									)}
								</>
							)}
						</div>
					)}
				</div>
				<div id="infoTables">
					<table>
						<caption style="color:#2a77c5">Umamusume 1</caption>
						<tbody>
							<tr><th>Time to finish</th><td>{formatTime(chartData.t[0][chartData.t[0].length-1] * 1.18)}</td></tr>
							<tr><th>Start delay</th><td>{chartData.sdly[0].toFixed(4) + ' s'}</td></tr>
							<tr><th>Top speed</th><td>{chartData.v[0].reduce((a,b) => Math.max(a,b), 0).toFixed(2) + ' m/s'}</td></tr>
							{rushedStats && allowRushedUma2 && (
								<tr><th>Rushed frequency</th><td>{rushedStats.uma1.frequency > 0 ? `${rushedStats.uma1.frequency.toFixed(1)}% (${rushedStats.uma1.mean.toFixed(1)}m)` : '0%'}</td></tr>
							)}
							{leadCompetitionStats && (
								<tr><th>Spot Struggle frequency</th><td>{leadCompetitionStats.uma1.frequency > 0 ? `${leadCompetitionStats.uma1.frequency.toFixed(1)}%` : '0%'}</td></tr>
							)}
						</tbody>
						{chartData.sk[0].size > 0 &&
							<tbody>
								{Array.from(chartData.sk[0].entries()).map(([id,ars]) => ars.flatMap(pos =>
									<tr>
										<th>{skillnames[id][0]}</th>
										<td>{`${pos[0].toFixed(2)} m – ${pos[1].toFixed(2)} m`}</td>
									</tr>))}
							</tbody>}
					</table>
					<table>
						<caption style="color:#c52a2a">Umamusume 2</caption>
						<tbody>
							<tr><th>Time to finish</th><td>{formatTime(chartData.t[1][chartData.t[1].length-1] * 1.18)}</td></tr>
							<tr><th>Start delay</th><td>{chartData.sdly[1].toFixed(4) + ' s'}</td></tr>
							<tr><th>Top speed</th><td>{chartData.v[1].reduce((a,b) => Math.max(a,b), 0).toFixed(2) + ' m/s'}</td></tr>
							{rushedStats && allowRushedUma2 && (
								<tr><th>Rushed frequency</th><td>{rushedStats.uma2.frequency > 0 ? `${rushedStats.uma2.frequency.toFixed(1)}% (${rushedStats.uma2.mean.toFixed(1)}m)` : '0%'}</td></tr>
							)}
							{leadCompetitionStats && (
								<tr><th>Spot Struggle frequency</th><td>{leadCompetitionStats.uma2.frequency > 0 ? `${leadCompetitionStats.uma2.frequency.toFixed(1)}%` : '0%'}</td></tr>
							)}
						</tbody>
						{chartData.sk[1].size > 0 &&
							<tbody>
								{Array.from(chartData.sk[1].entries()).map(([id,ars]) => ars.flatMap(pos =>
									<tr>
										<th>{skillnames[id][0]}</th>
										<td>{`${pos[0].toFixed(2)} m – ${pos[1].toFixed(2)} m`}</td>
									</tr>))}
							</tbody>}
					</table>
				</div>
			</div>
		);
	} else if (mode == Mode.Chart && tableData.size > 0) {
		resultsPane = (
			<div id="resultsPaneWrapper">
				<div id="resultsPane" class="mode-chart">
					<BasinnChart data={Array.from(tableData.values())} hidden={uma1.skills}
						onSelectionChange={basinnChartSelection}
						onRunTypeChange={setChartData}
						onDblClickRow={addSkillFromTable}
						onInfoClick={showPopover} />
				</div>
			</div>
		);
	} else if (mode == Mode.UniquesChart && tableData.size > 0) {
		resultsPane = (
			<div id="resultsPaneWrapper">
				<div id="resultsPane" class="mode-chart">
					<BasinnChart data={Array.from(tableData.values())} hidden={new Set()}
						onSelectionChange={basinnChartSelection}
						onRunTypeChange={setChartData}
						onDblClickRow={addSkillFromTable}
						onInfoClick={showPopover}
						showUmaIcons={true} />
				</div>
			</div>
		);
	} else if (CC_GLOBAL) {
		resultsPane = (
			<div id="resultsPaneWrapper">
				<div id="resultsPane">
					<IntroText />
				</div>
			</div>
		);
	} else {
		resultsPane = null;
	}

	return (
		<Language.Provider value={props.lang}>
			<IntlProvider definition={strings}>
				<div id="topPane" class={chartData ? 'hasResults' : ''}>
					<RaceTrack courseid={courseId} width={960} height={240} xOffset={20} yOffset={15} yExtra={20} mouseMove={rtMouseMove} mouseLeave={rtMouseLeave} onSkillDrag={handleSkillDrag} regions={[...skillActivations, ...rushedIndicators]} posKeepLabels={posKeepLabels} uma1={uma1} uma2={uma2} pacer={pacer}>
						<VelocityLines data={chartData} courseDistance={course.distance} width={960} height={250} xOffset={20} showHp={showHp} showLanes={showLanes} horseLane={course.horseLane} showVirtualPacemaker={showVirtualPacemakerOnGraph && posKeepMode === PosKeepMode.Virtual} selectedPacemakers={getSelectedPacemakers()} />
						
						<g id="rtMouseOverBox" style="display:none">
							<text id="rtV1" x="25" y="10" fill="#2a77c5" font-size="10px"></text>
							<text id="rtV2" x="25" y="20" fill="#c52a2a" font-size="10px"></text>
							<text id="rtVp" x="25" y="30" fill="#22c55e" font-size="10px"></text>
							<text id="pd1" x="25" y="10" fill="#2a77c5" font-size="10px"></text>
							<text id="pd2" x="25" y="20" fill="#c52a2a" font-size="10px"></text>
						</g>
					</RaceTrack>
					<div id="runPane">
						<fieldset>
							<legend>Mode:</legend>
							<div>
								<input type="radio" id="mode-compare" name="mode" value="compare" checked={mode == Mode.Compare} onClick={() => updateUiState(UiStateMsg.SetModeCompare)} />
								<label for="mode-compare">Compare</label>
							</div>
							<div>
								<input type="radio" id="mode-chart" name="mode" value="chart" checked={mode == Mode.Chart} onClick={() => updateUiState(UiStateMsg.SetModeChart)} />
								<label for="mode-chart">Skill chart</label>
							</div>
							<div>
								<input type="radio" id="mode-uniques-chart" name="mode" value="uniques-chart" checked={mode == Mode.UniquesChart} onClick={() => updateUiState(UiStateMsg.SetModeUniquesChart)} />
								<label for="mode-uniques-chart">Uma chart</label>
							</div>
						</fieldset>
						{
							mode == Mode.Compare
							? <button id="run" onClick={doComparison} tabindex={1} disabled={isSimulationRunning}>COMPARE</button>
							: <button id="run" onClick={doBasinnChart} tabindex={1} disabled={isSimulationRunning}>RUN</button>
						}
						{
							mode == Mode.Compare
							? <button id="runOnce" onClick={doRunOnce} tabindex={1} disabled={isSimulationRunning}>Run Once</button>
							: null
						}
						<label for="nsamples">Samples:</label>
						<input type="number" id="nsamples" min="1" max="10000" value={nsamples} onInput={(e) => setSamples(+e.currentTarget.value)} />
						<label for="seed">Seed:</label>
						<div id="seedWrapper">
							<input type="number" id="seed" value={seed} onInput={(e) => { setSeed(+e.currentTarget.value); setRunOnceCounter(0); }} />
							<button title="Randomize seed" onClick={() => { setSeed(Math.floor(Math.random() * (-1 >>> 0)) >>> 0); setRunOnceCounter(0); }}>🎲</button>
						</div>
						<fieldset id="posKeepFieldset">
							<legend>Position Keep:</legend>
							<select id="poskeepmode" value={posKeepMode} onInput={(e) => setPosKeepMode(+e.currentTarget.value)}>
								<option value={PosKeepMode.None}>None</option>
								<option value={PosKeepMode.Approximate}>Approximate</option>
								<option value={PosKeepMode.Virtual}>Virtual Pacemaker</option>
							</select>
							{posKeepMode == PosKeepMode.Approximate && (
								<div id="pacemakerIndicator">
									<span>Using default pacemaker</span>
								</div>
							)}
							{posKeepMode == PosKeepMode.Virtual && (
								<div id="pacemakerIndicator">
									<div>
										<label>Show Pacemakers:</label>
										<div className="pacemaker-combobox">
											<button 
												className="pacemaker-combobox-button"
												onClick={() => setIsPacemakerDropdownOpen(!isPacemakerDropdownOpen)}
											>
												{selectedPacemakerIndices.length === 0
													? 'None'
													: selectedPacemakerIndices.length === 1 
													? `Pacemaker ${selectedPacemakerIndices[0] + 1}`
													: selectedPacemakerIndices.length === pacemakerCount
													? 'All Pacemakers'
													: `${selectedPacemakerIndices.length} Pacemakers`
												}
												<span className="pacemaker-combobox-arrow">▼</span>
											</button>
											{isPacemakerDropdownOpen && (
												<div className="pacemaker-combobox-dropdown">
													{[...Array(pacemakerCount)].map((_, index) => (
														<label key={index} className="pacemaker-combobox-option">
															<input 
																type="checkbox" 
																checked={selectedPacemakerIndices.includes(index)}
																onChange={() => togglePacemakerSelection(index)}
															/>
															<span style={{color: index === 0 ? '#22c55e' : index === 1 ? '#a855f7' : '#ec4899'}}>
																Pacemaker {index + 1}
															</span>
														</label>
													))}
												</div>
											)}
										</div>
									</div>
									<div id="pacemakerCountControl">
										<label for="pacemakercount">Number of pacemakers: {pacemakerCount}</label>
										<input 
											type="range" 
											id="pacemakercount" 
											min="1" 
											max="3" 
											value={pacemakerCount} 
											onInput={(e) => handlePacemakerCountChange(+e.currentTarget.value)} 
										/>
									</div>
								</div>
							)}
						</fieldset>
						<div>
							<label for="showhp">Show HP</label>
							<input type="checkbox" id="showhp" checked={showHp} onClick={toggleShowHp} />
						</div>
						<div>
							<label for="showlanes">Show Lanes</label>
							<input type="checkbox" id="showlanes" checked={showLanes} onClick={toggleShowLanes} />
						</div>
						<div>
							<label for="simWitVariance">Wit Variance</label>
							<input type="checkbox" id="simWitVariance" checked={simWitVariance} onClick={handleSimWitVarianceToggle} />
							<button 
								className="wit-variance-settings-btn" 
								onClick={() => setShowWitVarianceSettings(true)}
								title="Configure Wit Variance settings"
								disabled={!simWitVariance}
							>
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<circle cx="12" cy="12" r="3"></circle>
									<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1 1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
								</svg>
							</button>
						</div>

						<a href="#" onClick={copyStateUrl}>Copy link</a>
						<RacePresets set={(courseId, racedef) => { setCourseId(courseId); setRaceDef(racedef); }} />
					</div>
					<div id="buttonsRow">
						<TrackSelect key={courseId} courseid={courseId} setCourseid={setCourseId} tabindex={2} />
						<div id="buttonsRowSpace" />
						<TimeOfDaySelect value={racedef.time} set={racesetter('time')} />
						<div>
							<GroundSelect value={racedef.ground} set={racesetter('ground')} />
							<WeatherSelect value={racedef.weather} set={racesetter('weather')} />
						</div>
						<SeasonSelect value={racedef.season} set={racesetter('season')} />
					</div>
				</div>
				{resultsPane}
				{expanded && <div id="umaPane" />}
				<div id={expanded ? 'umaOverlay' : 'umaPane'}>
					<div class={!expanded && currentIdx == 0 ? 'selected' : ''}>
						<HorseDef key={uma1.outfitId} state={uma1} setState={setUma1} courseDistance={course.distance} tabstart={() => 4} onResetAll={resetAllUmas}>
							{expanded ? 'Umamusume 1' : umaTabs}
						</HorseDef>
					</div>
					{expanded &&
						<div id="copyUmaButtons">
							<div id="copyUmaToRight" title="Copy uma 1 to uma 2" onClick={copyUmaToRight} />
							<div id="copyUmaToLeft" title="Copy uma 2 to uma 1" onClick={copyUmaToLeft} />
							<div id="swapUmas" title="Swap umas" onClick={swapUmas}>⮂</div>
						</div>}
					{mode == Mode.Compare && <div class={!expanded && currentIdx == 1 ? 'selected' : ''}>
						<HorseDef key={uma2.outfitId} state={uma2} setState={setUma2} courseDistance={course.distance} tabstart={() => 4 + horseDefTabs()} onResetAll={resetAllUmas}>
							{expanded ? 'Umamusume 2' : umaTabs}
						</HorseDef>
					</div>}
					{posKeepMode == PosKeepMode.Virtual && <div class={!expanded && currentIdx == 2 ? 'selected' : ''}>
						<HorseDef key={pacer.outfitId} state={pacer} setState={setPacer} courseDistance={course.distance} tabstart={() => 4 + (mode == Mode.Compare ? 2 : 1) * horseDefTabs()} onResetAll={resetAllUmas}>
							{expanded ? 'Virtual Pacemaker' : umaTabs}
						</HorseDef>
					</div>}
					{expanded && <div id="closeUmaOverlay" title="Close panel" onClick={toggleExpand}>✕</div>}
				</div>
				{popoverSkill && <BasinnChartPopover skillid={popoverSkill} results={tableData.get(popoverSkill).results} courseDistance={course.distance} />}
				<WitVarianceSettingsPopup 
					show={showWitVarianceSettings}
					onClose={() => setShowWitVarianceSettings(false)}
					allowRushedUma1={allowRushedUma1}
					allowRushedUma2={allowRushedUma2}
					allowDownhillUma1={allowDownhillUma1}
					allowDownhillUma2={allowDownhillUma2}
					allowSectionModifierUma1={allowSectionModifierUma1}
					allowSectionModifierUma2={allowSectionModifierUma2}
					allowSkillCheckChanceUma1={allowSkillCheckChanceUma1}
					allowSkillCheckChanceUma2={allowSkillCheckChanceUma2}
					toggleRushedUma1={toggleRushedUma1}
					toggleRushedUma2={toggleRushedUma2}
					toggleDownhillUma1={toggleDownhillUma1}
					toggleDownhillUma2={toggleDownhillUma2}
					toggleSectionModifierUma1={toggleSectionModifierUma1}
					toggleSectionModifierUma2={toggleSectionModifierUma2}
					toggleSkillCheckChanceUma1={toggleSkillCheckChanceUma1}
					toggleSkillCheckChanceUma2={toggleSkillCheckChanceUma2}
				/>
			</IntlProvider>
		</Language.Provider>
	);
}

initTelemetry();
render(<App lang="en-ja" />, document.getElementById('app'));

