import type { CourseData } from '../uma-skill-tools/CourseData';
import type { RaceParameters } from '../uma-skill-tools/RaceParameters';

import { Map as ImmMap } from 'immutable';
import { HorseState, SkillSet } from '../components/HorseDefTypes';
import { runComparison } from './compare';
import skill_meta from '../skill_meta.json';

function skillmeta(id: string) {
	return skill_meta[id.split('-')[0]];
}

function mergeSkillMaps(map1, map2) {
	const obj1 = map1 instanceof Map ? Object.fromEntries(map1) : (map1 || {});
	const obj2 = map2 instanceof Map ? Object.fromEntries(map2) : (map2 || {});
	const merged = { ...obj1 };
	Object.entries(obj2).forEach(([skillId, values]: [string, any]) => {
		merged[skillId] = [...(merged[skillId] || []), ...(values || [])];
	});
	return merged;
}

function mergeResults(results1, results2) {
	console.assert(results1.id == results2.id, `mergeResults: ${results1.id} != ${results2.id}`);
	const n1 = results1.results.length, n2 = results2.results.length;
	const combinedResults = results1.results.concat(results2.results).sort((a,b) => a - b);
	const combinedMean = (results1.mean * n1 + results2.mean * n2) / (n1 + n2);
	const mid = Math.floor(combinedResults.length / 2);
	const newMedian = combinedResults.length % 2 == 0 ? (combinedResults[mid-1] + combinedResults[mid]) / 2 : combinedResults[mid];
	
	const allruns1 = results1.runData?.allruns || {};
	const allruns2 = results2.runData?.allruns || {};
	const {skBasinn: skBasinn1, sk: sk1, totalRuns: totalRuns1, ...rest1} = allruns1;
	const {skBasinn: skBasinn2, sk: sk2, totalRuns: totalRuns2, ...rest2} = allruns2;
	
	const mergedAllRuns: any = {
		...rest1,
		...rest2,
		totalRuns: (totalRuns1 || 0) + (totalRuns2 || 0)
	};
	
	if (skBasinn1 && skBasinn2) {
		mergedAllRuns.skBasinn = [
			mergeSkillMaps(skBasinn1[0] || {}, skBasinn2[0] || {}),
			mergeSkillMaps(skBasinn1[1] || {}, skBasinn2[1] || {})
		];
	} else if (skBasinn1 || skBasinn2) {
		mergedAllRuns.skBasinn = skBasinn1 || skBasinn2;
	}
	
	if (sk1 && sk2) {
		mergedAllRuns.sk = [
			mergeSkillMaps(sk1[0] || {}, sk2[0] || {}),
			mergeSkillMaps(sk1[1] || {}, sk2[1] || {})
		];
	} else if (sk1 || sk2) {
		mergedAllRuns.sk = sk1 || sk2;
	}
	
	return {
		id: results1.id,
		results: combinedResults,
		min: Math.min(results1.min, results2.min),
		max: Math.max(results1.max, results2.max),
		mean: combinedMean,
		median: newMedian,
		runData: {
			...(n2 > n1 ? results2.runData : results1.runData),
			allruns: mergedAllRuns,
			minrun: results1.min < results2.min ? results1.runData.minrun : results2.runData.minrun,
			maxrun: results1.max > results2.max ? results1.runData.maxrun : results2.runData.maxrun,
		}
	};
}

function mergeResultSets(data1, data2) {
	data2.forEach((r,id) => {
		data1.set(id, mergeResults(data1.get(id), r));
	});
}

function run1Round(nsamples: number, skills: string[], course: CourseData, racedef: RaceParameters, uma, pacer, options) {
	const data = new Map();
	skills.forEach(id => {
		const newSkillGroupId = skillmeta(id)?.groupId;
		let skillsToUse = uma.skills;
		
		if (newSkillGroupId) {
			skillsToUse = skillsToUse.filter((existingSkillId: string) => {
				const existingGroupId = skillmeta(existingSkillId)?.groupId;
				return existingGroupId !== newSkillGroupId;
			});
		}
		
		const withSkill = uma.set('skills', skillsToUse.add(id));
		const {results, runData} = runComparison(nsamples, course, racedef, uma, withSkill, pacer, options);
		const mid = Math.floor(results.length / 2);
		const median = results.length % 2 == 0 ? (results[mid-1] + results[mid]) / 2 : results[mid];
		const mean = results.reduce((a,b) => a+b, 0) / results.length;
		data.set(id, {
			id, results, runData,
			min: results[0],
			max: results[results.length-1],
			mean,
			median
		});
	});
	return data;
}

