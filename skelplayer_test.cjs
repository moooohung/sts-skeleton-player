"use strict";
/* Original synthetic fixtures only. No exported game or third-party runtime data. */
const test=require('node:test'),assert=require('node:assert/strict');
const player=require('./skelplayer.js');
test('intentional renderer disposal cannot allocate a recovery context',async()=>{
  const renderer=Object.create(player.Renderer.prototype);let replaced=0,lost=0;
  Object.assign(renderer,{textures:new Map(),images:new Map(),tintCache:new Map(),_replaceCanvas:()=>replaced++});
  renderer.gl={getExtension:()=>({loseContext:()=>{lost++;void renderer._recover('webgl2',Error('intentional disposal'));}})};
  renderer.dispose();await renderer._recover('webgpu',Error('late device event'));renderer.dispose();
  assert.equal(lost,1);assert.equal(replaced,0);assert.equal(renderer.gl,null);
});

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

// Expectations come from the 4.2 API reference and Applying Animations guide.
const keyX=(value,time=0)=>({type:'translateX',bone:0,frames:[{time,values:[value]}],curves:[]});
function stateFixture(){const data=poseData([{}]);data.animations=[{name:'base',duration:1,timelines:[keyX(10)]},{name:'a',duration:1,timelines:[keyX(20)]},{name:'b',duration:1,timelines:[keyX(40)]}];const skeleton=new player.Skeleton(data);return {data,skeleton,state:new player.AnimationState(skeleton,{defaultMix:1})};}
test('documented blend modes, alpha zero and before-first semantics',()=>{
  for(const [mode,expected] of [['setup',10],['first',35],['replace',35],['add',60]]){
    const {skeleton}=stateFixture();skeleton.bones[0].x=50;skeleton.applyAnimation('a',0,{alpha:.5,mixBlend:mode});close(skeleton.bones[0].x,expected);
  }
  for(const [mode,expected] of [['setup',0],['first',25],['replace',50],['add',50]]){
    const {data,skeleton}=stateFixture();data.animations[1].timelines=[keyX(20,.5)];skeleton.bones[0].x=50;skeleton.applyAnimation('a',0,{alpha:.5,mixBlend:mode});close(skeleton.bones[0].x,expected);
  }
  const {skeleton,state}=stateFixture();state.setAnimation(0,'base');state.setAnimation(1,'a').alpha=0;state.apply();close(skeleton.bones[0].x,10);
  state.getCurrent(1).alpha=.5;state.apply();close(skeleton.bones[0].x,15);
  state.getCurrent(1).mixBlend='add';state.apply();close(skeleton.bones[0].x,20);state.apply();close(skeleton.bones[0].x,20);
});
test('holdPrevious holds the upper outgoing pose at full strength during its mix',()=>{
  for(const [hold,expected] of [[false,27.5],[true,30]]){const {skeleton,state}=stateFixture();state.setAnimation(0,'base');state.setAnimation(1,'a');state.apply();state.setAnimation(1,'b').holdPrevious=hold;state.update(.5);state.apply();close(skeleton.bones[0].x,expected);}
});
test('upper first blends a future key toward setup while replace preserves the lower pose',()=>{
  for(const [blend,expected] of [['first',5],['replace',10]]){const {data,skeleton,state}=stateFixture();data.animations[1].timelines=[keyX(20,.5)];state.setAnimation(0,'base');const entry=state.setAnimation(1,'a');entry.alpha=.5;entry.mixBlend=blend;state.apply();close(skeleton.bones[0].x,expected);}
});
test('partial lower-track translation and color channels survive upper grouped timeline blending',()=>{
  const {data,skeleton,state}=stateFixture();data.animations[1].timelines=[{type:'translate',bone:0,frames:[{time:0,values:[20,40]}],curves:[]}];state.setAnimation(0,'base');state.setAnimation(1,'a').alpha=.5;state.apply();close(skeleton.bones[0].x,15);close(skeleton.bones[0].y,20);assert.equal(state.tracks[1],state.getCurrent(1));
  data.animations[1].timelines[0].frames[0].time=.5;state.apply();close(skeleton.bones[0].x,10);close(skeleton.bones[0].y,0);
  const d=poseData([{}],{slots:[{}]});d.animations=[{name:'alpha',duration:1,timelines:[{type:'alpha',slot:0,frames:[{time:0,values:[.2]}],curves:[]}]},{name:'rgba',duration:1,timelines:[{type:'rgba',slot:0,frames:[{time:0,values:[0,0,0,.8]}],curves:[]}]}];const s=new player.Skeleton(d),st=new player.AnimationState(s);st.setAnimation(0,'alpha');st.setAnimation(1,'rgba').alpha=.5;st.apply();close(s.slots[0].color[0],.5);close(s.slots[0].color[3],.5);
});
test('attachment alpha and outgoing draw-order thresholds apply only inside their thresholds',()=>{
  const a={type:'point'},b={type:'point'},data=poseData([{}],{slots:[{attachment:'a'},{attachment:'a'}],attachments:{0:{a,b},1:{a,b}}});data.animations=[{name:'a',duration:1,timelines:[{type:'attachment',slot:0,frames:[{time:0,name:'b'}]},{type:'drawOrder',frames:[{time:0,order:[1,0]}]}]},{name:'empty',duration:1,timelines:[]}];
  const s=new player.Skeleton(data),state=new player.AnimationState(s,{defaultMix:1});state.setAnimation(0,'empty');const entry=state.setAnimation(1,'a');entry.alpha=0;state.apply();assert.equal(s.slots[0].attachmentName,'a');entry.alpha=1;state.apply();assert.equal(s.slots[0].attachmentName,'b');entry.mixAttachmentThreshold=.75;entry.mixDrawOrderThreshold=.75;state.setAnimation(1,'empty');state.update(.5);state.apply();assert.equal(s.slots[0].attachmentName,'b');assert.deepEqual(s.drawOrder,[1,0]);state.update(.3);state.apply();assert.equal(s.slots[0].attachmentName,'a');assert.deepEqual(s.drawOrder,[0,1]);
});
test('empty animations fade to setup or lower tracks, including zero duration and fade in',()=>{
  for(const track of [0,1]){const {skeleton,state}=stateFixture();if(track)state.setAnimation(0,'base');state.setAnimation(track,'a');state.apply();const empty=state.setEmptyAnimation(track,1);assert(empty.isEmptyAnimation());state.update(.5);state.apply();close(skeleton.bones[0].x,track?15:10);state.update(.5);state.apply();close(skeleton.bones[0].x,track?10:0);state.update(.01);state.apply();assert.equal(state.getCurrent(track),null);}
  const {skeleton,state}=stateFixture();state.setAnimation(0,'a');state.apply();state.setEmptyAnimation(0,0);state.update(0);state.apply();close(skeleton.bones[0].x,0);state.update(0);state.apply();assert.equal(state.current,null);
  state.setEmptyAnimation(0,0);const entry=state.addAnimation(0,'b');entry.setMixDuration(1,0);state.apply();state.update(.5);state.apply();close(skeleton.bones[0].x,20);
});
test('clearing tracks preserves the last pose and ends/disposes started and queued entries once',()=>{
  const {skeleton,state}=stateFixture(),seen=[];for(const type of ['start','interrupt','end','dispose'])state.addListener({[type]:e=>seen.push(type+':'+e.animation.name)});
  state.setAnimation(0,'a');state.apply();state.addAnimation(0,'b');state.clearTracks();state.apply();close(skeleton.bones[0].x,20);
  assert.deepEqual(seen,['start:a','end:a','dispose:a','dispose:b']);state.clearTracks();assert.equal(seen.length,4);
});
test('events and completes are ordered across loops, repeated apply and reentrant listeners',()=>{
  const {data,state}=stateFixture(),seen=[];data.animations[1].timelines.push({type:'event',frames:[{time:0,string:'zero'},{time:.5,string:'half'},{time:1,string:'end'}]});
  state.addListener({event:(e,v)=>seen.push(v.string),complete:()=>seen.push('complete')});state.setAnimation(0,'a',true);state.apply();state.update(2.1);state.apply();state.apply();
  assert.deepEqual(seen,['zero','half','end','complete','zero','half','end','complete','zero']);
  const order=[];state.clearListeners();state.addListener({event:()=>{order.push('event');state.setAnimation(0,'b');},interrupt:()=>order.push('interrupt'),start:()=>order.push('start')});state.update(.5);state.apply();assert.deepEqual(order,['event','interrupt','start']);assert.equal(state.current.animation.name,'b');
});
test('outgoing event thresholds, lifecycle and per-entry listeners',()=>{
  const {data,state}=stateFixture(),seen=[];data.animations[1].timelines.push({type:'event',frames:[{time:.25,string:'hit'}]});
  state.addListener({start:e=>seen.push('start:'+e.animation.name),interrupt:e=>seen.push('interrupt:'+e.animation.name),end:e=>seen.push('end:'+e.animation.name),dispose:e=>seen.push('dispose:'+e.animation.name),event:e=>seen.push('event:'+e.animation.name)});
  const a=state.setAnimation(0,'a');a.listener={event:()=>seen.push('entry-event')};a.eventThreshold=.5;state.apply();state.setAnimation(0,'b');state.update(.25);state.apply();state.update(.8);state.apply();state.update(0);state.apply();
  assert.deepEqual(seen,['start:a','interrupt:a','start:b','entry-event','event:a','end:a','dispose:a']);
});
test('explicit animationLast skips earlier events after playback has already begun',()=>{
  const {data,state}=stateFixture();data.animations[1].timelines.push({type:'event',frames:[{time:.1},{time:.3},{time:.6}]});const entry=state.setAnimation(0,'a');state.apply();state.update(.8);entry.animationLast=.4;assert.deepEqual(state.apply().map(e=>e.time),[.6]);
});
test('additive physics mass operates in mass units before inversion',()=>{
  const data=poseData([{}],{physics:[{order:0,bone:0,massInverse:.5}]}),key=mass=>({type:'physicsMass',physics:0,frames:[{time:0,values:[mass]}],curves:[]});data.animations=[{name:'base',duration:1,timelines:[key(4)]},{name:'delta',duration:1,timelines:[key(6)]}];const s=new player.Skeleton(data),state=new player.AnimationState(s);state.setAnimation(0,'base');const entry=state.setAnimation(1,'delta');entry.mixBlend='add';entry.alpha=.5;state.apply();close(s.constraints.physics[0].massInverse,1/6);
});
test('entry delays, time scales, animation ranges, reverse and trackEnd',()=>{
  const {data,skeleton,state}=stateFixture();data.animations[1].timelines=[{type:'translateX',bone:0,frames:[{time:0,values:[0]},{time:1,values:[100]}],curves:[]},{type:'event',frames:[{time:.5}]}];
  const entry=state.addAnimation(0,'a',false,.5);entry.timeScale=2;state.update(.1);state.apply();assert.equal(entry.trackTime,0);state.update(.2);state.apply();close(entry.trackTime,.1);
  entry.animationStart=.25;entry.animationEnd=.75;entry.trackTime=.1;entry.reverse=true;assert.equal(state.apply().length,0);close(skeleton.bones[0].x,65);
  entry.reverse=false;entry.trackTime=.25;state.apply();close(skeleton.bones[0].x,50);entry.trackEnd=.5;state.update(.2);state.apply();close(skeleton.bones[0].x,0);assert.equal(state.current,null);
});
test('a delayed first entry leaves the current skeleton pose alone until playback starts',()=>{
  const {skeleton,state}=stateFixture();skeleton.bones[0].x=7;const entry=state.addAnimation(0,'a',false,.5);state.apply();close(skeleton.bones[0].x,7);state.update(.25);state.apply();close(skeleton.bones[0].x,7);state.update(.5);state.apply();close(skeleton.bones[0].x,20);close(entry.trackTime,.25);
});
test('setEmptyAnimations fades all occupied tracks and updateCache follows constraint order',()=>{
  const {skeleton,state}=stateFixture();state.setAnimation(0,'base');state.setAnimation(2,'a');state.apply();state.setEmptyAnimations(.5);state.update(.5);state.apply();close(skeleton.bones[0].x,0);state.update(.01);state.apply();assert.equal(state.getCurrent(0),null);assert.equal(state.getCurrent(2),null);
  const s=new player.Skeleton(poseData([{}],{ik:[{order:1}],transform:[{order:0}]}));const calls=[];s.applyIK=()=>calls.push('ik');s.applyTransform=()=>calls.push('transform');s.updateWorld({constraints:true});assert.deepEqual(calls,['transform','ik']);calls.length=0;s.constraints.ik[0].order=-1;s.updateCache();s.updateWorld({constraints:true});assert.deepEqual(calls,['ik','transform']);
});
test('shortestRotation and resetRotationDirections control remembered winding',()=>{
  const {data,skeleton,state}=stateFixture();data.animations[1].timelines=[{type:'rotate',bone:0,frames:[{time:0,values:[170]},{time:1,values:[190]}],curves:[]}];state.setAnimation(0,'base');const a=state.setAnimation(1,'a');a.alpha=.5;state.apply();close(skeleton.bones[0].rotation,85);state.update(1);state.apply();close(skeleton.bones[0].rotation,95);a.shortestRotation=true;state.apply();close(skeleton.bones[0].rotation,-85);a.resetRotationDirections();assert.equal(a.rotationWinding.size,0);
});
test('all sequence modes, delay boundaries, single images and invalid mode fail closed',()=>{
  const attachment={type:'region',sequence:{count:3,setupIndex:1}},data=poseData([{}],{slots:[{attachment:'strip'}],attachments:{0:{strip:attachment}}}),frame={time:0,modeAndIndex:0,delay:.25};data.animations=[{name:'strip',duration:2,timelines:[{type:'sequence',slot:0,key:'strip',attachment,frames:[frame]}]}];const s=new player.Skeleton(data);
  for(const [mode,expected] of [[0,[0,0,0,0,0]],[1,[0,1,2,2,2]],[2,[0,1,2,0,1]],[3,[0,1,2,1,0]],[4,[2,1,0,0,0]],[5,[2,1,0,2,1]],[6,[2,1,0,1,2]]]){frame.modeAndIndex=mode;for(let i=0;i<5;i++){s.applyAnimation('strip',i*.25);assert.equal(s.slots[0].sequenceIndex,expected[i]);}}
  attachment.sequence.count=1;for(const mode of [0,1,2,3,4,5,6]){frame.modeAndIndex=mode;s.applyAnimation('strip',1);assert.equal(s.slots[0].sequenceIndex,0);}frame.modeAndIndex=7;assert.throws(()=>s.applyAnimation('strip',0),/Invalid sequence/);
});
test('physics none and pose do not advance simulation; reset timeline resets at the current world pose',()=>{
  const c={name:'spring',order:0,bone:0,x:1,y:1,rotate:0,scaleX:0,shearX:0,limit:1000,step:1/60,inertia:1,strength:10,damping:.9,massInverse:1,wind:1,gravity:1,mix:1};const data=poseData([{}],{physics:[c]}),s=new player.Skeleton(data);s.updateWorld({constraints:true,physics:'none'});assert.equal(s.constraints.physics[0].simulation,undefined);s.updateWorld({constraints:true,physics:'pose'});assert.equal(s.constraints.physics[0].simulation,undefined);s.updateWorld({constraints:true,physics:'reset'});s.bones[0].x=10;s.update(.1);s.updateWorld({constraints:true,physics:'update'});const saved=JSON.stringify(s.constraints.physics[0].simulation);s.update(.1);s.updateWorld({constraints:true,physics:'pose'});assert.equal(JSON.stringify(s.constraints.physics[0].simulation),saved);s.updateWorld({constraints:true,physics:'none'});close(s.bones[0].worldX,10);assert.equal(JSON.stringify(s.constraints.physics[0].simulation),saved);
  data.animations=[{name:'reset',duration:1,timelines:[{type:'physicsReset',physics:-1,frames:[{time:.5}]}]}];const state=new player.AnimationState(s);state.setAnimation(0,'reset',true);state.apply();state.update(.6);state.apply();s.bones[0].x=30;s.updateWorld({constraints:true,physics:'update'});close(s.bones[0].worldX,30);close(s.constraints.physics[0].simulation.vx,0);
});
test('degenerate clipping vertices conserve concave area and collapsed polygons draw nothing',()=>{
  const polygon=[[0,0],[1,0],[2,0],[2,2],[1,1],[0,2],[0,2],[0,0]],triangles=player.math.triangulatePolygon(polygon);const area=triangles.reduce((n,[a,b,c])=>n+Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2,0);close(area,3);assert.deepEqual(player.math.triangulatePolygon([[0,0],[1,0],[2,0],[0,0]]),[]);assert.throws(()=>player.math.triangulatePolygon([[0,0],[1,NaN],[1,1]]),/Non-finite/);
});

