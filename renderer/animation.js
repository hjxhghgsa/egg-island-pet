import * as THREE from '../vendor/three/three.module.js';

// All motion stays inside the supplied visual. Its parent owns translation and yaw.
const TAU=Math.PI*2;
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const damp=(a,b,k,dt)=>a+(b-a)*(1-Math.exp(-k*dt));
const normalizedName=name=>name.replace(/[:_\s]/g,'').toLowerCase();
const q=new THREE.Quaternion(),q2=new THREE.Quaternion();
const ease=t=>t*t*(3-2*t);

function findBones(root){
  const bones=[];root.traverse(o=>{if(o.isBone)bones.push(o)});
  return {bones,find:(...names)=>bones.find(b=>names.some(n=>normalizedName(b.name).endsWith(normalizedName(n))))};
}
function point(root,bone){return root.worldToLocal(bone.getWorldPosition(new THREE.Vector3()))}
function axisInBone(root,bone,axis){
  return axis.clone().applyQuaternion(root.getWorldQuaternion(new THREE.Quaternion()))
    .applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
}
function lowerArms(root,find,pet=false){
  for(const [armNames,foreNames] of [
    [['LeftArm','LUpperarm'],['LeftForeArm','LForearm']],
    [['RightArm','RUpperarm'],['RightForeArm','RForearm']]
  ]){
    const arm=find(...armNames),fore=find(...foreNames);if(!arm||!fore)continue;
    root.updateWorldMatrix(true,true);
    const direction=fore.getWorldPosition(new THREE.Vector3()).sub(arm.getWorldPosition(new THREE.Vector3())).normalize();
    const localDirection=direction.clone().applyQuaternion(root.getWorldQuaternion(new THREE.Quaternion()).invert());
    // Keep a little room between the plush arm and body, avoiding cloth intersections.
    const target=new THREE.Vector3(localDirection.x*(pet?.34:.21),-1,localDirection.z*.15).normalize()
      .applyQuaternion(root.getWorldQuaternion(new THREE.Quaternion()));
    const old=arm.getWorldQuaternion(new THREE.Quaternion());
    arm.quaternion.copy(arm.parent.getWorldQuaternion(new THREE.Quaternion()).invert()
      .multiply(new THREE.Quaternion().setFromUnitVectors(direction,target)).multiply(old));
  }
  root.updateWorldMatrix(true,true);
}
function setup(root,kind,id){
  if(root.userData.islandRig)return root.userData.islandRig;
  const {bones,find}=findBones(root);lowerArms(root,find,kind==='pet');
  root.updateWorldMatrix(true,true);
  const box=new THREE.Box3().setFromObject(root),height=Math.max(.1,box.max.y-box.min.y);
  const rig={kind,id,bones,find,height,phase:0,blend:0,speed:0,turn:0,time:0,floatBlend:0,lanternBlend:0,reclineBlend:0,
    joints:new Map(),legs:[],arms:[],hips:find('Hips','Pelvis'),chest:find('Spine2','Spine02','Spine1'),head:find('Head'),ears:[],
    previousOrigin:root.getWorldPosition(new THREE.Vector3()),previousQuaternion:root.getWorldQuaternion(new THREE.Quaternion())};
  const record=(name,...aliases)=>{
    const bone=find(name,...aliases);if(!bone)return null;
    if(!rig.joints.has(bone))rig.joints.set(bone,{bone,base:bone.quaternion.clone(),position:bone.position.clone(),
      x:axisInBone(root,bone,new THREE.Vector3(1,0,0)),y:axisInBone(root,bone,new THREE.Vector3(0,1,0)),z:axisInBone(root,bone,new THREE.Vector3(0,0,1))});
    return bone;
  };
  for(const side of ['Left','Right']){
    const short=side==='Left'?'L':'R';
    const upper=record(side+'UpLeg',short+'Thigh'),lower=record(side+'Leg',short+'Calf'),foot=record(side+'Foot',short+'Foot');
    const arm=record(side+'Arm',short+'Upperarm'),fore=record(side+'ForeArm',short+'Forearm'),hand=record(side+'Hand',short+'Hand');
    record(side+'Shoulder',short+'Clavicle');
    if(arm&&fore&&hand){
      const a=arm.getWorldPosition(new THREE.Vector3()),b=fore.getWorldPosition(new THREE.Vector3()),c=hand.getWorldPosition(new THREE.Vector3());
      rig.arms.push({upper:arm,lower:fore,hand,side,length1:a.distanceTo(b),length2:b.distanceTo(c),
        handRootQ:root.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(hand.getWorldQuaternion(new THREE.Quaternion()))});
      for(const finger of ['Index','Middle','Ring','Pinky','Thumb'])for(let i=1;i<=3;i++)record(side+'Hand'+finger+i);
    }
    if(upper&&lower&&foot){
      const a=upper.getWorldPosition(new THREE.Vector3()),b=lower.getWorldPosition(new THREE.Vector3()),c=foot.getWorldPosition(new THREE.Vector3());
      rig.legs.push({upper,lower,foot,side,rest:point(root,foot),length1:a.distanceTo(b),length2:b.distanceTo(c),
        soleOffset:clamp(c.y-box.min.y,0,height*.16),plantWorld:null,plantQ:null,wasStance:false,
        footRootQ:root.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(foot.getWorldQuaternion(new THREE.Quaternion()))});
    }
  }
  for(const bone of [rig.hips,rig.chest,rig.head,find('Neck','NeckTwist01')])if(bone)record(bone.name);
  for(const name of ['IslandEarLeft','IslandEarRight','IslandEarTipLeft','IslandEarTipRight']){const bone=record(name);if(bone)rig.ears.push(bone)}
  rig.legLength=rig.legs.length?rig.legs.reduce((s,l)=>s+l.length1+l.length2,0)/rig.legs.length:height*.3;
  rig.baseStride=Math.max(height*.30,rig.legLength*1.9);rig.stride=rig.baseStride;
  root.userData.islandRig=rig;
  return rig;
}
export function setupCharacterRig(root){return setup(root,'character','avatar')}
export function setupPetRig(root,id='egg'){return setup(root,'pet',id)}

