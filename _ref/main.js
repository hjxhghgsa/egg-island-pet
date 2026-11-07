import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {clone as cloneSkeleton} from 'three/addons/utils/SkeletonUtils.js';
import {createWorld} from './world.js';
import {createUI} from './ui.js';
import {createAtmosphere} from './atmosphere.js';
import {createWaterSystem} from './water.js';
import {createCinematicEffects} from './effects.js';
import {createHandLantern} from './lantern.js';
import {createSurfaceDetail} from './surface-detail.js';
import {createIslandLightShow} from './island-lights.js';
import {setupCharacterRig,setupPetRig,updateRig,setupFishMotion,updateFishMotion} from './animation.js';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {GTAOPass} from 'three/addons/postprocessing/GTAOPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import {ShaderPass} from 'three/addons/postprocessing/ShaderPass.js';
import {FXAAShader} from 'three/addons/shaders/FXAAShader.js';

const canvas=document.querySelector('#game');
const timeLabels={sunrise:'日出',noon:'中午',sunset:'夕阳',blue:'蓝调时间',night:'夜晚'};
const names={cake:'蛋糕纯',jade:'珠玉纯',egg:'蛋仔',rabbit:'高定兔',jasmine:'借你的茉莉',tears:'落泪的繁花',sun:'明年的向日葵'};
const saveKey='egg-island-letter-v1';
let saved={};try{saved=JSON.parse(localStorage.getItem(saveKey)||'{}')}catch{}
const state={started:false,ready:false,character:['cake','jade'].includes(saved.character)?saved.character:'cake',pet:['egg','rabbit'].includes(saved.pet)?saved.pet:'egg',time:timeLabels[saved.time]?saved.time:'sunset',collected:new Set((saved.collected||[]).filter(x=>Number.isInteger(x)&&x>=1&&x<=18)),flowers:{jasmine:6,tears:6,sun:6,...saved.flowers},planted:(saved.planted||[]).slice(0,18),vehicle:'off',eggTarget:0,flightTarget:14,photo:null,music:false,lanternEnabled:saved.lanternEnabled!==false};
state.quality=['mobile','balanced','ultra','extreme'].includes(saved.quality)?saved.quality:matchMedia('(pointer:coarse)').matches?'mobile':'extreme';
const qualityProfiles={mobile:{label:'轻量',ratio:1,ao:false,bloom:.18},balanced:{label:'平衡',ratio:1.2,ao:false,bloom:.23},ultra:{label:'影院',ratio:1.55,ao:true,bloom:.30},extreme:{label:'极致',ratio:2,ao:true,bloom:.35}};
const save=()=>{try{localStorage.setItem(saveKey,JSON.stringify({character:state.character,pet:state.pet,time:state.time,quality:state.quality,lanternEnabled:state.lanternEnabled,collected:[...state.collected],flowers:state.flowers,planted:state.planted}))}catch{}};
let renderer,world,player,pet,eggGroup,eggBase=0,petVisual,playerVisual;
let atmosphere,waters,composer,gtao,bloom,fxaa,cinema,lantern,surfaces,lightShow,shellGroup,pearl,eggSpot,shellPose=0,petSpeed=0,turnSpeed=0;
let photoTracer=null,traceController=null,traceLoading=false,traceEpoch=0,gpuName='正在检测 GPU',fps=0,frameDuration=0,frameCount=0;
const oldPetPos=new THREE.Vector3(),desiredVelocity=new THREE.Vector3();
const landmarkSprites=[];
let cards=[],cardObjects=[],fish=[],models={},mixers=[],nearest=null,photoSaved=null,pendingEggExit=false,previews={};
const keys=new Set(),moveAxis=new THREE.Vector2(),clock=new THREE.Clock();
let yaw=.16,pitch=.43,distance=13,elapsed=0,lastUI=0,drag=null,footTime=0;
const playerPos=new THREE.Vector3(0,4,22),petPos=new THREE.Vector3(1.8,4,24);
const velocity=new THREE.Vector3(),targetCam=new THREE.Vector3(),lookTarget=new THREE.Vector3(),camera=new THREE.PerspectiveCamera(53,innerWidth/innerHeight,.1,3200),scene=new THREE.Scene();
const audio=new Audio('./assets/bgm.mp3');audio.loop=true;audio.volume=.38;audio.preload='none';
const ui=createUI({start,action,open:openPanel,selectCharacter,selectPet,selectTime,plant,viewCard,collect,photo:setPhoto,capture,closePhoto,vehicle:vehicleAction,travel,toggleMusic,setLantern,setQuality,tracePhoto});
function toast(s){ui.showToast(s)}
function fatal(error){console.error(error);const p=document.createElement('div');p.className='fatal-error';p.style.cssText='position:fixed;inset:25%;z-index:999;background:#fff7e5;color:#34483b;padding:40px;border-radius:20px;line-height:2';p.textContent='海风暂时停了一下：'+(error?.message||error)+'。请刷新重试，或用启动游戏.cmd 通过本地服务器打开。';document.body.append(p)}

