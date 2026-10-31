import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

for(const file of fs.readdirSync(new URL('../data/coaches-anim/rigs/',import.meta.url)).filter(f=>f.endsWith('.js'))){
  test(file+': settled face avoids repeated writes and still responds to emotion and speech',()=>{
    let queue=[],now=0,writes=0;const nodes=new Map(),window={addEventListener(){}};
    const node=id=>{if(!nodes.has(id)){const attrs=new Map();nodes.set(id,{attrs,addEventListener(){},setAttribute(k,v){writes++;attrs.set(k,v);},getAttribute:k=>attrs.has(k)?attrs.get(k):null,removeAttribute:k=>attrs.delete(k),classList:{toggle(){},add(){},remove(){}}});}return nodes.get(id);};
    const context=vm.createContext({document:{getElementById:node,querySelectorAll:()=>[]},window,
      performance:{now:()=>now},requestAnimationFrame:fn=>queue.push(fn),setTimeout(){},clearTimeout(){},setInterval(){},clearInterval(){},console,Math});
    vm.runInContext(fs.readFileSync(new URL('../data/coaches-anim/rigs/'+file,import.meta.url),'utf8'),context);
    const frames=n=>{for(let i=0;i<n;i++){now+=1000/60;const current=queue;queue=[];current.forEach(fn=>fn(now));}};
    frames(180);writes=0;frames(300);assert.equal(writes,0,'settled values should not invalidate SVG');
    const mouth=node('mouth').getAttribute('d');window.coach.setEmotion('happy');frames(180);
    assert.ok(writes>0);assert.notEqual(node('mouth').getAttribute('d'),mouth);
    writes=0;window.coach.talk(true);frames(20);assert.ok(writes>0,'speaking remains animated');
    window.coach.talk(false);frames(180);writes=0;frames(30);assert.equal(writes,0);
  });
}