function boundsPlayer(fingerprint='bounds-fixture-175') {
  const region={name:'patch',path:'patch',type:'region',x:3,y:2,rotation:0,scaleX:1,scaleY:1,width:8,height:12};
  const data=poseData([{}],{slots:[{attachment:'patch'}],attachments:{0:{patch:region}}});
  data.animations=[{name:'move',duration:1,timelines:[{type:'translate',bone:0,frames:[{time:0,values:[0,0]},{time:1,values:[17,9]}],curves:[]}]}];
  data.skins.push({...data.skins[0],name:'alternate'});
  const instance=Object.create(player.Player.prototype);
  Object.assign(instance,{data,atlas:player.parseAtlas('synthetic.png\nsize:32,32\npatch\nbounds:0,0,8,12'),skeleton:new player.Skeleton(data),_boundsFingerprint:fingerprint});
  instance.skeleton.bindAtlas(instance.atlas);instance.boundsSamples=0;
  instance.bounds=function(...args){this.boundsSamples++;return player.Player.prototype.bounds.apply(this,args);};
  return instance;
}

test('bounds reuse across identical players preserves results and returns independent copies',()=>{
  const plain=boundsPlayer(),first=boundsPlayer(),second=boundsPlayer();
  const expected=plain.animationBounds('move'),actual=first.animationBounds('move',{cacheNamespace:'identical'});
  assert.deepEqual(actual,expected);assert.ok(first.boundsSamples>1);
  actual.x=999;
  const reused=second.animationBounds('move',{cacheNamespace:'identical'});
  assert.deepEqual(reused,expected);assert.equal(second.boundsSamples,0);assert.equal(second.boundsCacheHits,1);
  reused.width=999;assert.deepEqual(second.animationBounds('move',{cacheNamespace:'identical'}),expected);
});