async function boot(){
  renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,preserveDrawingBuffer:true,powerPreference:'high-performance'});
  renderer.setPixelRatio(qualityProfiles[state.quality].ratio);renderer.setSize(innerWidth,innerHeight);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.08;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.info.autoReset=false;
  const context=renderer.getContext(),debug=context.getExtension('WEBGL_debug_renderer_info');gpuName=debug?context.getParameter(debug.UNMASKED_RENDERER_WEBGL):context.getParameter(context.RENDERER);
  atmosphere=createAtmosphere({THREE,scene,renderer});atmosphere.setCamera(camera);atmosphere.setQuality(state.quality);atmosphere.setTime(state.time);
  ui.progress('正在展开你的小岛 · 真实地形与湖岸',3);
  const terrainLoader=new GLTFLoader();
  const [terrainData,baseTerrain,floatingTerrain]=await Promise.all([
    fetch('./assets/v3/collision-height.json').then(r=>{if(!r.ok)throw new Error('岛屿碰撞数据未能加载');return r.json()}),
    terrainLoader.loadAsync('./assets/v3/island.glb'),terrainLoader.loadAsync('./assets/v3/floating-island.glb')
  ]);
  world=createWorld({THREE,scene,renderer,quality:state.quality,lights:atmosphere.lights,terrainData,baseTerrain:baseTerrain.scene,floatingTerrain:floatingTerrain.scene});world.setTime(state.time);
  state.flightTarget=world.flightBaseHeight??world.flightIsland.position.y;
  waters=createWaterSystem({renderer,scene,camera,world,lights:atmosphere.lights,quality:state.quality});
  setupPostprocessing();
  lightShow=createIslandLightShow({scene,world,camera,renderer,depthTexture:()=>gtao.depthTexture,quality:state.quality});
  const beamPass=new RenderPass(lightShow.beamScene,camera);beamPass.clear=false;composer.insertPass(beamPass,composer.passes.indexOf(bloom));
  player=new THREE.Group();player.name='Island player';scene.add(player);pet=new THREE.Group();pet.name='Floating companion';scene.add(pet);
  const spawn=world.locations.spawn;playerPos.set(spawn.x,world.heightAt(spawn.x,spawn.z),spawn.z);petPos.copy(playerPos).add(new THREE.Vector3(1.8,1.4,1.8));player.position.copy(playerPos);
  lantern=createHandLantern({scene,quality:state.quality});
  if(world.cardPositions)cardPositions.splice(0,cardPositions.length,...world.cardPositions.map(p=>Array.isArray(p)?p:[p.x,p.z]));
  addMarkers();bindInput();animate();
  cards=await (await fetch('./assets/postcards.json')).json();
  const files={cake:'character-cake',jade:'character-jade',eggPet:'pet-egg',rabbit:'pet-rabbit',egg:'egg',shell:'v2/shell-interactive',fish1:'v3/fish-a',fish2:'v3/fish-b',sun:'flower-sun',jasmine:'flower-jasmine',tears:'flower-tears'};
  const loader=new GLTFLoader();let loaded=0;
  // Two concurrent loads avoid a large memory spike on phones.
  const queue=Object.entries(files);
  async function worker(){while(queue.length){const [id,file]=queue.shift();ui.progress('正在迎接 '+(names[id]||({eggPet:'蛋仔',shell:'海边贝壳',fish1:'池塘小鱼',fish2:'池塘小鱼'}[id])||'岛上伙伴'),Math.round(loaded/11*100));const gltf=await loader.loadAsync('./assets/'+file+'.glb');models[id]=gltf;gltf.scene.updateMatrixWorld(true);loaded++;ui.progress('海岛正在醒来',Math.round(loaded/11*100));}}
  await Promise.all([worker(),worker()]);
  ui.progress('Blender 制作的枝叶与岩岸正在抵达',98);
  const scenery={};for(const[key,file]of Object.entries({treeRound:'v3/tree-round',treePalm:'v3/tree-palm',rock:'v2/rock-cluster',grass:'v2/grass-clump'}))scenery[key]=(await loader.loadAsync('./assets/'+file+'.glb')).scene;
  world.attachScenery(scenery);
  surfaces=createSurfaceDetail({world});
  makePreviews();selectCharacter(state.character,true);selectPet(state.pet,true);placeProps();buildPostcards();
  // Old saves keep flower counts, with their plots relocated onto the new map.
  state.planted=state.planted.map((p,i)=>({...p,...plantSpot(i)}));for(const p of state.planted)placeFlower(p);save();
  state.ready=true;ui.ready();updateUI();
  document.dispatchEvent(new Event('island-ready'));
}

function setupPostprocessing(){
  composer=new EffectComposer(renderer);composer.addPass(new RenderPass(scene,camera));
  gtao=new GTAOPass(scene,camera,innerWidth,innerHeight);gtao.blendIntensity=.58;gtao.updateGtaoMaterial({radius:.75,thickness:.6,distanceExponent:1.3,scale:1,samples:16});composer.addPass(gtao);
  const drawGtao=gtao.render.bind(gtao);
  gtao.render=(...args)=>{const hidden=[...landmarkSprites];scene.traverse(o=>{if(o.userData.excludeFromPathTrace||o.userData.ptIgnore)hidden.push(o);});const visible=hidden.map(o=>o.visible);hidden.forEach(o=>o.visible=false);try{return drawGtao(...args)}finally{hidden.forEach((o,i)=>o.visible=visible[i])}};
  cinema=createCinematicEffects({renderer,scene,camera,lights:atmosphere.lights,quality:state.quality,depthTexture:()=>gtao.depthTexture,enableDepth:qualityProfiles[state.quality].ao,styleStrength:.19});
  cinema.passes.forEach(pass=>composer.addPass(pass));
  bloom=new UnrealBloomPass(new THREE.Vector2(innerWidth,innerHeight),.31,.7,.92);composer.addPass(bloom);composer.addPass(new OutputPass());fxaa=new ShaderPass(FXAAShader);composer.addPass(fxaa);applyRenderQuality();
}
function applyRenderQuality(){if(!renderer)return;const q=qualityProfiles[state.quality];renderer.setPixelRatio(q.ratio);renderer.setSize(innerWidth,innerHeight);composer?.setPixelRatio(q.ratio);composer?.setSize(innerWidth,innerHeight);if(gtao){gtao.enabled=q.ao;gtao.setSize(Math.round(innerWidth*q.ratio*.5),Math.round(innerHeight*q.ratio*.5));}if(bloom)bloom.strength=q.bloom;cinema?.setQuality(state.quality);cinema?.setDepthEnabled(q.ao);cinema?.resize();lantern?.setQuality(state.quality);lightShow?.setQuality(state.quality);if(fxaa)fxaa.material.uniforms.resolution.value.set(1/(innerWidth*q.ratio),1/(innerHeight*q.ratio));waters?.resize();}
function setQuality(id){if(!qualityProfiles[id])return;stopTrace();state.quality=id;applyRenderQuality();world?.setQuality(id);atmosphere?.setQuality(id);waters?.setQuality(id);save();ui.setPerformance({quality:id,qualityLabel:qualityProfiles[id].label,gpu:gpuName,grass:world?.stats.totalGrass,renderScale:qualityProfiles[id].ratio,reflection:waters?.stats.reflection+' px 实时反射'});toast('画质已切换为'+qualityProfiles[id].label);if(state.started)openPanel('settings');}