// Lantern geometry should have its handle/grip at its own origin and hang in -Y.
// The returned metric scale cancels the original GLB's normalization scale.
export function getLanternMount(root,side='right'){
  const rig=root?.userData.islandRig;if(!rig)return null;
  const prefix=/left/i.test(side)?'Left':'Right',bone=rig.find(prefix+'Hand',prefix==='Left'?'LHand':'RHand');if(!bone)return null;
  root.updateWorldMatrix(true,true);
  const finger=rig.find(prefix+'HandMiddle1',prefix+'HandIndex1');
  const position=finger?bone.worldToLocal(finger.getWorldPosition(new THREE.Vector3())).multiplyScalar(.62):new THREE.Vector3();
  const worldScale=bone.getWorldScale(new THREE.Vector3());
  return {bone,position,scale:new THREE.Vector3(1/Math.max(Math.abs(worldScale.x),1e-6),1/Math.max(Math.abs(worldScale.y),1e-6),1/Math.max(Math.abs(worldScale.z),1e-6)),side:prefix.toLowerCase()};
}

function rotate(rig,bone,axis,angle){
  const data=rig.joints.get(bone);if(data&&Math.abs(angle)>1e-8)bone.quaternion.multiply(q.setFromAxisAngle(data[axis],angle));
}
function aimBone(bone,child,target){
  const origin=bone.getWorldPosition(new THREE.Vector3());
  const oldDirection=child.getWorldPosition(new THREE.Vector3()).sub(origin).normalize();
  const newDirection=target.clone().sub(origin).normalize();
  if(!Number.isFinite(newDirection.x)||newDirection.lengthSq()<.1)return;
  const worldQ=bone.getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.copy(bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert()
    .multiply(new THREE.Quaternion().setFromUnitVectors(oldDirection,newDirection)).multiply(worldQ));
  bone.updateWorldMatrix(false,true);
}
function solveLeg(root,rig,leg,target,footRoll=0,footOrientation=null,groundNormal=null){
  const hip=leg.upper.getWorldPosition(new THREE.Vector3());
  const direction=target.clone().sub(hip),distance=clamp(direction.length(),Math.abs(leg.length1-leg.length2)+.0001,leg.length1+leg.length2-.0001);direction.normalize();
  const projected=hip.clone().addScaledVector(direction,distance);
  const along=(leg.length1**2-leg.length2**2+distance**2)/(2*distance);
  const rise=Math.sqrt(Math.max(0,leg.length1**2-along**2));
  const forward=new THREE.Vector3(0,0,1).applyQuaternion(root.getWorldQuaternion(new THREE.Quaternion()));
  const bend=forward.addScaledVector(direction,-forward.dot(direction));if(bend.lengthSq()<.0001)bend.set(1,0,0);bend.normalize();
  const knee=hip.clone().addScaledVector(direction,along).addScaledVector(bend,rise);
  aimBone(leg.upper,leg.lower,knee);aimBone(leg.lower,leg.foot,projected);
  const rootQ=root.getWorldQuaternion(new THREE.Quaternion());
  const desired=footOrientation?footOrientation.clone():rootQ.clone().multiply(leg.footRootQ);
  if(groundNormal?.isVector3&&groundNormal.lengthSq()>.1){
    const up=new THREE.Vector3(0,1,0).applyQuaternion(rootQ),normal=groundNormal.clone().normalize();
    const tilt=up.angleTo(normal);if(tilt>.45)normal.lerp(up,1-.45/tilt).normalize();
    desired.premultiply(q2.setFromUnitVectors(up,normal));
  }
  if(footRoll)desired.premultiply(q2.setFromAxisAngle(new THREE.Vector3(1,0,0).applyQuaternion(rootQ),footRoll));
  leg.foot.quaternion.copy(leg.foot.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(desired));
  leg.foot.updateWorldMatrix(false,true);
}

