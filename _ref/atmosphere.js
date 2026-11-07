// Linear-light atmosphere. Clouds integrate Beer-Lambert extinction through a stable world-space field.
export function createAtmosphere({THREE,scene,renderer}){
  const PRESETS={
    sunrise:{zenith:'#6683ac',middle:'#b7aecb',horizon:'#efc6b9',below:'#a9bec7',sun:'#ffe3b6',cloud:'#f7d3cb',shade:'#a2a6c4',hemi:'#c5d3e5',ground:'#8b886d',direction:[-.73,.24,.51],sunIntensity:1.95,hemiIntensity:.95,environment:.60,night:0,coverage:.54},
    noon:{zenith:'#5c9aca',middle:'#a6c9de',horizon:'#d9e5df',below:'#94bdc8',sun:'#fff0d1',cloud:'#fff9e9',shade:'#b2c6d8',hemi:'#c3dcf0',ground:'#858d6d',direction:[-.46,.81,-.36],sunIntensity:2.7,hemiIntensity:.95,environment:.65,night:0,coverage:.51},
    sunset:{zenith:'#4d608c',middle:'#8a8fbc',horizon:'#edbfc7',below:'#a5b5c8',sun:'#ffddb0',cloud:'#efc5cf',shade:'#9f9ab7',hemi:'#d0d3e8',ground:'#8d8a6b',direction:[-.65,.32,.70],sunIntensity:2.4,hemiIntensity:1.1,environment:.65,night:0,coverage:.55},
    blue:{zenith:'#263e72',middle:'#677ba6',horizon:'#b1a1bd',below:'#6e86a4',sun:'#f2dbbf',cloud:'#bbb9d3',shade:'#6d7b9e',hemi:'#8ba0cc',ground:'#565e67',direction:[.70,.055,-.71],sunIntensity:.38,hemiIntensity:.48,environment:.34,night:.47,coverage:.49},
    night:{zenith:'#101d3c',middle:'#293f67',horizon:'#596a86',below:'#344b68',sun:'#c9ddff',cloud:'#879bb9',shade:'#344c72',hemi:'#6f8bbd',ground:'#394a60',direction:[-.48,.68,-.55],sunIntensity:.72,hemiIntensity:.52,environment:.38,night:1,coverage:.40}
  };
  const QUALITY={mobile:{steps:12,seaSteps:8,shadow:1024,stars:1200,environment:128},balanced:{steps:20,seaSteps:12,shadow:2048,stars:2600,environment:128},ultra:{steps:32,seaSteps:16,shadow:4096,stars:4800,environment:128},extreme:{steps:64,seaSteps:24,shadow:8192,stars:7600,environment:256}};
  let qualityId='ultra',timeKey='sunset',camera=null,currentNight=0,elapsed=0,environmentTarget=null,environmentQueue=[.15],environmentPending=false,environmentFailed=false;
  let seed=219413;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const hash=(x,y,z)=>{let n=Math.imul(x,1597334677)^Math.imul(y,3812015801)^Math.imul(z,2798796415);n=Math.imul(n^(n>>>15),2246822519);return((n^(n>>>13))>>>0)/4294967295;};
  const wrap=(x,n)=>(x%n+n)%n;
  function periodicNoise(x,y,z,n){const a=Math.floor(x),b=Math.floor(y),c=Math.floor(z);let u=x-a,v=y-b,w=z-c;u*=u*(3-2*u);v*=v*(3-2*v);w*=w*(3-2*w);const h=(dx,dy,dz)=>hash(wrap(a+dx,n),wrap(b+dy,n),wrap(c+dz,n));const lerp=(a,b,t)=>a+(b-a)*t;return lerp(lerp(lerp(h(0,0,0),h(1,0,0),u),lerp(h(0,1,0),h(1,1,0),u),v),lerp(lerp(h(0,0,1),h(1,0,1),u),lerp(h(0,1,1),h(1,1,1),u),v),w);}
  const noiseSize=64,noiseData=new Uint8Array(noiseSize**3*4);
  for(let z=0;z<noiseSize;z++)for(let y=0;y<noiseSize;y++)for(let x=0;x<noiseSize;x++){
    const u=x/noiseSize,v=y/noiseSize,w=z/noiseSize,i=((z*noiseSize+y)*noiseSize+x)*4;
    const base=periodicNoise(u*5,v*5,w*5,5)*.62+periodicNoise(u*10,v*10,w*10,10)*.26+periodicNoise(u*20,v*20,w*20,20)*.12;
    const detail=periodicNoise(u*13,v*13,w*13,13)*.68+periodicNoise(u*26,v*26,w*26,26)*.32;
    const coverage=periodicNoise(u*2,v*2,w*2,2)*.78+periodicNoise(u*4,v*4,w*4,4)*.22;
    noiseData[i]=Math.round(base*255);noiseData[i+1]=Math.round(detail*255);noiseData[i+2]=Math.round(coverage*255);noiseData[i+3]=Math.round(random()*255);
  }
  const noiseTexture=new THREE.Data3DTexture(noiseData,noiseSize,noiseSize,noiseSize);noiseTexture.format=THREE.RGBAFormat;noiseTexture.type=THREE.UnsignedByteType;noiseTexture.minFilter=THREE.LinearFilter;noiseTexture.magFilter=THREE.LinearFilter;noiseTexture.wrapS=noiseTexture.wrapT=noiseTexture.wrapR=THREE.RepeatWrapping;noiseTexture.unpackAlignment=1;noiseTexture.needsUpdate=true;
  const colors=['zenith','middle','horizon','below','sun','cloud','shade','hemi','ground'];
  const current={},target={};for(const name of colors){current[name]=new THREE.Color(PRESETS.sunset[name]);target[name]=current[name].clone();}
  const sunDirection=new THREE.Vector3(...PRESETS.sunset.direction).normalize(),targetDirection=sunDirection.clone(),moonDirection=new THREE.Vector3(-.48,.68,-.55).normalize();
  const uniforms={
    uNoise:{value:noiseTexture},uTime:{value:0},uCameraWorld:{value:new THREE.Vector3()},uSteps:{value:32},uSeaSteps:{value:16},uEnvironment:{value:0},uNight:{value:0},uCoverage:{value:.50},
    uZenith:{value:current.zenith},uMiddle:{value:current.middle},uHorizon:{value:current.horizon},uBelow:{value:current.below},uSunColor:{value:current.sun},uCloudLight:{value:current.cloud},uCloudShade:{value:current.shade},uSunDirection:{value:sunDirection},uMoonDirection:{value:moonDirection}
  };
  const vertexShader=`out vec3 vAtmosphereWorld;void main(){vec4 world=modelMatrix*vec4(position,1.);vAtmosphereWorld=world.xyz;gl_Position=projectionMatrix*viewMatrix*world;}`;
  const sharedShader=`
    precision highp sampler3D;
    uniform sampler3D uNoise;uniform float uTime,uNight,uCoverage,uEnvironment;uniform int uSteps,uSeaSteps;
    uniform vec3 uCameraWorld,uZenith,uMiddle,uHorizon,uBelow,uSunColor,uCloudLight,uCloudShade,uSunDirection,uMoonDirection;
    in vec3 vAtmosphereWorld;out vec4 atmosphereColor;
    #define gl_FragColor atmosphereColor
    float weatherNoise(vec3 p){return texture(uNoise,p).b;}
    float deckDensity(vec3 p){
      vec3 q=p*vec3(.00072,.00155,.00072)+vec3(uTime*.000011,0.,uTime*.000005);
      vec4 n=texture(uNoise,q);float detail=texture(uNoise,q*3.13+vec3(.19,.43,.72)).g;
      // The weather field is a horizontal column: it opens real blue-sky
      // windows instead of filling an entire constant-height cloud sheet.
      float weather=weatherNoise(vec3(q.x,.31,q.z));
      float coverage=smoothstep(.43,.62,weather+(uCoverage-.50)*.70);
      if(coverage<.012)return 0.;
      float base=210.+(1.-weather)*22.;
      float depth=mix(90.,180.,smoothstep(.35,.72,weather));
      float h=(p.y-base)/depth;if(h<0.||h>1.)return 0.;
      float profile=smoothstep(0.,.16,h)*(1.-smoothstep(.52,1.,h));
      float billow=texture(uNoise,q*1.73+vec3(.42,.18,.63)).r;
      float shape=n.r+(weather-.5)*.12+(billow-.5)*.10-detail*.05;
      float threshold=mix(.62,.405,coverage);
      return max(0.,shape-threshold)*8.0*profile;
    }
    float seaDensity(vec3 p){
      float h=(p.y-29.)/26.;if(h<0.||h>1.)return 0.;
      float ring=smoothstep(185.,260.,length(p.xz))*(1.-smoothstep(1050.,1450.,length(p.xz)));if(ring<.001)return 0.;
      vec3 q=p*vec3(.0018,.005,.0018)+vec3(uTime*.000013,.27,-uTime*.000008);
      vec4 n=texture(uNoise,q);float detail=texture(uNoise,q*2.7+vec3(.6,.1,.4)).g;
      float profile=smoothstep(0.,.25,h)*(1.-smoothstep(.60,1.,h));
      float coverage=smoothstep(.36,.61,n.b+.025);
      float threshold=mix(.55,.38,coverage);
      return max(0.,n.r+(n.b-.5)*.18-detail*.06-threshold)*5.2*profile*ring;
    }
    vec2 slab(vec3 ro,vec3 rd,float low,float high){if(abs(rd.y)<.00015)return vec2(1.,0.);vec2 v=(vec2(low,high)-ro.y)/rd.y;return vec2(max(0.,min(v.x,v.y)),min(3400.,max(v.x,v.y)));}
    float jitter(vec2 p){return fract(52.9829189*fract(dot(p,vec2(.06711056,.00583715))));}
    vec4 clouds(vec3 ro,vec3 rd,bool sea){
      vec2 range=sea?slab(ro,rd,29.,55.):slab(ro,rd,208.,412.);if(range.y<=range.x)return vec4(0.);
      int count=sea?uSeaSteps:uSteps;if(uEnvironment>.5)count=12;
      float stepLength=(range.y-range.x)/float(count),offset=jitter(gl_FragCoord.xy),transmittance=1.,visibility=1.;vec3 scattering=vec3(0.);
      float mu=dot(rd,uSunDirection),g=.42;float phase=(1.-g*g)/pow(max(.1,1.+g*g-2.*g*mu),1.5);
      for(int i=0;i<64;i++){
        if(i>=count||transmittance<.018)break;
        float distanceAlong=range.x+(float(i)+offset)*stepLength;vec3 p=ro+rd*distanceAlong;
        float density=sea?seaDensity(p):deckDensity(p);if(density<.009)continue;
        if(i%4==0||visibility==1.){
          float s1=sea?seaDensity(p+uSunDirection*19.):deckDensity(p+uSunDirection*55.);
          float s2=sea?seaDensity(p+uSunDirection*43.):deckDensity(p+uSunDirection*142.);
          visibility=exp(-(s1*1.9+s2*1.3));
        }
        float alpha=1.-exp(-density*stepLength*(sea?.053:.032));
        float topLight=sea?smoothstep(31.,53.,p.y):smoothstep(215.,400.,p.y);
        vec3 radiance=mix(uCloudShade,uCloudLight,.22+visibility*.68+topLight*.10);
        radiance+=uSunColor*phase*.13*visibility*(1.-density*.5)*(1.-uNight*.75);
        float haze=1.-exp(-distanceAlong*.00022);radiance=mix(radiance,uHorizon,haze*.64);
        scattering+=transmittance*alpha*radiance;transmittance*=1.-alpha;
      }
      return vec4(scattering,1.-transmittance);
    }
    vec3 skyGradient(vec3 rd){
      float elevation=max(rd.y,0.);float low=smoothstep(0.,.18,elevation),high=smoothstep(.04,.42,elevation);
      vec3 color=mix(uHorizon,uMiddle,low);color=mix(color,uZenith,high);
      color=mix(color,uBelow,smoothstep(0.,.65,-rd.y));
      // Match the distant cloud deck and sky at the horizon without obscuring
      // the foreground with a uniform fog layer.
      color=mix(color,uHorizon,exp(-abs(rd.y)*19.)*.12);
      float angle=max(0.,dot(rd,uSunDirection));float warmth=(1.-uNight)*pow(angle,12.)*(1.-smoothstep(.15,.75,rd.y));
      color=mix(color,uSunColor,warmth*.31);color+=uSunColor*pow(angle,180.)*.21*(1.-uNight);
      float sunDisc=smoothstep(cos(.011),cos(.0075),angle)*(1.-uNight);
      color+=uSunColor*sunDisc*2.7;
      float moonAngle=dot(rd,uMoonDirection);float moonHalo=pow(max(moonAngle,0.),190.);color+=vec3(.22,.30,.48)*moonHalo*uNight*.19;
      vec3 tangent=normalize(cross(uMoonDirection,vec3(0.,1.,0.)));vec3 bitangent=cross(tangent,uMoonDirection);
      vec2 moonUV=vec2(dot(rd,tangent),dot(rd,bitangent))/.021;float radius2=dot(moonUV,moonUV);
      if(radius2<1.06&&uNight>.001){float disc=1.-smoothstep(.93,1.03,radius2);float relief=texture(uNoise,vec3(moonUV*.8,.38)).g;float shade=.48+.52*max(0.,dot(normalize(vec3(moonUV,sqrt(max(0.,1.-radius2)))),normalize(vec3(-.45,.24,.87))));color=mix(color,vec3(.91,.92,.84)*shade*(.82+relief*.25),disc*uNight);}
      float galactic=exp(-pow(dot(rd,normalize(vec3(.43,.39,-.81)))*4.2,2.));float dust=texture(uNoise,rd*2.6+vec3(.4,.2,.8)).r;float dustFine=texture(uNoise,rd*7.1).g;color+=vec3(.11,.13,.20)*galactic*pow(max(dust-.26,0.),1.6)*(.6+dustFine)*uNight*.48*smoothstep(.03,.3,rd.y);
      return color;
    }
  `;
  const skyMaterial=new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,uniforms,vertexShader,fragmentShader:sharedShader+`
    void main(){vec3 direction=normalize(vAtmosphereWorld-uCameraWorld);vec3 color=skyGradient(direction);vec4 cloud=clouds(uCameraWorld,direction,false);color=color*(1.-cloud.a)+cloud.rgb;gl_FragColor=vec4(color,1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    }`,side:THREE.BackSide,depthWrite:false,depthTest:true,fog:false});
  const skyGeometry=new THREE.SphereGeometry(1,40,24),sky=new THREE.Mesh(skyGeometry,skyMaterial);sky.name='Painted sky and volumetric cloud atmosphere';sky.scale.setScalar(1690);sky.frustumCulled=false;sky.renderOrder=-10000;sky.userData.excludeFromPathTrace=true;scene.add(sky);
  sky.onBeforeRender=(_renderer,_scene,renderCamera)=>{uniforms.uCameraWorld.value.setFromMatrixPosition(renderCamera.matrixWorld);uniforms.uEnvironment.value=0;};
  const cloudSeaMaterial=new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,uniforms,vertexShader,fragmentShader:sharedShader+`
    void main(){vec3 direction=normalize(vAtmosphereWorld-uCameraWorld);vec4 cloud=clouds(uCameraWorld,direction,true);if(cloud.a<.003)discard;gl_FragColor=vec4(cloud.rgb/max(cloud.a,.001),cloud.a*.88);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    }`,side:THREE.DoubleSide,transparent:true,depthWrite:false,depthTest:true,fog:false});
  const cloudSea=new THREE.Mesh(new THREE.CircleGeometry(1450,96),cloudSeaMaterial);cloudSea.name='Low volumetric ocean cloud deck';cloudSea.rotation.x=-Math.PI/2;cloudSea.position.y=42;cloudSea.renderOrder=3;cloudSea.frustumCulled=false;cloudSea.userData.excludeFromPathTrace=true;scene.add(cloudSea);cloudSea.onBeforeRender=sky.onBeforeRender;
  const starCount=7600,starPositions=new Float32Array(starCount*3),starColors=new Float32Array(starCount*3),starSizes=new Float32Array(starCount),starPhases=new Float32Array(starCount),starBrightness=new Float32Array(starCount);
  const starColor=new THREE.Color();for(let i=0;i<starCount;i++){const a=random()*Math.PI*2,y=.018+Math.pow(random(),.88)*.981,r=Math.sqrt(1-y*y);starPositions.set([Math.cos(a)*r,y,Math.sin(a)*r],i*3);const tint=random();starColor.set(tint<.22?'#b9d6ff':tint>.88?'#ffe0b2':'#f5f0e7');starColors.set([starColor.r,starColor.g,starColor.b],i*3);starSizes[i]=.8+Math.pow(random(),5)*3.4;starPhases[i]=random()*Math.PI*2;starBrightness[i]=.16+Math.pow(random(),3)*.84;}
  const starGeometry=new THREE.BufferGeometry();starGeometry.setAttribute('position',new THREE.BufferAttribute(starPositions,3));starGeometry.setAttribute('color',new THREE.BufferAttribute(starColors,3));starGeometry.setAttribute('aSize',new THREE.BufferAttribute(starSizes,1));starGeometry.setAttribute('aPhase',new THREE.BufferAttribute(starPhases,1));starGeometry.setAttribute('aBrightness',new THREE.BufferAttribute(starBrightness,1));starGeometry.setDrawRange(0,4800);
  const starUniforms={uTime:uniforms.uTime,uNight:uniforms.uNight,uPixelRatio:{value:Math.min(2,renderer?.getPixelRatio?.()||1)}};
  const starMaterial=new THREE.ShaderMaterial({uniforms:starUniforms,vertexColors:true,transparent:true,depthWrite:false,depthTest:true,blending:THREE.AdditiveBlending,fog:false,vertexShader:`attribute float aSize,aPhase,aBrightness;uniform float uTime,uNight,uPixelRatio;varying vec3 vStarColor;varying float vStarAlpha,vStarCore;void main(){vStarColor=color;float twinkle=.72+.20*sin(uTime*(.8+aPhase*.17)+aPhase)+.16*sin(uTime*2.7+aPhase*5.1);vStarAlpha=aBrightness*twinkle*1.25*pow(uNight,1.45)*smoothstep(.015,.20,position.y);vStarCore=step(2.,aSize);gl_PointSize=clamp(aSize*uPixelRatio,1.,9.);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,fragmentShader:`varying vec3 vStarColor;varying float vStarAlpha,vStarCore;void main(){vec2 p=gl_PointCoord*2.-1.;float r=dot(p,p);if(r>1.)discard;float core=exp(-r*10.)+.24*exp(-r*2.4);float sparkle=(pow(max(0.,1.-abs(p.x)),16.)+pow(max(0.,1.-abs(p.y)),16.))*.28*vStarCore;float alpha=(core+sparkle)*vStarAlpha;if(alpha<.006)discard;gl_FragColor=vec4(vStarColor*(1.25+core*.85),alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    }`});
  const stars=new THREE.Points(starGeometry,starMaterial);stars.name='Twinkling warm and blue stars';stars.scale.setScalar(1660);stars.frustumCulled=false;stars.renderOrder=-9999;stars.userData.excludeFromPathTrace=true;scene.add(stars);
  const meteorPositions=new Float32Array(18),meteorGeometry=new THREE.BufferGeometry();meteorGeometry.setAttribute('position',new THREE.BufferAttribute(meteorPositions,3));meteorGeometry.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,1,0,0,1,0,1,1,0,1,1],2));
  const meteorUniforms={uAlpha:{value:0},uNight:uniforms.uNight};
  const meteorMaterial=new THREE.ShaderMaterial({uniforms:meteorUniforms,transparent:true,depthWrite:false,depthTest:true,blending:THREE.AdditiveBlending,fog:false,vertexShader:'varying vec2 vMeteorUv;void main(){vMeteorUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:`varying vec2 vMeteorUv;uniform float uAlpha,uNight;void main(){float width=exp(-pow((vMeteorUv.y-.5)*4.2,2.));float head=exp(-pow((1.-vMeteorUv.x)*17.,2.));float trail=pow(vMeteorUv.x,1.7);float alpha=width*(trail*.6+head)*uAlpha*uNight;vec3 color=mix(vec3(.28,.48,.95),vec3(2.7,2.85,3.),vMeteorUv.x);gl_FragColor=vec4(color,alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    }`});
  const meteor=new THREE.Mesh(meteorGeometry,meteorMaterial);meteor.name='Animated night meteor';meteor.frustumCulled=false;meteor.visible=false;meteor.renderOrder=-9998;meteor.userData.ptIgnore=true;scene.add(meteor);
  let meteorActive=false,meteorNight=false,meteorStart=0,meteorDuration=1.2,nextMeteorAt=Infinity,meteorsLaunched=0;
  const meteorStartDirection=new THREE.Vector3(),meteorEndDirection=new THREE.Vector3(),meteorForward=new THREE.Vector3(),meteorRight=new THREE.Vector3(),meteorOrigin=new THREE.Vector3(),meteorHead=new THREE.Vector3(),meteorTail=new THREE.Vector3(),meteorMotion=new THREE.Vector3(),meteorSide=new THREE.Vector3(),meteorView=new THREE.Vector3();
  function updateMeteor(){
    if(!camera||currentNight<.6){meteor.visible=false;meteorActive=false;meteorNight=false;return;}
    if(!meteorNight){meteorNight=true;nextMeteorAt=elapsed+10+random()*10;}
    if(!meteorActive&&elapsed>=nextMeteorAt){camera.getWorldDirection(meteorForward);meteorForward.y=0;if(meteorForward.lengthSq()<.01)meteorForward.set(0,0,-1);meteorForward.normalize();meteorRight.crossVectors(meteorForward,new THREE.Vector3(0,1,0)).normalize();meteorStartDirection.copy(meteorForward).addScaledVector(meteorRight,(random()-.5)*.85);meteorStartDirection.y=.22+random()*.5;meteorStartDirection.normalize();meteorEndDirection.copy(meteorStartDirection).addScaledVector(meteorRight,.26+random()*.15);meteorEndDirection.y-=.14+random()*.08;meteorEndDirection.normalize();meteorStart=elapsed;meteorDuration=.95+random()*.45;meteorActive=true;nextMeteorAt=elapsed+10+random()*10;meteorsLaunched++;}
    if(!meteorActive)return;const progress=(elapsed-meteorStart)/meteorDuration;if(progress>=1){meteorActive=false;meteor.visible=false;return;}
    const radius=Math.min(2700,camera.far*.86);meteorOrigin.setFromMatrixPosition(camera.matrixWorld);meteorHead.lerpVectors(meteorStartDirection,meteorEndDirection,progress).normalize().multiplyScalar(radius).add(meteorOrigin);meteorMotion.subVectors(meteorEndDirection,meteorStartDirection).normalize();meteorTail.copy(meteorHead).addScaledVector(meteorMotion,-radius*.075);meteorView.subVectors(meteorHead,meteorOrigin).normalize();meteorSide.crossVectors(meteorMotion,meteorView).normalize().multiplyScalar(radius*.0011);
    const vertices=[meteorTail.clone().sub(meteorSide),meteorHead.clone().addScaledVector(meteorSide,-.4),meteorTail.clone().add(meteorSide),meteorTail.clone().add(meteorSide),meteorHead.clone().addScaledVector(meteorSide,-.4),meteorHead.clone().addScaledVector(meteorSide,.4)];for(let i=0;i<6;i++)vertices[i].toArray(meteorPositions,i*3);meteorGeometry.attributes.position.needsUpdate=true;meteorUniforms.uAlpha.value=Math.pow(Math.max(0,Math.sin(progress*Math.PI)),.45);meteor.visible=true;
  }
  const sun=new THREE.DirectionalLight(current.sun,PRESETS.sunset.sunIntensity);sun.name='Sun and moon directional light';sun.target.position.set(0,0,-6);sun.castShadow=true;sun.shadow.camera.left=-105;sun.shadow.camera.right=105;sun.shadow.camera.top=105;sun.shadow.camera.bottom=-105;sun.shadow.camera.near=1;sun.shadow.camera.far=520;sun.shadow.bias=-.00013;sun.shadow.normalBias=.045;sun.shadow.radius=1.6;sun.shadow.mapSize.set(4096,4096);scene.add(sun,sun.target);
  const hemi=new THREE.HemisphereLight(current.hemi,current.ground,PRESETS.sunset.hemiIntensity);hemi.name='Cool sky and warm ground fill';scene.add(hemi);
  if(!scene.fog)scene.fog=new THREE.FogExp2(current.horizon,.0007);else scene.fog.color.copy(current.horizon);
  scene.environmentIntensity=PRESETS.sunset.environment;
  const envScene=new THREE.Scene(),envSky=new THREE.Mesh(skyGeometry,skyMaterial);envSky.scale.setScalar(1800);envSky.frustumCulled=false;envScene.add(envSky);
  envSky.onBeforeRender=(_renderer,_scene,renderCamera)=>{uniforms.uCameraWorld.value.setFromMatrixPosition(renderCamera.matrixWorld);uniforms.uEnvironment.value=1;};
  let pmrem=null,pathTraceEnvironment=null,lastCaptureStats=null;try{if(renderer)pmrem=new THREE.PMREMGenerator(renderer);}catch(error){console.warn('Atmosphere environment generator is unavailable.',error);}
  let sunIntensity=PRESETS.sunset.sunIntensity,hemiIntensity=PRESETS.sunset.hemiIntensity,environmentIntensity=PRESETS.sunset.environment;
  function refreshEnvironment(){
    if(!pmrem||environmentPending)return false;environmentPending=true;
    try{const next=pmrem.fromScene(envScene,.035,.1,4000,{size:QUALITY[qualityId].environment});const previous=environmentTarget;environmentTarget=next;scene.environment=next.texture;scene.environmentIntensity=environmentIntensity;if(previous)previous.dispose();environmentFailed=false;return true;}
    catch(error){if(!environmentFailed)console.warn('Could not refresh island environment lighting.',error);environmentFailed=true;return false;}
    finally{uniforms.uEnvironment.value=0;environmentPending=false;if(camera)uniforms.uCameraWorld.value.setFromMatrixPosition(camera.matrixWorld);}
  }
  function capturePathTraceEnvironment(width=1024){
    // The photo path tracer expects an equirectangular HDR texture, whereas
    // live PBR uses Three's packed CubeUV PMREM. Render the actual atmosphere
    // into a linear float panorama instead of substituting a flat gradient.
    const height=Math.round(width/2),starData=new Float32Array(width*height*4);
    const count=QUALITY[qualityId].stars;
    for(let i=0;i<count;i++){
      const x=starPositions[i*3],y=starPositions[i*3+1],z=starPositions[i*3+2];
      const u=Math.atan2(z,x)/(Math.PI*2)+.5,v=Math.asin(y)/Math.PI+.5;
      const px=Math.floor(u*width),py=Math.min(height-1,Math.floor(v*height));
      const twinkle=.72+.20*Math.sin(elapsed*(.8+starPhases[i]*.17)+starPhases[i])+.16*Math.sin(elapsed*2.7+starPhases[i]*5.1);
      const intensity=starBrightness[i]*twinkle*(starSizes[i]>2?3.4:1.6);
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        const iy=py+dy;if(iy<0||iy>=height)continue;const ix=(px+dx+width)%width,j=(iy*width+ix)*4;
        const falloff=dx===0&&dy===0?1:.07;
        for(let c=0;c<3;c++)starData[j+c]+=starColors[i*3+c]*intensity*falloff;
        starData[j+3]=1;
      }
    }
    const starMap=new THREE.DataTexture(starData,width,height,THREE.RGBAFormat,THREE.FloatType);starMap.needsUpdate=true;starMap.minFilter=starMap.magFilter=THREE.LinearFilter;
    const target=new THREE.WebGLRenderTarget(width,height,{type:THREE.FloatType,format:THREE.RGBAFormat,depthBuffer:false,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter});
    const material=new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,uniforms:{...uniforms,uPhotoStars:{value:starMap}},toneMapped:false,depthTest:false,depthWrite:false,
      vertexShader:'out vec3 vAtmosphereWorld;void main(){vAtmosphereWorld=vec3(uv,0.);gl_Position=vec4(position.xy,0.,1.);}',
      fragmentShader:sharedShader+`uniform sampler2D uPhotoStars;void main(){vec2 uv=vAtmosphereWorld.xy;float longitude=(uv.x-.5)*6.28318530718,latitude=(uv.y-.5)*3.14159265359;vec3 direction=vec3(cos(latitude)*cos(longitude),sin(latitude),cos(latitude)*sin(longitude));vec3 color=skyGradient(direction)+texture(uPhotoStars,uv).rgb*pow(uNight,1.45);vec4 cloud=clouds(uCameraWorld,direction,false);gl_FragColor=vec4(color*(1.-cloud.a)+cloud.rgb,1.);}`});
    const geometry=new THREE.PlaneGeometry(2,2),captureScene=new THREE.Scene(),quad=new THREE.Mesh(geometry,material);quad.frustumCulled=false;captureScene.add(quad);
    const oldTarget=renderer.getRenderTarget(),oldFace=renderer.getActiveCubeFace?.()||0,oldMip=renderer.getActiveMipmapLevel?.()||0;
    // RenderTarget viewports are already physical pixels. renderer.setViewport
    // scales logical pixels by DPR, which cropped this panorama to its lower
    // left quadrant at DPR=2 and turned every upward PT ray into grey under-sky.
    target.viewport.set(0,0,width,height);target.scissor.set(0,0,width,height);target.scissorTest=false;
    try{
      if(camera)uniforms.uCameraWorld.value.setFromMatrixPosition(camera.matrixWorld);uniforms.uEnvironment.value=0;
      renderer.setRenderTarget(target);renderer.render(captureScene,new THREE.Camera());
      const pixels=new Float32Array(width*height*4);renderer.readRenderTargetPixels(target,0,0,width,height,pixels);
      let minimum=Infinity,maximum=-Infinity,sum=0,sum2=0,counted=0;for(let i=0;i<pixels.length;i+=32){for(let c=0;c<3;c++){const value=pixels[i+c];if(!Number.isFinite(value))throw new Error('天空 HDR 捕获包含无效像素，请重试。');minimum=Math.min(minimum,value);maximum=Math.max(maximum,value);sum+=value;sum2+=value*value;counted++;}}
      if(maximum-minimum<.000001)throw new Error('天空 HDR 捕获没有有效天空变化，请重试。');
      const at=(x,y)=>{const i=(Math.min(height-1,Math.max(0,Math.floor(y)))*width+Math.min(width-1,Math.max(0,Math.floor(x))))*4;return Array.from(pixels.subarray(i,i+3));};
      lastCaptureStats={width,height,dpr:renderer.getPixelRatio?.()||1,fullSphere:true,minimum,maximum,variance:Math.max(0,sum2/counted-(sum/counted)**2),zenith:at(width*.5,height*.98),nadir:at(width*.5,height*.02),night:currentNight,time:timeKey};
      const texture=new THREE.DataTexture(pixels,width,height,THREE.RGBAFormat,THREE.FloatType);texture.mapping=THREE.EquirectangularReflectionMapping;texture.colorSpace=THREE.LinearSRGBColorSpace;texture.wrapS=THREE.RepeatWrapping;texture.wrapT=THREE.ClampToEdgeWrapping;texture.flipY=false;texture.minFilter=texture.magFilter=THREE.LinearFilter;texture.needsUpdate=true;texture.name='Captured HDR sky, volumetric clouds, moon and stars';texture.userData.atmosphereCapture=lastCaptureStats;
      pathTraceEnvironment?.dispose();pathTraceEnvironment=texture;return texture;
    }finally{renderer.setRenderTarget(oldTarget,oldFace,oldMip);material.dispose();geometry.dispose();starMap.dispose();target.dispose();}
  }
  function setTime(key){if(!PRESETS[key])return;timeKey=key;const preset=PRESETS[key];for(const name of colors)target[name].set(preset[name]);targetDirection.set(...preset.direction).normalize();environmentQueue=[.4,3.8];}
  function setQuality(id){if(!QUALITY[id])return;qualityId=id;const q=QUALITY[id];uniforms.uSteps.value=q.steps;uniforms.uSeaSteps.value=q.seaSteps;starGeometry.setDrawRange(0,q.stars);cloudSea.visible=id!=='mobile';const maxTexture=renderer?.capabilities?.maxTextureSize||4096,size=Math.min(q.shadow,maxTexture);if(sun.shadow.mapSize.x!==size){sun.shadow.map?.dispose();sun.shadow.map=null;sun.shadow.mapSize.set(size,size);sun.shadow.needsUpdate=true;}starUniforms.uPixelRatio.value=Math.min(2,renderer?.getPixelRatio?.()||1);environmentQueue=[.3];}
  function setCamera(nextCamera){camera=nextCamera;if(camera){const radius=Math.min(3000,(camera.far||1800)*.94);sky.scale.setScalar(radius);stars.scale.setScalar(radius*.985);sky.position.copy(camera.position);stars.position.copy(camera.position);uniforms.uCameraWorld.value.setFromMatrixPosition(camera.matrixWorld);}}
  function update(t,dt){
    elapsed=Number.isFinite(t)?t:elapsed+dt;const delta=Math.max(0,Math.min(dt||0,.15)),blend=1-Math.exp(-delta*1.1),preset=PRESETS[timeKey];uniforms.uTime.value=elapsed;
    for(const name of colors)current[name].lerp(target[name],blend);sunDirection.lerp(targetDirection,blend).normalize();currentNight=THREE.MathUtils.lerp(currentNight,preset.night,blend);uniforms.uNight.value=currentNight;uniforms.uCoverage.value=THREE.MathUtils.lerp(uniforms.uCoverage.value,preset.coverage,blend);
    sunIntensity=THREE.MathUtils.lerp(sunIntensity,preset.sunIntensity,blend);hemiIntensity=THREE.MathUtils.lerp(hemiIntensity,preset.hemiIntensity,blend);environmentIntensity=THREE.MathUtils.lerp(environmentIntensity,preset.environment,blend);
    sun.color.copy(current.sun);sun.intensity=sunIntensity;sun.position.copy(sunDirection).multiplyScalar(235).add(sun.target.position);hemi.color.copy(current.hemi);hemi.groundColor.copy(current.ground);hemi.intensity=hemiIntensity;scene.environmentIntensity=environmentIntensity;scene.fog?.color.copy(current.horizon);
    if(camera){sky.position.copy(camera.position);stars.position.copy(camera.position);}
    stars.visible=currentNight>.025;updateMeteor();
    if(environmentQueue.length){environmentQueue=environmentQueue.map(wait=>wait-delta);if(environmentQueue[0]<=0){environmentQueue.shift();refreshEnvironment();}}
  }
  update(0,0);setQuality('ultra');
  return {lights:{sun,hemi},setTime,setQuality,setCamera,update,getNightFactor:()=>currentNight,sky,refreshEnvironment,capturePathTraceEnvironment,getNightSkyStats:()=>({stars:QUALITY[qualityId].stars,meteorActive,meteorsLaunched,nextMeteorIn:Math.max(0,nextMeteorAt-elapsed),hdrCapture:lastCaptureStats})};
}