function runChart({skills, course, racedef, uma, pacer, options}) {
	const uma_ = new HorseState(uma)
		.set('skills', SkillSet(uma.skills))
		.set('forcedSkillPositions', ImmMap(uma.forcedSkillPositions || {}));
	const pacer_ = pacer ? new HorseState(pacer)
		.set('skills', SkillSet(pacer.skills || []))
		.set('forcedSkillPositions', ImmMap(pacer.forcedSkillPositions || {})) : null;
	postMessage({type: 'chart-progress', round: 1, total: 4});
	let results = run1Round(5, skills, course, racedef, uma_, pacer_, options);
	postMessage({type: 'chart', results});
	skills = skills.filter(id => results.get(id).max > 0.1);
	postMessage({type: 'chart-progress', round: 2, total: 4});
	let update = run1Round(20, skills, course, racedef, uma_, pacer_, options);
	mergeResultSets(results, update);
	postMessage({type: 'chart', results});
	skills = skills.filter(id => Math.abs(results.get(id).max - results.get(id).min) > 0.1);
	postMessage({type: 'chart-progress', round: 3, total: 4});
	update = run1Round(50, skills, course, racedef, uma_, pacer_, options);
	mergeResultSets(results, update);
	postMessage({type: 'chart', results});
	postMessage({type: 'chart-progress', round: 4, total: 4});
	update = run1Round(200, skills, course, racedef, uma_, pacer_, options);
	mergeResultSets(results, update);
	postMessage({type: 'chart', results});
	postMessage({type: 'chart-complete'});
}

function runCompare({nsamples, course, racedef, uma1, uma2, pacer, options}) {
	const uma1_ = new HorseState(uma1)
		.set('skills', SkillSet(uma1.skills))
		.set('forcedSkillPositions', ImmMap(uma1.forcedSkillPositions || {}));
	const uma2_ = new HorseState(uma2)
		.set('skills', SkillSet(uma2.skills))
		.set('forcedSkillPositions', ImmMap(uma2.forcedSkillPositions || {}));
	const pacer_ = pacer ? new HorseState(pacer)
		.set('skills', SkillSet(pacer.skills || []))
		.set('forcedSkillPositions', ImmMap(pacer.forcedSkillPositions || {})) : null;
	const compareOptions = {...options, mode: 'compare'};
	let results;
	for (let n = Math.min(20, nsamples), mul = 6; n < nsamples; n = Math.min(n * mul, nsamples), mul = Math.max(mul - 1, 2)) {
		results = runComparison(n, course, racedef, uma1_, uma2_, pacer_, compareOptions);
		postMessage({type: 'compare', results});
	}
	results = runComparison(nsamples, course, racedef, uma1_, uma2_, pacer_, compareOptions);
	postMessage({type: 'compare', results});
	postMessage({type: 'compare-complete'});
}

function runAdditionalSamples({skillId, nsamples, course, racedef, uma, pacer, options}) {
	const uma_ = new HorseState(uma)
		.set('skills', SkillSet(uma.skills))
		.set('forcedSkillPositions', ImmMap(uma.forcedSkillPositions || {}));
	const pacer_ = pacer ? new HorseState(pacer)
		.set('skills', SkillSet(pacer.skills || []))
		.set('forcedSkillPositions', ImmMap(pacer.forcedSkillPositions || {})) : null;
	
	const newSkillGroupId = skillmeta(skillId)?.groupId;
	let skillsToUse = uma_.skills;
	
	if (newSkillGroupId) {
		skillsToUse = skillsToUse.filter((existingSkillId: string) => {
			const existingGroupId = skillmeta(existingSkillId)?.groupId;
			return existingGroupId !== newSkillGroupId;
		});
	}
	
	const withSkill = uma_.set('skills', skillsToUse.add(skillId));
	const {results, runData} = runComparison(nsamples, course, racedef, uma_, withSkill, pacer_, options);
	const mid = Math.floor(results.length / 2);
	const median = results.length % 2 == 0 ? (results[mid-1] + results[mid]) / 2 : results[mid];
	const mean = results.reduce((a,b) => a+b, 0) / results.length;
	const newResult = {
		id: skillId,
		results,
		runData,
		min: results[0],
		max: results[results.length-1],
		mean,
		median
	};
	postMessage({type: 'additional-samples', skillId, result: newResult});
}

self.addEventListener('message', function (e) {
	const {msg, data} = e.data;
	switch (msg) {
		case 'chart':
			runChart(data);
			break;
		case 'compare':
			runCompare(data);
			break;
		case 'additional-samples':
			runAdditionalSamples(data);
			break;
	}
});
