"use strict";
/* Original synthetic fixtures only. No exported game or third-party runtime data. */
const test=require('node:test'),assert=require('node:assert/strict');
const player=require('./skelplayer.js');

function bytes() {
  const parts=[];
  const api={
    byte:n=>{parts.push(Buffer.from([n]));return api;},
    uint:n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);parts.push(b);return api;},
    float:n=>{const b=Buffer.alloc(4);b.writeFloatBE(n);parts.push(b);return api;},
    var:n=>{do{const b=n&127;n=Math.floor(n/128);parts.push(Buffer.from([b|(n?128:0)]));}while(n);return api;},
    string:s=>{if(s===null)return api.var(0);const b=Buffer.from(s,'utf8');api.var(b.length+1);parts.push(b);return api;},
    end:()=>Buffer.concat(parts)
  };
  return api;
}

function syntheticSetup(mix,dark=0xffffffff) {
  const b=bytes().uint(0).uint(0).string('4.2.43');
  for(const n of [-10,-5,20,30,100])b.float(n);
  b.byte(0).var(0).var(2);
  for(const [i,name] of ['origin','tip'].entries()) {
    b.string(name);if(i)b.var(0);
    for(const n of [i?90:0,i?3:0,i?4:0,1,1,0,0,10])b.float(n);
    b.var(0).byte(0);
  }
  b.var(1).string('surface').var(1).uint(0xffffffff).uint(dark).var(0).var(0);
  b.var(1).string('aim').var(0).var(1).var(1).var(0);
  const bits=mix===0?0:mix===1?32:96;
  b.byte(bits|2);if(bits===96)b.float(mix);
  return b.var(0).var(0).var(0).end();
}

test('primitive reader: UTF-8, 32-bit varints, signed values, offset bounds',()=>{
  const b=bytes().var(0xffffffff).var(13).string('bone Ω').float(-1.25).end();
  const r=new player.Reader(b);
  assert.equal(r.varint(),0xffffffff);assert.equal(r.varint(true),-7);
  assert.equal(r.string(),'bone Ω');assert.equal(r.float(),-1.25);
  assert.throws(()=>r.byte(),/Truncated skeleton/);
  assert.throws(()=>new player.Reader(Uint8Array.of(255,255,255,255,31)).varint(),/Invalid varint/);
  assert.throws(()=>new player.Reader(Uint8Array.of(2)).bool(),/Invalid boolean/);
  assert.throws(()=>new player.Reader(Uint8Array.of(2,255)).string(),/Invalid UTF-8/);
});

test('slot dark color uses packed RGB and zero alpha',()=>{
  const d=player.parseBinary(syntheticSetup(1,0x102030),{stopAfter:'constraints'});
  assert.equal(d.slots[0].dark,'10203000');
});

test('binary setup: synthetic hierarchy, slot and fractional IK mixes',()=>{
  for(const mix of [0,0.25,1]) {
    const d=player.parseBinary(syntheticSetup(mix),{stopAfter:'constraints'});
    assert.equal(d.bones[1].parent,0);assert.equal(d.bones[1].rotation,90);
    assert.equal(d.slots[0].bone,1);assert.equal(d.slots[0].dark,null);
    assert.equal(d.ik[0].mix,mix);assert.equal(d.ik[0].bendDirection,1);
    assert.equal(d.reader.pos,d.reader.bytes.length);
  }
});

test('binary setup rejects truncated input and unsupported version',()=>{
  const b=syntheticSetup(0.25);
  assert.throws(()=>player.parseBinary(b.subarray(0,b.length-1),{stopAfter:'constraints'}),/Truncated skeleton/);
  const v=Buffer.from(b);v[9]='3'.charCodeAt(0);
  assert.throws(()=>player.parseBinary(v,{stopAfter:'constraints'}),/Unsupported binary version/);
});

