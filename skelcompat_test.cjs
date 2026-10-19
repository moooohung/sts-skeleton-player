"use strict";
/* Authored synthetic exports; no game data or third-party runtime fixtures. */
const test=require('node:test'),assert=require('node:assert/strict');
const {probe}=require('./skelcompat.js');
const runtime=require('./skelplayer.js');
const atlas='synthetic.png\nsize: 16,16\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\ntile\n bounds: 0,0,16,16\n';
function writer(){
  const chunks=[];return {
    byte(n){chunks.push(Buffer.from([n]));return this;},
    uint(n){const b=Buffer.alloc(4);b.writeUInt32BE(n);chunks.push(b);return this;},
    float(n){const b=Buffer.alloc(4);b.writeFloatBE(n);chunks.push(b);return this;},
    var(n){do{this.byte((n&127)|(n>=128?128:0));n=Math.floor(n/128);}while(n);return this;},
    string(s){const b=Buffer.from(s);this.var(b.length+1);chunks.push(b);return this;},end(){return Buffer.concat(chunks);}
  };
}
function setup({version='4.2.43',slot=false}={}){
  const w=writer().uint(0).uint(0).string(version);
  for(const n of [0,0,16,16,100])w.float(n);
  w.byte(0).var(slot?1:0);if(slot)w.string('tile');
  w.var(1).string('root');for(const n of [0,0,0,1,1,0,0,0])w.float(n);w.var(0).byte(0);
  w.var(slot?1:0);if(slot)w.string('panel').var(0).uint(0xffffffff).uint(0xffffffff).var(1).var(0);
  for(let i=0;i<4;i++)w.var(0);return w;
}
function minimal(options){return setup(options).var(0).var(0).var(0).var(0).end();}
function eventExport(audio='',used=true){
  const w=setup().var(0).var(0).var(1).string('hit').var(0).float(0).string('').string(audio);
  if(audio)w.float(1).float(0);
  w.var(1).string('ping').var(used?1:0);
  for(let i=0;i<8;i++)w.var(0);
  w.var(used?1:0);
  if(used){w.float(0).var(0).var(0).float(0).byte(0);if(audio)w.float(1).float(0);}
  return w.end();
}
function sequenceExport(mode=0,delay=.1,count=3){
  const w=setup({slot:true}).var(1).var(0).var(1).var(1).byte(64).var(count).var(0).var(0).var(0);
  for(const v of [0,0,1,1,16,16])w.float(v);
  w.var(0).var(0).var(1).string('strip').var(1);
  for(let i=0;i<6;i++)w.var(0);
  return w.var(1).var(0).var(1).var(0).var(1).var(1).byte(1).var(1).float(0).uint(mode).float(delay).var(0).var(0).end();
}
test('sequence mode and delay compatibility gate accepts seven modes and rejects invalid metadata',()=>{
  const strips=atlas.replace('tile\n','tile0\n')+'tile1\n bounds: 0,0,16,16\ntile2\n bounds: 0,0,16,16\n';
  for(let mode=0;mode<7;mode++){const r=probe({skeleton:sequenceExport(mode),atlas:strips});assert.equal(r.status,'supported',JSON.stringify(r));assert(r.features.includes('timeline:sequence'));}
  for(const [mode,delay] of [[7,.1],[0,-1]]){const r=probe({skeleton:sequenceExport(mode,delay),atlas:strips});assert(r.unsupported.some(x=>x.feature==='timeline:sequence:mode-delay'));}
  assert(probe({skeleton:sequenceExport(0,.1,0),atlas:strips}).unsupported.some(x=>x.reason.includes('Invalid sequence')));
});