test('bounds cache keys include content, caller edits, animation, skin, reflection, sampling and atlas size',()=>{
  boundsPlayer().animationBounds('move',{cacheNamespace:'invalidation'});
  for(const configure of [p=>p._boundsFingerprint+='changed',p=>p.skeleton.setSkin('alternate'),
    p=>p.skeleton.scaleX=-1,p=>p.skeleton.scaleY=2,p=>p.atlas.pages[0].width=64,
    p=>p.data.animations.push({...p.data.animations[0],name:'other'})]) {
    const p=boundsPlayer();configure(p);const name=p.data.animations.at(-1).name;
    assert.deepEqual(p.animationBounds(name,{cacheNamespace:'invalidation'}),p.animationBounds(name));assert.ok(p.boundsSamples>1);assert.equal(p.boundsCacheHits,undefined);
  }
  for(const options of [{cacheNamespace:'other'},{cacheNamespace:'invalidation',step:.2},{}]) {
    const p=boundsPlayer();assert.deepEqual(p.animationBounds('move',options),p.animationBounds('move',{step:options.step}));assert.ok(p.boundsSamples>1);assert.equal(p.boundsCacheHits,undefined);
  }
  assert.throws(()=>boundsPlayer().animationBounds('move',{cacheNamespace:'invalidation',step:0}),/Invalid sampling step/);
  assert.throws(()=>boundsPlayer().animationBounds('missing',{cacheNamespace:'invalidation'}),/Unknown animation/);
});

