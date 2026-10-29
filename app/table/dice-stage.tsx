'use client';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { diceHull } from '@/lib/table/dice-geometry';
import { percentilePair, type RollRecord } from '@/lib/table/dice';

export default function DiceStage({ roll, sound }: { roll: RollRecord; sound: boolean }) {
  const host = useRef<HTMLDivElement>(null), [fallback, setFallback] = useState(false);
  useEffect(() => {
    const element = host.current; if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }); } catch { setFallback(true); return; }
    const width = Math.max(240, element.clientWidth), height = 230;
    renderer.setSize(width,height); renderer.setPixelRatio(Math.min(devicePixelRatio,2)); element.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('aria-label', `Бросок ${roll.formula}: ${roll.total}`);
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#171f20');
    const camera = new THREE.PerspectiveCamera(42,width/height,.1,100); camera.position.set(0,9,8); camera.lookAt(0,0,0);
    scene.add(new THREE.HemisphereLight(0xe9efef,0x302820,2.5)); const light = new THREE.DirectionalLight(0xffffff,3); light.position.set(3,8,4); scene.add(light);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(11,.15,6.4),new THREE.MeshStandardMaterial({color:'#293b39',roughness:.9})); floor.position.y=-.12; scene.add(floor);
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0,-18,0), allowSleep:true }); world.broadphase = new CANNON.SAPBroadphase(world);
    world.defaultContactMaterial.friction=.45; world.defaultContactMaterial.restitution=.4;
    function barrier(x:number,y:number,z:number,sx:number,sy:number,sz:number) { const body = new CANNON.Body({mass:0,shape:new CANNON.Box(new CANNON.Vec3(sx,sy,sz))}); body.position.set(x,y,z); world.addBody(body); }
    barrier(0,-.15,0,6,.15,3.5); barrier(-5.5,1.5,0,.2,2,3.4); barrier(5.5,1.5,0,.2,2,3.4); barrier(0,1.5,-3.2,6,2,.2); barrier(0,1.5,3.2,6,2,.2);
    const physical = roll.dice.flatMap(die => die.sides === 100 ? percentilePair(die.value).map((v,i)=>({sides:10,value:v,label:i===0?'tens':'units',kept:die.kept})) : [{...die,label:'normal'}]);
    const sounds: {time:number;strength:number}[] = [];
    const resources: {geometry:THREE.BufferGeometry;material:THREE.Material;texture?:THREE.Texture}[]=[];
    const objects = physical.map((die,index) => {
      const hull=diceHull(die.sides), shape=new CANNON.ConvexPolyhedron({vertices:hull.vertices.map(v=>new CANNON.Vec3(v.x,v.y,v.z)),faces:hull.faces.map(f=>f.ids)});
      const body=new CANNON.Body({mass:1,shape,linearDamping:.26,angularDamping:.3,sleepSpeedLimit:.15,sleepTimeLimit:.3});
      const columns=Math.min(8,physical.length),rows=Math.ceil(physical.length/columns);
      body.position.set((index%columns-(columns-1)/2)*1.1,2+Math.floor(index/columns)*1.3,(Math.floor(index/columns)-(rows-1)/2)*1.05);
      body.velocity.set((Math.random()-.5)*6,1+Math.random()*3,(Math.random()-.5)*5); body.angularVelocity.set(Math.random()*14,Math.random()*14,Math.random()*14);
      body.quaternion.setFromEuler(Math.random()*6,Math.random()*6,Math.random()*6); world.addBody(body);
      body.addEventListener('collide', (event: {contact:CANNON.ContactEquation}) => { const strength=Math.abs(event.contact.getImpactVelocityAlongNormal()); if(strength>1 && sounds.length<180) sounds.push({time:world.time,strength}); });
      return {die,hull,body,group:new THREE.Group()};
    });
    // Simulate first, then number the upward face consistently with the server
    // outcome. Playback uses the unmodified rigid-body collision trajectory.
    const frames: {p:THREE.Vector3;q:THREE.Quaternion}[][]=[];
    for(let tick=0;tick<240;tick++) { world.step(1/60); frames.push(objects.map(({body})=>({p:new THREE.Vector3(body.position.x,body.position.y,body.position.z),q:new THREE.Quaternion(body.quaternion.x,body.quaternion.y,body.quaternion.z,body.quaternion.w)}))); }
    objects.forEach(({die,hull,group},index)=>{
      const final=frames.at(-1)![index]; let upward=0,best=-Infinity;
      hull.faces.forEach((face,i)=>{const dot=face.normal.clone().applyQuaternion(final.q).y;if(dot>best){best=dot;upward=i;}});
      hull.faces.forEach((face,i)=>{
        const value=(i-upward+(die.label==='normal'?die.value-1:die.value)+die.sides)%die.sides;
        const label=die.label==='tens'?String(value*10).padStart(2,'0'):String(die.label==='normal'?value+1:value);
        const positions:number[]=[]; for(let n=1;n<face.ids.length-1;n++) for(const id of [face.ids[0],face.ids[n],face.ids[n+1]]) positions.push(...hull.vertices[id].toArray());
        const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.computeVertexNormals();
        const material=new THREE.MeshStandardMaterial({color:die.kept?'#c2a370':'#64706e',roughness:.38,metalness:.18});group.add(new THREE.Mesh(geometry,material));resources.push({geometry,material});
        const canvas=document.createElement('canvas');canvas.width=canvas.height=128;const ctx=canvas.getContext('2d')!;
        ctx.fillStyle='#1c2424';ctx.font='bold 68px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(label,64,67);
        const texture=new THREE.CanvasTexture(canvas), labelGeometry=new THREE.PlaneGeometry(die.sides>=12?.34:.4,die.sides>=12?.34:.4),labelMaterial=new THREE.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false});
        const text=new THREE.Mesh(labelGeometry,labelMaterial);text.position.copy(face.center).addScaledVector(face.normal,.003);text.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),face.normal);group.add(text);resources.push({geometry:labelGeometry,material:labelMaterial,texture});
      });
      scene.add(group);
    });
    let audio:AudioContext|undefined; if(sound) try {audio=new AudioContext();} catch { /* numeric and visual results remain available */ }
    let frame=0,soundIndex=0; const start=performance.now(), reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    function draw(now:number){
      const elapsed=reduced?4:Math.max(0,(now-start)/1000),index=Math.max(0,Math.min(239,Math.floor(elapsed*60)));
      objects.forEach(({group},i)=>{group.position.copy(frames[index][i].p);group.quaternion.copy(frames[index][i].q);});
      while(soundIndex<sounds.length && sounds[soundIndex].time<=elapsed){ const hit=sounds[soundIndex++];if(audio && !reduced && elapsed-hit.time<.1 && audio.state==='running'){
        const oscillator=audio.createOscillator(),gain=audio.createGain();oscillator.type='triangle';oscillator.frequency.setValueAtTime(180+Math.random()*140,audio.currentTime);gain.gain.setValueAtTime(Math.min(.08,hit.strength*.008),audio.currentTime);gain.gain.exponentialRampToValueAtTime(.001,audio.currentTime+.055);oscillator.connect(gain).connect(audio.destination);oscillator.start();oscillator.stop(audio.currentTime+.06);
      }}
      renderer.render(scene,camera);if(index<239)frame=requestAnimationFrame(draw);
    }
    frame=requestAnimationFrame(draw);
    return()=>{cancelAnimationFrame(frame);void audio?.close();for(const r of resources){r.geometry.dispose();r.material.dispose();r.texture?.dispose();}floor.geometry.dispose();(floor.material as THREE.Material).dispose();renderer.dispose();renderer.domElement.remove();};
  },[roll.id,sound]);
  return <div className="dice-stage" ref={host}>{fallback && <p>3D недоступно на этом устройстве. Результат сервера: {roll.total}.</p>}</div>;
}
