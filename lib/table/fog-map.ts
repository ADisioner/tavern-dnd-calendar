import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { GifReader } from 'omggif';
import { FOG_CELL, pointVisible } from './fog.ts';
import type { TableActor, TableScene } from './scene.ts';
const cache=new Map<string,Uint8Array>();
// No image bytes from unexplored areas are returned to the browser.
export function maskedMap(bytes:Uint8Array,mime:string,scene:TableScene,actor:TableActor,assetId:string):Uint8Array {
  const key=assetId+':'+actor.userId+':'+JSON.stringify([scene.fog,scene.gridSize,scene.tokens.filter(token=>token.ownerId===actor.userId).map(t=>[t.x,t.y,t.visionFeet,t.hidden])]);
  const found=cache.get(key);if(found)return found;
  let image:{width:number;height:number;data:Uint8Array}|undefined;
  if(mime==='image/png'){
    const data=Buffer.from(bytes);if(data.readUInt32BE(16)*data.readUInt32BE(20)>4_000_000)throw new Error('Карта для тумана — до 4 мегапикселей.');image=PNG.sync.read(data);
  }else if(mime==='image/jpeg')image=jpeg.decode(bytes,{useTArray:true,maxResolutionInMP:4,maxMemoryUsageInMB:40});
  else if(mime==='image/gif') {const reader=new GifReader(Buffer.from(bytes));if(reader.width*reader.height>4_000_000)throw new Error('Карта слишком велика.');const data=new Uint8Array(reader.width*reader.height*4);reader.decodeAndBlitFrameRGBA(0,data);image={width:reader.width,height:reader.height,data};}
  // Unsupported encodings fail closed. The GM can normalize them to PNG in UI.
  const output=new PNG({width:scene.width,height:scene.height});
  const scale=image?Math.min(scene.width/image.width,scene.height/image.height):1;
  const offsetX=image?(scene.width-image.width*scale)/2:0,offsetY=image?(scene.height-image.height*scale)/2:0;
  const explored=new Set(scene.fog.explored[actor.userId]??[]);
  for(let y=0;y<scene.height;y+=4)for(let x=0;x<scene.width;x+=4){
    const p={x:x+2,y:y+2};const override=scene.fog.manual.findLast(a=>p.x>=a.x&&p.y>=a.y&&p.x<a.x+a.width&&p.y<a.y+a.height);
    const known=override?!override.reveal?false:true:pointVisible(scene,actor,p)||explored.has(`${Math.floor(x/FOG_CELL)*FOG_CELL}:${Math.floor(y/FOG_CELL)*FOG_CELL}`);
    for(let dy=0;dy<4&&y+dy<scene.height;dy++)for(let dx=0;dx<4&&x+dx<scene.width;dx++){
      const dest=((y+dy)*scene.width+x+dx)*4;
      if(known&&image){const sx=Math.floor((x+dx-offsetX)/scale),sy=Math.floor((y+dy-offsetY)/scale),background=[21,25,26];
        if(sx>=0&&sy>=0&&sx<image.width&&sy<image.height){const src=(sy*image.width+sx)*4,alpha=image.data[src+3]/255;for(let c=0;c<3;c++)output.data[dest+c]=Math.round(image.data[src+c]*alpha+background[c]*(1-alpha));}
        else for(let c=0;c<3;c++)output.data[dest+c]=background[c];
      }
      else{output.data[dest]=8;output.data[dest+1]=14;output.data[dest+2]=17;}output.data[dest+3]=255;
    }
  }
  const result=PNG.sync.write(output);cache.set(key,result);while(cache.size>3)cache.delete(cache.keys().next().value!);return result;
}