test('event payloads require an audio fallback only when a used event contains an audio path',()=>{
  const plain=probe({skeleton:eventExport(),atlas});
  assert.equal(plain.status,'supported');assert(plain.features.includes('timeline:event'));assert.equal(plain.fallbacks.length,0);
  const sound=probe({skeleton:eventExport('hit.wav'),atlas});
  assert.equal(sound.status,'supported with fallbacks');assert(sound.features.includes('event:audio'));assert(sound.fallbacks.some(f=>f.feature==='event:audio'));
  const unused=probe({skeleton:eventExport('hit.wav',false),atlas});assert.equal(unused.status,'supported');assert.equal(unused.fallbacks.length,0);
});
test('valid synthetic binary and atlas are supported without a visual-parity claim',()=>{
  const r=probe({skeleton:minimal(),atlas,pages:['synthetic.png']});assert.equal(r.status,'supported');assert.equal(r.version,'4.2.43');
  assert.equal(r.unsupported.length,0);assert.equal(r.action,'animate');
});
test('newer binary export header is rejected before interpreting its layout',()=>{
  const r=probe({skeleton:minimal({version:'4.3.0'}),atlas});assert.equal(r.status,'unsupported');assert.equal(r.unsupported[0].feature,'export-version:4.3.0');
});
test('missing texture page and malformed atlas separators report explicit reasons',()=>{
  const missing=probe({skeleton:minimal(),atlas,pages:[]});assert(missing.unsupported.some(r=>r.feature==='atlas:missing-page'));
  const broken=probe({skeleton:minimal(),atlas:atlas.replace('format:', '\nformat:')});assert(broken.unsupported.some(r=>r.feature==='atlas:property-after-page-separator'));
});
test('Canvas2D and duplicated Windows carriage returns are listed as fallbacks',()=>{
  const r=probe({skeleton:minimal(),atlas:atlas.replace(/\n/g,'\r\r\n'),renderer:'canvas2d'});
  assert.equal(r.status,'supported with fallbacks');assert(r.fallbacks.some(f=>f.feature==='renderer:canvas2d'));assert(r.fallbacks.some(f=>f.feature==='atlas:duplicated-carriage-return'));
});
test('unknown binary attachment and zero-length numeric timeline fail safely',()=>{
  const unknown=setup({slot:true}).var(1).var(0).var(1).var(1).byte(7).end();
  assert(probe({skeleton:unknown,atlas}).unsupported.some(r=>r.feature==='attachment:binary-type:7'&&r.reason.includes('Unknown attachment type')&&r.reason.includes('(type 7)')));
  const zero=setup().var(0).var(0).var(0).var(1).string('empty-rotate').var(1).var(0).var(1).var(0).var(1).byte(0).var(0).var(0).end();
  assert(probe({skeleton:zero,atlas}).unsupported.some(r=>r.reason.includes('Empty timeline')));
});
test('JSON inspection detects unknown attachments and honestly reports missing playback conversion',()=>{
  const r=probe({skeleton:JSON.stringify({skeleton:{spine:'4.2.43'},bones:[{name:'root'}],skins:[{name:'default',attachments:{panel:{tile:{type:'future-volume'}}}}]}),atlas});
  assert.equal(r.status,'unsupported');assert(r.unsupported.some(r=>r.feature==='attachment:future-volume'));assert(r.unsupported.some(r=>r.feature==='format:json-playback'));
});
test('authored truncation, bit mutations and random exports never escape the probe',()=>{
  const seed=minimal();let random=129;
  const next=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random;};
  let count=0;
  for(let length=0;length<seed.length;length++){const r=probe({skeleton:seed.subarray(0,length),atlas});assert.equal(r.status,'unsupported');count++;}
  for(let i=0;i<2000;i++){
    const b=i%2?Buffer.from(seed):Buffer.alloc(next()%256);for(let n=0;n<1+next()%8;n++)if(b.length)b[next()%b.length]=next()&255;
    const r=probe({skeleton:b,atlas:i%7?'':atlas});assert(['supported','supported with fallbacks','unsupported'].includes(r.status));
    if(r.status==='unsupported')assert(r.unsupported.length);count++;
    if(r.status!=='unsupported'){
      const s=new runtime.Skeleton(runtime.parseBinary(b));s.bindAtlas(runtime.parseAtlas(i%7?'':atlas));
      s.updateWorld({constraints:true,physics:'reset'});runtime.drawCommands(s);
    }
  }
  assert(count>2000);
});
test('supported empty-animation model updates and draws no commands',()=>{
  const skeleton=new runtime.Skeleton(runtime.parseBinary(minimal()));skeleton.bindAtlas(runtime.parseAtlas(atlas));skeleton.updateWorld({constraints:true});assert.deepEqual(runtime.drawCommands(skeleton),[]);
});
test('standalone CLI discovers missing atlas pages instead of accepting an omitted inventory',()=>{
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'packet129-cli-'));
  const skeleton=path.join(directory,'model.skel'),atlasFile=path.join(directory,'model.atlas');
  try{
    fs.writeFileSync(skeleton,minimal());fs.writeFileSync(atlasFile,atlas);
    const result=spawnSync(process.execPath,[path.join(__dirname,'probe_compatibility.cjs'),skeleton,atlasFile],{encoding:'utf8'});
    assert.equal(result.status,0);const report=JSON.parse(result.stdout);
    assert.equal(report.status,'unsupported');assert(report.unsupported.some(r=>r.feature==='atlas:missing-page'&&r.reason.includes('synthetic.png')));
  }finally{fs.unlinkSync(skeleton);fs.unlinkSync(atlasFile);fs.rmdirSync(directory);}
});
