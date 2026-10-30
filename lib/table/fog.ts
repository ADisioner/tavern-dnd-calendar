import { z } from 'zod';
import type { Point } from './geometry.ts';
import { redactCombat, emptyCombat, type CombatState } from './combat.ts';
const point=z.object({x:z.number().finite().min(0).max(1600),y:z.number().finite().min(0).max(1120)}).strict();
export const wallSchema=z.object({id:z.string().uuid(),a:point,b:point,door:z.boolean(),open:z.boolean()}).strict();
export const fogAreaSchema=z.object({id:z.string().uuid(),x:z.number().min(0).max(1600),y:z.number().min(0).max(1120),width:z.number().min(1).max(1600),height:z.number().min(1).max(1120),reveal:z.boolean()}).strict();
export const fogSchema=z.object({enabled:z.boolean(),walls:z.array(wallSchema).max(300),manual:z.array(fogAreaSchema).max(200),explored:z.record(z.string(),z.array(z.string().regex(/^\d+:\d+$/)).max(4480)),
  view:z.object({viewerId:z.string(),polygons:z.array(z.array(point)),exploredCells:z.array(z.string()),areas:z.array(fogAreaSchema)}).optional()}).strict();
export const emptyFog=()=>({enabled:false,walls:[],manual:[],explored:{}});
type Fog=z.infer<typeof fogSchema>;
type VisionToken={id:string;ownerId:string|null;x:number;y:number;visionFeet?:number;hidden?:boolean;shareStats?:boolean};
type FogScene={width:number;height:number;gridSize:number;tokens:VisionToken[];drawings:{points:number[]}[];fog?:Fog;combat?:CombatState};
type Viewer={userId:string;role:string};
const cross=(a:Point,b:Point)=>a.x*b.y-a.y*b.x;
function hit(a:Point,b:Point,c:Point,d:Point) {
  const r={x:b.x-a.x,y:b.y-a.y},s={x:d.x-c.x,y:d.y-c.y},q={x:c.x-a.x,y:c.y-a.y},den=cross(r,s);
  if(Math.abs(den)<1e-9){
    if(Math.abs(cross(q,r))>1e-8)return null;
    const length=r.x*r.x+r.y*r.y;if(length<1e-9)return null;
    const ts=[((c.x-a.x)*r.x+(c.y-a.y)*r.y)/length,((d.x-a.x)*r.x+(d.y-a.y)*r.y)/length].sort((x,y)=>x-y);
    return ts[1]>1e-6&&ts[0]<1-1e-6?Math.max(1e-6,ts[0]):null;
  }
  const t=cross(q,s)/den,u=cross(q,r)/den;
  return t>1e-6&&t<1-1e-6&&u>=-1e-8&&u<=1+1e-8?t:null;
}
export function lineOfSight(from:Point,to:Point,walls:z.infer<typeof wallSchema>[]) {return !walls.some(wall=>!(wall.door&&wall.open)&&hit(from,to,wall.a,wall.b)!==null);}
function contains(area:z.infer<typeof fogAreaSchema>,p:Point){return p.x>=area.x&&p.x<=area.x+area.width&&p.y>=area.y&&p.y<=area.y+area.height;}
function sources(scene:FogScene,actor:Viewer){return scene.tokens.filter(token=>token.ownerId===actor.userId&&!token.hidden&&(token.visionFeet??60)>0);}
export function pointVisible(scene:FogScene,actor:Viewer,p:Point){
  if(actor.role==='master'||!scene.fog?.enabled)return true;
  const manual=scene.fog.manual.findLast(area=>contains(area,p));if(manual)return manual.reveal;
  return sources(scene,actor).some(token=>Math.hypot(token.x-p.x,token.y-p.y)<=(token.visionFeet??60)*scene.gridSize/5+1e-6&&lineOfSight(token,p,scene.fog!.walls));
}
export function tokenVisible(scene:FogScene,actor:Viewer,token:VisionToken){return actor.role==='master'||!token.hidden&&(token.ownerId===actor.userId||pointVisible(scene,actor,token));}
export function visiblePolygon(scene:FogScene,token:VisionToken){
  const radius=(token.visionFeet??60)*scene.gridSize/5,angles=Array.from({length:128},(_,i)=>i*Math.PI*2/128),walls=scene.fog?.walls.filter(wall=>!wall.door||!wall.open)??[];
  const corners=[{x:0,y:0},{x:scene.width,y:0},{x:scene.width,y:scene.height},{x:0,y:scene.height}];
  const segments=[...walls,...corners.map((a,i)=>({a,b:corners[(i+1)%4]}))];
  for(const wall of segments)for(const p of [wall.a,wall.b]){const angle=Math.atan2(p.y-token.y,p.x-token.x);angles.push(angle-1e-5,angle,angle+1e-5);}
  return angles.sort((a,b)=>a-b).map(angle=>{
    const target={x:token.x+Math.cos(angle)*radius,y:token.y+Math.sin(angle)*radius};let distance=1;
    for(const wall of segments){const t=hit(token,target,wall.a,wall.b);if(t!==null)distance=Math.min(distance,t);}
    return{x:Math.max(0,Math.min(scene.width,token.x+(target.x-token.x)*distance)),y:Math.max(0,Math.min(scene.height,token.y+(target.y-token.y)*distance))};
  });
}
export const FOG_CELL=20;
export function exploreScene<T extends FogScene>(scene:T,roster:Viewer[]):T {
  if(!scene.fog?.enabled)return scene;
  const explored={...scene.fog.explored};
  for(const actor of roster){
    const cells=new Set(explored[actor.userId]??[]);
    for(let y=0;y<scene.height;y+=FOG_CELL)for(let x=0;x<scene.width;x+=FOG_CELL)if(pointVisible(scene,{...actor,role:'player'},{x:x+10,y:y+10}))cells.add(`${x}:${y}`);
    explored[actor.userId]=[...cells];
  }
  return{...scene,fog:{...scene.fog,explored}};
}
export function projectScene<T extends FogScene>(scene:T,actor:Viewer):T {
  if(actor.role==='master')return scene;
  const tokens=scene.tokens.filter(token=>tokenVisible(scene,actor,token));
  const safe=redactCombat({...scene,tokens,combat:scene.combat??emptyCombat()},actor,new Set(tokens.map(t=>t.id))) as T;
  if(!scene.fog?.enabled)return safe;
  const fog=scene.fog;
  return {...safe,drawings:scene.drawings.filter(d=>d.points.every((value,i)=>i%2||pointVisible(scene,actor,{x:value,y:d.points[i+1]}))),fog:{enabled:true,walls:[],manual:[],explored:{},view:{viewerId:actor.userId,polygons:sources(scene,actor).map(token=>visiblePolygon(scene,token)),exploredCells:fog.explored[actor.userId]??[],areas:fog.manual}}};
}

// Local GM-only overview. Never attach this union to a player's server view.
export function gmFogView(scene:FogScene):NonNullable<Fog['view']>{
 return {viewerId:'gm-overview',polygons:scene.tokens.filter(t=>t.ownerId&&!t.hidden&&(t.visionFeet??60)>0).map(t=>visiblePolygon(scene,t)),exploredCells:[...new Set(Object.values(scene.fog?.explored??{}).flat())],areas:scene.fog?.manual??[]};
}
