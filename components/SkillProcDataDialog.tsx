import { h, Fragment } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { LengthDifferenceChart, ActivationFrequencyChart, VelocityChart } from '../umalator/app';
import { CourseHelpers } from '../uma-skill-tools/CourseData';

function extractSkillRunData(compareRunData: any, umaIndex: number): any {
	if (!compareRunData?.allruns) {
		return null;
	}

	const umaSkBasinn = compareRunData.allruns.skBasinn?.[umaIndex];
	const umaSk = compareRunData.allruns.sk?.[umaIndex];
	const totalRuns = compareRunData.allruns.totalRuns || 0;

	if (!umaSkBasinn && !umaSk) {
		return null;
	}

	return {
		allruns: {
			skBasinn: umaSkBasinn ? [umaSkBasinn] : [],
			sk: umaSk ? [umaSk] : [],
			totalRuns: totalRuns
		},
		minrun: compareRunData.minrun,
		maxrun: compareRunData.maxrun,
		meanrun: compareRunData.meanrun,
		medianrun: compareRunData.medianrun
	};
}

interface SkillProcDataDialogProps {
	skillId: string;
	compareRunData: any;
	courseDistance: number;
	umaIndex: number;
	displaying?: string;
	onClose: () => void;
}

export function SkillProcDataDialog(props: SkillProcDataDialogProps) {
	const { skillId, compareRunData, courseDistance, umaIndex, displaying = 'meanrun', onClose } = props;
	const dialogRef = useRef<HTMLDivElement>(null);

	const runData = extractSkillRunData(compareRunData, umaIndex);
	if (!runData) {
		return null;
	}

	useEffect(() => {
		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				onClose();
			}
		};
		document.addEventListener('keydown', handleEscape);
		return () => document.removeEventListener('keydown', handleEscape);
	}, [onClose]);

	useEffect(() => {
		if (dialogRef.current) {
			dialogRef.current.focus();
		}
	}, []);

	let effectivenessRate = 0;
	const totalCount = runData?.allruns?.totalRuns || 0;
	let skillProcs = 0;

	const phase2Start = CourseHelpers.phaseStart(courseDistance, 1);
	const phase2End = CourseHelpers.phaseStart(courseDistance, 2);

	if (runData?.allruns?.skBasinn && Array.isArray(runData.allruns.skBasinn)) {
		const allBasinnActivations: Array<[number, number]> = [];
		runData.allruns.skBasinn.forEach((skBasinnMap: any) => {
			if (!skBasinnMap) return;
			let activations = null;
			if (skBasinnMap instanceof Map || (typeof skBasinnMap.has === 'function' && typeof skBasinnMap.get === 'function')) {
				if (skBasinnMap.has(skillId)) {
					activations = skBasinnMap.get(skillId);
				}
			} else if (typeof skBasinnMap === 'object' && skillId in skBasinnMap) {
				activations = skBasinnMap[skillId];
			}
			if (activations && Array.isArray(activations)) {
				activations.forEach((activation: any) => {
					if (Array.isArray(activation) && activation.length === 2 && 
					    typeof activation[0] === 'number' && typeof activation[1] === 'number') {
						allBasinnActivations.push([activation[0], activation[1]]);
					}
				});
			}
		});
		skillProcs = allBasinnActivations.length;
		const positiveCount = allBasinnActivations.filter(([_, basinn]) => basinn > 0).length;
		effectivenessRate = totalCount > 0 ? (positiveCount / totalCount) * 100 : 0;
	}

	return (
		<>
			<div class="skillProcDataOverlay" onClick={onClose} />
			<div class="skillProcDataDialog" ref={dialogRef} tabIndex={-1}>
				<div class="skillProcDataHeader">
					<h3>Skill Proc Data</h3>
					<button class="skillProcDataClose" onClick={onClose}>✕</button>
				</div>
				<div class="skillProcDataContent">
					<div style="margin-bottom: 8px; width: 300px;">
						<div style="font-size: 9px; margin-bottom: 2px; display: flex; align-items: center; gap: 8px;">
							<span>Total samples: {totalCount} ({skillProcs} skill procs)</span>
						</div>
						<div style="font-size: 9px; margin-bottom: 2px;">Effectiveness rate: {effectivenessRate.toFixed(1)}%</div>
						<div style="display: flex; width: 100%; height: 8px; border: 1px solid #ccc; overflow: hidden; margin-bottom: 8px;">
							<div style={`width: ${effectivenessRate}%; background-color: #4caf50; height: 100%;`}></div>
							<div style={`width: ${100 - effectivenessRate}%; background-color: #f44336; height: 100%;`}></div>
						</div>
					</div>
					<div style="display: flex; gap: 20px; align-items: flex-start;">
						<div>
							<LengthDifferenceChart 
								skillId={skillId} 
								runData={runData} 
								courseDistance={courseDistance}
							/>
							<ActivationFrequencyChart 
								skillId={skillId} 
								runData={runData} 
								courseDistance={courseDistance}
							/>
						</div>
						<VelocityChart 
							skillId={skillId} 
							runData={runData}
							courseDistance={courseDistance}
							displaying={displaying}
						/>
					</div>
					<div style="position: absolute; bottom: 0; right: 0; font-size: 9px; font-style: italic; padding: 4px;">
						(yes these graphs are copied from utools &gt;-&lt;)
					</div>
				</div>
			</div>
		</>
	);
}

