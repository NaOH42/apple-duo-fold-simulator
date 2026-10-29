import test from 'node:test';
import assert from 'node:assert/strict';
import type { RevoluteImpulseJoint } from '@dimforge/rapier3d-compat';
import { DuoPhysics, HINGE_REFERENCE } from '../src/physics';
import { GameRules } from '../src/rules';
import { FIXED_DT } from '../src/config';

test('100 complete gentle cycles through the actual constrained hinge remain undamaged', async () => {
  const sim = await DuoPhysics.create();
  // Isolate the hinge from table impacts. The entire assembly is relocated once before motion.
  sim.world.gravity = {x:0,y:0,z:0};
  for (const body of sim.bodies) { const p=body.translation(); body.setTranslation({x:p.x,y:p.y+2,z:p.z},true); }
  let hinge: RevoluteImpulseJoint;
  sim.world.impulseJoints.forEach(j => { hinge = j as RevoluteImpulseJoint; });
  const rules = new GameRules(); rules.reset('challenge');
  let peakSpeed = 0;
  const drive = (target:number) => {
    hinge!.configureMotorPosition(target + HINGE_REFERENCE, .9, .35);
    let last = 0;
    for(let i=0;i<360;i++) {
      const sample = sim.step(FIXED_DT); rules.step(sample,FIXED_DT);
      peakSpeed=Math.max(peakSpeed,sample.angularSpeed); last=sample.angle;
    }
    return last;
  };
  drive(0);
  for(let cycle=0;cycle<100;cycle++) {
    const closed=drive(-Math.PI+.09); const opened=drive(0);
    assert.ok(closed<=25,`cycle ${cycle}: closed ${closed}`);
    assert.ok(opened>=155,`cycle ${cycle}: opened ${opened}`);
  }
  assert.equal(rules.state.folds,100);
  assert.equal(rules.state.screen,100); assert.equal(rules.state.hinge,100);
  assert.ok(peakSpeed<12); sim.dispose();
});