function poseLanternArm(root,rig,arm,weight){
  if(weight<.001)return;
  const saved=[arm.upper,arm.lower,arm.hand].map(b=>b.quaternion.clone());
  const shoulder=point(root,arm.upper),side=Math.sign(shoulder.x)||(arm.side==='Left'?1:-1),length=arm.length1+arm.length2;
  const localTarget=shoulder.clone().add(new THREE.Vector3(side*rig.height*.055,-length*.53,rig.height*.16));
  localTarget.y+=Math.sin(rig.time*1.65)*rig.height*.003;
  const hip=arm.upper.getWorldPosition(new THREE.Vector3()),target=localTarget.applyMatrix4(root.matrixWorld),direction=target.clone().sub(hip);
  const distance=clamp(direction.length(),Math.abs(arm.length1-arm.length2)+.0001,length-.0001);direction.normalize();
  const along=(arm.length1**2-arm.length2**2+distance**2)/(2*distance),rise=Math.sqrt(Math.max(0,arm.length1**2-along**2));
  const pole=new THREE.Vector3(side,-.12,-.32).applyQuaternion(root.getWorldQuaternion(new THREE.Quaternion()));
  pole.addScaledVector(direction,-pole.dot(direction)).normalize();
  const elbow=hip.clone().addScaledVector(direction,along).addScaledVector(pole,rise),hand=hip.clone().addScaledVector(direction,distance);
  aimBone(arm.upper,arm.lower,elbow);aimBone(arm.lower,arm.hand,hand);
  const desired=root.getWorldQuaternion(new THREE.Quaternion()).multiply(arm.handRootQ);
  arm.hand.quaternion.copy(arm.hand.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(desired));
  [arm.upper,arm.lower,arm.hand].forEach((bone,i)=>{const held=bone.quaternion.clone();bone.quaternion.copy(saved[i]).slerp(held,weight)});
  // A small palmward curl grips a handle without forcing the tiny chibi fingers into a fist.
  for(const finger of ['Index','Middle','Ring','Pinky'])for(let i=1;i<=3;i++)rotate(rig,rig.find(arm.side+'Hand'+finger+i),'z',-side*[.22,.31,.25][i-1]*weight);
}
function groundSample(sample,x,z,fallback,normalFallback){
  const value=typeof sample==='function'?sample(x,z):fallback;
  if(Number.isFinite(value))return {height:value,normal:normalFallback?.isVector3?normalFallback:null};
  if(value&&Number.isFinite(value.height??value.y))return {height:value.height??value.y,normal:value.normal?.isVector3?value.normal:null};
  return {height:null,normal:null};
}