function syntheticAnimation() {
  const setup=syntheticSetup(0),b=bytes();
  b.var(0).var(0); // Empty default and named skins.
  b.var(1).string('pulse').var(0).float(0).string('ok').string(null);
  b.var(1).string('turn').var(3);
  b.var(1).var(0).var(1).byte(0).var(2).float(0).var(0).float(1).var(0);
  b.var(1).var(1).var(1).byte(0).var(2).var(1);
  b.float(0).float(0).float(1).float(90).byte(2).float(0.25).float(0).float(0.75).float(90);
  b.var(0).var(0).var(0).var(0).var(0).var(0);
  b.var(1).float(0.5).var(0).var(6).float(1).byte(0);
  return Buffer.concat([setup,b.end()]);
}

test('complete synthetic binary: attachment, Bezier rotation and event timelines',()=>{
  const d=player.parseBinary(syntheticAnimation());
  assert.equal(d.decodedThrough,'animations');assert.equal(d.reader.pos,d.reader.bytes.length);
  const a=d.animations[0];assert.equal(a.duration,1);assert.equal(a.timelines.length,3);
  assert.deepEqual(a.timelines[0].frames,[{time:0,name:null},{time:1,name:null}]);
  const s=new player.Skeleton(d),events=s.applyAnimation('turn',0.5);
  close(s.bones[1].rotation,135);assert.equal(events.length,1);assert.equal(events[0].int,3);
  assert.equal(events[0].string,'ok');assert.equal(events[0].float,1);
  assert.equal(s.applyAnimation('turn',0.75,{lastTime:0.5}).length,0);
  assert.equal(s.applyAnimation('turn',2.75,{loop:true,lastTime:0.75}).length,2);
});

test('curve evaluation has independent components, stepped keys and exact endpoints',()=>{
  const t={type:'translate',frames:[{time:0,values:[0,10]},{time:1,values:[20,30]}],
    curves:[{type:'bezier',components:[[0.25,0,0.75,20],[0.25,30,0.75,10]]}]};
  assert.equal(player.timelineValue(t,-1),null);assert.deepEqual(player.timelineValue(t,0).values,[0,10]);
  close(player.timelineValue(t,0.5).values[0],10);close(player.timelineValue(t,0.5).values[1],20);
  t.curves=[{type:'stepped'}];assert.deepEqual(player.timelineValue(t,0.999).values,[0,10]);
  assert.deepEqual(player.timelineValue(t,1).values,[20,30]);
});

test('atlas: multiple pages, PMA, rotated trim and indexed sequence regions',()=>{
  const a=player.parseAtlas('one.png\nsize:64,32\npma:true\npart\nbounds:2,4,8,12\nrotate:90\noffsets:1,2,10,16\nindex:0\npart\nbounds:20,4,8,12\nindex:1\n\ntwo.png\nsize:32,32\nother\nxy:0,0\nsize:4,4\n');
  assert.equal(a.pages.length,2);assert.equal(a.pages[0].pma,true);
  assert.equal(a.regions.get('part').length,2);
  assert.equal(a.regions.get('part')[0].rotate,90);
  assert.equal(a.regions.get('part')[0].originalHeight,16);
  assert.equal(a.regions.get('other')[0].page,a.pages[1]);
  assert.throws(()=>player.parseAtlas('p.png\na\nbounds:0,0,-1,2'),/Invalid atlas region/);
});

// Pose observations use an angular compatibility constant; 1e-6 is still
// much stricter than the required coordinate/relative parity tolerances.
function close(a,b,tolerance=1e-6) {assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);}
test('known affine transforms: parent rotation, nonuniform scale, inverse',()=>{
  const m=player.math;
  const parent=m.localMatrix({x:10,y:20,rotation:90,scaleX:2,scaleY:3,shearX:0,shearY:0});
  const child=m.localMatrix({x:4,y:5,rotation:0,scaleX:1,scaleY:1,shearX:0,shearY:0});
  const world=m.multiply(parent,child),p=m.transform(world,1,2);
  close(world.x,-5);close(world.y,28);close(p[0],-11);close(p[1],30);
  const back=m.transform(m.inverse(world),...p);close(back[0],1);close(back[1],2);
  assert.throws(()=>m.inverse({a:1,b:2,c:2,d:4,x:0,y:0}),/Singular transform/);
});

