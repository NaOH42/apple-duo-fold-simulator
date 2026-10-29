import assert from 'node:assert/strict';
import test from 'node:test';
import type { RevoluteImpulseJoint } from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';
import { PHONE, CAMERA, FIXED_DT } from '../src/config';
import { DuoPhysics, HINGE_REFERENCE } from '../src/physics';

test('open body envelope matches the official wide 164.6 by 117.8 mm form', async () => {
  const sim=await DuoPhysics.create();
  sim.world.gravity={x:0,y:0,z:0};
  for(const body of sim.bodies) {const p=body.translation();body.setTranslation({x:p.x,y:p.y+2,z:p.z},true);}
  let joint:RevoluteImpulseJoint;
  sim.world.impulseJoints.forEach(j=>{joint=j as RevoluteImpulseJoint;});
  joint!.configureMotorPosition(HINGE_REFERENCE,.9,.35);
  for(let i=0;i<480;i++)sim.step(FIXED_DT);
  const bounds=bodyEnvelope(sim);
  assert.ok(Math.abs(bounds.x-1.646)<.003,`open width ${bounds.x}`);
  assert.ok(Math.abs(bounds.y-1.178)<.001,`open height ${bounds.y}`);
  assert.ok(bounds.x>bounds.y*1.39,'landscape aspect, not two tall slab phones');
  sim.dispose();
});

test('actual hinge closure reaches the 11.3 mm body thickness without a wedge', async () => {
  const sim=await DuoPhysics.create();sim.world.gravity={x:0,y:0,z:0};
  for(const body of sim.bodies){const p=body.translation();body.setTranslation({x:p.x,y:p.y+2,z:p.z},true);}
  let joint:RevoluteImpulseJoint;
  sim.world.impulseJoints.forEach(j=>{joint=j as RevoluteImpulseJoint;});
  joint!.configureMotorPosition(-Math.PI + HINGE_REFERENCE,.9,.35);
  let angle=180;
  for(let i=0;i<720;i++)angle=sim.step(FIXED_DT).angle;
  const bounds=bodyEnvelope(sim);
  assert.ok(angle<.3,`actual closed angle ${angle}`);
  assert.ok(Math.abs(bounds.z-PHONE.closedThickness)<.003,`actual body thickness ${bounds.z}`);
  assert.ok(Math.abs(bounds.x+PHONE.spineOverhang-PHONE.closedWidth)<.002,`closed silhouette ${bounds.x+PHONE.spineOverhang}`);
  sim.dispose();
});

test('rear camera has a real collider matching its visible protrusion and remains on the body',async()=>{
  const sim=await DuoPhysics.create();
  let found=false;
  sim.world.colliders.forEach(c=>{
    if(c.parent()?.handle!==sim.bodies[0].handle)return;
    const t=c.translationWrtParent();
    if(t && t.z< -PHONE.thickness/2){
      found=true;
      assert.ok(Math.abs(t.y-CAMERA.centerY)<.001);
      assert.ok(CAMERA.centerY+CAMERA.height/2<PHONE.height/2);
    }
  });
  assert.ok(found,'camera no longer sinks below the table');sim.dispose();
});

function bodyEnvelope(sim:DuoPhysics):Vector3 {
  const inverse=sim.poses[0].quaternion.clone().invert();
  const origin=sim.poses[0].position;
  const lo=new Vector3(Infinity,Infinity,Infinity),hi=new Vector3(-Infinity,-Infinity,-Infinity);
  for(const pose of sim.poses)for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1]) {
    const p=new Vector3(x*PHONE.width/2,y*PHONE.height/2,z*PHONE.thickness/2)
      .applyQuaternion(pose.quaternion).add(pose.position).sub(origin).applyQuaternion(inverse);
    lo.min(p);hi.max(p);
  }
  return hi.sub(lo);
}