// Optional V3 parameters are additive: old speed/turn/groundHeight calls still work.
// groundAt(x,z) may return a height or {height,normal}; lantern accepts a boolean,
// a 0..1 night factor, or {weight,side,mount}; floating accepts boolean or 0..1.
export function updateRig(root,{time,dt=1/60,speed=0,turn=0,groundHeight,groundAt,heightAt,sampleGround,groundNormal,floating=false,lantern=false,lanternSide='right',reclining=false}={}){
  const rig=root?.userData.islandRig;if(!rig)return;
  dt=clamp(Number.isFinite(dt)?dt:1/60,0,.08);rig.time=Number.isFinite(time)?time:rig.time+dt;
  rig.speed=damp(rig.speed,clamp(Math.abs(speed),0,12),10,dt);rig.turn=damp(rig.turn,clamp(turn,-3,3),7,dt);
  const reclineTarget=typeof reclining==='number'?clamp(reclining):reclining?1:0;
  const floatTarget=(typeof floating==='number'?clamp(floating):floating?1:0)*(1-reclineTarget);
  const lamp=lantern&&typeof lantern==='object'?lantern:null;
  const lampTarget=(rig.kind==='character'?(lamp?lamp.enabled===false?0:clamp(lamp.weight??lamp.strength??1):typeof lantern==='number'?clamp(lantern):lantern?1:0):0)*(1-reclineTarget);
  rig.floatBlend=damp(rig.floatBlend,floatTarget,5,dt);rig.lanternBlend=damp(rig.lanternBlend,lampTarget,6,dt);rig.reclineBlend=damp(rig.reclineBlend,reclineTarget,6,dt);
  rig.blend=damp(rig.blend,clamp(rig.speed/.65)*(1-floatTarget)*(1-reclineTarget),9,dt);
  const run=clamp((rig.speed-3.7)/3);rig.stride=damp(rig.stride,rig.baseStride*(1+run*.32),6,dt);
  // Distance-based phase: during stance the foot travels backward at body speed.
  rig.phase=(rig.phase+rig.speed*dt/rig.stride*TAU)%TAU;
  for(const joint of rig.joints.values()){joint.bone.quaternion.copy(joint.base);joint.bone.position.copy(joint.position)}
  root.updateWorldMatrix(true,true);
  const origin=root.getWorldPosition(new THREE.Vector3()),rootQ=root.getWorldQuaternion(new THREE.Quaternion());
  const teleported=origin.distanceTo(rig.previousOrigin)>rig.height*1.1||rootQ.angleTo(rig.previousQuaternion)>1.0||dt>.07;
  const t=rig.time,phase=rig.phase,walk=rig.blend*(1-rig.floatBlend)*(1-rig.reclineBlend),float=rig.floatBlend,recline=rig.reclineBlend,pet=rig.kind==='pet',rabbit=pet&&/rabbit/i.test(rig.id),breath=Math.sin(t*1.8);
  const heldSide=/left/i.test(lamp?.side??lanternSide)?'Left':'Right';
  if(rig.hips){
    root.updateWorldMatrix(true,true);
    const hip=rig.hips.getWorldPosition(new THREE.Vector3());
    const bounce=rabbit?Math.max(0,Math.sin(phase))*.034*rig.height*walk:Math.cos(phase*2)*.006*rig.height*walk;
    const shift=new THREE.Vector3(Math.sin(phase)*.008*rig.height*walk,
      -rig.legLength*.065*walk+bounce+breath*.0018*rig.height+Math.sin(t*1.35)*rig.height*.008*float,0);
    shift.applyMatrix4(root.matrixWorld).sub(root.getWorldPosition(new THREE.Vector3()));
    rig.hips.position.copy(rig.hips.parent.worldToLocal(hip.add(shift)));
    rotate(rig,rig.hips,'z',Math.sin(phase)*.014*walk-rig.turn*.014+Math.sin(t*.9)*.018*float);
    rotate(rig,rig.hips,'y',Math.sin(phase)*.035*walk);
  }
  if(rig.chest){rotate(rig,rig.chest,'x',.010*breath+(.023+.040*run)*walk-.035*float);rotate(rig,rig.chest,'y',-Math.sin(phase)*.025*walk);rotate(rig,rig.chest,'z',-rig.turn*.022)}
  if(rig.head){rotate(rig,rig.head,'y',Math.sin(t*.63)*.020*(1-walk)+rig.turn*.026);rotate(rig,rig.head,'x',Math.sin(t*1.8+.5)*.008+(rabbit?Math.sin(phase-.35)*.022*walk:0)+Math.sin(t*1.1)*.015*float)}
  for(const side of ['Left','Right']){
    const short=side==='Left'?'L':'R',offset=side==='Left'?0:Math.PI,swing=Math.cos(phase+offset),held=side===heldSide?rig.lanternBlend:0;
    const arm=rig.find(side+'Arm',short+'Upperarm'),fore=rig.find(side+'ForeArm',short+'Forearm'),shoulder=rig.find(side+'Shoulder',short+'Clavicle');
    rotate(rig,arm,'x',swing*(pet?.20:.27+.10*run)*walk*(1-held*.85)+breath*.007);
    rotate(rig,arm,'z',(side==='Left'?1:-1)*(.25+Math.sin(t*1.4+offset)*.035)*float);
    rotate(rig,fore,'x',-.045-(Math.max(0,-swing)*.10+.07*run)*walk-.10*float);
    rotate(rig,shoulder,'z',(side==='Left'?1:-1)*breath*.008);
  }
  for(const ear of rig.ears){const sign=/Right/.test(ear.name)?-1:1,tip=/Tip/.test(ear.name);rotate(rig,ear,'z',sign*(Math.sin(t*1.35+(tip?.5:0))*.017+Math.sin(phase-.6-(tip?.2:0))*.040*walk+Math.sin(t*1.6-(tip?.45:0))*.024*float));rotate(rig,ear,'x',Math.sin(t*.85+sign)*.012+Math.sin(phase-.8)*.023*walk)}
  root.updateWorldMatrix(true,true);
  for(const arm of rig.arms)if(arm.side===heldSide)poseLanternArm(root,rig,arm,rig.lanternBlend);
  if(recline>.001)for(const arm of rig.arms){
    const side=Math.sign(point(root,arm.upper).x)||(arm.side==='Left'?1:-1);
    for(const [bone,pitch,spread] of [[arm.upper,.025,side*.10],[arm.lower,-.12,0],[arm.hand,-.035,0]]){
      const data=rig.joints.get(bone);if(!data)continue;
      const relaxed=data.base.clone().multiply(new THREE.Quaternion().setFromAxisAngle(data.x,pitch)).multiply(new THREE.Quaternion().setFromAxisAngle(data.z,spread));
      bone.quaternion.slerp(relaxed,recline);
    }
  }
  root.updateWorldMatrix(true,true);
  for(const leg of rig.legs){
    if(recline>.1){
      // The parent lays the whole avatar along the shell. Relax knees in its
      // own body frame; a world-Y floor constraint would twist those legs down.
      for(const [bone,angle] of [[leg.upper,-.10],[leg.lower,.18],[leg.foot,-.065]]){
        const data=rig.joints.get(bone);bone.quaternion.slerp(data.base.clone().multiply(new THREE.Quaternion().setFromAxisAngle(data.x,angle)),recline);
      }
      leg.plantWorld=null;leg.plantQ=null;leg.wasStance=false;continue;
    }
    let u=((phase+(leg.side==='Right'?(rabbit?.12:Math.PI):0))/TAU)%1;
    const stance=pet&&rabbit?.57:.62;let z,lift=0,toe=0;
    if(u<stance){z=rig.stride*(stance*.5-u);toe=-.10*(1-clamp(u/.13))+.17*clamp((u-stance+.14)/.14);}
    else {const f=(u-stance)/(1-stance);z=rig.stride*stance*(-.5+ease(f));lift=Math.sin(Math.PI*f)*rig.height*(pet?.038:.055+.012*run);toe=-Math.sin(Math.PI*f)*.08;}
    const local=leg.rest.clone();local.z+=z*walk;local.y+=lift*walk;
    local.y+=rig.legLength*(.15+Math.sin(t*1.25+(leg.side==='Left'?0:Math.PI))*.025)*float;
    local.z+=rig.legLength*.11*float;local.x+=Math.sign(local.x)*rig.height*.012*float;
    let target=local.applyMatrix4(root.matrixWorld),footQ=null;
    const planted=u<stance&&walk>.16&&float<.1;
    if(teleported||!planted){leg.plantWorld=null;leg.plantQ=null;}
    if(planted){
      if(!leg.wasStance||!leg.plantWorld){leg.plantWorld=target.clone();leg.plantQ=rootQ.clone().multiply(leg.footRootQ);}
      // A stance foot stays at its world contact while the avatar moves and turns.
      const hip=leg.upper.getWorldPosition(new THREE.Vector3());
      if(hip.distanceTo(leg.plantWorld)<(leg.length1+leg.length2)*1.04){target.copy(leg.plantWorld);footQ=leg.plantQ;}
      else {leg.plantWorld=target.clone();leg.plantQ=rootQ.clone().multiply(leg.footRootQ);}
    }
    const ground=groundSample(groundAt??heightAt??sampleGround,target.x,target.z,groundHeight,groundNormal);
    if(float<.1&&ground.height!==null&&Math.abs(ground.height-origin.y)<rig.height*.65)target.y=ground.height+leg.soleOffset+(planted?0:lift*walk);
    solveLeg(root,rig,leg,target,toe*walk+.07*float,footQ,ground.normal);
    leg.wasStance=planted;
  }
  root.updateWorldMatrix(true,true);
  if(lamp?.mount?.isObject3D&&lamp.mount.parent){
    const mount=lamp.mount,parentQ=mount.parent.getWorldQuaternion(new THREE.Quaternion());
    const sway=new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(phase)*.025*walk,0,-rig.turn*.025+Math.sin(t*1.2)*.008));
    mount.quaternion.copy(parentQ.invert().multiply(rootQ).multiply(sway));
    const scale=mount.parent.getWorldScale(new THREE.Vector3());mount.scale.set(1/Math.max(Math.abs(scale.x),1e-6),1/Math.max(Math.abs(scale.y),1e-6),1/Math.max(Math.abs(scale.z),1e-6));
  }
  rig.previousOrigin.copy(origin);rig.previousQuaternion.copy(rootQ);return rig;
}