test('known shear axes and reflection determinant',()=>{
  const m=player.math.localMatrix({x:0,y:0,rotation:0,scaleX:-2,scaleY:3,shearX:30,shearY:-20});
  close(m.a,-Math.sqrt(3));close(m.b,-1);close(m.c,3*Math.cos(70*Math.PI/180));
  close(m.d,3*Math.sin(70*Math.PI/180));assert.ok(m.a*m.d-m.b*m.c<0);
});

function poseData(bones,{ik=[],transform=[],path=[],physics=[],slots=[],attachments={}}={}) {
  return {bones:bones.map((b,i)=>({name:'b'+i,parent:i?0:-1,x:0,y:0,rotation:0,scaleX:1,scaleY:1,shearX:0,shearY:0,length:10,transform:'normal',skinRequired:false,...b})),
    slots:slots.map((s,i)=>({name:'s'+i,bone:0,color:'ffffffff',dark:null,attachment:null,blend:'normal',...s})),
    ik,transform,path,physics,animations:[],skins:[{name:'default',bones:[],ik:[],transform:[],path:[],physics:[],attachments}]};
}

test('global reflection and nonuniform scale surround all five inheritance modes',()=>{
  for(const transform of ['normal','onlyTranslation','noRotationOrReflection','noScale','noScaleOrReflection']){
    const data=poseData([{x:7,y:11,rotation:31,scaleX:-2,scaleY:3},{x:5,y:9,rotation:17,shearY:12,transform}]);
    const base=new player.Skeleton(data);base.updateWorld();
    for(const [sx,sy] of [[-1,1],[2,.5],[1,-1],[-2,-.5]]){
      const scaled=new player.Skeleton(data);scaled.scaleX=sx;scaled.scaleY=sy;scaled.x=13;scaled.y=-7;scaled.updateWorld();
      for(let i=0;i<base.bones.length;i++){
        const a=base.bones[i],b=scaled.bones[i];
        for(const [field,expected] of [['a',a.a*sx],['b',a.b*sx],['c',a.c*sy],['d',a.d*sy],['worldX',a.worldX*sx+13],['worldY',a.worldY*sy-7]])assert.ok(Math.abs(b[field]-expected)<1e-9,transform+'/'+field);
      }
    }
  }
});

test('translation-only applied recovery retains the reflected world axes',()=>{
  const skeleton=new player.Skeleton(poseData([{rotation:40},{transform:'onlyTranslation',rotation:20,scaleX:1.5,scaleY:2}]));
  skeleton.scaleX=-1;skeleton.updateWorld();const bone=skeleton.bones[1];bone.matrixOverride={...bone.matrix};
  const applied=skeleton.appliedFromWorld(bone);close(applied.rotation,180*Math.PI/3.1415927-20);close(applied.scaleX,1.5);close(applied.scaleY,-2);
  assert.ok(Math.abs(Math.abs(applied.shearY)-180)<1e-5);close(bone.rotation,20);
});

for(const transform of ['onlyTranslation','noRotationOrReflection'])test('one-bone IK aims through global reflection: '+transform,()=>{
  const data=poseData([{rotation:30,scaleX:1.5,scaleY:.7},{x:8,y:2,rotation:25,transform},{parent:-1,x:20,y:30}],
    {ik:[{name:'aim',order:0,bones:[1],target:2,mix:1,stretch:false,compress:false}]});
  for(const sx of [1,-1]){
    const s=new player.Skeleton(data);s.scaleX=sx;s.updateWorld({constraints:true});const b=s.bones[1],target=s.bones[2],dx=target.worldX-b.worldX,dy=target.worldY-b.worldY;
    assert.ok(Math.abs(b.a*dy-b.c*dx)<1e-7);assert.ok(b.a*dx+b.c*dy>0);close(b.rotation,25);
  }
});