const gradient=new THREE.DataTexture(new Uint8Array([85,145,210,255]),4,1,THREE.RedFormat);gradient.needsUpdate=true;gradient.minFilter=gradient.magFilter=THREE.NearestFilter;
function model(id,height){
  const source=models[id];if(!source)throw Error('模型尚未加载：'+id);
  const object=cloneSkeleton(source.scene),holder=new THREE.Group();holder.add(object);
  object.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;const convert=m=>{const mat=new THREE.MeshPhysicalMaterial({color:m.color?.clone()||new THREE.Color('white'),map:m.map||null,vertexColors:!!o.geometry.attributes.color,transparent:m.transparent,opacity:m.opacity??1,side:m.side,alphaTest:m.alphaTest||0,normalMap:m.normalMap||null,roughness:id==='shell'?.24:.68,metalness:0,clearcoat:id==='shell'?.7:.12,clearcoatRoughness:.3,envMapIntensity:.8});if(m.emissive){mat.emissive.copy(m.emissive);mat.emissiveMap=m.emissiveMap;mat.emissiveIntensity=Math.min(m.emissiveIntensity||0,.3)}if(mat.map){mat.map.anisotropy=8;mat.map.colorSpace=THREE.SRGBColorSpace}return mat;};o.material=Array.isArray(o.material)?o.material.map(convert):convert(o.material);}});
  holder.updateMatrixWorld(true);const box=new THREE.Box3().setFromObject(object),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
  const scale=height/Math.max(size.y,.001);object.scale.multiplyScalar(scale);object.position.add(new THREE.Vector3(-center.x,-box.min.y,-center.z).multiplyScalar(scale));
  if(id==='cake'||id==='jade')setupCharacterRig(holder);
  if(id==='eggPet'||id==='rabbit')setupPetRig(holder,id==='eggPet'?'egg':'rabbit');
  if(source.animations.length){const mixer=new THREE.AnimationMixer(object);const clip=source.animations.find(c=>/walk|run/i.test(c.name))||source.animations[0];mixer.clipAction(clip).play();mixers.push({mixer,id});}
  return holder;
}

function selectCharacter(id,quiet=false){if(!['cake','jade'].includes(id))return;state.character=id;if(playerVisual){player.remove(playerVisual);mixers=mixers.filter(x=>!['cake','jade'].includes(x.id))}playerVisual=model(id,2.6);player.add(playerVisual);lantern?.bind(playerVisual);save();if(!quiet){toast('今天，就以「'+names[id]+'」的样子出发');openPanel('outfit')}}
function selectPet(id,quiet=false){if(!['egg','rabbit'].includes(id))return;state.pet=id;if(petVisual){pet.remove(petVisual);mixers=mixers.filter(x=>!['eggPet','rabbit'].includes(x.id))}petVisual=model(id==='egg'?'eggPet':'rabbit',id==='egg'?1.05:1.35);pet.add(petVisual);save();if(!quiet){toast(names[id]+' 会一直跟着你');openPanel('pet')}}
function selectTime(id){if(!timeLabels[id])return;stopTrace();state.time=id;world.setTime(id);atmosphere.setTime(id);save();toast('把时间，停在'+timeLabels[id]);openPanel('time')}
function makePreviews(){
  const r=new THREE.WebGLRenderer({antialias:true,alpha:true});r.setSize(280,330);r.setPixelRatio(1);r.outputColorSpace=THREE.SRGBColorSpace;r.toneMapping=THREE.ACESFilmicToneMapping;
  const s=new THREE.Scene();s.add(new THREE.HemisphereLight('#fff6e6','#7c946c',2.5));const light=new THREE.DirectionalLight('#fff1cb',2.8);light.position.set(-3,5,4);s.add(light);
  const cam=new THREE.PerspectiveCamera(34,280/330,.1,30);cam.position.set(0,1.6,5);cam.lookAt(0,1.2,0);
  for(const id of ['cake','jade','egg','rabbit']){const o=model(id==='egg'?'eggPet':id,2.4);o.rotation.y=-.2;s.add(o);r.render(s,cam);previews[id]=r.domElement.toDataURL('image/png');s.remove(o);}
  r.dispose();
}
function placeProps(){
  eggGroup=new THREE.Group();const l=world.locations.egg;eggBase=world.heightAt(l.x,l.z);eggGroup.position.set(l.x,eggBase,l.z);eggGroup.add(model('egg',6.8));scene.add(eggGroup);state.eggTarget=eggBase;
  shellGroup=model('shell',6.4);shellGroup.name='Pearl shell resting beach';const s=world.locations.shell;shellGroup.position.set(s.x,world.heightAt(s.x,s.z),s.z);shellGroup.rotation.y=world.getShellAccess?.().heading??-.2;scene.add(shellGroup);
  // Blender separated the supplied pearl from the supplied shell. Move that
  // original surface, so the resting shell never contains a duplicate pearl.
  shellGroup.updateMatrixWorld(true);pearl=shellGroup.getObjectByName('Pearl');
  if(!pearl)throw new Error('珠玉模型缺少独立珍珠节点');scene.attach(pearl);
  pearl.material=new THREE.MeshPhysicalMaterial({color:'#fff7e9',roughness:.13,metalness:.2,clearcoat:1,clearcoatRoughness:.08,iridescence:1,iridescenceIOR:1.35,iridescenceThicknessRange:[150,420]});pearl.castShadow=true;pearl.userData.restY=pearl.position.y;
  eggSpot=new THREE.SpotLight('#c6d6ff',0,85,.48,.75,1.4);eggSpot.position.set(l.x-9,eggBase+18,l.z+7);eggSpot.target=eggGroup;eggSpot.castShadow=true;eggSpot.shadow.mapSize.set(1024,1024);scene.add(eggSpot);
  for(let i=0;i<14;i++){const id=i%2?'fish1':'fish2',f=model(id,.42+(i%3)*.065);f.name='Swimming koi '+i;setupFishMotion(f,id);scene.add(f);const a=i*Math.PI*2/14;f.position.set(world.locations.pond.x+Math.cos(a)*world.pondRadii.x*.5,world.pondLevel-1.1,world.locations.pond.z+Math.sin(a)*world.pondRadii.z*.45);fish.push({group:f,phase:a,radius:.33+(i%5)*.065,speed:.085+(i%4)*.012,heading:a,previous:f.position.clone()});}
}
function makeLabel(text){const c=document.createElement('canvas');c.width=512;c.height=128;const ctx=c.getContext('2d');ctx.font='36px "Microsoft YaHei",sans-serif';ctx.textAlign='center';ctx.fillStyle='#334e43';ctx.fillText(text,256,70);const texture=new THREE.CanvasTexture(c);texture.colorSpace=THREE.SRGBColorSpace;const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,transparent:true,depthWrite:false,opacity:.85}));sprite.scale.set(7,1.75,1);landmarkSprites.push(sprite);return sprite;}
function addMarkers(){for(const [id,label] of [['egg','蛋'],['garden','一小片花田'],['flightDock','去云端'],['shell','珠玉']]){const p=world.locations[id];const o=makeLabel(label);o.position.set(p.x,world.heightAt(p.x,p.z)+(id==='egg'?8.2:4),p.z);scene.add(o);}}