function fishShader(material,uniforms,key){
  const previous=material.onBeforeCompile;const previousKey=material.customProgramCacheKey.bind(material);
  material.onBeforeCompile=function(shader,renderer){
    previous.call(this,shader,renderer);Object.assign(shader.uniforms,uniforms);
    const header=`uniform float islandFishTime,islandFishSpeed,islandFishTurn,islandFishLength,islandFishTailSign;
uniform vec3 islandFishAxis,islandFishSide,islandFishCenter;
float islandFishU(vec3 p){return clamp(dot(p-islandFishCenter,islandFishAxis)*islandFishTailSign/islandFishLength+.5,0.,1.);}
float islandFishOffset(float x){float p=x*7.-islandFishTime;float effort=.026+min(islandFishSpeed,4.)*.006;return islandFishLength*(sin(p)*(.04+.96*x*x)*effort-islandFishTurn*.010*x*x);}
float islandFishSlope(float x){float p=x*7.-islandFishTime;float effort=.026+min(islandFishSpeed,4.)*.006;return islandFishTailSign*(effort*(1.92*x*sin(p)+7.*(.04+.96*x*x)*cos(p))-islandFishTurn*.020*x);}
`;
    shader.vertexShader=header+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\ntransformed += islandFishSide*islandFishOffset(islandFishU(position));');
    shader.vertexShader=shader.vertexShader.replace('#include <beginnormal_vertex>','#include <beginnormal_vertex>\nobjectNormal=normalize(objectNormal-islandFishAxis*dot(objectNormal,islandFishSide)*islandFishSlope(islandFishU(position)));');
  };
  material.customProgramCacheKey=()=>previousKey()+'-island-fish-wave-v3-'+key;material.needsUpdate=true;
}
export function setupFishMotion(root,id='fish'){
  if(root.userData.islandFishMotion)return root.userData.islandFishMotion;
  const {find}=findBones(root),motion={id,bones:[],uniforms:[],speed:0,turn:0,phase:0,lastTime:null,
    seed:[...String(id)].reduce((s,c)=>s+c.charCodeAt(0)*.017,0)};root.updateWorldMatrix(true,true);
  // V3 koi export five actual deform bones. Keep the head steady and let the
  // wave travel back through the body into a wider, delayed caudal-fin stroke.
  for(let i=0;i<4;i++){const bone=find('Spine'+i);if(bone)motion.bones.push({bone,base:bone.quaternion.clone(),axis:axisInBone(root,bone,new THREE.Vector3(0,1,0)),amount:[.012,.029,.052,.078][i],phase:i*.73})}
  const tail=find('Tail0');if(tail)motion.bones.push({bone:tail,base:tail.quaternion.clone(),axis:axisInBone(root,tail,new THREE.Vector3(0,1,0)),amount:.205,phase:3.05});
  // Rigged fish deform through their true skeleton; the unrigged fish gets a
  // longitudinal body wave with the normal transformed by the same derivative.
  if(!motion.bones.length)root.traverse(mesh=>{
    if(!mesh.isMesh)return;const geo=mesh.geometry;if(!geo.boundingBox)geo.computeBoundingBox();const box=geo.boundingBox,size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
    const long=size.x>=size.z?'x':'z',side=long==='x'?'z':'x',length=Math.max(size[long],.001),axis=new THREE.Vector3(),lateral=new THREE.Vector3();axis[long]=1;lateral[side]=1;
    const positions=geo.attributes.position;const bands=[[],[]];for(let i=0;i<positions.count;i++){const a=positions.getComponent(i,long==='x'?0:2),b=positions.getComponent(i,side==='x'?0:2);if(a<box.min[long]+length*.23)bands[0].push(b);if(a>box.max[long]-length*.23)bands[1].push(b)}
    const variance=a=>{if(!a.length)return 0;const mean=a.reduce((s,x)=>s+x,0)/a.length;return a.reduce((s,x)=>s+(x-mean)**2,0)/a.length};const tailSign=variance(bands[0])<variance(bands[1])?-1:1;
    const uniforms={islandFishTime:{value:0},islandFishSpeed:{value:1},islandFishTurn:{value:0},islandFishLength:{value:length},islandFishTailSign:{value:tailSign},islandFishAxis:{value:axis},islandFishSide:{value:lateral},islandFishCenter:{value:center}};
    const clone=mat=>{const m=mat.clone();fishShader(m,uniforms,long);return m};mesh.material=Array.isArray(mesh.material)?mesh.material.map(clone):clone(mesh.material);
    const depth=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking});fishShader(depth,uniforms,long+'-depth');mesh.customDepthMaterial=depth;
    const distance=new THREE.MeshDistanceMaterial();fishShader(distance,uniforms,long+'-distance');mesh.customDistanceMaterial=distance;mesh.frustumCulled=false;motion.uniforms.push(uniforms);
  });
  root.userData.islandFishMotion=motion;return motion;
}
export function updateFishMotion(root,{time=0,speed=1,turn=0,dt}={}){
  const motion=root?.userData.islandFishMotion;if(!motion)return;
  time=Number.isFinite(time)?time:0;
  const step=clamp(Number.isFinite(dt)?dt:motion.lastTime===null?1/60:time-motion.lastTime,.001,.08);
  motion.speed=damp(motion.speed,clamp(Math.abs(speed),0,8),3.8,step);motion.turn=damp(motion.turn,clamp(turn,-3,3),5.2,step);
  const frequency=1.05+motion.speed*.17,coast=.72+.28*ease(.5+.5*Math.sin(time*.73+motion.seed));
  if(motion.lastTime===null||time<motion.lastTime)motion.phase=time*TAU*frequency+motion.seed;
  else motion.phase=(motion.phase+step*TAU*frequency)%TAU;
  const activity=(.56+clamp(motion.speed/3)*.44)*coast;
  for(const joint of motion.bones){const angle=Math.sin(motion.phase-joint.phase)*joint.amount*activity+motion.turn*joint.amount*.14;joint.bone.quaternion.copy(joint.base).multiply(q.setFromAxisAngle(joint.axis,angle));}
  for(const u of motion.uniforms){u.islandFishTime.value=motion.phase;u.islandFishSpeed.value=motion.speed*coast;u.islandFishTurn.value=motion.turn;}
  motion.lastTime=time;return motion;
}
