import * as THREE from 'three';

// The lantern lives in world space so the imported armature's scale cannot
// scale its light or its pendulum. Its grip follows the actual animated hand.
export function createHandLantern({scene,quality='extreme'}) {
  const root=new THREE.Group();root.name='Hand held warm lantern';root.visible=false;scene.add(root);
  const brass=new THREE.MeshStandardMaterial({color:'#80623f',roughness:.29,metalness:.74});
  const paper=new THREE.MeshPhysicalMaterial({color:'#ffe5ad',roughness:.3,metalness:0,emissive:'#ffb344',emissiveIntensity:2.2,transmission:.12,thickness:.015,side:THREE.DoubleSide});
  const glowMaterial=new THREE.MeshBasicMaterial({color:'#fff1c5',transparent:true,opacity:.9});
  const add=(g,m,x=0,y=0,z=0)=>{const o=new THREE.Mesh(g,m);o.position.set(x,y,z);o.castShadow=m===brass;o.receiveShadow=true;root.add(o);return o;};
  const handle=add(new THREE.TorusGeometry(.115,.013,8,32),brass,0,-.10);handle.scale.y=1.12;
  add(new THREE.CylinderGeometry(.135,.17,.06,12),brass,0,-.255);
  add(new THREE.CylinderGeometry(.17,.18,.34,12,1,true),paper,0,-.44);
  add(new THREE.CylinderGeometry(.19,.14,.07,12),brass,0,-.63);
  add(new THREE.SphereGeometry(.075,16,10),glowMaterial,0,-.45);
  for(let i=0;i<4;i++){const a=i*Math.PI*.5+Math.PI*.25;add(new THREE.CylinderGeometry(.009,.009,.37,5),brass,Math.sin(a)*.175,-.44,Math.cos(a)*.175);}
  const light=new THREE.PointLight('#ffcb72',0,12,1.65);light.position.y=-.44;light.castShadow=quality==='extreme'||quality==='ultra';light.shadow.mapSize.set(512,512);light.shadow.bias=-.001;light.shadow.normalBias=.018;root.add(light);
  let holder=null,hand=null,visibility=0;
  const handPosition=new THREE.Vector3(),up=new THREE.Vector3(0,1,0),swing=new THREE.Quaternion(),handQuaternion=new THREE.Quaternion();
  function bind(character){holder=character;hand=null;character?.traverse(o=>{if(o.isBone&&/^(HandR|Hand_R|RightHand|hand\.R|R_Hand)$/i.test(o.name))hand=o;});if(!hand)character?.traverse(o=>{if(o.isBone&&/hand/i.test(o.name)&&/(right|\.r$|_r$|r$)/i.test(o.name)&&!/finger|thumb|index|middle|ring|pinky/i.test(o.name))hand=o;});return hand?.name||null;}
  function update({time=0,dt=.016,night=0,speed=0,heading=0,reclining=false,enabled=true}={}){
    const target=enabled&&hand&&!reclining?THREE.MathUtils.smoothstep(night,.18,.8):0;visibility=THREE.MathUtils.damp(visibility,target,4,dt);root.visible=visibility>.015;if(!root.visible){light.intensity=0;return;}
    holder.updateWorldMatrix(true,true);hand.getWorldPosition(handPosition);hand.getWorldQuaternion(handQuaternion);
    // A very small grip offset avoids fingers passing through the handle.
    root.position.copy(handPosition).addScaledVector(up,-.025);
    const sway=Math.sin(time*3.2)*Math.min(.16,speed*.025),cross=Math.sin(time*2.4+.8)*.035;
    swing.setFromEuler(new THREE.Euler(cross,heading+.2,sway));root.quaternion.slerp(swing,1-Math.exp(-dt*8));root.scale.setScalar(1);
    const flicker=1+Math.sin(time*12.7)*.035+Math.sin(time*19.3)*.018;light.intensity=19*visibility*flicker;paper.emissiveIntensity=(1.6+night*.9)*flicker;glowMaterial.opacity=.9*visibility;
  }
  function setQuality(id){light.castShadow=id==='extreme'||id==='ultra';light.shadow.needsUpdate=true;}
  return{root,light,bind,update,setQuality,get stats(){return{hand:hand?.name||null,visible:root.visible,intensity:light.intensity};}};
}