test('bounds cache evicts the oldest entry and cannot reuse without a content fingerprint',()=>{
  boundsPlayer('evict-first').animationBounds('move',{cacheNamespace:'eviction'});
  for(let i=0;i<256;i++)boundsPlayer('evict-'+i).animationBounds('move',{step:1,cacheNamespace:'eviction'});
  const evicted=boundsPlayer('evict-first');evicted.animationBounds('move',{cacheNamespace:'eviction'});assert.ok(evicted.boundsSamples>1);
  const noFingerprint=boundsPlayer(null);noFingerprint.animationBounds('move',{cacheNamespace:'identical'});assert.ok(noFingerprint.boundsSamples>1);assert.equal(noFingerprint.boundsCacheHits,undefined);
});

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

test('game mix pairs override defaults for repeated attacks and queued idle',()=>{
  const data=poseData([{}]);data.animations=['idle','attack'].map(name=>({name,duration:1,timelines:[]}));
  const state=new player.AnimationState(new player.Skeleton(data),{defaultMix:.05,mixes:[{from:'idle',to:'attack',duration:.1},{from:'attack',to:'attack',duration:0}]});
  state.setAnimation(0,'idle',true);state.apply();assert.equal(state.setAnimation(0,'attack').mixDuration,.1);state.apply();
  assert.equal(state.setAnimation(0,'attack').mixDuration,0);
  const queued=state.addAnimation(0,'idle',true);close(queued.delay,.95);close(queued.mixDuration,.05);
});