function translationPhysicsChain(mix=1){
  return poseData([{}, {parent:0,rotation:30},{parent:1,x:10,rotation:20,transform:'onlyTranslation'},{parent:-1,x:30,y:40}],{
    ik:[{name:'inactiveAim',order:1,bones:[1],target:3,mix:0}],
    physics:[{name:'clothSpring',order:0,bone:2,x:0,y:0,rotate:1,scaleX:0,shearX:0,limit:5000,step:1/60,inertia:0,strength:0,damping:1,massInverse:1,wind:0,gravity:0,mix}]});
}
test('zero-mix ancestor IK rebuilds a translation-only descendant after physics reset',()=>{
  const s=new player.Skeleton(translationPhysicsChain());s.scaleX=-1;s.updateWorld({constraints:true});const b=s.bones[2],angle=20*3.1415927/180;
  close(b.a,Math.cos(angle));close(b.c,Math.sin(angle));close(b.d,-Math.cos(angle));close(b.rotation,20);
});
test('first physics activation during update recovers the descendant like reset',()=>{
  const s=new player.Skeleton(translationPhysicsChain(0));s.scaleX=-1;s.updateWorld({constraints:true});const angle=20*3.1415927/180;
  close(s.bones[2].a,-Math.cos(angle));s.constraints.physics[0].mix=1;s.update(1/30);s.updateWorld({constraints:true,physics:'update'});
  close(s.bones[2].a,Math.cos(angle));close(s.bones[2].d,-Math.cos(angle));close(s.bones[2].rotation,20);
});

test('authored crossfade takes the short rotation arc and preserves incoming scale reflection',()=>{
  const data=poseData([{}]);
  const timeline=(type,values)=>({type,bone:0,frames:[{time:0,values}],curves:[]});
  data.animations=[{name:'a',duration:1,timelines:[timeline('rotate',[170]),timeline('scale',[2,3])]},
    {name:'b',duration:1,timelines:[timeline('rotate',[-170]),timeline('scale',[-4,-5])]}];
  const s=new player.Skeleton(data),state=new player.AnimationState(s,{defaultMix:1});
  state.setAnimation(0,'a',true);state.apply();state.setAnimation(0,'b',true);state.update(.5);state.apply();
  close(s.bones[0].rotation,180);close(s.bones[0].scaleX,-3);close(s.bones[0].scaleY,-4);
  state.update(.5);state.apply();close(s.bones[0].rotation,-170);close(s.bones[0].scaleX,-4);
});

test('authored queue starts after the last applied track time reaches its delay and fires each event once',()=>{
  const data=poseData([{}]);data.events=[{name:'mark'}];
  data.animations=[{name:'a',duration:1,timelines:[]},{name:'b',duration:1,timelines:[{type:'event',frames:[{time:0,event:0,int:1,float:0,string:''}],curves:[]}]}];
  const s=new player.Skeleton(data),state=new player.AnimationState(s,{defaultMix:.25});
  state.setAnimation(0,'a',false);state.addAnimation(0,'b',true,0);state.apply();
  state.update(.8);state.apply();assert.equal(state.getCurrent().animation.name,'a');
  state.update(.1);const events=state.apply();assert.equal(state.getCurrent().animation.name,'b');
  close(state.getCurrent().trackTime,.15);close(state.getCurrent().mixTime,.1);assert.equal(events.length,1);
  state.update(.1);assert.equal(state.apply().length,0);
});

test('future keys blend toward setup during a crossfade while the same attachment retains deformation',()=>{
  const attachment={name:'soft',type:'mesh',weights:[[{bone:0,x:0,y:0,weight:1}]],vertices:[]};
  const data=poseData([{}],{slots:[{attachment:'soft'}],attachments:{0:{soft:attachment}}});
  const keyed=(type,values,time=0)=>({type,bone:0,frames:[{time,values}],curves:[]});
  const slotTimeline=(type,values,time=0)=>({type,slot:0,attachment,key:'soft',frames:[{time,values}],curves:[]});
  const attachmentTimeline={type:'attachment',slot:0,frames:[{time:0,name:'soft'}]};
  data.animations=[{name:'a',duration:1,timelines:[keyed('rotate',[40]),keyed('scale',[3,3]),attachmentTimeline,slotTimeline('deform',[10,20]),slotTimeline('alpha',[.4])]},
    {name:'b',duration:1,timelines:[keyed('rotate',[80],.5),keyed('scale',[4,4],.5),attachmentTimeline,slotTimeline('deform',[30,40],.5),slotTimeline('alpha',[.1],.5)]}];
  const s=new player.Skeleton(data),state=new player.AnimationState(s,{defaultMix:.25});
  state.setAnimation(0,'a',true);state.apply();s.setAttachment(0,'soft');assert.deepEqual(s.slots[0].deform,[10,20]);
  state.setAnimation(0,'b',false);state.update(.1);state.apply();
  close(s.bones[0].rotation,24);close(s.bones[0].scaleX,2.2);close(s.slots[0].color[3],.64);
  assert.deepEqual(s.slots[0].deform,[6,12]);
});

