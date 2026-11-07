import * as THREE from 'three';
import {Water} from 'three/addons/objects/Water.js';

// Two true planar reflection cameras, a color/depth refraction pass, and
// wavelength-dependent absorption. All textures are generated locally.
export function createWaterSystem({renderer,scene,camera,world,lights,quality='ultra'}){
  const presets={mobile:{reflection:384,refraction:384,interval:4,segments:128},balanced:{reflection:768,refraction:640,interval:2,segments:256},ultra:{reflection:1024,refraction:960,interval:2,segments:512},extreme:{reflection:2048,refraction:1440,interval:1,segments:768}};
  let qualityId=presets[quality]?quality:'ultra',q=presets[qualityId],frame=0,night=0,time=0;
  const oceanSegments=q.segments,oceanWidth=2600,spacing=oceanWidth/oceanSegments;
  const waves=[
    {direction:[1,.32],wavelength:30,amplitude:.18,steepness:.065,phase:0},
    {direction:[-.34,.94],wavelength:17,amplitude:.08,steepness:.045,phase:1.7},
    {direction:[.75,-.66],wavelength:8,amplitude:.035,steepness:.025,phase:3.4}
  ].map(w=>{const length=Math.hypot(...w.direction),k=Math.PI*2/w.wavelength;return{...w,x:w.direction[0]/length,z:w.direction[1]/length,k,omega:Math.sqrt(9.81*k)};});
  // Sum(q*k*A) = .135 < 1, so the horizontal Jacobian cannot fold.
  // Coarser startup meshes omit wavelengths below their Nyquist limit; the
  // animated normal texture still provides small surface ripples in all modes.
  const resolvedWaves=waves.filter(w=>w.wavelength>2.01*spacing);
  const glslNumber=value=>Number(value).toFixed(8);
  const oceanWaveCalls=resolvedWaves.map(w=>`addGerstner(offset,tangent,binormal,w.xz,vec2(${glslNumber(w.x)},${glslNumber(w.z)}),${glslNumber(w.wavelength)},${glslNumber(w.amplitude)},${glslNumber(w.steepness)},${glslNumber(w.phase)});`).join('\n');
  function oceanDisplacement(x,z,t,target){target.set(0,0,0);for(const w of resolvedWaves){const phase=w.k*(w.x*x+w.z*z)-w.omega*t+w.phase,horizontal=w.steepness/w.k*Math.cos(phase);target.x+=w.x*horizontal;target.y+=w.amplitude*Math.sin(phase);target.z+=w.z*horizontal;}return target;}
  function pondDisplacement(x,z,t){return .018*(Math.sin(x*.24+z*.16-t*.75)+.48*Math.sin(x*.41-z*.3+t*1.13)+.2*Math.sin(x*.87+z*.54-t*1.6));}
  const size=new THREE.Vector2(),surfaces=[],sunDirection=new THREE.Vector3(-1,1,-1).normalize();
  const declaredPond=world.pond?.position||world.pondCenter||{};
  const pondCenter=new THREE.Vector3(declaredPond.x??0,declaredPond.y??world.pondLevel??world.pond?.waterLevel??0,declaredPond.z??0);
  const pondRadii=world.pondRadii||{x:world.pond?.radiusX??9,z:world.pond?.radiusZ??7};
  // Water.js is a custom shader: Three's ordinary SpotLight list does not
  // illuminate it. Share actual scene light cones with the pond shader rather
  // than painting an emissive tint over the whole lake.
  const pondLightLimit=12,pondLightPositions=Array.from({length:pondLightLimit},()=>new THREE.Vector3()),pondLightDirections=Array.from({length:pondLightLimit},()=>new THREE.Vector3(0,-1,0)),pondLightColors=Array.from({length:pondLightLimit},()=>new THREE.Color(0,0,0)),pondLightParameters=Array.from({length:pondLightLimit},()=>new THREE.Vector4());
  const pondShoreRoot=new THREE.Group();pondShoreRoot.name='Soft colored lake illumination';scene.add(pondShoreRoot);
  const pondShoreLights=[],pondShorePalette=['#79d9c4','#8cbcff','#d3a9e8'].map(c=>new THREE.Color(c));
  for(let i=0;i<3;i++){const light=new THREE.SpotLight(pondShorePalette[i],0,72,.72,.88,2);light.name='Lake shore spotlight '+i;light.castShadow=false;pondShoreRoot.add(light,light.target);pondShoreLights.push(light);}
  const pondLightCandidates=[],pondLightSamples=Array.from({length:9},(_,i)=>{const a=(i-1)/8*Math.PI*2,r=i===0?0:.72;return new THREE.Vector3(pondCenter.x+Math.cos(a)*pondRadii.x*r,pondCenter.y,pondCenter.z+Math.sin(a)*pondRadii.z*r);});
  const pondLightPosition=new THREE.Vector3(),pondLightTarget=new THREE.Vector3(),pondLightDelta=new THREE.Vector3();let pondLightScan=-Infinity,activePondLights=0;
  function syncPondLightUniforms(){
    if(time-pondLightScan>1||time<pondLightScan){pondLightScan=time;pondLightCandidates.length=0;scene.traverse(o=>{if(o.isSpotLight)pondLightCandidates.push({light:o,score:0});});}
    for(const candidate of pondLightCandidates){const light=candidate.light;candidate.score=0;if(light.intensity<=.001||!light.visible)continue;let ancestor=light.parent,visible=true;while(ancestor){if(!ancestor.visible){visible=false;break;}ancestor=ancestor.parent;}if(!visible)continue;
      light.getWorldPosition(pondLightPosition);light.target.getWorldPosition(pondLightTarget);pondLightTarget.sub(pondLightPosition).normalize();const outer=Math.cos(light.angle),inner=Math.cos(light.angle*(1-light.penumbra)),range=light.distance||1e6;
      for(const sample of pondLightSamples){pondLightDelta.subVectors(sample,pondLightPosition);const distance=pondLightDelta.length();if(distance>=range)continue;const angle=pondLightDelta.multiplyScalar(1/Math.max(distance,.001)).dot(pondLightTarget),cone=THREE.MathUtils.smoothstep(angle,outer,Math.max(inner,outer+.00001)),cutoff=Math.pow(Math.max(0,1-Math.pow(distance/range,4)),2);candidate.score+=cone*light.intensity*cutoff/Math.max(1,Math.pow(distance,light.decay));}
    }
    pondLightCandidates.sort((a,b)=>b.score-a.score);activePondLights=0;
    for(let i=0;i<pondLightLimit;i++){const candidate=pondLightCandidates[i];if(night<=.001||!candidate||candidate.score<=.00001){pondLightColors[i].setRGB(0,0,0);continue;}const light=candidate.light;light.getWorldPosition(pondLightPositions[i]);light.target.getWorldPosition(pondLightDirections[i]);pondLightDirections[i].sub(pondLightPositions[i]).normalize();pondLightColors[i].copy(light.color).multiplyScalar(light.intensity);pondLightParameters[i].set(Math.cos(light.angle),Math.cos(light.angle*(1-light.penumbra)),light.distance||1e6,light.decay);activePondLights++;}
  }
  const normalMap=makeNormals();normalMap.wrapS=normalMap.wrapT=THREE.RepeatWrapping;normalMap.minFilter=THREE.LinearMipmapLinearFilter;normalMap.generateMipmaps=true;normalMap.needsUpdate=true;
  const refraction=new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter});
  refraction.depthTexture=new THREE.DepthTexture(1,1,THREE.UnsignedIntType);
  refraction.texture.name='Underwater color and shoreline refraction';
  let ocean,pond;
  const common={uScene:{value:refraction.texture},uDepth:{value:refraction.depthTexture},uResolution:{value:new THREE.Vector2()},uNear:{value:camera.near},uFar:{value:camera.far},uNight:{value:0},uPond:{value:0},uPondCenter:{value:new THREE.Vector2(pondCenter.x,pondCenter.z)}};
  function buildSurface(isPond){
    const geometry=isPond?new THREE.CircleGeometry(1,128):new THREE.PlaneGeometry(oceanWidth,oceanWidth,oceanSegments,oceanSegments);
    const water=new Water(geometry,{textureWidth:isPond?Math.min(q.reflection,1024):q.reflection,textureHeight:isPond?Math.min(q.reflection,1024):q.reflection,waterNormals:normalMap,sunDirection,sunColor:'#ffe6bc',waterColor:isPond?'#268d89':'#236e8d',distortionScale:isPond?.7:1.35,alpha:1,fog:true});
    const reflectionTarget=water.getRenderTarget();reflectionTarget.texture.generateMipmaps=true;reflectionTarget.texture.minFilter=THREE.LinearMipmapLinearFilter;reflectionTarget.texture.magFilter=THREE.LinearFilter;reflectionTarget.texture.anisotropy=Math.min(8,renderer.capabilities?.getMaxAnisotropy?.()||1);
    water.name=isPond?'Mirror pond · refraction and caustics':'Ocean · Gerstner and Fresnel';
    water.rotation.x=-Math.PI/2;water.position.y=0;
    if(isPond){water.scale.set(pondRadii.x,pondRadii.z,1);water.position.copy(pondCenter);}
    water.userData.isWater=true;water.userData.pathTraceWater=true;water.userData.ior=1.333;water.renderOrder=3;water.receiveShadow=true;
    if(!isPond)water.userData.gerstner={segments:oceanSegments,waves:resolvedWaves.map(w=>({wavelength:w.wavelength,amplitude:w.amplitude,steepness:w.steepness,phase:w.phase,direction:[w.x,w.z]})),gravity:9.81,maxHorizontalSlope:resolvedWaves.reduce((sum,w)=>sum+w.steepness,0)};
    const u=water.material.uniforms;for(const[k,v]of Object.entries(common))u[k]=v;u.uPond={value:isPond?1:0};
    if(isPond){u.uLakeLightPosition={value:pondLightPositions};u.uLakeLightDirection={value:pondLightDirections};u.uLakeLightColor={value:pondLightColors};u.uLakeLightParameters={value:pondLightParameters};}
    water.material.vertexShader=water.material.vertexShader.replace('void main() {',`
      varying vec3 vWaveNormal;
      void addGerstner(inout vec3 offset,inout vec3 tangent,inout vec3 binormal,vec2 xz,vec2 direction,float wavelength,float amplitude,float steepness,float phaseOffset){
        float k=6.28318530718/wavelength;
        float omega=sqrt(9.81*k);
        float phase=k*dot(direction,xz)-omega*time+phaseOffset;
        float sine=sin(phase),cosine=cos(phase);
        float horizontal=steepness/k;
        offset+=vec3(direction.x*horizontal*cosine,amplitude*sine,direction.y*horizontal*cosine);
        tangent+=vec3(-direction.x*direction.x*steepness*sine,direction.x*amplitude*k*cosine,-direction.x*direction.y*steepness*sine);
        binormal+=vec3(-direction.x*direction.y*steepness*sine,direction.y*amplitude*k*cosine,-direction.y*direction.y*steepness*sine);
      }
      vec3 wavePosition(vec3 p){
        vec4 w=modelMatrix*vec4(p,1.);
        ${isPond?`
        float a=w.x*.24+w.z*.16-time*.75,b=w.x*.41-w.z*.3+time*1.13,c=w.x*.87+w.z*.54-time*1.6;
        p.z+=.018*(sin(a)+.48*sin(b)+.2*sin(c));
        float dx=.018*(.24*cos(a)+.48*.41*cos(b)+.2*.87*cos(c));
        float dz=.018*(.16*cos(a)-.48*.3*cos(b)+.2*.54*cos(c));
        vWaveNormal=normalize(vec3(-dx,1.,-dz));
        `:`
        vec3 offset=vec3(0.),tangent=vec3(1.,0.,0.),binormal=vec3(0.,0.,1.);
        ${oceanWaveCalls}
        // PlaneGeometry is rotated -PI/2 about X: local +Y is world -Z.
        p+=vec3(offset.x,-offset.z,offset.y);
        vWaveNormal=normalize(cross(binormal,tangent));
        `}
        return p;
      }
      void main() {vec3 displaced=wavePosition(position);`).replaceAll('vec4( position, 1.0 )','vec4( displaced, 1.0 )');
    water.material.fragmentShader=water.material.fragmentShader.replace('uniform sampler2D mirrorSampler;',`uniform sampler2D mirrorSampler;
      uniform sampler2D uScene;uniform sampler2D uDepth;uniform vec2 uResolution;uniform float uNear,uFar,uNight,uPond;uniform vec2 uPondCenter;varying vec3 vWaveNormal;
      ${isPond?`uniform vec3 uLakeLightPosition[${pondLightLimit}],uLakeLightDirection[${pondLightLimit}],uLakeLightColor[${pondLightLimit}];uniform vec4 uLakeLightParameters[${pondLightLimit}];`:''}
    `).replace('void main() {',`
      vec2 waterHash(vec2 p){return fract(sin(vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))))*43758.5453);}
      float caustic(vec2 p){p+=vec2(sin(p.y*.81+time*.19),sin(p.x*.73-time*.23))*.6;vec2 cell=floor(p),f=fract(p);float near1=10.,near2=10.;for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec2 offset=vec2(float(x),float(y)),seed=waterHash(cell+offset);vec2 q=offset+.5+.31*sin(time*.29+6.2831853*seed)-f;float d=dot(q,q);if(d<near1){near2=near1;near1=d;}else near2=min(near2,d);}return pow(1.-smoothstep(.015,.19,sqrt(near2)-sqrt(near1)),3.);}
      float sunGlint(vec3 normal,vec3 viewDirection){
        vec3 lightDirection=normalize(sunDirection),halfDirection=normalize(lightDirection+viewDirection);
        float nl=max(dot(normal,lightDirection),0.),nv=max(dot(normal,viewDirection),.001),nh=max(dot(normal,halfDirection),0.),vh=max(dot(viewDirection,halfDirection),0.);
        float footprint=length(dFdx(normal))+length(dFdy(normal));float roughness=.075+min(.20,footprint*.35),a=roughness*roughness,a2=a*a;
        float denominator=nh*nh*(a2-1.)+1.,distribution=a2/max(3.14159265*denominator*denominator,.00000001);
        float k=roughness*roughness*.5,masking=nv/(nv*(1.-k)+k)*nl/(nl*(1.-k)+k+.000001);
        float reflectance=.02037+.97963*pow(1.-vh,5.);return min(8.,distribution*masking*reflectance/max(4.*nv*nl,.0001))*nl;
      }
      ${isPond?`
      vec3 lakeIllumination(vec3 point,vec3 normal,vec3 viewDirection,float depth){
        vec3 result=vec3(0.);float nv=max(dot(normal,viewDirection),.001),waterPath=1.-exp(-min(depth,8.)*.48);
        float roughness=.16+min(.16,(length(dFdx(normal))+length(dFdy(normal)))*.45),a=roughness*roughness,a2=a*a;
        for(int i=0;i<${pondLightLimit};i++){
          vec3 delta=uLakeLightPosition[i]-point;float distance=max(length(delta),.01);vec3 direction=delta/distance;vec4 parameters=uLakeLightParameters[i];
          float cone=smoothstep(parameters.x,parameters.y+1e-6,dot(-direction,uLakeLightDirection[i]));
          float cutoff=pow(clamp(1.-pow(distance/max(parameters.z,.01),4.),0.,1.),2.);
          vec3 incident=uLakeLightColor[i]*cone*cutoff/max(pow(distance,parameters.w),1.);
          float nl=max(dot(normal,direction),0.);vec3 halfDirection=normalize(direction+viewDirection);float nh=max(dot(normal,halfDirection),0.),vh=max(dot(viewDirection,halfDirection),0.);
          float denominator=nh*nh*(a2-1.)+1.,distribution=a2/max(3.14159265*denominator*denominator,.000001),k=roughness*roughness*.5;
          float masking=nv/(nv*(1.-k)+k)*nl/(nl*(1.-k)+k+.000001),fresnel=.02037+.97963*pow(1.-vh,5.);
          float specular=min(5.,distribution*masking*fresnel/max(4.*nv*nl,.0001))*nl;
          // A lit water column scatters incoming radiance back through the
          // surface. It glows only inside a real light cone, following its
          // position, penumbra, color, range and inverse-square attenuation.
          vec3 scattering=vec3(.17,.44,.38)*(.11+.29*waterPath)*(.30+.70*nl);
          result+=incident*(scattering+vec3(specular*.68));
        }
        return result*smoothstep(.015,.65,uNight);
      }
      `:''}
      void main() {
    `).replace('vec3 surfaceNormal = normalize( noise.xzy * vec3( 1.5, 1.0, 1.5 ) );',`
      float worldFootprint=max(length(dFdx(worldPosition.xz)),length(dFdy(worldPosition.xz)));
      float detailFade=1.-smoothstep(.25,3.5,worldFootprint);
      vec3 surfaceNormal=normalize(vWaveNormal+vec3(noise.x,noise.z-1.,noise.y)*detailFade);
    `).replace('float rf0 = 0.3;','float rf0 = 0.02037;').replace('vec3 outgoingLight = albedo;',`
      vec2 screenUv=gl_FragCoord.xy/uResolution;
      vec2 refractUv=clamp(screenUv+surfaceNormal.xz*.004*(1.-uPond*.5),vec2(.001),vec2(.999));
      float sceneDepth=texture2D(uDepth,screenUv).x;
      float sceneZ=perspectiveDepthToViewZ(sceneDepth,uNear,uFar);
      float waterZ=perspectiveDepthToViewZ(gl_FragCoord.z,uNear,uFar);
      float depth=clamp(waterZ-sceneZ,0.,150.);
      vec3 refracted=texture2D(uScene,refractUv).rgb;
      vec3 absorption=exp(-depth*mix(vec3(.25,.084,.045),vec3(.18,.056,.036),uPond));
      vec3 bodyColor=mix(waterColor*mix(.45,.15,uNight),refracted,absorption);
      float caustics=caustic(worldPosition.xz*.75)+caustic(worldPosition.zx*.57+vec2(1.7,3.1))*.4;
      bodyColor+=caustics*mix(.40,.8,uPond)*vec3(.12,.18,.135)*exp(-depth*.35)*(1.-uNight*.93)*smoothstep(.05,.3,depth);
      float fresnel=.02037+.97963*pow(1.-max(dot(eyeDirection,surfaceNormal),0.),5.);
      vec3 outgoingLight=mix(bodyColor,reflectionSample,fresnel);
      outgoingLight+=specularLight*.12*(1.-uNight*.9);
      outgoingLight+=sunColor*sunGlint(surfaceNormal,eyeDirection)*.85*(1.-uNight*.82)*getShadowMask();
      ${isPond?'outgoingLight+=lakeIllumination(worldPosition.xyz,surfaceNormal,eyeDirection,depth);':''}
      float shore=1.-smoothstep(.05,.65,depth);
      float wash=.5+.5*sin(worldPosition.x*.9+worldPosition.z*.71-time*1.13+noise.x*2.);
      float foam=shore*smoothstep(.33,.92,wash)*.55;
      outgoingLight=mix(outgoingLight,mix(vec3(.82,.89,.80),vec3(.19,.28,.34),uNight),foam);
    `);
    const before=water.onBeforeRender;let reflectedFrame=-1;
    water.onBeforeRender=function(r,s,c){if(isPond)syncPondLightUniforms();if(reflectedFrame===frame||frame%q.interval!==0)return;reflectedFrame=frame;const hidden=surfaces.map(o=>[o,o.visible]);for(const[o]of hidden)o.visible=false;try{before.call(this,r,s,c)}finally{for(const[o,visible]of hidden)o.visible=visible;}};
    scene.add(water);surfaces.push(water);return water;
  }
  ocean=buildSurface(false);pond=buildSurface(true);
  const viewport=new THREE.Vector4();
  function resize(){renderer.getDrawingBufferSize(size);common.uResolution.value.copy(size);let height=q.refraction,width=Math.round(height*size.x/size.y);refraction.setSize(width,height);}
  resize();
  function update(t,dt,n=0){
    time=t;night=n;frame++;const authored=world.pond?.position||world.pondCenter;
    if(authored){pond.position.set(authored.x??pond.position.x,authored.y??world.pondLevel??pond.position.y,authored.z??pond.position.z);common.uPondCenter.value.set(pond.position.x,pond.position.z);}
    const radii=world.pondRadii;if(radii)pond.scale.set(radii.x,radii.z,1);
    sunDirection.copy(lights.sun.position).sub(lights.sun.target.position).normalize();
    for(const w of surfaces){const u=w.material.uniforms;u.time.value=t;u.sunDirection.value.copy(sunDirection);u.sunColor.value.copy(lights.sun.color).multiplyScalar(Math.min(1.5,lights.sun.intensity*.65));u.uNight.value=n;u.eye.value.copy(camera.position);u.uNear.value=camera.near;u.uFar.value=camera.far;u.waterColor.value.set(n>.6?'#174461':w===pond?'#277f79':'#236e8d');}
    pondShoreRoot.visible=n>.001;
    for(let i=0;i<pondShoreLights.length;i++){
      const light=pondShoreLights[i],angle=i/3*Math.PI*2+.45,x=pond.position.x+Math.cos(angle)*pond.scale.x*1.06,z=pond.position.z+Math.sin(angle)*pond.scale.y*1.06;
      const shoreHeight=world.heightAt?.(x,z),height=Number.isFinite(shoreHeight)?Math.max(pond.position.y+5.4,shoreHeight+.8):pond.position.y+5.4;
      light.position.set(x,height,z);light.target.position.set(pond.position.x+Math.sin(t*.055+i*2)*pond.scale.x*.24,pond.position.y-.32,pond.position.z+Math.cos(t*.047+i*2)*pond.scale.y*.24);
      light.color.copy(pondShorePalette[i]).lerp(pondShorePalette[(i+1)%3],.25+.2*Math.sin(t*.041+i));light.intensity=n*(qualityId==='mobile'?950:1650)*(.82+.18*Math.sin(t*.16-i*1.8));
    }
    for(let i=0;i<pondLightSamples.length;i++){const angle=(i-1)/8*Math.PI*2,r=i===0?0:.72;pondLightSamples[i].set(pond.position.x+Math.cos(angle)*pond.scale.x*r,pond.position.y,pond.position.z+Math.sin(angle)*pond.scale.y*r);}
    // Also synchronize outside a render, so captures/debug checks and the first
    // night frame use current lights. onBeforeRender refreshes show spotlights
    // again after the main loop has moved them.
    syncPondLightUniforms();
  }
  function renderRefraction(){if(frame%q.interval!==0)return;const previous=renderer.getRenderTarget(),shadowUpdate=renderer.shadowMap.autoUpdate;renderer.getViewport(viewport);const visibles=surfaces.map(o=>o.visible);surfaces.forEach(o=>o.visible=false);renderer.shadowMap.autoUpdate=false;try{renderer.setRenderTarget(refraction);renderer.clear();renderer.render(scene,camera);}finally{surfaces.forEach((o,i)=>o.visible=visibles[i]);renderer.setRenderTarget(previous);renderer.setViewport(viewport);renderer.shadowMap.autoUpdate=shadowUpdate;}}
  function setQuality(id){if(!presets[id])return;qualityId=id;q=presets[id];for(const w of surfaces){const targetSize=w===pond?Math.min(q.reflection,1024):q.reflection;w.getRenderTarget().setSize(targetSize,targetSize);}resize();}
  // Snapshot geometry for the optional physical path tracer; regular gameplay
  // continues to use the live reflected/refracted shader above.
  function pathTraceMeshes(){return surfaces.map(w=>{w.updateMatrixWorld(true);const geometry=w.geometry.clone(),p=geometry.attributes.position,v=new THREE.Vector3(),offset=new THREE.Vector3(),inverse=new THREE.Matrix4().copy(w.matrixWorld).invert();for(let i=0;i<p.count;i++){v.fromBufferAttribute(p,i).applyMatrix4(w.matrixWorld);if(w===pond)v.y+=pondDisplacement(v.x,v.z,time);else v.add(oceanDisplacement(v.x,v.z,time,offset));v.applyMatrix4(inverse);p.setXYZ(i,v.x,v.y,v.z);}geometry.computeVertexNormals();const m=new THREE.MeshPhysicalMaterial({color:w===pond?'#8fcac1':'#82b8bc',roughness:.055,metalness:0,transmission:.92,ior:1.333,thickness:1.5,attenuationColor:'#2c9f9c',attenuationDistance:18,side:THREE.DoubleSide});const clone=new THREE.Mesh(geometry,m);clone.matrix.copy(w.matrixWorld);clone.matrixAutoUpdate=false;clone.name='Physical water snapshot';return clone;});}
  function photographicWater(){
    const meshes=pathTraceMeshes(),positions=[],indices=[],offset=new THREE.Vector3(),segments=128,inner=oceanWidth*.5,outer=30000;
    // A physical photograph has no raster fog hiding the finite ocean mesh.
    // Continue the displaced boundary to 30 km with a cheap outer annulus.
    for(let side=0;side<4;side++)for(let i=0;i<=segments;i++){
      const t=i/segments*2-1,x=side===0?t:side===1?1:side===2?-t:-1,z=side===0?-1:side===1?t:side===2?1:-t;
      oceanDisplacement(x*inner,z*inner,time,offset);positions.push(x*inner+offset.x,offset.y,z*inner+offset.z,x*outer,0,z*outer);
      if(i<segments){const n=(side*(segments+1)+i)*2;indices.push(n,n+2,n+1,n+1,n+2,n+3);}
    }
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setIndex(indices);geometry.computeVertexNormals();
    const extension=new THREE.Mesh(geometry,meshes[0].material.clone());extension.name='Distant physical sea continuation';extension.matrixAutoUpdate=false;meshes.push(extension);return meshes;
  }
  return{update,resize,setQuality,renderRefraction,ocean,pond,surfaces,pathTraceMeshes:photographicWater,get stats(){return{reflection:q.reflection,refraction:q.refraction,quality:qualityId,oceanSegments,resolvedWaves:resolvedWaves.length,pondLights:activePondLights,pondShoreLights:pondShoreLights.length,pondNightFactor:night}}};
}