const cardPositions=[[0,16],[-14,19],[15,22],[-30,33],[33,28],[-51,15],[57,12],[-28,2],[24,9],[-21,-18],[22,-24],[-38,-33],[39,-35],[-8,-37],[14,-44],[-47,-9],[-20,48],[47,-13]];
function postcardTexture(n){const c=document.createElement('canvas');c.width=256;c.height=180;const ctx=c.getContext('2d');ctx.fillStyle='#faf0d6';ctx.fillRect(0,0,256,180);ctx.strokeStyle='#9fa78a';ctx.lineWidth=3;ctx.strokeRect(10,10,236,160);ctx.fillStyle='#b6bfa2';ctx.fillRect(193,24,34,39);ctx.strokeStyle='#8f9b82';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(20,35);ctx.lineTo(128,107);ctx.lineTo(236,35);ctx.stroke();ctx.fillStyle='#586d5c';ctx.font='24px Georgia';ctx.fillText(String(n).padStart(2,'0'),25,150);const texture=new THREE.CanvasTexture(c);texture.colorSpace=THREE.SRGBColorSpace;return texture;}
function buildPostcards(){for(let i=0;i<18;i++){const [x,z]=cardPositions[i],id=i+1;if(state.collected.has(id))continue;const group=new THREE.Group();const card=new THREE.Mesh(new THREE.PlaneGeometry(.85,.6),new THREE.MeshBasicMaterial({map:postcardTexture(id),side:THREE.DoubleSide}));card.rotation.z=-.08;group.add(card);const ring=new THREE.Mesh(new THREE.TorusGeometry(.55,.012,4,40),new THREE.MeshBasicMaterial({color:'#fff0b2',transparent:true,opacity:.65}));ring.rotation.x=Math.PI/2;ring.position.y=-.7;group.add(ring);group.position.set(x,world.heightAt(x,z)+1.3,z);scene.add(group);cardObjects.push({id,group,base:group.position.y});}}
function viewCard(id){const card=cards.find(x=>x.id===Number(id));if(card)ui.showPostcard(card,state.collected.has(card.id));}
function collect(id){id=Number(id);if(state.collected.has(id))return;state.collected.add(id);const o=cardObjects.find(x=>x.id===id);if(o){scene.remove(o.group);cardObjects=cardObjects.filter(x=>x!==o)}save();ui.closePanel();toast(state.collected.size===18?'18 封来信，都已经抵达。谢谢你来过这座岛。':'第 '+String(id).padStart(2,'0')+' 封来信，收进背包了');updateUI();}
function openPanel(kind){if(!state.started)return;if(state.photo&&kind!=='photo')closePhoto();const data=kind==='bag'?{collected:cards.filter(x=>state.collected.has(x.id)),flowers:state.flowers,planted:state.planted.length,lanternEnabled:state.lanternEnabled}:kind==='outfit'?{selected:state.character,previews}:kind==='pet'?{selected:state.pet,previews}:kind==='time'?{selected:state.time}:kind==='settings'?{selected:state.quality,quality:state.quality,rendererInfo:gpuName,stats:{fps,grass:world.stats.totalGrass,reflection:waters.stats.reflection+' px',renderScale:qualityProfiles[state.quality].ratio,rayTracing:!!photoTracer}}:{};ui.openPanel(kind,data);keys.clear();}
function plantSpot(i){const p=world.plantSpots?.[i],g=world.locations.garden;return p?{x:p.x,z:p.z}:{x:g.x+(i%6-2.5)*.8,z:g.z+(Math.floor(i/6)-1)*1.1};}
function plant(id){if(!['jasmine','tears','sun'].includes(id))return;const g=world.locations.garden;if(state.vehicle!=='off'||Math.hypot(playerPos.x-g.x,playerPos.z-g.z)>6){toast('到池塘右侧「一小片花田」，就能种下花种');return}if(state.flowers[id]<=0){toast('这一种花已经种完了，试试其他花种');return}if(state.planted.length>=18){toast('花田已经满了，让花儿慢慢开吧');return}const i=state.planted.length,p={id,...plantSpot(i),rotation:i*1.72};state.planted.push(p);state.flowers[id]--;placeFlower(p);save();toast('种下「'+names[id]+'」，把愿望交给风');openPanel('bag');}
function placeFlower(p){const f=model(p.id,p.id==='sun'?1.5:1.05);f.position.set(p.x,world.heightAt(p.x,p.z)+.16,p.z);f.rotation.y=p.rotation;scene.add(f)}

function computeNearest(){let best=null;const offer=(id,p,r,text,data)=>{const d=Math.hypot(playerPos.x-p.x,playerPos.z-p.z);if(d<r&&(!best||d<best.d))best={id,d,text,data}};if(state.vehicle!=='off')return null;for(const c of cardObjects)offer('card',c.group.position,3.2,'幸好我们的心连成一片一片...',c.id);offer('egg',world.getEggAccess?.().entry||world.locations.egg,4.8,'走进蛋');offer('shell',world.getShellAccess?.().entry||world.locations.shell,5.2,'珠玉 · 横躺听海');offer('garden',world.locations.garden,4.8,'打开背包 · 种一朵花');offer('flight',world.locations.flightDock,4.8,'交换 · 登上飞岛');const p=world.locations.pond,dx=playerPos.x-p.x,dz=playerPos.z-p.z,r=Math.hypot(dx/world.pondRadii.x,dz/world.pondRadii.z);if(r>1.03&&r<1.24)offer('pond',{x:p.x+dx/r,z:p.z+dz/r},5.4,'撒下鱼食');return best;}
let feedingUntil=0;