test('physics crossfade blends mass before taking its reciprocal',()=>{
  const data=poseData([{}],{physics:[{name:'mass',order:0,bone:0,massInverse:1}]});
  const keyed=mass=>({type:'physicsMass',physics:0,frames:[{time:0,values:[mass]}],curves:[]});
  data.animations=[{name:'heavy',duration:1,timelines:[keyed(3)]},{name:'light',duration:1,timelines:[keyed(1)]}];
  const s=new player.Skeleton(data),state=new player.AnimationState(s,{defaultMix:1});
  state.setAnimation(0,'heavy',true);state.apply();close(s.constraints.physics[0].massInverse,1/3);
  state.setAnimation(0,'light',true);state.update(.5);state.apply();close(s.constraints.physics[0].massInverse,.5);
});

test('non-looping sequence clock holds at the animation duration',()=>{
  const a={name:'strip',type:'region',sequence:{count:6,setupIndex:0}};
  const data=poseData([{}],{slots:[{attachment:'strip'}],attachments:{0:{strip:a}}});
  data.animations=[{name:'once',duration:1,timelines:[{type:'sequence',slot:0,key:'strip',attachment:a,frames:[{time:0,modeAndIndex:2,delay:.2}]}]}];
  const s=new player.Skeleton(data),state=new player.AnimationState(s);
  state.setAnimation(0,'once',false);state.update(1.3);state.apply();assert.equal(s.slots[0].sequenceIndex,5);
  state.update(1);state.apply();assert.equal(s.slots[0].sequenceIndex,5);
});

test('one-bone IK rotates and stretches world pose without changing local keyframe values',()=>{
  const s=new player.Skeleton(poseData([{}, {parent:-1,x:0,y:20}],{ik:[{name:'aim',order:0,bones:[0],target:1,mix:1,stretch:true,compress:false,uniform:false}]}));
  s.updateWorld({constraints:true});close(s.bones[0].a,0);close(s.bones[0].c,2);
  assert.equal(s.bones[0].rotation,0);assert.equal(s.bones[0].scaleX,1);
});

test('two-bone IK known right-angle chain reaches its target and respects bend sign',()=>{
  for(const bendDirection of [1,-1]) {
    const s=new player.Skeleton(poseData([{}, {x:10}, {parent:-1,x:10,y:10}],{ik:[{name:'chain',order:0,bones:[0,1],target:2,mix:1,bendDirection,softness:0,compress:false,stretch:false}]}));
    s.updateWorld({constraints:true});
    const end=player.math.transform(s.bones[1].matrix,10,0);close(end[0],10);close(end[1],10);
    assert.ok(s.bones[1].applied.rotation*bendDirection>0);
    assert.equal(s.bones[0].rotation,0);assert.equal(s.bones[1].rotation,0);
  }
});

test('two-bone IK softness smooths the reach boundary and uniform stretch reaches outside it',()=>{
  for(const [softness,stretch,reach] of [[20,false,195],[0,true,230]]) {
    const x=stretch?230:200;
    const s=new player.Skeleton(poseData([{length:100},{x:100,length:100},{parent:-1,x}],{ik:[{name:'chain',order:0,bones:[0,1],target:2,mix:1,bendDirection:1,softness,stretch,uniform:true}]}));
    s.updateWorld({constraints:true});const tip=player.math.transform(s.bones[1].matrix,100,0);
    close(tip[0],reach);close(tip[1],0);
  }
});

