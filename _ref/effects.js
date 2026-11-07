import * as THREE from 'three';
import {ShaderPass} from 'three/addons/postprocessing/ShaderPass.js';

// Linear HDR passes. Insert after GTAO, before bloom and OutputPass. A current
// scene DepthTexture is mandatory for depth effects; no color-only fake DOF.
export function createCinematicEffects({renderer,scene,camera,lights={},quality='extreme',depthTexture,enableDepth=true,styleStrength=.10}={}){
  const presets={mobile:{depth:false,fog:6,bokeh:8,blur:7},balanced:{depth:false,fog:10,bokeh:16,blur:10},ultra:{depth:true,fog:16,bokeh:28,blur:14},extreme:{depth:true,fog:24,bokeh:40,blur:18}};
  let qualityId=presets[quality]?quality:'extreme',depthEnabled=enableDepth,disposed=false,focus=13;
  const white=new THREE.DataTexture(new Uint8Array([255,255,255,255]),1,1);white.needsUpdate=true;
  const resolution=new THREE.Vector2(),position=new THREE.Vector3(),forward=new THREE.Vector3(),sunDirection=new THREE.Vector3(),sunPoint=new THREE.Vector3(),focusView=new THREE.Vector3(),scratch=new THREE.Vector3();
  const shared={tDepth:{value:white},uResolution:{value:resolution},uNear:{value:camera.near},uFar:{value:camera.far},uInvProjection:{value:new THREE.Matrix4()},uCameraWorld:{value:new THREE.Matrix4()},uCameraPosition:{value:new THREE.Vector3()},uSunDirection:{value:new THREE.Vector3(-.65,.32,.70).normalize()},uSunColor:{value:new THREE.Color('#ffddb0')},uSunIntensity:{value:2.4},uNight:{value:0},uTime:{value:0},uDepthEnabled:{value:0},uFogColor:{value:new THREE.Color('#c3c7d6')},uShadowMap:{value:white},uShadowMatrix:{value:new THREE.Matrix4()},uHasShadow:{value:0},uSunUv:{value:new THREE.Vector2(-10,-10)},uSunVisible:{value:0},uStyleStrength:{value:styleStrength}};
  const vertex=`varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
  const depthHelpers=`
    uniform sampler2D tDiffuse,tDepth;uniform vec2 uResolution;uniform float uNear,uFar,uDepthEnabled;
    uniform mat4 uInvProjection,uCameraWorld;varying vec2 vUv;
    vec3 viewPosition(vec2 uv,float depth){vec4 p=uInvProjection*vec4(uv*2.-1.,depth*2.-1.,1.);return p.xyz/p.w;}
    float linearDepth(vec2 uv){float d=texture2D(tDepth,clamp(uv,vec2(.001),vec2(.999))).r;return d>.999999?uFar:-viewPosition(uv,d).z;}
  `;
  const makePass=(name,uniforms,fragment)=>new ShaderPass(new THREE.ShaderMaterial({name,uniforms:{tDiffuse:{value:null},...shared,...uniforms},vertexShader:vertex,fragmentShader:fragment,depthTest:false,depthWrite:false,toneMapped:false}));
  const scatter=makePass('Depth reconstructed height scattering',{uFogSteps:{value:24}},depthHelpers+`
    uniform vec3 uCameraPosition,uSunDirection,uSunColor,uFogColor;uniform float uSunIntensity,uNight,uTime,uHasShadow;uniform int uFogSteps;
    uniform sampler2D uShadowMap;uniform mat4 uShadowMatrix;
    #include <packing>
    float shadowAt(vec3 p){if(uHasShadow<.5)return 1.;vec4 projected=uShadowMatrix*vec4(p,1.);vec3 uv=projected.xyz/projected.w;if(any(lessThan(uv,vec3(0.)))||any(greaterThan(uv,vec3(1.))))return 1.;float depth=unpackRGBAToDepth(texture2D(uShadowMap,uv.xy));return uv.z-.0012<=depth?1.:.12;}
    void main(){vec4 original=texture2D(tDiffuse,vUv);if(uDepthEnabled<.5){gl_FragColor=original;return;}
      float depth=texture2D(tDepth,vUv).r;vec3 endView=viewPosition(vUv,min(depth,.999995));vec3 ray=normalize(mat3(uCameraWorld)*endView);
      float distanceAlong=min(length(endView),650.);float stepLength=distanceAlong/float(uFogSteps),transmittance=1.;vec3 radiance=vec3(0.);
      float mu=dot(ray,uSunDirection),g=.57;float phase=(1.-g*g)/(12.5663706*pow(max(.08,1.+g*g-2.*g*mu),1.5));
      float jitter=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))));
      for(int i=0;i<24;i++){if(i>=uFogSteps)break;float d=(float(i)+jitter)*stepLength;vec3 p=uCameraPosition+ray*d;
        float heightDensity=exp(-max(p.y-1.,0.)*.036);float variation=.84+.16*sin(p.x*.029+p.z*.024+sin(p.z*.013-uTime*.035));
        float extinction=mix(.00175,.0012,uNight)*heightDensity*variation;float alpha=1.-exp(-extinction*stepLength);
        float visibility=shadowAt(p);vec3 source=uFogColor*.68+uSunColor*uSunIntensity*phase*visibility*mix(.88,.32,uNight);
        radiance+=transmittance*alpha*source;transmittance*=1.-alpha;
      }
      gl_FragColor=vec4(original.rgb*transmittance+radiance,original.a);
    }`);
  const dof=makePass('Thin lens depth of field · six blade aperture',{uFocus:{value:13},uFocalLength:{value:.05},uFStop:{value:1.5},uSensorHeight:{value:.05},uMaxCoC:{value:18},uBokehSamples:{value:40}},depthHelpers+`
    uniform float uFocus,uFocalLength,uFStop,uSensorHeight,uMaxCoC;uniform int uBokehSamples;
    float circleOfConfusion(float z){float f=uFocalLength;return clamp(f*f*(z-uFocus)/(uFStop*max(z,.05)*max(uFocus-f,.05))/uSensorHeight*uResolution.y,-uMaxCoC,uMaxCoC);}
    void main(){vec4 original=texture2D(tDiffuse,vUv);if(uDepthEnabled<.5){gl_FragColor=original;return;}float z=linearDepth(vUv),coc=circleOfConfusion(z),radius=abs(coc);if(radius<.45){gl_FragColor=original;return;}
      vec3 color=original.rgb;float weightSum=1.;
      for(int i=0;i<40;i++){if(i>=uBokehSamples)break;float n=float(i)+.5,angle=n*2.39996323;float disk=sqrt(n/float(uBokehSamples));float hexagon=.8660254/cos(mod(angle,1.04719755)-.52359878);vec2 offset=vec2(cos(angle),sin(angle))*disk*hexagon*radius/uResolution;vec2 uv=clamp(vUv+offset,vec2(.001),vec2(.999));
        float sampleCoC=circleOfConfusion(linearDepth(uv));float weight=coc>0.?smoothstep(coc-radius*.9-1.,coc+1.,sampleCoC):1.-smoothstep(-1.,1.,sampleCoC);
        weight=max(.025,weight);vec3 sampleColor=texture2D(tDiffuse,uv).rgb;float highlight=smoothstep(1.1,4.,dot(sampleColor,vec3(.2126,.7152,.0722)));color+=sampleColor*weight*(1.+highlight*.06);weightSum+=weight;
      }
      gl_FragColor=vec4(mix(original.rgb,color/weightSum,smoothstep(.35,1.4,radius)),original.a);
    }`);
  const flare=makePass('Occluded solar lens flare and gentle PBR palette',{},depthHelpers+`
    uniform vec2 uSunUv;uniform vec3 uSunColor;uniform float uSunVisible,uNight,uStyleStrength;
    float clearSun(vec2 uv){if(any(lessThan(uv,vec2(0.)))||any(greaterThan(uv,vec2(1.))))return 0.;vec2 r=vec2(2.)/uResolution;float visible=step(800.,linearDepth(uv));visible+=step(800.,linearDepth(uv+vec2(r.x,0.)));visible+=step(800.,linearDepth(uv-vec2(r.x,0.)));visible+=step(800.,linearDepth(uv+vec2(0.,r.y)));visible+=step(800.,linearDepth(uv-vec2(0.,r.y)));return visible*.2;}
    float ghost(vec2 p,vec2 center,float radius){vec2 d=(p-center)*vec2(uResolution.x/uResolution.y,1.);float r=length(d);return exp(-pow(r/max(radius,.001),4.))* .65+exp(-pow((r-radius)/.005,2.))*.15;}
    void main(){vec4 original=texture2D(tDiffuse,vUv);vec3 color=original.rgb;
      if(uDepthEnabled>.5&&uSunVisible>.001&&uNight<.9){float visibility=clearSun(uSunUv)*uSunVisible*(1.-uNight*.96);vec2 p=(vUv-uSunUv)*vec2(uResolution.x/uResolution.y,1.);float r=length(p);vec3 light=uSunColor*(exp(-r*26.)*.11+exp(-r*110.)*.24);light+=uSunColor*exp(-abs(p.y)*520.)*exp(-abs(p.x)*5.)*.10;
        vec2 axis=vec2(.5)-uSunUv;light+=vec3(.88,.52,.27)*ghost(vUv,uSunUv+axis*.65,.025)*.038;light+=vec3(.27,.57,.73)*ghost(vUv,uSunUv+axis*1.18,.047)*.032;light+=vec3(.65,.35,.57)*ghost(vUv,uSunUv+axis*1.75,.075)*.026;light+=vec3(.68,.77,.42)*ghost(vUv,uSunUv+axis*2.18,.038)*.024;color+=light*visibility;
      }
      // A small luminance quantization blend preserves PBR normals and maps;
      // warm highlights/cool shade are deliberately restrained and optional.
      float luminance=max(dot(color,vec3(.2126,.7152,.0722)),.0001);float stepped=exp2(floor(log2(1.+luminance)*14.+.5)/14.)-1.;vec3 stylized=color*(stepped/luminance);float high=smoothstep(.5,1.8,luminance);stylized*=mix(vec3(.985,1.,1.025),vec3(1.025,1.005,.98),high);color=mix(color,stylized,clamp(uStyleStrength,0.,.35));
      gl_FragColor=vec4(color,original.a);
    }`);
  const passes=[scatter,dof,flare];
  function actualDepth(){return typeof depthTexture==='function'?depthTexture():depthTexture;}
  function applyDepth(){const texture=actualDepth(),enabled=depthEnabled&&presets[qualityId].depth;if(enabled&&!texture?.isDepthTexture)throw new Error('Cinematic effects require a current scene DepthTexture. Supply GTAOPass.depthTexture or an explicit scene-depth pass.');shared.tDepth.value=texture?.isDepthTexture?texture:white;shared.uDepthEnabled.value=enabled?1:0;scatter.enabled=enabled;dof.enabled=enabled;}
  function setQuality(id){if(!presets[id])return;qualityId=id;const q=presets[id];scatter.uniforms.uFogSteps.value=q.fog;dof.uniforms.uBokehSamples.value=q.bokeh;resize();applyDepth();}
  function resize(){renderer.getDrawingBufferSize(resolution);dof.uniforms.uMaxCoC.value=presets[qualityId].blur*Math.max(.6,resolution.y/1080);}
  function setDepthEnabled(enabled){depthEnabled=!!enabled;applyDepth();}
  function update({time=0,dt=.016,focusPoint,nightFactor=0,enableDepth:nextDepth}={}){
    if(disposed)return;if(nextDepth!==undefined)depthEnabled=!!nextDepth;applyDepth();camera.updateMatrixWorld();position.setFromMatrixPosition(camera.matrixWorld);camera.getWorldDirection(forward);
    shared.uCameraPosition.value.copy(position);shared.uCameraWorld.value.copy(camera.matrixWorld);shared.uInvProjection.value.copy(camera.projectionMatrixInverse);shared.uNear.value=camera.near;shared.uFar.value=camera.far;shared.uTime.value=time;shared.uNight.value=nightFactor;
    const target=focusPoint?.isVector3?focusPoint:Array.isArray(focusPoint)?scratch.fromArray(focusPoint):scratch.copy(position).addScaledVector(forward,13);focusView.copy(target).applyMatrix4(camera.matrixWorldInverse);const desired=Math.max(.35,-focusView.z);focus=THREE.MathUtils.damp(focus,desired,5,Math.min(dt,.1));dof.uniforms.uFocus.value=focus;dof.uniforms.uFStop.value=1.5+nightFactor*1.1;dof.uniforms.uSensorHeight.value=2*dof.uniforms.uFocalLength.value*Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV())*.5);
    if(scene.fog?.color)shared.uFogColor.value.copy(scene.fog.color);const sun=lights.sun;
    if(sun){sun.getWorldPosition(sunDirection);sun.target.getWorldPosition(scratch);sunDirection.sub(scratch).normalize();shared.uSunDirection.value.copy(sunDirection);shared.uSunColor.value.copy(sun.color);shared.uSunIntensity.value=sun.intensity;sunPoint.copy(position).addScaledVector(sunDirection,Math.min(camera.far*.6,1500)).project(camera);shared.uSunUv.value.set(sunPoint.x*.5+.5,sunPoint.y*.5+.5);const edge=Math.max(Math.abs(sunPoint.x),Math.abs(sunPoint.y));shared.uSunVisible.value=sunDirection.dot(forward)>0?1-THREE.MathUtils.smoothstep(edge,.75,1.35):0;
      const map=sun.shadow?.map?.texture;shared.uHasShadow.value=map?1:0;shared.uShadowMap.value=map||white;if(sun.shadow?.matrix)shared.uShadowMatrix.value=sun.shadow.matrix;
    }else{shared.uSunVisible.value=0;shared.uHasShadow.value=0;}
  }
  function dispose(){if(disposed)return;disposed=true;passes.forEach(pass=>pass.dispose());white.dispose();}
  setQuality(qualityId);update({});
  return{passes,update,setQuality,resize,setDepthEnabled,setStyleStrength(value){shared.uStyleStrength.value=THREE.MathUtils.clamp(value,0,.35);},dispose,get stats(){return{quality:qualityId,depthEnabled:!!shared.uDepthEnabled.value,focusDistance:focus,focalLengthMm:dof.uniforms.uFocalLength.value*1000,fStop:dof.uniforms.uFStop.value,fogSteps:scatter.uniforms.uFogSteps.value,bokehSamples:dof.uniforms.uBokehSamples.value,sunInView:shared.uSunVisible.value>0,sunUv:shared.uSunUv.value.toArray()};}};
}