function action(){
  if(!state.started||state.photo||ui.isBlocking())return;nearest=computeNearest();if(!nearest)return;
  if(nearest.id==='card')viewCard(nearest.data);if(nearest.id==='garden')openPanel('bag');
  if(nearest.id==='egg'){state.vehicle='egg';state.eggTarget=eggBase;toast('坐稳啦。点击上升，让海岛慢慢变小');ui.closePanel()}
  if(nearest.id==='flight')travel();
  if(nearest.id==='shell'){state.vehicle='shell';keys.clear();velocity.set(0,0,0);chime();toast('珠玉升起了。躺下来，让海声轻轻经过。');ui.closePanel()}
  if(nearest.id==='pond'){feedingUntil=elapsed+9;toast('鱼群循着水波，向你游来。')}
  updateUI();
}
function vehicleAction(a){
  if(state.vehicle==='shell'){if(a==='exit'){state.vehicle='off';const l=world.getShellAccess?.().exit||world.locations.shell;returnToGround(l);shellPose=0;toast('把这一刻的安静，带回草地。')}return;}
  if(state.vehicle==='flight'){if(a==='exit')travel();return}
  if(state.vehicle!=='egg')return;
  if(a==='up'){state.eggTarget=Math.min(eggBase+58,state.eggTarget+9);pendingEggExit=false}
  if(a==='down')state.eggTarget=Math.max(eggBase,state.eggTarget-9);
  if(a==='exit'){state.eggTarget=eggBase;pendingEggExit=true;if(eggGroup.position.y>eggBase+.3)toast('正在降落，落地后就可以离开')}
}
function travel(){
  const f=world.locations.flight,d=world.locations.flightDock;
  if(state.vehicle==='flight'){state.vehicle='off';state.flightTarget=world.flightBaseHeight??14;returnToGround(d);yaw=.2;distance=13;toast('回到蛋岛，海风还是熟悉的味道')}
  else{if(state.vehicle!=='off')return;state.vehicle='flight';state.flightTarget=(world.flightBaseHeight??14)+78;const landing=world.getFlightSpawn?.()||{x:f.x,y:flightHeight(f.x,f.z),z:f.z};playerPos.set(landing.x,landing.y+.02,landing.z);petPos.copy(playerPos).add(new THREE.Vector3(1,1.4,1));velocity.set(0,0,0);yaw=.4;distance=19;toast('飞岛开始上升。下一站，云海之上。')}
  ui.closePanel();updateUI();
}
function returnToGround(point){let p=point;if(!world.canWalk(p.x,p.z)){p=world.closestSafePoint?.(p.x,p.z)||world.locations.spawn;}playerPos.set(p.x,world.heightAt(p.x,p.z),p.z);petPos.copy(playerPos).add(new THREE.Vector3(1,1.4,1));velocity.set(0,0,0);keys.clear();player.rotation.set(0,player.rotation.y,0);}
function flightHeight(x,z){return world.flightHeightAt?world.flightHeightAt(x,z):(world.flightIsland.position.y+(world.flightWalkHeight??0)+.08);}

function setLantern(enabled){state.lanternEnabled=!!enabled;save();toast(enabled?'已取出手提灯，夜色中会为你亮起':'已收起手提灯');openPanel('bag');}
function toggleMusic(){if(state.music){audio.pause();state.music=false}else{audio.play().then(()=>{state.music=true;updateUI()}).catch(()=>toast('轻触音乐按钮，即可播放背景音乐'))}updateUI()}
function chime(){try{const context=new(window.AudioContext||window.webkitAudioContext)();[523.25,659.25,783.99].forEach((f,i)=>{const o=context.createOscillator(),g=context.createGain();o.type='sine';o.frequency.value=f;o.connect(g);g.connect(context.destination);g.gain.setValueAtTime(0,context.currentTime+i*.2);g.gain.linearRampToValueAtTime(.04,context.currentTime+i*.2+.05);g.gain.exponentialRampToValueAtTime(.001,context.currentTime+i*.2+1.3);o.start(context.currentTime+i*.2);o.stop(context.currentTime+i*.2+1.4)});setTimeout(()=>context.close(),2400)}catch{}}
function start(){if(!state.ready)return;state.started=true;ui.setStarted();canvas.focus();toggleMusic();toast('WASD 行走 · 拖动鼠标环顾 · 靠近来信后按 E 拾取');updateUI()}


function stopTrace(){traceEpoch++;traceController?.abort();traceController=null;photoTracer?.dispose();photoTracer=null;traceLoading=false;ui.setPerformance({rayTracing:false,traceSamples:0,traceStatus:''});}
function setPhoto(mode){
  stopTrace();if(!state.photo){photoSaved={yaw,pitch,distance};ui.closePanel()}
  state.photo=mode;keys.clear();
  if(mode==='selfie'){yaw=player.rotation.y;distance=5.5;pitch=.15}else{yaw=.44;distance=305;pitch=.23}
  toast(mode==='selfie'?'转动镜头，和伙伴留一张合影':'滚轮调整远近，收藏这一刻的蛋岛');
}
async function tracePhoto(){
  if(!state.photo||traceLoading||photoTracer)return;
  const epoch=++traceEpoch;traceController=new AbortController();traceLoading=true;keys.clear();
  ui.setPerformance({rayTracing:'loading',traceStatus:'正在冻结此刻、建立光线加速结构…'});
  try{
    const {createPhotoPathTracer}=await import('./pathtracing.js');
    atmosphere.refreshEnvironment();scene.updateMatrixWorld(true);
    const photoEnvironment=atmosphere.capturePathTraceEnvironment(1024);
    const tracer=await createPhotoPathTracer({renderer,scene,camera,ptMeshes:waters.pathTraceMeshes(),environment:photoEnvironment,signal:traceController.signal,maxGrassInstances:60000,maxSamples:128,time:elapsed,onProgress:p=>{if(epoch!==traceEpoch)return;const sampled=p.stage==='sampling',n=Math.floor(p.samples||0);ui.setPerformance({rayTracing:['ready','compiling','sampling','rendering'].includes(p.stage)?'active':'loading',traceSamples:p.samples||0,traceStatus:sampled?(n>=128?'128 次采样已完成，可以保存照片':'光线采样 '+n+' / 128 · 镜头已静止'):(p.message||'正在计算真实光线路径…')});}});
    if(epoch!==traceEpoch){tracer.dispose();return}photoTracer=tracer;traceLoading=false;ui.setPerformance({rayTracing:'active',traceStatus:'静止镜头，光线正在慢慢汇聚。'});
  }catch(error){if(epoch!==traceEpoch)return;traceLoading=false;photoTracer=null;console.warn('Path tracing photo failed:',error);ui.setPerformance({rayTracing:false,traceStatus:'此设备暂未完成光追初始化，已恢复实时取景。'});toast('光追初始化未完成，实时反射拍照仍可使用。');}
}
function closePhoto(){stopTrace();state.photo=null;if(photoSaved){({yaw,pitch,distance}=photoSaved);photoSaved=null}ui.endPhoto?.({silent:true});ui.closePanel();}
function capture(){
  if(!state.photo)return;if(traceLoading){toast('光追正在准备，稍候即可拍摄。');return}
  if(!photoTracer){waters.renderRefraction();composer.render()}
  const c=document.createElement('canvas');c.width=canvas.width;c.height=canvas.height;const ctx=c.getContext('2d');ctx.drawImage(canvas,0,0);const scale=c.width/1600;
  ctx.fillStyle='rgba(255,249,230,.9)';ctx.font=`${Math.max(15,24*scale)}px Georgia,serif`;ctx.fillText('欢迎来到蛋岛 / EGG ISLAND',36*scale,c.height-38*scale);ctx.textAlign='right';ctx.font=`${Math.max(12,16*scale)}px sans-serif`;ctx.fillText(timeLabels[state.time]+' · '+new Date().toLocaleDateString('zh-CN')+(photoTracer?' · PATH TRACED':''),c.width-36*scale,c.height-38*scale);
  c.toBlob(blob=>{if(!blob){toast('照片保存失败，请重试');return}const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='欢迎来到蛋岛-'+(photoTracer?'光追':state.photo==='selfie'?'自拍':'全景')+'-'+Date.now()+'.png';link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);toast('咔嚓，这一刻的海风已经保存');},'image/png');
}