test('path tangent and chain scale follow an authored straight cubic at known distances',()=>{
  for(const rotateMode of [0,2]) {
    const route={name:'route',type:'path',closed:false,constantSpeed:true,vertexCount:6,vertices:[-10,0,0,0,100/3,0,200/3,0,100,0,110,0],lengths:[100,200]};
    const c={name:'route-follow',order:0,bones:[1,2],target:0,positionMode:1,spacingMode:2,rotateMode,rotation:0,position:.25,spacing:.2,mixRotate:1,mixX:1,mixY:1};
    const s=new player.Skeleton(poseData([{}, {length:10},{length:10}],{path:[c],slots:[{attachment:'route'}],attachments:{0:{route}}}));
    s.updateWorld({constraints:true});close(s.bones[1].worldX,25);close(s.bones[2].worldX,45);
    close(s.bones[1].a,rotateMode===2?2:1);close(s.bones[1].worldY,0);
  }
});

test('physics translation uses bounded inertia and a damped spring at a fixed step',()=>{
  const c={name:'spring',bone:0,order:0,x:1,y:0,rotate:0,scaleX:0,shearX:0,limit:1000,step:1/60,inertia:1,strength:100,damping:.9,massInverse:1,wind:0,gravity:0,mix:1};
  const s=new player.Skeleton(poseData([{}],{physics:[c]}));s.updateWorld({constraints:true});
  s.bones[0].x=10;s.updateWorld({constraints:true,physics:'update',delta:1/60});close(s.bones[0].worldX,5/18);
  s.updateWorld({constraints:true,physics:'update',delta:1/60});close(s.bones[0].worldX,0.79783950617284);
  const limited=new player.Skeleton(poseData([{}],{physics:[{...c,inertia:.5}]}));limited.updateWorld({constraints:true});
  limited.bones[0].x=100;limited.updateWorld({constraints:true,physics:'update',delta:1/60});close(limited.bones[0].worldX,100-1000/60*35/36);
});

test('physics rotational inertia preserves prior mixing through a moving two-bone chain',()=>{
  const c={order:0,x:0,y:0,rotate:1,scaleX:0,shearX:0,limit:5000,step:1/60,inertia:.5,strength:100,damping:.85,massInverse:1,wind:0,gravity:0,mix:.5};
  const s=new player.Skeleton(poseData([{}, {length:100},{parent:1,x:100,length:100}],{physics:[{...c,bone:1},{...c,order:1,bone:2}]}));
  s.updateWorld({constraints:true});s.bones[1].rotation=30;s.updateWorld({constraints:true,physics:'update',delta:1/30});
  s.bones[1].rotation=60;s.updateWorld({constraints:true,physics:'update',delta:1/30});
  close(Math.atan2(s.bones[2].c,s.bones[2].a)*180/Math.PI,29.150441557487465,0.00001);
});

test('combined spring scaling projects movement onto the axis after rotational inertia',()=>{
  const constraint={name:'combined',order:0,bone:1,x:0,y:0,rotate:.5,scaleX:1,shearX:0,limit:5000,step:.1,inertia:.5,strength:0,damping:1,massInverse:1,wind:0,gravity:0,mix:1};
  const s=new player.Skeleton(poseData([{}, {parent:0,length:100}],{physics:[constraint]}));
  s.updateWorld({constraints:true});s.bones[1].x=10;s.bones[1].y=10;s.update(.1);s.updateWorld({constraints:true,physics:'update'});
  const angle=Math.atan2(-10,90)*.25,scale=1+(-10*Math.cos(angle)-10*Math.sin(angle))*.5/100;
  close(Math.atan2(s.bones[1].c,s.bones[1].a),angle);close(Math.hypot(s.bones[1].a,s.bones[1].c),scale);
});

