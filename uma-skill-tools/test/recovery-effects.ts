import assert from 'node:assert/strict';
import skilldata from '../data/skill_data.json';

import { describeRecoveryEffect, resolveRecoveryModifier } from '../RecoveryEffects';

function createSkillRng(roll: number) {
	return {
		random() {
			return roll;
		}
	};
}

assert.equal(
	resolveRecoveryModifier({type: 9, modifier: -0.2}, createSkillRng(0.95)),
	-0.2,
	'direct negative recovery should stay unchanged'
);

assert.equal(
	resolveRecoveryModifier({type: 9, modifier: -1, valueUsage: 8}, createSkillRng(0.1)),
	0,
	'MultiplyRandom drains should have a 60% no-drain branch'
);
assert.equal(
	resolveRecoveryModifier({type: 9, modifier: -1, valueUsage: 8}, createSkillRng(0.6)),
	-0.02,
	'MultiplyRandom drains should have a 30% 2% drain branch'
);
assert.equal(
	resolveRecoveryModifier({type: 9, modifier: -1, valueUsage: 9}, createSkillRng(0.95)),
	-0.04,
	'MultiplyRandom drains should have a 10% 4% drain branch'
);

assert.equal(
	describeRecoveryEffect({type: 9, modifier: -1, valueUsage: 8}),
	'60% chance to drain nothing, 30% to drain 2%, 10% to drain 4%',
	'MultiplyRandom drains should render the documented split'
);
assert.equal(
	describeRecoveryEffect({type: 9, modifier: -0.2}),
	null,
	'normal drains should not get the MultiplyRandom description'
);

for (const skillId of ['202031', '202032']) {
	const recoveryEffect = skilldata[skillId].alternatives[0].effects.find((effect) => effect.type == 9 && effect.modifier < 0);
	assert.deepEqual(recoveryEffect && {
		valueUsage: recoveryEffect.valueUsage,
		valueLevelUsage: recoveryEffect.valueLevelUsage
	}, {
		valueUsage: 8,
		valueLevelUsage: 1
	}, `${skillId} should preserve MultiplyRandom metadata`);
}

console.log('recovery-effects: ok');