function bindInput(){
  addEventListener('resize',()=>{if(photoTracer||traceLoading)stopTrace();camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();applyRenderQuality();});
  canvas.addEventListener('contextmenu',e=>e.preventDefault());
  canvas.addEventListener('pointerdown',e=>{if(!state.started)return;drag={id:e.pointerId,x:e.clientX,y:e.clientY};canvas.setPointerCapture(e.pointerId);canvas.focus()});
  canvas.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId||traceLoading||photoTracer)return;yaw-=(e.clientX-drag.x)*.006;pitch=Math.max(-.08,Math.min(1.15,pitch+(e.clientY-drag.y)*.004));drag.x=e.clientX;drag.y=e.clientY});
  canvas.addEventListener('pointerup',()=>drag=null);canvas.addEventListener('pointercancel',()=>drag=null);
  canvas.addEventListener('wheel',e=>{e.preventDefault();if(photoTracer||traceLoading)return;distance=THREE.MathUtils.clamp(distance+e.deltaY*.02,state.photo?3.5:5,state.photo?450:28)},{passive:false});
  addEventListener('keydown',e=>{if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))return;if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code))e.preventDefault();if(e.code==='Escape'){if(state.photo)closePhoto();else ui.closePanel();return}if(ui.isBlocking())return;keys.add(e.code);if(e.repeat)return;if(e.code==='KeyE')action();if(e.code==='KeyB')openPanel('bag');if(e.code==='KeyC')openPanel('photo');if(e.code==='KeyT')openPanel('time');});
  addEventListener('keyup',e=>keys.delete(e.code));addEventListener('blur',()=>{keys.clear();moveAxis.set(0,0)});document.addEventListener('visibilitychange',()=>{if(document.hidden){keys.clear();moveAxis.set(0,0)}});
  const joy=document.querySelector('#joystick');if(joy){let pointer=null;const update=e=>{const r=joy.getBoundingClientRect(),dx=e.clientX-r.x-r.width/2,dy=e.clientY-r.y-r.height/2,l=Math.max(1,Math.hypot(dx,dy)/35);moveAxis.set(dx/l/35,dy/l/35);joy.querySelector('.knob')?.style.setProperty('transform',`translate(${dx/l}px,${dy/l}px)`)};joy.addEventListener('pointerdown',e=>{pointer=e.pointerId;joy.setPointerCapture(pointer);update(e)});joy.addEventListener('pointermove',e=>{if(e.pointerId===pointer)update(e)});const end=()=>{pointer=null;moveAxis.set(0,0);joy.querySelector('.knob')?.style.setProperty('transform','translate(0,0)')};joy.addEventListener('pointerup',end);joy.addEventListener('pointercancel',end);}
  // The transparent right-hand touch zone uses the same orbit gesture as the canvas.
  const lookzone=document.querySelector('#lookzone');if(lookzone){let touch=null;lookzone.addEventListener('pointerdown',e=>{touch={id:e.pointerId,x:e.clientX,y:e.clientY};lookzone.setPointerCapture(e.pointerId)});lookzone.addEventListener('pointermove',e=>{if(touch?.id!==e.pointerId)return;yaw-=(e.clientX-touch.x)*.006;pitch=THREE.MathUtils.clamp(pitch+(e.clientY-touch.y)*.004,-.08,1.15);touch.x=e.clientX;touch.y=e.clientY});lookzone.addEventListener('pointerup',()=>touch=null);lookzone.addEventListener('pointercancel',()=>touch=null);}
}