test('a constrained onlyTranslation descendant retains its world orientation when its parent changes',()=>{
  const s=new player.Skeleton(poseData([{}, {parent:0,rotation:60}, {parent:1,transform:'onlyTranslation',rotation:20}]));
  s.updateWorld();const b=s.bones[2];b.matrixOverride={...b.matrix};
  s.bones[1].applied.rotation=90;s.invalidateDescendants(1);s.updateBones();
  close(b.applied.rotation,20);close(Math.atan2(b.c,b.a),20*3.1415927/180);
});

test('absolute world transform constraint copies rotated target axes and offset position',()=>{
  const c={name:'copy',order:0,bones:[0],target:1,local:false,relative:false,rotation:0,x:1,y:2,scaleX:0,scaleY:0,shearY:0,
    mixRotate:1,mixX:1,mixY:1,mixScaleX:1,mixScaleY:1,mixShearY:1};
  const s=new player.Skeleton(poseData([{x:5,y:5},{parent:-1,x:20,y:30,rotation:90,scaleX:2,scaleY:3}],{transform:[c]}));
  s.updateWorld({constraints:true});
  close(s.bones[0].worldX,14);close(s.bones[0].worldY,32);close(s.bones[0].a,0);close(s.bones[0].b,-3);close(s.bones[0].c,2);close(s.bones[0].d,0);
});

test('unrotated trimmed region and weighted mesh deform have known world vertices',()=>{
  const region={name:'cut',path:'cut',type:'region',x:0,y:0,rotation:0,scaleX:1,scaleY:1,width:10,height:20};
  const mesh={name:'weighted',type:'mesh',vertexCount:1,weights:[[{bone:0,x:0,y:0,weight:0.25},{bone:1,x:0,y:0,weight:0.75}]]};
  const s=new player.Skeleton(poseData([{}, {x:20,y:40}],{slots:[{attachment:'cut'},{attachment:'weighted'}],attachments:{0:{cut:region},1:{weighted:mesh}}}));
  region.regions=[player.parseAtlas('synthetic.png\nsize:32,32\ncut\nbounds:0,0,6,10\noffsets:2,4,10,20').regions.get('cut')[0]];
  s.updateWorld();s.worldVertices(0).forEach((v,i)=>close(v,[-3,-6,-3,4,3,4,3,-6][i]));
  s.worldVertices(1).forEach((v,i)=>close(v,[15,30][i]));s.slots[1].deform=[2,4,0,0];s.worldVertices(1).forEach((v,i)=>close(v,[15.5,31][i]));
});

test('synthetic 90-degree atlas region maps the four logical corners correctly',()=>{
  const r=player.parseAtlas('synthetic.png\nsize:64,64\nrotated\nbounds:4,8,6,10\nrotate:90').regions.get('rotated')[0];
  const slot={attachment:{name:'rotated',type:'region',regions:[r]},sequenceIndex:-1};
  assert.deepEqual(player.attachmentUVs(slot),[14/64,14/64,4/64,14/64,4/64,8/64,14/64,8/64]);
});

test('trimmed rotated region rounds its known attachment corners before the bone transform',()=>{
  const region={name:'patch',path:'patch',type:'region',x:1.25,y:-3.5,rotation:30,scaleX:2,scaleY:.5,width:10,height:20};
  const s=new player.Skeleton(poseData([{x:13,y:7,scaleX:2,scaleY:.5}],{slots:[{attachment:'patch'}],attachments:{0:{patch:region}}}));
  s.bindAtlas(player.parseAtlas('synthetic.png\nsize:32,32\npatch\nbounds:0,0,6,10\noffsets:2,4,10,20'));s.updateWorld();
  const expected=[[-3,-6],[-3,4],[3,4],[3,-6]].flatMap(([x,y])=>{
    const lx=Math.fround(1.25+Math.sqrt(3)*x-.25*y),ly=Math.fround(-3.5+x+Math.sqrt(3)/4*y),boneRightAngle=3.1415927/2;
    return [13+2*lx+.5*Math.cos(boneRightAngle)*ly,7+.5*Math.sin(boneRightAngle)*ly];
  });
  s.worldVertices(0).forEach((v,i)=>close(v,expected[i],1e-9));
});

