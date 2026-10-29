import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { DuoPhysics } from '../src/physics';
import { PHONE, FIXED_DT } from '../src/config';

test('repeated fast inertial closures do not cross an angular branch and eject the phone',async()=>{
  const sim=await DuoPhysics.create();
  for(let i=0;i<60;i++)sim.step(FIXED_DT);
  const local=new Vector3(-PHONE.width*.35,PHONE.height*.22,PHONE.thickness/2);
  const start=local.clone().applyQuaternion(sim.poses[0].quaternion).add(sim.poses[0].position);
  const grip={id:1,half:0 as const,localPoint:local,localNormal:new Vector3(0,0,1),target:start.clone()};
  sim.setGrip(grip);
  let peak=0;
  for(let i=0;i<960;i++) {
    const t=i*FIXED_DT;
    grip.target.set(start.x+Math.sin(t*8)*1.1,start.y+1.1+Math.sin(t*5)*.5,start.z+Math.sin(t*3)*.2);
    if(i===720)sim.releaseAll();
    const sample=sim.step(FIXED_DT);
    peak=Math.max(peak,sample.angularSpeed);
  }
  sim.dispose();
  assert.ok(peak<120,`unphysical relative angular velocity ${peak}`);
});
