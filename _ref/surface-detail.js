import * as THREE from 'three';

// Small-scale material detail is independent of the supplied island's 4K
// painted atlas. It adds normal relief without changing walkable geometry.
export function createSurfaceDetail({world}) {
  const time={value:0},seen=new Set();
  const noise=`
    varying vec3 vIslandDetailWorld;
    float detailHash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
    float detailNoise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(detailHash(i),detailHash(i+vec3(1,0,0)),f.x),mix(detailHash(i+vec3(0,1,0)),detailHash(i+vec3(1,1,0)),f.x),f.y),mix(mix(detailHash(i+vec3(0,0,1)),detailHash(i+vec3(1,0,1)),f.x),mix(detailHash(i+vec3(0,1,1)),detailHash(i+vec3(1,1,1)),f.x),f.y),f.z);}
    vec3 detailNormal(vec3 original,float h){vec3 sx=dFdx(-vViewPosition),sy=dFdy(-vViewPosition),r1=cross(sy,original),r2=cross(original,sx);float determinant=dot(sx,r1);return normalize(abs(determinant)*original-sign(determinant)*(dFdx(h)*r1+dFdy(h)*r2));}
  `;
  const windVertex=`uniform float uIslandLeafTime;varying vec3 vIslandDetailWorld;`;
  function wind(shader){shader.uniforms.uIslandLeafTime=time;shader.vertexShader=windVertex+'\n'+shader.vertexShader;shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
    vec3 root=modelMatrix[3].xyz;float tip=smoothstep(1.7,7.5,position.y);float gust=sin(uIslandLeafTime*.73+root.x*.11+root.z*.08);
    transformed.x+=gust*.115*tip;transformed.z+=sin(uIslandLeafTime*.61+root.z*.09)*.065*tip;
  `).replace('#include <worldpos_vertex>','#include <worldpos_vertex>\nvIslandDetailWorld=(modelMatrix*vec4(transformed,1.)).xyz;');}
  function decorateMaterial(mat,foliage){if(seen.has(mat)||!mat?.isMeshStandardMaterial)return;seen.add(mat);const previous=mat.onBeforeCompile;
    mat.onBeforeCompile=(shader,r)=>{previous.call(mat,shader,r);if(foliage)wind(shader);else{shader.vertexShader='varying vec3 vIslandDetailWorld;\n'+shader.vertexShader;shader.vertexShader=shader.vertexShader.replace('#include <worldpos_vertex>','#include <worldpos_vertex>\nvIslandDetailWorld=(modelMatrix*vec4(transformed,1.)).xyz;');}
      shader.fragmentShader=shader.fragmentShader.replace(/void main\s*\(\s*\)\s*\{/,noise+'\nvoid main() {');
      const body=foliage?`float smallLeaves=detailNoise(vIslandDetailWorld*8.5)*.68+detailNoise(vIslandDetailWorld*22.)*.32;diffuseColor.rgb*=.88+.22*smallLeaves;`:`float mineral=detailNoise(vIslandDetailWorld*3.4)*.65+detailNoise(vIslandDetailWorld*23.)*.35;diffuseColor.rgb*=.95+.10*mineral;
        vec3 landscapeNormal=normalize(cross(dFdx(vIslandDetailWorld),dFdy(vIslandDetailWorld)));float cliff=smoothstep(.35,.72,1.-abs(landscapeNormal.y));
        float layers=.92+.08*sin(vIslandDetailWorld.y*1.9+detailNoise(vIslandDetailWorld*.2)*2.);vec3 cliffStone=mix(vec3(.23,.255,.225),vec3(.40,.385,.315),mineral)*layers;diffuseColor.rgb=mix(diffuseColor.rgb,cliffStone,cliff*.84);`;
      shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\n'+body);
      shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_maps>','#include <normal_fragment_maps>\nnormal=detailNormal(normal,'+(foliage?'smallLeaves*.035':'mineral*.055')+');');
    };mat.customProgramCacheKey=()=>foliage?'island-leaf-relief-wind-v1':'island-mineral-relief-v1';mat.needsUpdate=true;
  }
  world.terrain?.traverse(mesh=>{if(mesh.isMesh)for(const mat of(Array.isArray(mesh.material)?mesh.material:[mesh.material]))decorateMaterial(mat,false);});
  const scenery=world.terrain?.parent?.getObjectByName('Blender authored scenery');
  scenery?.traverse(mesh=>{if(!mesh.isMesh||!/Canopy|Fronds/i.test(mesh.name))return;for(const mat of(Array.isArray(mesh.material)?mesh.material:[mesh.material]))decorateMaterial(mat,true);const depth=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,side:mesh.material?.side??THREE.FrontSide});depth.onBeforeCompile=wind;depth.customProgramCacheKey=()=> 'island-leaf-wind-depth-v1';mesh.customDepthMaterial=depth;});
  return{update(t){time.value=t;},get stats(){return{detailedMaterials:seen.size};}};
}