test('texture loading preserves declared atlas dimensions and fills only missing sizes',async()=>{
  const original=global.Image;
  global.Image=class {naturalWidth=68;naturalHeight=72;set src(value){if(value)queueMicrotask(()=>this.onload?.());}};
  try {
    const renderer=new player.Renderer({getContext:type=>type==='2d'?{}:null},{mode:'canvas2d'});
    const declared=player.parseAtlas('authored.png\nsize:64,64\npatch\nbounds:4,8,6,10');
    await renderer.loadTextures(declared,'https://synthetic.invalid/atlas.txt');
    assert.deepEqual([declared.pages[0].width,declared.pages[0].height],[64,64]);
    const slot={attachment:{name:'patch',type:'region',regions:declared.regions.get('patch')},sequenceIndex:-1};
    assert.deepEqual(player.attachmentUVs(slot),[4/64,18/64,4/64,8/64,10/64,8/64,10/64,18/64]);
    const omitted=player.parseAtlas('authored.png\npatch\nbounds:4,8,6,10');
    await renderer.loadTextures(omitted,'https://synthetic.invalid/atlas.txt');
    assert.deepEqual([omitted.pages[0].width,omitted.pages[0].height],[68,72]);
  } finally {if(original===undefined)delete global.Image;else global.Image=original;}
});

test('concave polygon triangulation conserves area and clipping interpolates UVs',()=>{
  const triangles=player.math.triangulatePolygon([[0,0],[2,0],[2,1],[1,1],[1,2],[0,2]]);
  const area=triangles.reduce((sum,[a,b,c])=>sum+Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2,0);
  assert.equal(area,3);
  const clipped=player.math.clipTriangle([[-1,0,0,0],[2,0,1,0],[0,2,1/3,1]],[[0,0],[1,0],[1,1],[0,1]]);
  for(const v of clipped){assert.ok(v[0]>=0 && v[0]<=1 && v[1]>=0 && v[1]<=1);close(v[2],(v[0]+1)/3);close(v[3],v[1]/2);}
});

test('convex clipping partitions conserve concave area without unnecessary rectangle edges',()=>{
  const area=polygon=>Math.abs(polygon.reduce((sum,p,i)=>{const q=polygon[(i+1)%polygon.length];return sum+p[0]*q[1]-p[1]*q[0];},0))/2;
  for(const points of [[[0,0],[2,0],[2,2],[0,2]],[[0,0],[2,0],[2,1],[1,1],[1,2],[0,2]]]) {
    for(const winding of [points,points.slice().reverse()]) {
      const parts=player.math.convexPartitions(winding);
      close(parts.reduce((sum,p)=>sum+area(p),0),area(points));
      for(const p of parts)for(let i=0;i<p.length;i++) {
        const [a,b,c]=[p[i],p[(i+1)%p.length],p[(i+2)%p.length]];
        assert.ok((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])>=0);
      }
      if(points.length===4)assert.equal(parts.length,1);
    }
  }
});

test('a clipping marker ending at its own slot masks subsequent attachments',()=>{
  const clip={name:'mask',type:'clipping',end:0,vertexCount:4,vertices:[0,0,1,0,1,1,0,1]},region={name:'square',path:'square',type:'region',color:'ffffffff',x:0,y:0,rotation:0,scaleX:1,scaleY:1,width:2,height:2};
  const s=new player.Skeleton(poseData([{}],{slots:[{attachment:'mask'},{attachment:'square'}],attachments:{0:{mask:clip},1:{square:region}}}));
  s.bindAtlas(player.parseAtlas('synthetic.png\nsize:32,32\nsquare\nbounds:0,0,2,2'));s.updateWorld();
  const commands=player.drawCommands(s);assert.equal(commands.length,1);
  let area=0;for(let i=0;i<commands[0].vertices.length;i+=3){const [a,b,c]=commands[0].vertices.slice(i,i+3);area+=Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;}
  close(area,1);for(const v of commands[0].vertices){assert.ok(v[0]>=-1e-6&&v[1]>=-1e-6&&v[0]<=1+1e-6&&v[1]<=1+1e-6);}
});
