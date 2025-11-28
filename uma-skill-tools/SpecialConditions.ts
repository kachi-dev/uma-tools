import { Strategy } from './HorseTypes';
import { ApproximateMultiCondition, ApproximateStartContinue, ConditionEntry } from './ApproximateConditions';

export function createBlockedSideCondition(): ApproximateMultiCondition {
	const conditions: ConditionEntry[] = [
		{
			condition: new ApproximateStartContinue("Outer lane", 0.0, 0.0),
			predicate: (state: any) => {
				const sim = state.simulation;
				const section = Math.floor(sim.pos / sim.sectionLength);
				return section >= 1 && section <= 3 && sim.currentLane > 3.0 * sim.course.horseLane;
			}
		},
		{
			condition: new ApproximateStartContinue("Early race", 0.1, 0.85),
			predicate: (state: any) => state.simulation.phase === 0
		},
		{
			condition: new ApproximateStartContinue("Mid race", 0.08, 0.75),
			predicate: (state: any) => state.simulation.phase === 1
		},
		{
			condition: new ApproximateStartContinue("Other", 0.07, 0.50),
			predicate: null
		}
	];

	return new ApproximateMultiCondition(
		"blocked_side",
		conditions,
		1
	);
}

export function createOvertakeCondition(): ApproximateMultiCondition {
	const conditions: ConditionEntry[] = [
		{
			condition: new ApproximateStartContinue("逃げ", 0.05, 0.50),
			predicate: (state: any) => {
				return state.simulation.horse.strategy === Strategy.Nige;
			}
		},
		{
			condition: new ApproximateStartContinue("先行", 0.15, 0.55),
			predicate: (state: any) => {
				return state.simulation.horse.strategy === Strategy.Senkou;
			}
		},
		{
			condition: new ApproximateStartContinue("その他", 0.20, 0.60),
			predicate: null
		}
	];

	return new ApproximateMultiCondition(
		"overtake",
		conditions
	);
}