function updatePlayer(dt){
  const oldYaw=player.rotation.y;oldPetPos.copy(petPos);
  if(state.vehicle==='egg'){playerPos.set(eggGroup.position.x,eggGroup.position.y+.3,eggGroup.position.z);velocity.set(0,0,0)}
  else if(state.vehicle==='shell'){
    shellPose=THREE.MathUtils.damp(shellPose,1,2.4,dt);const h=shellGroup.rotation.y;
    const longAxis=new THREE.Vector3(Math.cos(h),0,-Math.sin(h)),up=new THREE.Vector3(0,1,0),side=new THREE.Vector3().crossVectors(longAxis,up);
    const bed=shellGroup.position.clone().add(new THREE.Vector3(Math.sin(h)*1.15,1.35,Math.cos(h)*1.15));
    playerPos.copy(bed).addScaledVector(longAxis,-1.3);
    const target=new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(side,longAxis,up));player.quaternion.slerp(target,1-Math.exp(-dt*4));velocity.set(0,0,0);
  }
  else if(state.started&&!state.photo&&!ui.isBlocking()){
    let x=(keys.has('KeyD')||keys.has('ArrowRight')?1:0)-(keys.has('KeyA')||keys.has('ArrowLeft')?1:0)+moveAxis.x,z=(keys.has('KeyS')||keys.has('ArrowDown')?1:0)-(keys.has('KeyW')||keys.has('ArrowUp')?1:0)+moveAxis.y;
    const len=Math.hypot(x,z);if(len>1){x/=len;z/=len}const speed=keys.has('ShiftLeft')?8.2:4.5;
    desiredVelocity.set((x*Math.cos(yaw)+z*Math.sin(yaw))*speed,0,(-x*Math.sin(yaw)+z*Math.cos(yaw))*speed);velocity.lerp(desiredVelocity,1-Math.exp(-dt*(len>.03?9:14)));
    const f=world.locations.flight,valid=(px,pz)=>state.vehicle==='flight'?(world.canWalkFlight?.(px,pz)??Math.hypot(px-f.x,pz-f.z)<(world.flightRadius??8.2)-1):world.canWalk(px,pz)&&Math.abs(world.heightAt(px,pz)-playerPos.y)<1.1;
    const nx=playerPos.x+velocity.x*dt,nz=playerPos.z+velocity.z*dt;if(valid(nx,playerPos.z))playerPos.x=nx;else velocity.x=0;if(valid(playerPos.x,nz))playerPos.z=nz;else velocity.z=0;
    if(velocity.lengthSq()>.01){const a=Math.atan2(velocity.x,velocity.z);player.rotation.y+=Math.atan2(Math.sin(a-player.rotation.y),Math.cos(a-player.rotation.y))*Math.min(1,dt*10);}
  }else velocity.multiplyScalar(Math.exp(-dt*16));
  if(state.vehicle==='flight')playerPos.y=flightHeight(playerPos.x,playerPos.z);else if(state.vehicle==='off')playerPos.y=world.heightAt(playerPos.x,playerPos.z);
  if(state.vehicle!=='shell'){player.rotation.x=0;player.rotation.z=0;}
  player.position.copy(playerPos);turnSpeed=Math.atan2(Math.sin(player.rotation.y-oldYaw),Math.cos(player.rotation.y-oldYaw))/Math.max(dt,.001);
  const night=atmosphere.getNightFactor();
  if(playerVisual){playerVisual.position.y=0;playerVisual.rotation.z=0;updateRig(playerVisual,{time:elapsed,dt,speed:state.vehicle==='shell'?0:velocity.length(),turn:turnSpeed,groundHeight:playerPos.y,heightAt:world.heightAt,groundNormal:state.vehicle==='off'?world.normalAt(playerPos.x,playerPos.z):null,lantern:state.lanternEnabled!==false&&night>.25&&state.vehicle!=='shell',reclining:state.vehicle==='shell'});}
  const follow=playerPos.clone().add(new THREE.Vector3(Math.sin(player.rotation.y+2.6)*2.5,1.45,Math.cos(player.rotation.y+2.6)*2.5));
  if(state.vehicle==='egg'){follow.copy(playerPos).add(new THREE.Vector3(1.8,1.7,.4));}
  if(state.vehicle==='shell'){follow.set(shellGroup.position.x+4,shellGroup.position.y+1.7,shellGroup.position.z);}
  if(state.vehicle==='off'||state.vehicle==='shell')follow.y=Math.max(follow.y,world.heightAt(follow.x,follow.z)+1.2);
  follow.y+=Math.sin(elapsed*1.65+.7)*.18;
  const gap=petPos.distanceTo(follow);petPos.lerp(follow,1-Math.exp(-dt*(gap>5?3.8:2.6)));
  petSpeed=Math.hypot(petPos.x-oldPetPos.x,petPos.z-oldPetPos.z)/Math.max(.001,dt);pet.position.copy(petPos);
  const angle=Math.atan2(playerPos.x-petPos.x,playerPos.z-petPos.z),old=pet.rotation.y;pet.rotation.y+=Math.atan2(Math.sin(angle-old),Math.cos(angle-old))*Math.min(1,dt*6);
  pet.rotation.z=THREE.MathUtils.damp(pet.rotation.z,Math.sin(elapsed*1.1)*.035+THREE.MathUtils.clamp((pet.rotation.y-old)*.25,-.13,.13),3,dt);
  if(petVisual){petVisual.position.y=0;updateRig(petVisual,{time:elapsed,dt,speed:petSpeed,turn:(pet.rotation.y-old)/Math.max(.001,dt),groundHeight:petPos.y,floating:true});}
  lantern?.update({time:elapsed,dt,night,enabled:state.lanternEnabled!==false,speed:velocity.length(),heading:player.rotation.y,reclining:state.vehicle==='shell'});
}
function updateUI(){if(!world)return;const g=world.locations.garden,s=world.locations.shell;ui.update({count:state.collected.size,timeLabel:timeLabels[state.time],location:state.vehicle==='flight'?'云海之上':state.vehicle==='egg'?'蛋':state.vehicle==='shell'?'珠玉':world.pondDistance(playerPos.x,playerPos.z)<1.5?'镜湖边':Math.hypot(playerPos.x-s.x,playerPos.z-s.z)<18?'珠玉海岸':Math.hypot(playerPos.x-g.x,playerPos.z-g.z)<12?'花信草地':'蛋岛 · 慢慢走',interaction:nearest?.text||'',vehicle:state.vehicle,altitude:state.vehicle==='egg'?Math.round(eggGroup.position.y-eggBase):Math.round(world.flightIsland.position.y-(world.flightBaseHeight??0)),music:state.music});}
function clearCameraSight(origin,desired){
  const end=desired.clone(),point=new THREE.Vector3();let lastClear=1;
  for(let i=1;i<=32;i++){const t=i/32;point.lerpVectors(origin,end,t);if(world.heightAt(point.x,point.z)+.45>point.y){lastClear=Math.max(.1,(i-1)/32);break;}}
  if(lastClear<1)desired.lerpVectors(origin,end,lastClear);
}
function animate(){
  requestAnimationFrame(animate);renderer.info.reset();const raw=clock.getDelta(),dt=Math.min(raw,.05);frameDuration+=raw;frameCount++;
  if(frameDuration>1){fps=frameCount/frameDuration;frameDuration=0;frameCount=0;ui.setPerformance({fps,gpu:gpuName,quality:state.quality,qualityLabel:qualityProfiles[state.quality].label,grass:world.stats.totalGrass,reflection:waters.stats.reflection+' px 实时反射',renderScale:qualityProfiles[state.quality].ratio,rayTracing:traceLoading?'loading':photoTracer?'active':false,traceSamples:photoTracer?.samples||0});}
  if(photoTracer){try{photoTracer.render()}catch(error){console.warn(error);stopTrace();toast('已恢复实时取景。')}return;}
  if(traceLoading){composer.render();return;}
  elapsed+=dt;surfaces?.update(elapsed);atmosphere.update(elapsed,dt);world.setNightFactor(atmosphere.getNightFactor());world.update(elapsed,dt,playerPos);
  world.flightIsland.position.y=THREE.MathUtils.damp(world.flightIsland.position.y,state.flightTarget,.16,dt);
  if(eggGroup){eggGroup.position.y=THREE.MathUtils.damp(eggGroup.position.y,state.eggTarget,.7,dt);eggGroup.rotation.y=Math.sin(elapsed*.2)*.04;eggSpot.intensity=atmosphere.getNightFactor()*380;eggSpot.position.y=eggGroup.position.y+18;if(pendingEggExit&&Math.abs(eggGroup.position.y-eggBase)<.2){pendingEggExit=false;state.vehicle='off';returnToGround(world.getEggAccess?.().exit||world.locations.spawn);toast('着陆了，继续去蛋岛上走走吧')}}
  updatePlayer(dt);
  if(pearl){const rest=pearl.userData.restY;const target=state.vehicle==='shell'?rest+3.4:rest;pearl.position.y=THREE.MathUtils.damp(pearl.position.y,target,1.8,dt);pearl.rotation.y=elapsed*.16;}
  for(const c of cardObjects){c.group.position.y=c.base+Math.sin(elapsed*1.5+c.id)*.13;c.group.rotation.y=elapsed*.28+c.id*.4;}
  for(const f of fish){
    const a=elapsed*f.speed+f.phase,r=f.radius*(feedingUntil>elapsed?.65:1),p=world.locations.pond;
    const x=p.x+Math.cos(a)*world.pondRadii.x*r+Math.sin(a*2.3+f.phase)*.4,z=p.z+Math.sin(a)*world.pondRadii.z*r+Math.sin(elapsed*.17+f.phase*2)*.45;
    const bottom=world.heightAt(x,z),depth=1.0+Math.sin(a*1.7+f.phase)*.26;
    f.previous.copy(f.group.position);f.group.position.set(x,Math.min(world.pondLevel-.37,Math.max(bottom+.32,world.pondLevel-depth)),z);
    const heading=Math.atan2(f.group.position.x-f.previous.x,f.group.position.z-f.previous.z),turn=Math.atan2(Math.sin(heading-f.heading),Math.cos(heading-f.heading));f.heading+=turn*Math.min(1,dt*3);f.group.rotation.y=f.heading;f.group.rotation.z=Math.sin(elapsed*.8+f.phase)*.05;
    updateFishMotion(f.group,{time:elapsed+f.phase,speed:.8+f.speed*2,turn:turn/Math.max(.001,dt)});
  }
  for(const m of mixers)m.mixer.update(dt);
  if(!state.started){const overview=world.cameraOverview;targetCam.copy(overview?.position||new THREE.Vector3(168,112,205));lookTarget.copy(overview?.target||new THREE.Vector3(6,10,-7));camera.position.lerp(targetCam,1-Math.exp(-dt*2));}
  else{
    lookTarget.copy(playerPos).add(new THREE.Vector3(0,state.photo==='panorama'?2:1.7,0));
    if(state.photo==='panorama'&&state.vehicle==='off')lookTarget.copy(world.cameraOverview?.target||new THREE.Vector3(5,10,0));
    if(state.vehicle==='shell'&&!state.photo)lookTarget.copy(playerPos).add(new THREE.Vector3(0,1,-.6));
    const horizontal=Math.cos(pitch)*distance;targetCam.set(lookTarget.x+Math.sin(yaw)*horizontal,lookTarget.y+Math.sin(pitch)*distance,lookTarget.z+Math.cos(yaw)*horizontal);
    if(state.vehicle==='off'&&distance<30){targetCam.y=Math.max(targetCam.y,world.heightAt(targetCam.x,targetCam.z)+1.1);clearCameraSight(lookTarget,targetCam);}camera.position.lerp(targetCam,1-Math.exp(-dt*7));
  }
  camera.lookAt(lookTarget);camera.updateMatrixWorld();atmosphere.setCamera(camera);waters.update(elapsed,dt,atmosphere.getNightFactor());lightShow.update(elapsed,atmosphere.getNightFactor());cinema.update({time:elapsed,dt,focusPoint:lookTarget,nightFactor:atmosphere.getNightFactor(),enableDepth:gtao.enabled});waters.renderRefraction();composer.render();
  if(elapsed-lastUI>.16){nearest=computeNearest();updateUI();lastUI=elapsed;}
}

// A small API also makes the standalone build easy to embed in an existing H5 page.
export const game={state,ready:()=>state.ready,start,selectCharacter,selectPet,selectTime,setLantern,plant,action,collect,travel,vehicleAction,setPhoto,closePhoto,capture,openPanel,closePanel:()=>ui.closePanel(),position:()=>playerPos.clone(),world:()=>world,teleport(x,z){if(world.canWalk(x,z)){playerPos.set(x,world.heightAt(x,z),z);petPos.copy(playerPos);return true}return false},setQuality,tracePhoto,cardLocations:()=>cardPositions,scene:()=>scene,camera:()=>camera,metrics:()=>({fps,gpu:gpuName,quality:state.quality,grass:world.stats.totalGrass,reflection:waters.stats.reflection,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,models:Object.keys(models),cards:cards.length,night:atmosphere.getNightFactor(),traceSamples:photoTracer?.samples||0,traceLoading,cinema:cinema?.stats,lantern:lantern?.stats,sky:atmosphere.getNightSkyStats?.(),terrain:world.stats.terrainSource,mapBounds:world.bounds,fish:fish.length,lightShow:lightShow?.stats,water:waters?.stats,flight:world.flightDetails?.stats})};
boot().catch(fatal);