function makeNormals(){
  const n=256,data=new Uint8Array(n*n*4),height=new Float32Array(n*n);
  const fade=t=>t*t*t*(t*(t*6-15)+10),wrap=(v,period)=>(v%period+period)%period;
  const gradient=(x,y,period)=>{x=wrap(x,period);y=wrap(y,period);let h=Math.imul(x,374761393)^Math.imul(y,668265263);h=Math.imul(h^(h>>>13),1274126177);const angle=((h^(h>>>16))>>>0)/4294967296*Math.PI*2;return[Math.cos(angle),Math.sin(angle)];};
  const noise=(x,y,period)=>{const ix=Math.floor(x),iy=Math.floor(y),dx=x-ix,dy=y-iy,u=fade(dx),v=fade(dy),g00=gradient(ix,iy,period),g10=gradient(ix+1,iy,period),g01=gradient(ix,iy+1,period),g11=gradient(ix+1,iy+1,period),a=g00[0]*dx+g00[1]*dy,b=g10[0]*(dx-1)+g10[1]*dy,c=g01[0]*dx+g01[1]*(dy-1),d=g11[0]*(dx-1)+g11[1]*(dy-1);return(a+(b-a)*u)*(1-v)+(c+(d-c)*u)*v;};
  // Isotropic, C2-continuous gradient waves replace coherent crossed sine
  // lattices. Periodic gradients keep the tile and all of its mip levels seamless.
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){const u=x/n,v=y/n;height[y*n+x]=noise(u*4,v*4,4)+noise(u*8+.37,v*8+.13,8)*.42+noise(u*16+.71,v*16+.39,16)*.16+noise(u*32+.23,v*32+.57,32)*.06+noise(u*64+.19,v*64+.73,64)*.02;}
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){let dx=height[y*n+(x+1)%n]-height[y*n+(x+n-1)%n],dy=height[((y+1)%n)*n+x]-height[((y+n-1)%n)*n+x];const normal=new THREE.Vector3(-dx*3.,1,-dy*3.).normalize(),i=(y*n+x)*4;data[i]=Math.round((normal.x*.5+.5)*255);data[i+1]=Math.round((normal.z*.5+.5)*255);data[i+2]=Math.round((normal.y*.5+.5)*255);data[i+3]=255;}
  const texture=new THREE.DataTexture(data,n,n,THREE.RGBAFormat);texture.name='Isotropic seamless multiscale water normals';texture.needsUpdate=true;return texture;
}