test('replacement before first apply skips the unapplied animation and its queue',()=>{
  const data=poseData([{}]);data.animations=['idle','attack','hurt'].map(name=>({name,duration:1,timelines:[]}));
  const state=new player.AnimationState(new player.Skeleton(data));state.setAnimation(0,'idle');state.apply();
  state.setAnimation(0,'attack');state.addAnimation(0,'hurt');
  const current=state.setAnimation(0,'attack');assert.equal(current.mixingFrom.animation.name,'idle');assert.equal(current.next,null);
});

test('interruption weight belongs to the incoming entry and cannot compound before apply',()=>{
  const data=poseData([{}]);data.animations=['idle','attack'].map(name=>({name,duration:1,timelines:[]}));
  const state=new player.AnimationState(new player.Skeleton(data),{defaultMix:.1});state.setAnimation(0,'idle');state.apply();
  const attack=state.setAnimation(0,'attack');state.update(.025);state.apply();
  const first=state.setAnimation(0,'attack');close(first.interruptAlpha,.25);close(attack.interruptAlpha,1);
  const second=state.setAnimation(0,'attack');close(second.interruptAlpha,.25);close(attack.interruptAlpha,1);
  state.apply();state.update(.2);state.apply();state.update(.01);state.apply();
  const idle=state.setAnimation(0,'idle');close(idle.interruptAlpha,1);
});

