"use strict";
/* Authored numeric draw data. No game fixtures or reference runtime. */
const test=require('node:test'),assert=require('node:assert/strict'),runtime=require('./skelplayer.js');
test('WebGPU uploads individual effect colors including zero alpha using an authored mock device',async()=>{
 const fs=require('node:fs'),names=['navigator','GPUBufferUsage','GPUTextureUsage','GPUShaderStage'],saved=names.map(n=>Object.getOwnPropertyDescriptor(globalThis,n)),noop=()=>{},pass=new Proxy({}, {get:()=>noop}),uploads=[];
 const device=new Proxy({lost:new Promise(()=>{}),queue:{copyExternalImageToTexture:noop,submit:noop,writeBuffer:(buffer,offset,data,start=0,size)=>{if(buffer.label==='sts2-skel-vertices')uploads.push(new Float32Array(data,start,size/4));}},createBuffer:options=>({...options,destroy:noop}),createTexture:()=>({createView:()=>({}),destroy:noop}),createCommandEncoder:()=>({beginRenderPass:()=>pass,finish:()=>({})})},{get:(o,k)=>k==='then'?undefined:k in o?o[k]:(()=>({}))});
 try{
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{gpu:{requestAdapter:async()=>({requestDevice:async()=>device}),getPreferredCanvasFormat:()=> 'bgra8unorm'}}});
  for(const name of names.slice(1))globalThis[name]=new Proxy({}, {get:()=>1});
  const source=fs.readFileSync(require('node:path').join(__dirname,'skelgpu.js'),'utf8'),{createSkeletonWebGPU}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const context={configure:noop,unconfigure:noop,getCurrentTexture:()=>({createView:()=>({})})},renderer=await createSkeletonWebGPU({getContext:()=>context});const page={name:'synthetic',pma:false};await renderer.loadTexture(page,{width:1,height:1});
  const vertex=[1,2,.25,.5,.5,1,1,0,0,.75,0];renderer.render([{page,blend:'normal',vertices:[vertex,vertex,vertex],light:[1,1,1,1],dark:[0,0,0]}],{x:0,y:0,width:16,height:16},16,16);assert.deepEqual(Array.from(uploads[0].slice(0,11)),vertex);renderer.dispose();
 }finally{names.forEach((name,i)=>{if(saved[i])Object.defineProperty(globalThis,name,saved[i]);else delete globalThis[name];});}
});
test('vertex effects transform position, UV and both colors before batch uploads',()=>{
 const page={width:16,height:16,pma:false},region={page,x:0,y:0,width:16,height:16,originalWidth:16,originalHeight:16,offsetX:0,offsetY:0,rotate:0};
 const skeleton={bones:[{active:true}],drawOrder:[0],slots:[{data:{bone:0,blend:'normal'},color:[1,1,1,1],sequenceIndex:-1,attachment:{type:'region',color:'ffffffff',regions:[region]},sequenceIndex:-1}],worldVertices:()=>[0,0,0,16,16,16,16,0]};
 const calls=[],effect={begin:s=>calls.push(s),transform:(p,uv,light,dark)=>{p.x+=3;uv.x=.25;light.r=.5;light.a=0;dark.g=.75;},end:()=>calls.push('end')};
 const commands=runtime.drawCommands(skeleton,{vertexEffect:effect});assert.deepEqual(commands[0].vertices[0],[3,0,.25,1,.5,1,1,0,0,.75,0]);assert.deepEqual(calls,[skeleton,'end']);
 let upload;const gl=new Proxy({ONE:1,SRC_ALPHA:770,ONE_MINUS_SRC_ALPHA:771,bufferData:(_,d)=>upload=new Float32Array(d)}, {get:(o,k)=>k in o?o[k]:(()=>{})});
 const renderer=Object.create(runtime.Renderer.prototype);Object.assign(renderer,{gl,vertexEffect:effect,canvas:{width:16,height:16},viewport:{x:0,y:0,width:16,height:16},background:[0,0,0,0],locations:{},textures:new Map([[page,{}]])});renderer.render(skeleton);assert.deepEqual(Array.from(upload.slice(0,11)),commands[0].vertices[0]);assert.equal(skeleton.slots[0].color[0],1);
});
test('vertex effect cleanup runs even when a transform throws',()=>{
 const page={width:16,height:16},region={page,x:0,y:0,width:16,height:16,originalWidth:16,originalHeight:16,offsetX:0,offsetY:0,rotate:0},skeleton={bones:[{active:true}],drawOrder:[0],slots:[{data:{bone:0,blend:'normal'},color:[1,1,1,1],sequenceIndex:-1,attachment:{type:'region',color:'ffffffff',regions:[region]}}],worldVertices:()=>[0,0,0,1,1,1,1,0]};
 let ended=false;assert.throws(()=>runtime.drawCommands(skeleton,{vertexEffect:{transform(){throw Error('transform');},end(){ended=true;}}}),/transform/);assert.equal(ended,true);
});
test('inactive clipping end slots end clipping before the next batch',()=>{
 const page={width:16,height:16},region={page,x:0,y:0,width:16,height:16,originalWidth:16,originalHeight:16,offsetX:0,offsetY:0,rotate:0};
 const skeleton={bones:[{active:true},{active:false}],drawOrder:[0,1,2],slots:[{data:{bone:0},attachment:{type:'clipping',end:1}},{data:{bone:1},attachment:null},{data:{bone:0,blend:'normal'},color:[1,1,1,1],sequenceIndex:-1,attachment:{type:'region',color:'ffffffff',regions:[region]}}],worldVertices:index=>index===0?[0,0,0,1,1,1,1,0]:[10,10,10,11,11,11,11,10]};
 assert.equal(runtime.drawCommands(skeleton)[0].vertices.length,6);
 skeleton.bones[1].active=true;skeleton.slots[1].attachment={type:'clipping',end:2};assert.equal(runtime.drawCommands(skeleton)[0].vertices.length,6);
});
test('reused uploads preserve known float32 vertex/color bytes and batch boundaries',()=>{
 const page={width:16,height:16,pma:false},region={page,x:0,y:0,width:16,height:16,originalWidth:16,originalHeight:16,offsetX:0,offsetY:0,rotate:0};
 const slot=blend=>({data:{bone:0,blend},color:[1,.5,.25,.75],darkColor:[.1,.2,.3,0],attachment:{type:'region',color:'ffffffff',regions:[region]},sequenceIndex:-1});
 const skeleton={bones:[{active:true}],drawOrder:[0,1,2],slots:[slot('normal'),slot('additive'),slot('normal')],worldVertices:()=>[0,0,0,16,16,16,16,0]};
 const uploads=[],draws=[],gl=new Proxy({ONE:1,SRC_ALPHA:770,ONE_MINUS_SRC_ALPHA:771,bufferData:(target,data)=>uploads.push(Buffer.from(data.buffer,data.byteOffset,data.byteLength)),drawArrays:(mode,start,count)=>draws.push(count)}, {get:(o,k)=>k in o?o[k]:(()=>{})});
 const renderer=Object.create(runtime.Renderer.prototype);Object.assign(renderer,{gl,canvas:{width:512,height:512},viewport:{x:0,y:0,width:16,height:16},background:[0,0,0,1],locations:{},textures:new Map([[page,{}]])});
 renderer.render(skeleton);
 assert.deepEqual(draws,[6,6,6]);
 const expected=new Float32Array([0,0,0,1,1,.5,.25,.75,.1,.2,.3]);
 assert.deepEqual(uploads[0].subarray(0,44),Buffer.from(expected.buffer));
 const capacity=renderer.vertexData;
 const first=uploads.map(Buffer.from);uploads.length=draws.length=0;
 renderer.render(skeleton);assert.equal(renderer.vertexData,capacity);assert.deepEqual(uploads,first);
});
