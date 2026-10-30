import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

test('authorized fresh rolls animate on the table with the tray closed, in order, without replaying history',async()=>{
  const state=[],refs=[],deps=[],pending=[],timers=new Map();let cursor=0,refCursor=0,effectCursor=0,timerId=0;
  const jsx=(type,props)=>({type,props}),exports={};
  const react={useState(initial){const i=cursor++;if(!(i in state))state[i]=initial;return[state[i],value=>{state[i]=typeof value==='function'?value(state[i]):value;}];},useRef(initial){const i=refCursor++;return refs[i]??(refs[i]={current:initial});},useEffect(fn,next){const i=effectCursor++,previous=deps[i];if(!previous||next.some((item,j)=>item!==previous[j])){deps[i]=next;pending.push(fn);}}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../app/table/dice-tray.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require(name){if(name==='react')return react;if(name==='react/jsx-runtime')return{jsx,jsxs:jsx};if(name.endsWith('/dice'))return{DICE_SIDES:[20]};if(name==='./dice-stage')return{__esModule:true,default:'Stage'};return{};},setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout(id){timers.delete(id);}});
  const roll=id=>({id,formula:'d20',total:12,authorName:'Player',visibility:'public',createdAt:0,dice:[],modifier:0});
  let rolls=[roll('old')];
  const render=()=>{cursor=refCursor=effectCursor=0;const tree=exports.default({rolls,open:false,master:false,disabled:false,connected:true,timezone:'UTC',send(){throw Error('animation must not send commands');},onClose(){}});for(const effect of pending.splice(0))effect();return tree;};
  const nodes=tree=>!tree||typeof tree!=='object'?[]:Array.isArray(tree)?tree.flatMap(nodes):[tree,...nodes(tree.props?.children)];
  render();assert.equal(nodes(render()).some(n=>n.type==='Stage'),false);
  rolls=[...rolls,roll('first'),roll('second')];render();render();await new Promise(resolve=>setImmediate(resolve));
  let tree=render();assert.equal(nodes(tree).find(n=>n.type==='section').props.hidden,true);assert.equal(nodes(tree).find(n=>n.type==='Stage').props.roll.id,'first');
  const advance=()=>{const [id,fn]=timers.entries().next().value;timers.delete(id);fn();};
  advance();tree=render();assert.equal(nodes(tree).find(n=>n.type==='Stage').props.roll.id,'second');
  advance();tree=render();assert.equal(nodes(tree).some(n=>n.type==='Stage'),false);
});