test('third applied interruption uses the preceding mix progress without compounding its weight',()=>{
  const data=poseData([{}]);data.animations=['idle','attack'].map(name=>({name,duration:1,timelines:[]}));
  const state=new player.AnimationState(new player.Skeleton(data),{defaultMix:.25});state.setAnimation(0,'idle');state.apply();
  state.setAnimation(0,'attack');state.update(.15);state.apply();
  const second=state.setAnimation(0,'attack');close(second.interruptAlpha,.6);state.update(.15);state.apply();
  const third=state.setAnimation(0,'attack');close(third.interruptAlpha,.6);
});

test('zero duration transition restores outgoing properties once before dropping the mix',()=>{
  const data=poseData([{}]);data.animations=[{name:'idle',duration:1,timelines:[{type:'translateX',bone:0,frames:[{time:0,values:[40]}],curves:[]}]},{name:'attack',duration:1,timelines:[]}];
  const s=new player.Skeleton(data),state=new player.AnimationState(s,{defaultMix:0});state.setAnimation(0,'idle');state.apply();close(s.bones[0].x,40);
  state.setAnimation(0,'attack');state.update(.01);state.apply();close(s.bones[0].x,0);
  state.update(.01);state.apply();assert.equal(state.current.mixingFrom,null);close(s.bones[0].x,0);
});

test('secondary track holds independent properties and restores its outgoing scale after mixing',()=>{
  const data=poseData([{},{}]);
  const key=(type,bone,values)=>({type,bone,frames:[{time:0,values}],curves:[]});
  data.animations=[{name:'walk',duration:2,timelines:[key('translateX',0,[30])]},
    {name:'grow',duration:.1,timelines:[key('scale',1,[.5,.5])]},
    {name:'hold',duration:1,timelines:[key('rotate',1,[60])]}];
  const s=new player.Skeleton(data),state=new player.AnimationState(s,{defaultMix:.05});state.setAnimation(0,'walk',true);
  state.setAnimation(1,'grow');state.addAnimation(1,'hold',true);state.apply();
  for(let n=0;n<20;n++){state.update(.01);state.apply();}
  close(s.bones[0].x,30);close(s.bones[1].scaleX,1);close(s.bones[1].rotation,60);
  assert.equal(state.getCurrent(0).animation.name,'walk');assert.equal(state.getCurrent(1).animation.name,'hold');
  state.clearTrack(1);assert.equal(state.getCurrent(1),null);assert.equal(state.getCurrent().animation.name,'walk');
});

test('skin changes preserve animated slot color and select matching live attachment keys',()=>{
  const original={name:'original',type:'point'},alternate={name:'alternate',type:'point'},other={name:'manual',type:'point'};
  const data=poseData([{}],{slots:[{attachment:'part'}],attachments:{0:{part:original,manual:other}}});
  data.skins.push({...data.skins[0],name:'alternate',attachments:{0:{part:alternate}}});
  const s=new player.Skeleton(data);s.slots[0].color[3]=.4;s.drawOrder=[0];s.setSkin('alternate');
  assert.equal(s.slots[0].attachment,alternate);close(s.slots[0].color[3],.4);
  s.setAttachment(0,'manual');s.setSkin('default');assert.equal(s.slots[0].attachment,other);
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
