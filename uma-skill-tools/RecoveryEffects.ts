import type { PRNG } from './Random';

export type RecoveryEffectLike = {
	type: number
	modifier: number
	valueUsage?: number
	valueLevelUsage?: number
};

const RecoverySkillType = 9;
// valueUsage 8/9 uses the game's MultiplyRandom branch instead of applying the raw recovery modifier directly.
const MultiplyRandomRecoveryFactors = Object.freeze({
	low: 0.02,
	high: 0.04
});

export function isMultiplyRandomRecoveryEffect(effect: RecoveryEffectLike) {
	return effect.type == RecoverySkillType && (effect.valueUsage == 8 || effect.valueUsage == 9);
}

function formatRecoveryPercent(modifier: number) {
	const percent = Math.abs(modifier) * 100;
	const rounded = Number.isInteger(percent) ? percent.toString() : percent.toFixed(2);
	return `${rounded.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')}%`;
}

export function describeRecoveryEffect(effect: RecoveryEffectLike): string | null {
	if (!isMultiplyRandomRecoveryEffect(effect)) {
		return null;
	}

	const verb = effect.modifier < 0 ? 'drain' : 'recover';
	return [
		`60% chance to ${verb} nothing`,
		`30% to ${verb} ${formatRecoveryPercent(effect.modifier * MultiplyRandomRecoveryFactors.low)}`,
		`10% to ${verb} ${formatRecoveryPercent(effect.modifier * MultiplyRandomRecoveryFactors.high)}`
	].join(', ');
}

export function resolveRecoveryModifier(effect: RecoveryEffectLike, skillRng: Pick<PRNG, 'random'>): number {
	if (!isMultiplyRandomRecoveryEffect(effect)) {
		return effect.modifier;
	}

	const roll = skillRng.random();
	if (roll < 0.6) {
		return 0;
	}
	if (roll < 0.9) {
		return effect.modifier * MultiplyRandomRecoveryFactors.low;
	}
	return effect.modifier * MultiplyRandomRecoveryFactors.high;
}
