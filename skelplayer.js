"use strict";
/* First-party skeletal player. Written from public file-format documents,
 * exported game data, and general mathematics. See cleanroom_log.md.
 * No Spine runtime implementation was read or incorporated. */
const SkelPlayer = (() => {
  class FormatError extends Error {
    constructor(message, offset = null) {
      super(offset === null ? message : `${message} at byte ${offset}`);
      this.name = "SkelFormatError";
      this.offset = offset;
    }
  }
  class Reader {
    constructor(input) {
      this.bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
      this.pos = 0;
      this.strings = [];
      this.decoder = new TextDecoder("utf-8", { fatal: true });
    }
    need(n) {
      if (!Number.isSafeInteger(n) || n < 0 || n > this.bytes.length - this.pos)
        throw new FormatError("Truncated skeleton", this.pos);
    }
    byte() { this.need(1); return this.bytes[this.pos++]; }
    bool() {
      const p = this.pos, n = this.byte();
      if (n > 1) throw new FormatError("Invalid boolean", p);
      return n === 1;
    }
    skip(n) { this.need(n); this.pos += n; }
    uint32() { this.need(4); const n = this.view.getUint32(this.pos); this.pos += 4; return n; }
    float() {
      this.need(4); const n = this.view.getFloat32(this.pos); this.pos += 4;
      if (!Number.isFinite(n)) throw new FormatError("Non-finite float", this.pos - 4);
      return n;
    }
    varint(signed = false) {
      const p = this.pos;
      let n = 0;
      for (let shift = 0; shift <= 28; shift += 7) {
        const b = this.byte();
        if (shift === 28 && (b & 0xf0)) throw new FormatError("Invalid varint", p);
        n += (b & 127) * 2 ** shift;
        if (!(b & 128)) return signed ? (n >>> 1) ^ -(n & 1) : n;
      }
      throw new FormatError("Invalid varint", p);
    }
    count(label = "count") {
      const n = this.varint();
      if (n > this.bytes.length - this.pos) throw new FormatError(`Invalid ${label}`, this.pos);
      return n;
    }
    string() {
      const n = this.varint();
      if (n === 0) return null;
      this.need(n - 1);
      let value;
      try { value = this.decoder.decode(this.bytes.subarray(this.pos, this.pos + n - 1)); }
      catch (_) { throw new FormatError("Invalid UTF-8", this.pos); }
      this.pos += n - 1;
      return value;
    }
    ref() {
      const p = this.pos, i = this.varint();
      if (i > this.strings.length) throw new FormatError("Invalid string reference", p);
      return i ? this.strings[i - 1] : null;
    }
    color() { return this.uint32().toString(16).padStart(8, "0"); }
    index(items, label) {
      const p = this.pos, i = this.varint();
      if (i >= items.length) throw new FormatError(`Invalid ${label} index`, p);
      return i;
    }
  }

  function parseAtlas(text) {
    const pages = [], regions = new Map();
    let page = null, region = null, newPage = true;
    for (const raw of text.replace(/\r/g, "").split("\n")) {
      const line = raw.trim();
      if (!line) { newPage = true; region = null; continue; }
      const colon = line.indexOf(":");
      if (colon < 0) {
        if (newPage) {
          page = { name: line, width: 0, height: 0, pma: false, filter: "Nearest,Nearest" };
          pages.push(page); region = null; newPage = false;
        } else {
          region = { name: line, page, x: 0, y: 0, width: 0, height: 0, rotate: 0,
            offsetX: 0, offsetY: 0, originalWidth: 0, originalHeight: 0, index: -1 };
          if (!regions.has(line)) regions.set(line, []);
          regions.get(line).push(region);
        }
        continue;
      }
      if (!page) throw new FormatError("Atlas property without a page");
      const key = line.slice(0, colon).trim(), value = line.slice(colon + 1).trim();
      const nums = () => value.split(",").map(x => Number(x.trim()));
      if (!region) {
        if (key === "size") [page.width, page.height] = nums();
        else if (key === "pma") page.pma = value === "true";
        else page[key] = value;
      } else {
        if (key === "bounds") [region.x, region.y, region.width, region.height] = nums();
        else if (key === "xy") [region.x, region.y] = nums();
        else if (key === "size") [region.width, region.height] = nums();
        else if (key === "offsets") [region.offsetX, region.offsetY, region.originalWidth, region.originalHeight] = nums();
        else if (key === "offset") [region.offsetX, region.offsetY] = nums();
        else if (key === "orig") [region.originalWidth, region.originalHeight] = nums();
        else if (key === "rotate") region.rotate = value === "true" ? 90 : value === "false" ? 0 : Number(value);
        else if (key === "index") region.index = Number(value);
        else region[key] = value;
      }
    }
    for (const list of regions.values()) for (const r of list) {
      r.originalWidth ||= r.width; r.originalHeight ||= r.height;
      if (![r.x, r.y, r.width, r.height, r.offsetX, r.offsetY, r.originalWidth, r.originalHeight, r.rotate].every(Number.isFinite)
          || r.width <= 0 || r.height <= 0 || ![0, 90, 180, 270].includes(r.rotate))
        throw new FormatError(`Invalid atlas region: ${r.name}`);
    }
    if (!pages.length) throw new FormatError("Empty atlas");
    return { pages, regions };
  }

  // Pose compatibility constants established from public numeric observations.
  // The standalone affine helper retains the exact mathematical conversion.
  const posePi=3.1415927,radians=posePi/180,degrees=180/posePi;
  function localMatrix(b,angleFactor=Math.PI/180) {
    const xAngle = (b.rotation + b.shearX) * angleFactor;
    const yAngle = (b.rotation + 90 + b.shearY) * angleFactor;
    return { a: Math.cos(xAngle) * b.scaleX, b: Math.sin(xAngle) * b.scaleX,
      c: Math.cos(yAngle) * b.scaleY, d: Math.sin(yAngle) * b.scaleY, x: b.x, y: b.y };
  }
  function multiply(p, q) {
    return { a: p.a*q.a + p.c*q.b, b: p.b*q.a + p.d*q.b,
      c: p.a*q.c + p.c*q.d, d: p.b*q.c + p.d*q.d,
      x: p.a*q.x + p.c*q.y + p.x, y: p.b*q.x + p.d*q.y + p.y };
  }
  function transform(m, x, y) { return [m.a*x + m.c*y + m.x, m.b*x + m.d*y + m.y]; }
  function inverse(m) {
    const det = m.a*m.d - m.b*m.c;
    if (Math.abs(det) < 1e-12) throw new FormatError("Singular transform");
    const a=m.d/det, b=-m.b/det, c=-m.c/det, d=m.a/det;
    return { a,b,c,d,x:-a*m.x-c*m.y,y:-b*m.x-d*m.y };
  }
  function parseBinarySetup(input, { constraints = true } = {}) {
    const r = new Reader(input);
    const hash = r.uint32().toString(16).padStart(8,"0") + r.uint32().toString(16).padStart(8,"0");
    const version = r.string();
    if (!/^4\.2\.\d+$/.test(version || "")) throw new FormatError(`Unsupported binary version: ${version}`);
    const skeleton = { hash, version, x:r.float(), y:r.float(), width:r.float(), height:r.float(), referenceScale:r.float() };
    const nonessential = r.bool();
    if (nonessential) Object.assign(skeleton, { fps:r.float(), images:r.string(), audio:r.string() });
    const strings = r.count("shared strings");
    for (let i=0;i<strings;i++) r.strings.push(r.string());
    const bones = [], modes = ["normal","onlyTranslation","noRotationOrReflection","noScale","noScaleOrReflection"];
    const boneCount = r.count("bones");
    for (let i=0;i<boneCount;i++) {
      const name = r.string(), parent = i ? r.index(bones,"parent bone") : -1;
      const b = { name,parent,rotation:r.float(),x:r.float(),y:r.float(),scaleX:r.float(),scaleY:r.float(),
        shearX:r.float(),shearY:r.float(),length:r.float() };
      const mode = r.varint();
      if (mode >= modes.length) throw new FormatError("Unknown inheritance mode",r.pos);
      b.transform=modes[mode]; b.skinRequired=r.bool();
      if (nonessential) { b.color=r.color(); b.icon=r.string(); b.visible=r.bool(); }
      bones.push(b);
    }
    const slots = [], blends = ["normal","additive","multiply","screen"];
    const slotCount = r.count("slots");
    for (let i=0;i<slotCount;i++) {
      const name=r.string(), bone=r.index(bones,"slot bone"), color=r.color(), dark=r.color(), attachment=r.ref();
      const blend=r.varint();
      if (blend >= blends.length) throw new FormatError("Unknown blend mode",r.pos);
      const slot={name,bone,color,dark:dark === "ffffffff" ? null : dark.slice(2)+"00",attachment,blend:blends[blend]};
      if (nonessential) slot.visible=r.bool();
      slots.push(slot);
    }
    if (!constraints) return {skeleton,bones,slots,reader:r,nonessential};
    const ik = [], ikCount = r.count("IK constraints");
    for (let i=0;i<ikCount;i++) {
      const name=r.string(), order=r.varint(), boneCount=r.count("IK bones"), affected=[];
      if (boneCount < 1 || boneCount > 2) throw new FormatError("Invalid IK chain",r.pos);
      for (let j=0;j<boneCount;j++) affected.push(r.index(bones,"IK bone"));
      const target=r.index(bones,"IK target"), flags=r.byte();
      ik.push({name,order,bones:affected,target,skinRequired:!!(flags&1),bendDirection:flags&2 ? 1 : -1,
        compress:!!(flags&4),stretch:!!(flags&8),uniform:!!(flags&16),
        mix:flags&32 ? flags&64 ? r.float() : 1 : 0, softness:flags&128 ? r.float() : 0});
    }
    return { skeleton,bones,slots,ik,reader:r,nonessential };
  }
  function readSequence(r) {
    return {count:r.count("sequence images"),start:r.varint(),digits:r.varint(),setupIndex:r.varint()};
  }
  function readVertices(r, weighted, boneCount) {
    const count=r.count("vertices"), vertices=[], weights=weighted ? [] : null;
    if (weighted) {
      for(let i=0;i<count;i++) {
        const n=r.count("vertex influences");
        if (!n) throw new FormatError("Weighted vertex without influences",r.pos);
        const influences=[];
        for(let j=0;j<n;j++) {
          const bone=r.varint();
          if(bone>=boneCount) throw new FormatError("Invalid weight bone",r.pos);
          influences.push({bone,x:r.float(),y:r.float(),weight:r.float()});
        }
        weights.push(influences);
      }
    } else for(let i=0;i<count*2;i++) vertices.push(r.float());
    return {vertexCount:count,vertices,weights};
  }
  function readAttachment(r, key, data) {
    const flags=r.byte(), type=flags&7;
    const a={name:flags&8 ? r.ref() : key,type:["region","boundingbox","mesh","linkedmesh","path","point","clipping"][type]};
    if(!a.type) throw new FormatError("Unknown attachment type",r.pos-1);
    if(type===0 || type===2 || type===3) {
      a.path=flags&16 ? r.ref() : a.name;
      a.color=flags&32 ? r.color() : "ffffffff";
      if(flags&64) a.sequence=readSequence(r);
    }
    if(type===0) {
      Object.assign(a,{rotation:flags&128 ? r.float() : 0,x:r.float(),y:r.float(),scaleX:r.float(),scaleY:r.float(),width:r.float(),height:r.float()});
    } else if(type===2) {
      a.width=0;a.height=0;
      a.hull=r.count("mesh hull");Object.assign(a,readVertices(r,!!(flags&128),data.bones.length));
      if(a.hull<3 || a.hull>a.vertexCount) throw new FormatError("Invalid mesh hull",r.pos);
      a.uvs=Array.from({length:a.vertexCount*2},()=>r.float());
      const count=(a.vertexCount*2-a.hull-2)*3;
      r.need(count);a.triangles=Array.from({length:count},()=>r.varint());
      if(a.triangles.some(i=>i>=a.vertexCount)) throw new FormatError("Invalid mesh triangle",r.pos);
      if(data.nonessential) {
        a.edges=Array.from({length:r.count("mesh edges")},()=>r.varint());a.width=r.float();a.height=r.float();
      }
    } else if(type===3) {
      a.width=0;a.height=0;
      a.inheritDeform=!!(flags&128);a.parentSkin=r.varint();a.parent=r.ref();
      if(data.nonessential){a.width=r.float();a.height=r.float();}
    } else if(type===6) {
      a.end=r.index(data.slots,"clip end");Object.assign(a,readVertices(r,!!(flags&16),data.bones.length));
      if(data.nonessential) a.color=r.color();
    } else if(type===4) {
      a.closed=!!(flags&16);a.constantSpeed=!!(flags&32);
      Object.assign(a,readVertices(r,!!(flags&64),data.bones.length));
      if(a.vertexCount%3)throw new FormatError("Invalid path vertex count",r.pos);
      a.lengths=Array.from({length:a.vertexCount/3},()=>r.float());
      if(data.nonessential)a.color=r.color();
    } else if(type===1) {
      Object.assign(a,readVertices(r,!!(flags&16),data.bones.length));
      if(data.nonessential)a.color=r.color();
    } else if(type===5) {
      a.rotation=r.float();a.x=r.float();a.y=r.float();
      if(data.nonessential)a.color=r.color();
    } else throw new FormatError(`Attachment not yet decoded: ${a.type} (${key}, flags ${flags})`,r.pos);
    return a;
  }
  function readDefaultSkin(r,data) {
    const skin={name:"default",attachments:{},bones:[],ik:[],transform:[],path:[],physics:[]};
    for(let i=0,n=r.count("skin slots");i<n;i++) {
      const slot=r.index(data.slots,"skin slot"), map={};
      for(let j=0,count=r.count("skin attachments");j<count;j++) {
        const key=r.ref();
        if(key===null)throw new FormatError("Attachment without key",r.pos);
        map[key]=readAttachment(r,key,data);
      }
      skin.attachments[slot]=map;
    }
    return skin;
  }
  function resolveLinkedMeshes(data) {
    const resolving=new Set(),resolved=new Set();
    const resolve=(a,slot)=>{
      if(a.type!=="linkedmesh"||resolved.has(a))return;
      if(resolving.has(a))throw new FormatError("Circular linked mesh");
      resolving.add(a);
      const parent=data.skins[a.parentSkin]?.attachments[slot]?.[a.parent];
      if(!parent)throw new FormatError(`Missing linked mesh parent: ${a.parent}`);
      resolve(parent,slot);
      if(!["mesh","linkedmesh"].includes(parent.type))throw new FormatError("Linked parent is not a mesh");
      for(const key of ["vertices","weights","vertexCount","hull","triangles","uvs","edges"])a[key]=parent[key];
      a.deformSource=a.inheritDeform ? parent.deformSource || parent : a;
      resolving.delete(a);resolved.add(a);
    };
    for(const skin of data.skins)for(const [slot,map] of Object.entries(skin.attachments))for(const a of Object.values(map))resolve(a,slot);
  }
  // Numeric Bezier control points are stored in time/value coordinates in 4.2.
  // Each component has its own curve; do not assume a shared easing function.
  function readNumericTimeline(r,type,target,count,components,readValues=null) {
    const bezierCount=r.count("Bezier curves"),frames=[],curves=[];
    const read=()=>({time:r.float(),values:readValues ? readValues() : Array.from({length:components},()=>r.float())});
    if(!count)throw new FormatError("Empty timeline",r.pos);
    frames.push(read());let observed=0;
    for(let i=1;i<count;i++) {
      frames.push(read());const curve=r.byte();
      if(curve>2)throw new FormatError(`Unknown curve type ${curve} (${type})`,r.pos-1);
      if(curve===2) {
        curves.push({type:"bezier",components:Array.from({length:components},()=>[r.float(),r.float(),r.float(),r.float()])});observed+=components;
      } else curves.push({type:curve===1 ? "stepped" : "linear"});
    }
    if(observed>bezierCount)throw new FormatError("Bezier allocation is too small",r.pos);
    return {type,...target,frames,curves};
  }
  function readAnimation(r,data,name,{stopAfter=null}={}) {
    const declared=r.count("animation timelines"),timelines=[];
    for(let i=0,n=r.count("animated slots");i<n;i++) {
      const slot=r.index(data.slots,"animated slot");
      for(let j=0,m=r.count("slot timelines");j<m;j++) {
        const type=r.byte(),count=r.count("timeline frames");
        if(type===0)timelines.push({type:"attachment",slot,frames:Array.from({length:count},()=>({time:r.float(),name:r.ref()}))});
        else {
          const types=[null,"rgba","rgb","rgba2","rgb2","alpha"],components=[0,4,3,7,6,1];
          if(!types[type])throw new FormatError(`Unknown slot timeline ${type}`,r.pos);
          timelines.push(readNumericTimeline(r,types[type],{slot},count,components[type],()=>Array.from({length:components[type]},()=>r.byte()/255)));
        }
      }
    }
    if(stopAfter==="slots")return {name,declared,timelines};
    for(let i=0,n=r.count("animated bones");i<n;i++) {
      const bone=r.index(data.bones,"animated bone");
      for(let j=0,m=r.count("bone timelines");j<m;j++) {
        const type=r.byte(),count=r.count("timeline frames");
        const types=["rotate","translate","translateX","translateY","scale","scaleX","scaleY","shear","shearX","shearY","inherit"],components=[1,2,1,1,2,1,1,2,1,1];
        if(type===10)timelines.push({type:"inherit",bone,frames:Array.from({length:count},()=>({time:r.float(),values:[r.byte()]}))});
        else if(type<10)timelines.push(readNumericTimeline(r,types[type],{bone},count,components[type]));
        else throw new FormatError(`Unknown bone timeline ${type}`,r.pos);
      }
    }
    if(stopAfter==="bones")return {name,declared,timelines};
    for(let i=0,n=r.count("IK timelines");i<n;i++) {
      const ik=r.index(data.ik,"animated IK"),count=r.count("IK frames"),bezierCount=r.count("IK Bezier curves"),frames=[],curves=[];
      for(let j=0;j<count;j++) {
        const flags=r.byte(),time=r.float(),mix=flags&1 ? flags&2 ? r.float() : 1 : 0,softness=flags&4 ? r.float() : 0;
        frames.push({time,values:[mix,softness,flags&8 ? 1 : -1,flags&16 ? 1 : 0,flags&32 ? 1 : 0]});
        if(j)curves.push(flags&128 ? {type:"bezier",components:Array.from({length:2},()=>[r.float(),r.float(),r.float(),r.float()])} : {type:flags&64 ? "stepped" : "linear"});
      }
      if(curves.filter(c=>c.type==="bezier").length*2>bezierCount)throw new FormatError("Invalid IK Bezier allocation",r.pos);
      timelines.push({type:"ik",ik,frames,curves});
    }
    if(stopAfter==="ik")return {name,declared,timelines};
    for(let i=0,n=r.count("transform timelines");i<n;i++) {
      const transform=r.index(data.transform,"animated transform"),count=r.count("transform frames");
      timelines.push(readNumericTimeline(r,"transform",{transform},count,6));
    }
    if(stopAfter==="transformTimelines")return {name,declared,timelines};
    for(let i=0,n=r.count("path timeline groups");i<n;i++) {
      const path=r.index(data.path,"animated path");
      for(let j=0,m=r.count("path timelines");j<m;j++) {
        const tag=r.byte(),count=r.count("path frames"),type=["pathPosition","pathSpacing","pathMix"][tag];
        if(!type)throw new FormatError(`Unknown path timeline ${tag}`,r.pos);
        timelines.push(readNumericTimeline(r,type,{path},count,tag===2 ? 3 : 1));
      }
    }
    if(stopAfter==="pathTimelines")return {name,declared,timelines};
    for(let i=0,n=r.count("physics timeline groups");i<n;i++) {
      const physics=r.varint()-1;
      if(physics>=data.physics.length)throw new FormatError("Invalid physics timeline index",r.pos);
      for(let j=0,m=r.count("physics timelines");j<m;j++) {
        const tag=r.byte(),count=r.count("physics frames"),type=["physicsInertia","physicsStrength","physicsDamping","physicsReset","physicsMass","physicsWind","physicsGravity","physicsMix"][tag];
        if(!type)throw new FormatError(`Unknown physics timeline ${tag}`,r.pos);
        timelines.push(tag===3 ? {type,physics,frames:Array.from({length:count},()=>({time:r.float()}))} : readNumericTimeline(r,type,{physics},count,1));
      }
    }
    if(stopAfter==="physicsTimelines")return {name,declared,timelines};
    for(let i=0,n=r.count("attachment timeline skins");i<n;i++) {
      const skin=r.index(data.skins,"attachment timeline skin");
      for(let j=0,m=r.count("attachment timeline slots");j<m;j++) {
        const slot=r.index(data.slots,"attachment timeline slot");
        for(let k=0,q=r.count("attachment timelines");k<q;k++) {
          const key=r.ref(),attachment=data.skins[skin].attachments[slot]?.[key],tag=r.byte(),count=r.count("attachment frames");
          if(!attachment)throw new FormatError(`Unknown timeline attachment ${key}`,r.pos);
          if(tag===0) {
            const bezierCount=r.count("deform Bezier curves"),frames=[],curves=[];
            const size=attachment.weights ? attachment.weights.reduce((sum,list)=>sum+list.length*2,0) : attachment.vertexCount*2;
            if(!Number.isSafeInteger(size))throw new FormatError("Deform target has no vertices",r.pos);
            for(let f=0;f<count;f++) {
              const time=r.float();
              if(f) {
                const curve=r.byte();
                if(curve>2)throw new FormatError("Unknown deform curve",r.pos-1);
                curves.push(curve===2 ? {type:"bezier",components:[[r.float(),r.float(),r.float(),r.float()]]} : {type:curve===1 ? "stepped" : "linear"});
              }
              const end=r.count("deform values"),values=Array(size).fill(0);
              if(end) {
                const start=r.varint();
                if(start+end>size)throw new FormatError("Deform range exceeds vertices",r.pos);
                for(let v=start;v<start+end;v++)values[v]=r.float();
              }
              if(!attachment.weights)for(let v=0;v<size;v++)values[v]+=attachment.vertices[v];
              frames.push({time,values});
            }
            if(curves.filter(c=>c.type==="bezier").length>bezierCount)throw new FormatError("Invalid deform Bezier allocation",r.pos);
            timelines.push({type:"deform",skin,slot,key,attachment,frames,curves});
          } else if(tag===1) {
            timelines.push({type:"sequence",skin,slot,key,attachment,frames:Array.from({length:count},()=>({time:r.float(),modeAndIndex:r.uint32(),delay:r.float()}))});
          } else throw new FormatError(`Unknown attachment timeline ${tag}`,r.pos);
        }
      }
    }
    if(stopAfter==="attachmentTimelines")return {name,declared,timelines};
    const drawFrames=[];
    for(let i=0,n=r.count("draw order frames");i<n;i++) {
      const time=r.float(),count=r.count("draw order offsets"),order=Array(data.slots.length).fill(-1),unchanged=[];
      let index=0;
      for(let j=0;j<count;j++) {
        const slot=r.index(data.slots,"draw order slot"),offset=r.varint()|0;
        if(slot<index)throw new FormatError("Unsorted draw order offsets",r.pos);
        while(index<slot)unchanged.push(index++);
        const destination=slot+offset;
        if(destination<0 || destination>=order.length) {
          // Some exported mod animations contain an out-of-range move. The
          // reference public data retains a missing entry in that draw order.
          (data.diagnostics ||= []).push({type:"invalidDrawOrder",animation:name,time,slot,offset});index++;
        } else {
          if(order[destination]!==-1)throw new FormatError("Duplicate draw order destination",r.pos);
          order[destination]=index++;
        }
      }
      while(index<order.length)unchanged.push(index++);
      for(let j=order.length-1;j>=0;j--)if(order[j]===-1)order[j]=unchanged.pop() ?? null;
      drawFrames.push({time,order});
    }
    if(drawFrames.length)timelines.push({type:"drawOrder",frames:drawFrames});
    if(stopAfter==="drawOrder")return {name,declared,timelines};
    const eventFrames=[];
    for(let i=0,n=r.count("event frames");i<n;i++) {
      const time=r.float(),event=r.index(data.events,"event"),definition=data.events[event];
      const frame={time,event,name:definition.name,int:r.varint(true),float:r.float(),string:r.bool() ? r.string() : definition.string};
      if(definition.audio){frame.audio=definition.audio;frame.volume=r.float();frame.balance=r.float();}
      eventFrames.push(frame);
    }
    if(eventFrames.length)timelines.push({type:"event",frames:eventFrames});
    // This field is an allocation hint, not a validated count of parsed entries.
    const duration=timelines.reduce((max,t)=>Math.max(max,t.frames.at(-1)?.time || 0),0);
    return {name,declared,timelines,duration};
  }
  function parseBinary(input,{stopAfter="animations",animation=null}={}) {
    const data=parseBinarySetup(input),r=data.reader;
    data.transform=[];
    for(let i=0,n=r.count("transform constraints");i<n;i++) {
      const name=r.string(),order=r.varint(),bones=Array.from({length:r.count("transform bones")},()=>r.index(data.bones,"transform bone"));
      const target=r.index(data.bones,"transform target"),flags=r.byte();
      const c={name,order,bones,target,skinRequired:!!(flags&1),local:!!(flags&2),relative:!!(flags&4)};
      for(const [key,bit] of [["rotation",8],["x",16],["y",32],["scaleX",64],["scaleY",128]]) c[key]=flags&bit ? r.float() : 0;
      const mixes=r.byte();c.shearY=mixes&1 ? r.float() : 0;
      for(const [key,bit] of [["mixRotate",2],["mixX",4],["mixY",8],["mixScaleX",16],["mixScaleY",32],["mixShearY",64]]) c[key]=mixes&bit ? r.float() : 0;
      if(mixes&128)throw new FormatError("Unknown transform flags",r.pos);
      data.transform.push(c);
    }
    if(stopAfter==="transform") return data;
    data.path=[];
    for(let i=0,n=r.count("path constraints");i<n;i++) {
      const name=r.string(),order=r.varint(),skinRequired=r.bool();
      const bones=Array.from({length:r.count("path bones")},()=>r.index(data.bones,"path bone"));
      const target=r.index(data.slots,"path slot"),flags=r.byte();
      const positionMode=flags&1,spacingMode=(flags>>1)&3,rotateMode=(flags>>3)&3;
      if(spacingMode>3 || rotateMode>2 || flags&96)throw new FormatError("Unknown path mode",r.pos);
      data.path.push({name,order,skinRequired,bones,target,positionMode,spacingMode,rotateMode,
        rotation:flags&128 ? r.float() : 0,position:r.float(),spacing:r.float(),mixRotate:r.float(),mixX:r.float(),mixY:r.float()});
    }
    data.physics=[];
    for(let i=0,n=r.count("physics constraints");i<n;i++) {
      const name=r.string(),order=r.varint(),bone=r.index(data.bones,"physics bone"),flags=r.byte();
      const c={name,order,bone,skinRequired:!!(flags&1)};
      for(const [key,bit,defaultValue] of [["x",2,0],["y",4,0],["rotate",8,0],["scaleX",16,0],["shearX",32,0],["limit",64,5000]]) c[key]=flags&bit ? r.float() : defaultValue;
      const rate=r.byte();
      if(!rate)throw new FormatError("Invalid physics step rate",r.pos-1);
      c.step=1/rate;c.inertia=r.float();c.strength=r.float();c.damping=r.float();
      c.massInverse=flags&128 ? r.float() : 1;c.wind=r.float();c.gravity=r.float();
      const globals=r.byte();
      for(const [key,bit] of [["inertiaGlobal",1],["strengthGlobal",2],["dampingGlobal",4],["massGlobal",8],["windGlobal",16],["gravityGlobal",32],["mixGlobal",64]]) c[key]=!!(globals&bit);
      c.mix=globals&128 ? r.float() : 1;
      data.physics.push(c);
    }
    if(stopAfter==="constraints")return data;
    data.skins=[readDefaultSkin(r,data)];
    if(stopAfter==="defaultSkin")return data;
    for(let i=0,n=r.count("named skins");i<n;i++) {
      const name=r.string();
      if(!name)throw new FormatError("Named skin without a name",r.pos);
      const color=data.nonessential ? r.color() : null,lists={};
      for(const kind of ["bones","ik","transform","path","physics"]) {
        lists[kind]=Array.from({length:r.count(`${kind} skin references`)},()=>r.index(data[kind],`skin ${kind}`));
      }
      const skin=readDefaultSkin(r,data);Object.assign(skin,{name,color,...lists});data.skins.push(skin);
    }
    resolveLinkedMeshes(data);
    data.decodedThrough="skins";
    if(stopAfter===null || stopAfter==="skins")return data;
    data.events=[];
    for(let i=0,n=r.count("events");i<n;i++) {
      const event={name:r.string(),int:r.varint(true),float:r.float(),string:r.string(),audio:r.string()};
      if(event.audio){event.volume=r.float();event.balance=r.float();}
      data.events.push(event);
    }
    data.decodedThrough="events";
    if(stopAfter==="events")return data;
    const animationCount=r.count("animations");data.animations=[];
    for(let i=0;i<animationCount;i++) {
      const name=r.string();
      try { data.animations.push(readAnimation(r,data,name,{stopAfter:animation && name!==animation ? "animations" : stopAfter})); }
      catch(error){error.message+=` (animation ${name})`;throw error;}
      if(stopAfter!=="animations" && (!animation || name===animation))break;
    }
    data.decodedThrough=stopAfter;
    if(stopAfter==="animations" && r.pos!==r.bytes.length)throw new FormatError("Trailing skeleton data",r.pos);
    return data;
  }
  function unpackColor(hex) { return [0,2,4,6].map(i=>parseInt(hex.slice(i,i+2),16)/255); }
  function frameIndex(frames,time) {
    let low=0,high=frames.length;
    while(low<high){const mid=(low+high)>>>1;if(frames[mid].time<=time)low=mid+1;else high=mid;}
    return low-1;
  }
  function cubic(p0,p1,p2,p3,t) {
    const u=1-t;return u*u*u*p0+3*u*u*t*p1+3*u*t*t*p2+t*t*t*p3;
  }
  const sampledCurves=new WeakMap();
  function bezierSamples(curve,component,t0,v0,t1,v1) {
    let components=sampledCurves.get(curve);if(!components){components=new Map();sampledCurves.set(curve,components);}
    if(components.has(component))return components.get(component);
    const [x1,y1,x2,y2]=curve.components[component];
    const sample=(p0,p1,p2,p3)=>{
      const quadratic=p0-2*p1+p2,cubicTerm=3*(p1-p2)-p0+p3;
      let value=p0,first=.3*(p1-p0)+.03*quadratic+.001*cubicTerm,second=.06*quadratic+.006*cubicTerm;
      const third=.006*cubicTerm,points=[];
      for(let i=1;i<10;i++){value+=first;first+=second;second+=third;points.push(Math.fround(value));}
      return points;
    };
    const xs=sample(t0,x1,x2,t1),ys=sample(v0,y1,y2,v1),points=xs.map((x,i)=>[x,ys[i]]);
    components.set(component,points);return points;
  }
  function curveValue(curve,component,time,t0,v0,t1,v1,segments=10) {
    if(!curve || curve.type==="linear")return v0+(v1-v0)*(time-t0)/(t1-t0);
    if(curve.type==="stepped")return v0;
    const [x1,y1,x2,y2]=curve.components[component];
    if(segments>0) {
      let x=t0,y=v0;
      const samples=segments===10 ? bezierSamples(curve,component,t0,v0,t1,v1) : null;
      for(let i=1;i<=segments;i++) {
        const nextX=i===segments ? t1 : samples ? samples[i-1][0] : Math.fround(cubic(t0,x1,x2,t1,i/segments)),nextY=i===segments ? v1 : samples ? samples[i-1][1] : Math.fround(cubic(v0,y1,y2,v1,i/segments));
        if(time<=nextX)return nextX===x ? y : y+(nextY-y)*(time-x)/(nextX-x);
        x=nextX;y=nextY;
      }
      return v1;
    }
    let low=0,high=1;
    for(let i=0;i<48;i++){const mid=(low+high)/2;if(cubic(t0,x1,x2,t1,mid)<time)low=mid;else high=mid;}
    return cubic(v0,y1,y2,v1,(low+high)/2);
  }
  function timelineValue(t,time,segments=10) {
    const i=frameIndex(t.frames,time);
    if(i<0)return null;
    const a=t.frames[i],b=t.frames[i+1];
    if(!a.values || !b)return a;
    if(t.type==="inherit")return a;
    const curve=t.curves[i];
    if(t.type==="deform") {
      const percent=curveValue(curve,0,time,a.time,0,b.time,1,segments);
      return {time,values:a.values.map((v,j)=>v+(b.values[j]-v)*percent)};
    }
    return {time,values:a.values.map((v,j)=>t.type==="ik" && j>=2 ? v : curveValue(curve,j,time,a.time,v,b.time,b.values[j],segments))};
  }
  const localFields=["x","y","rotation","scaleX","scaleY","shearX","shearY"];
  const localPose=b=>({x:b.x,y:b.y,rotation:b.rotation,scaleX:b.scaleX,scaleY:b.scaleY,shearX:b.shearX,shearY:b.shearY});
  class Skeleton {
    constructor(data,{curveSegments=10}={}) {
      this.data=data;this.x=0;this.y=0;this.scaleX=1;this.scaleY=1;
      this.time=0;
      this.curveSegments=curveSegments;
      this.skin=data.skins.find(s=>s.name==="default") || data.skins[0];
      this.bones=data.bones.map(b=>({data:b,active:true,matrix:{a:0,b:0,c:0,d:0,x:0,y:0},a:0,b:0,c:0,d:0,worldX:0,worldY:0}));
      this.slots=data.slots.map(s=>({data:s}));
      this.constraints={};
      for(const kind of ["ik","transform","path","physics"])this.constraints[kind]=data[kind].map(c=>({...c,data:c}));
      this.setToSetupPose();
    }
    setSkin(name) {
      const skin=this.data.skins.find(s=>s.name===name);
      if(!skin)throw new FormatError(`Unknown skin: ${name}`);
      this.skin=skin;this.setSlotsToSetupPose();
    }
    bindAtlas(atlas) {
      this.atlas=atlas;
      for(const skin of this.data.skins)for(const map of Object.values(skin.attachments))for(const a of Object.values(map)) {
        if(!["region","mesh","linkedmesh"].includes(a.type))continue;
        const names=a.sequence ? Array.from({length:a.sequence.count},(_,i)=>a.path+String(a.sequence.start+i).padStart(a.sequence.digits,"0")) : [a.path];
        a.regions=names.map(name=>{
          const region=atlas.regions.get(name)?.[0];
          if(!region)throw new FormatError(`Missing atlas region: ${name}`);
          return region;
        });
      }
    }
    attachment(slot,name) {return name===null ? null : this.skin?.attachments[slot]?.[name] || this.data.skins[0]?.attachments[slot]?.[name] || null;}
    setAttachment(slot,name) {
      const s=this.slots[slot],attachment=this.attachment(slot,name);s.attachmentName=name;
      if(s.attachment===attachment)return;
      s.attachment=attachment;s.deform=[];s.sequenceIndex=-1;
    }
    setSlotsToSetupPose() {
      this.slots.forEach((s,i)=>{s.color=unpackColor(s.data.color);s.darkColor=s.data.dark ? unpackColor(s.data.dark) : null;this.setAttachment(i,s.data.attachment);s.deform=[];s.sequenceIndex=-1;});
      this.drawOrder=this.slots.map((_,i)=>i);
    }
    setToSetupPose() {
      this.bones.forEach(b=>{for(const field of localFields)b[field]=b.data[field];b.transform=b.data.transform;});
      for(const kind of Object.keys(this.constraints))this.constraints[kind].forEach(c=>Object.assign(c,c.data));
      this.setSlotsToSetupPose();
    }
    applyAnimation(name,time,{loop=false,alpha:baseAlpha=1,lastTime=-1,timelineAlpha=null,discreteAlpha=null,rotationDifference=null,rotationBase=null,timelineSetup=null,mixOut=false}={}) {
      const animation=this.data.animations.find(a=>a.name===name);
      if(!animation)throw new FormatError(`Unknown animation: ${name}`);
      const absoluteTime=time;
      if(loop && animation.duration>0){time%=animation.duration;if(time<0)time+=animation.duration;}
      const events=[];
      this.updateActive();
      for(const t of animation.timelines) {
        const alpha=timelineAlpha ? timelineAlpha(t) : baseAlpha,discrete=discreteAlpha===null ? alpha : discreteAlpha;
        if(t.type==="event") {
          if(loop && animation.duration>0) {
            const from=Math.floor(Math.max(0,lastTime)/animation.duration),to=Math.floor(absoluteTime/animation.duration);
            for(let cycle=from;cycle<=to;cycle++)for(const f of t.frames)if(f.time+cycle*animation.duration>lastTime && f.time+cycle*animation.duration<=absoluteTime)events.push({...f,absoluteTime:f.time+cycle*animation.duration});
          } else for(const f of t.frames)if(f.time>lastTime && f.time<=time)events.push({...f});
          continue;
        }
        if(t.bone!==undefined && !this.bones[t.bone].active || t.slot!==undefined && !this.bones[this.slots[t.slot].data.bone].active)continue;
        if(t.type==='sequence'&&mixOut) {
          const slot=this.slots[t.slot];if(slot.attachment===t.attachment&&timelineSetup?.(t))slot.sequenceIndex=-1;
          continue;
        }
        if(timelineSetup?.(t)) {
          if(t.bone!==undefined) {
            const b=this.bones[t.bone];for(const property of timelineProperties(t)){const key=property.split('/').at(-1);b[key]=b.data[key];}
          } else if(t.slot!==undefined) {
            const slot=this.slots[t.slot],light=unpackColor(slot.data.color),dark=slot.data.dark?unpackColor(slot.data.dark):null;
            if(t.type==='sequence'&&slot.attachment===t.attachment)slot.sequenceIndex=-1;
            else if(t.type==='deform'&&slot.attachment&&(slot.attachment.deformSource||slot.attachment)===t.attachment)slot.deform=[];
            else if(['rgba','rgb','rgba2','rgb2','alpha'].includes(t.type)) {
              const keys=t.type==='alpha'?[3]:t.type.startsWith('rgba')?[0,1,2,3]:[0,1,2];keys.forEach(k=>slot.color[k]=light[k]);
              if(t.type.endsWith('2')&&dark)slot.darkColor=dark;
            }
          } else if(t.ik!==undefined) {
            const c=this.constraints.ik[t.ik];for(const k of ['mix','softness','bendDirection','compress','stretch'])c[k]=c.data[k];
          } else if(t.transform!==undefined) {
            const c=this.constraints.transform[t.transform];for(const k of ['mixRotate','mixX','mixY','mixScaleX','mixScaleY','mixShearY'])c[k]=c.data[k];
          } else if(t.path!==undefined) {
            const c=this.constraints.path[t.path];for(const k of {pathPosition:['position'],pathSpacing:['spacing'],pathMix:['mixRotate','mixX','mixY']}[t.type])c[k]=c.data[k];
          } else if(t.physics!==undefined) {
            const key={physicsInertia:'inertia',physicsStrength:'strength',physicsDamping:'damping',physicsMass:'massInverse',physicsWind:'wind',physicsGravity:'gravity',physicsMix:'mix'}[t.type];
            if(key)for(const [i,c] of this.constraints.physics.entries())if(t.physics===i||t.physics===-1&&c.data[(key==='massInverse'?'mass':key)+'Global'])c[key]=c.data[key];
          }
        }
        let frame=timelineValue(t,time,this.curveSegments);
        if(!frame) {
          if(t.bone!==undefined) {
            const defaults={rotate:[0],translate:[0,0],translateX:[0],translateY:[0],scale:[1,1],scaleX:[1],scaleY:[1],shear:[0,0],shearX:[0],shearY:[0]};
            if(defaults[t.type])frame={values:defaults[t.type],beforeFirst:true};
          } else if(['rgba','rgb','rgba2','rgb2','alpha'].includes(t.type)) {
            const slot=this.slots[t.slot],light=unpackColor(slot.data.color),dark=slot.data.dark?unpackColor(slot.data.dark):[0,0,0,0];
            frame={values:t.type==='alpha'?[light[3]]:t.type==='rgba'?light:t.type==='rgb'?light.slice(0,3):t.type==='rgba2'?[...light,...dark.slice(0,3)]:[...light.slice(0,3),...dark.slice(0,3)]};
          } else if(t.ik!==undefined) {
            const c=this.constraints.ik[t.ik].data;frame={values:[c.mix,c.softness,c.bendDirection,c.compress,c.stretch],beforeFirst:true};
          } else if(t.transform!==undefined) {
            const c=this.constraints.transform[t.transform].data;frame={values:['mixRotate','mixX','mixY','mixScaleX','mixScaleY','mixShearY'].map(k=>c[k])};
          } else if(t.path!==undefined) {
            const c=this.constraints.path[t.path].data,keys={pathPosition:['position'],pathSpacing:['spacing'],pathMix:['mixRotate','mixX','mixY']}[t.type];frame={values:keys.map(k=>c[k])};
          } else if(t.physics!==undefined) {
            frame={values:[0],beforeFirst:true};
          } else if(t.type==='deform') {
            const slot=this.slots[t.slot],a=slot.attachment;
            if(a&&(a.deformSource||a)===t.attachment) {
              if(alpha===1)slot.deform=[];
              else if(slot.deform.length)slot.deform=slot.deform.map((v,i)=>v+((a.weights?0:a.vertices[i])-v)*alpha);
            }
          } else if(t.type==='attachment'&&!mixOut&&discrete>=.5)this.setAttachment(t.slot,this.slots[t.slot].data.attachment);
          if(!frame)continue;
        }
        const blend=(obj,key,value)=>{obj[key]=alpha===1?value:obj[key]+(value-obj[key])*alpha;};
        const values=frame.values;
        if(t.bone!==undefined) {
          const b=this.bones[t.bone],d=b.data;
          if(t.type==="inherit"){if(discrete>=0.5)b.transform=["normal","onlyTranslation","noRotationOrReflection","noScale","noScaleOrReflection"][values[0]];}
          else {
            const fields={rotate:["rotation"],translate:["x","y"],translateX:["x"],translateY:["y"],scale:["scaleX","scaleY"],scaleX:["scaleX"],scaleY:["scaleY"],shear:["shearX","shearY"],shearX:["shearX"],shearY:["shearY"]}[t.type];
            fields.forEach((key,i)=>{
              const value=t.type.startsWith("scale") ? d[key]*values[i] : d[key]+values[i];
              if(t.type.startsWith("scale") && alpha!==1&&!frame.beforeFirst) {
                const sign=(mixOut ? b[key] : value)<0 ? -1 : 1;
                b[key]=sign*(Math.abs(b[key])+(Math.abs(value)-Math.abs(b[key]))*alpha);
              } else if(key==="rotation" && alpha!==1) {
                const base=rotationBase?.(t);if(base!==null&&base!==undefined)b[key]=base;
                const difference=rotationDifference ? rotationDifference(t,value-b[key],time>=t.frames.at(-1).time) : ((value-b[key]+180)%360+360)%360-180;
                b[key]+=difference*alpha;
              } else blend(b,key,value);
            });
          }
        } else if(t.type==="attachment") {
          if((mixOut||discrete>=0.5) && this.slots[t.slot].attachmentName!==frame.name)this.setAttachment(t.slot,frame.name);
        } else if(["rgba","rgb","rgba2","rgb2","alpha"].includes(t.type)) {
          const slot=this.slots[t.slot];
          const light=t.type==="alpha" ? [3] : t.type.startsWith("rgba") ? [0,1,2,3] : [0,1,2];
          light.forEach((key,i)=>{const value=slot.color[key]+(values[i]-slot.color[key])*alpha;slot.color[key]=["alpha","rgb","rgb2"].includes(t.type) ? value : Math.max(0,Math.min(1,value));});
          if(t.type.endsWith("2") && slot.darkColor)for(let i=0;i<3;i++)slot.darkColor[i]=Math.max(0,Math.min(1,slot.darkColor[i]+(values[light.length+i]-slot.darkColor[i])*alpha));
        } else if(t.type==="deform") {
          const slot=this.slots[t.slot],a=slot.attachment;
          if(a && (a.deformSource || a)===t.attachment) {
            if(!slot.deform.length)slot.deform=a.weights ? Array(values.length).fill(0) : a.vertices.slice();
            values.forEach((v,i)=>{slot.deform[i]+=(v-slot.deform[i])*alpha;});
          }
        } else if(t.type==="drawOrder") {
          if(discrete>=0.5)this.drawOrder=frame.order.slice();
        } else if(t.type==="sequence") {
          const slot=this.slots[t.slot],sequence=t.attachment.sequence;
          if(slot.attachment!==t.attachment || !sequence || discrete<0.5)continue;
          const mode=frame.modeAndIndex&15,index=frame.modeAndIndex>>4,steps=frame.delay>0 ? Math.floor((time-frame.time)/frame.delay+0.00001) : 0,n=sequence.count;
          let v=index;
          if(mode===1)v=Math.min(n-1,index+steps);
          else if(mode===2)v=(index+steps)%n;
          else if(mode===3){const length=Math.max(1,n*2-2),k=(index+steps)%length;v=k<n ? k : length-k;}
          else if(mode===4)v=Math.max(0,n-1-index-steps);
          else if(mode===5)v=n-1-((index+steps)%n);
          else if(mode===6){const length=Math.max(1,n*2-2),k=(index+steps)%length;v=n-1-(k<n ? k : length-k);}
          slot.sequenceIndex=v;
        } else if(t.ik!==undefined) {
          const c=this.constraints.ik[t.ik];blend(c,"mix",values[0]);blend(c,"softness",values[1]);
          if(discrete>=0.5&&!frame.beforeFirst){c.bendDirection=values[2];c.compress=!!values[3];c.stretch=!!values[4];}
        } else if(t.transform!==undefined) {
          const c=this.constraints.transform[t.transform];["mixRotate","mixX","mixY","mixScaleX","mixScaleY","mixShearY"].forEach((key,i)=>blend(c,key,values[i]));
        } else if(t.path!==undefined) {
          const keys={pathPosition:["position"],pathSpacing:["spacing"],pathMix:["mixRotate","mixX","mixY"]}[t.type],c=this.constraints.path[t.path];
          keys.forEach((key,i)=>blend(c,key,values[i]));
        } else if(t.physics!==undefined) {
          const key={physicsInertia:"inertia",physicsStrength:"strength",physicsDamping:"damping",physicsMass:"massInverse",physicsWind:"wind",physicsGravity:"gravity",physicsMix:"mix"}[t.type];
          if(key)for(const [i,c] of this.constraints.physics.entries())if(t.physics===i || t.physics===-1 && c.data[(key==="massInverse" ? "mass" : key)+"Global"]) {
            if(key==='massInverse') {
              const mass=frame.beforeFirst?1/c.data.massInverse:values[0],previous=1/c.massInverse;
              c.massInverse=1/(alpha===1?mass:previous+(mass-previous)*alpha);
            } else blend(c,key,frame.beforeFirst?c.data[key]:values[0]);
          }
        }
      }
      return events;
    }
    updateWorld({constraints=false,physics="reset",delta=0}={}) {
      this.time+=delta;
      for(const b of this.bones){b.applied=localPose(b);b.matrixOverride=null;}
      this.updateBones();
      if(constraints) {
        const ordered=Object.entries(this.constraints).flatMap(([kind,list])=>list.map(c=>({kind,c}))).sort((a,b)=>a.c.order-b.c.order);
        for(const {kind,c} of ordered) {
          if(c.skinRequired && !this.skin?.[kind]?.includes(this.constraints[kind].indexOf(c)))continue;
          if(kind==="ik")this.applyIK(c);
          else if(kind==="transform")this.applyTransform(c);
          else if(kind==="path")this.applyPath(c);
          else if(kind==="physics")this.applyPhysics(c,physics);
          else throw new FormatError(`${kind} constraint evaluation is not implemented yet`);
        }
      }
    }
    updateActive() {
      for(const [i,b] of this.bones.entries()) {
        b.active=!b.data.skinRequired || this.skin?.bones.includes(i);
        if(b.data.parent>=0 && !this.bones[b.data.parent].active)b.active=false;
      }
    }
    updateBones() {
      this.updateActive();
      for(const [i,b] of this.bones.entries()) {
        const parent=b.data.parent>=0 ? this.bones[b.data.parent] : null;
        if(!b.active)continue;
        const p=parent ? parent.matrix : {a:this.scaleX,b:0,c:0,d:this.scaleY,x:this.x,y:this.y};
        const pose=b.applied || b;
        let q=localMatrix(pose,radians),m;
        if(b.matrixOverride)m=b.matrixOverride;
        else if(!parent || b.transform==="normal")m=multiply(p,q);
        else {
          const [x,y]=transform(p,pose.x,pose.y);
          // Inheritance operates in skeleton space. Global skeleton scaling is
          // applied afterwards, including reflection, regardless of this mode.
          const gx=this.scaleX,gy=this.scaleY,linear={a:p.a/(gx||1),b:p.b/(gy||1),c:p.c/(gx||1),d:p.d/(gy||1)};
          if(b.transform==="onlyTranslation")m={...q,x,y};
          else if(b.transform==="noScale" || b.transform==="noScaleOrReflection") {
            const rotation=pose.rotation*radians,ux=linear.a*Math.cos(rotation)+linear.c*Math.sin(rotation),uy=linear.b*Math.cos(rotation)+linear.d*Math.sin(rotation),length=Math.hypot(ux,uy);
            const sign=b.transform==="noScale" && linear.a*linear.d-linear.b*linear.c<0 ? -1 : 1;
            const a=length>1e-12 ? ux/length : 1,bb=length>1e-12 ? uy/length : 0;
            m=multiply({a,b:bb,c:-bb*sign,d:a*sign,x,y},localMatrix({...pose,x:0,y:0,rotation:0},radians));
          } else {
            const sx=Math.hypot(linear.a,linear.b),sy=sx>1e-12 ? Math.abs((linear.a*linear.d-linear.b*linear.c)/sx) : Math.hypot(linear.c,linear.d);
            const ux=sx>1e-12 ? linear.a/sx : 1,uy=sx>1e-12 ? linear.b/sx : 0,cross=(sx-sy)*ux*uy;
            // Remove the parent's orientation while retaining the directions
            // of its anisotropic stretch. Reflection and inherited shear are
            // excluded in this mode.
            m=multiply({a:sx*ux*ux+sy*uy*uy,b:cross,c:cross,d:sx*uy*uy+sy*ux*ux,x,y},{...q,x:0,y:0});
          }
          m.a*=gx;m.c*=gx;m.b*=gy;m.d*=gy;
        }
        b.matrix=m;b.a=m.a;b.b=m.c;b.c=m.b;b.d=m.d;b.worldX=m.x;b.worldY=m.y;
      }
    }
    applyIK(c) {
      if(!this.bones[c.bones[0]].active)return;
      if(c.mix===0) {
        // Descendants still recover earlier world constraints when an active
        // ancestor is visited, even when this aim contributes no rotation.
        for(const index of c.bones)this.invalidateDescendants(index);
        this.updateBones();return;
      }
      for(const index of c.bones) {
        this.invalidateDescendants(index);
        const b=this.bones[index];if(b.matrixOverride){b.applied=this.appliedFromWorld(b);b.matrixOverride=null;}
      }
      this.updateBones();
      const target=this.bones[c.target].matrix,wrap=a=>((a+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI;
      const singleTurn=value=>value>180?value-360:value<-180?value+360:value;
      if(c.bones.length===1) {
        const b=this.bones[c.bones[0]],original=b.applied.rotation;
        const affineAim=["normal","noScale","noScaleOrReflection"].includes(b.transform);
        if(affineAim) {
          const parent=b.data.parent>=0 ? this.bones[b.data.parent].matrix : {a:this.scaleX,b:0,c:0,d:this.scaleY,x:this.x,y:this.y};
          const [x,y]=transform(inverse(parent),target.x,target.y);
          b.applied.rotation=Math.atan2(y-b.applied.y,x-b.applied.x)*degrees-b.applied.shearX+(b.applied.scaleX<0 ? 180 : 0);
          this.updateBones();
        }
        for(let iteration=0;!affineAim && iteration<64;iteration++) {
          const m=b.matrix,desired=Math.atan2(target.y-m.y,target.x-m.x),angle=Math.atan2(m.b,m.a),error=wrap(desired-angle);
          if(Math.abs(error)<1e-10)break;
          b.applied.rotation+=error*degrees*(this.scaleX*this.scaleY<0 ? -1 : 1);this.updateBones();
        }
        b.applied.rotation=original+singleTurn(b.applied.rotation-original)*c.mix;
        if(c.compress || c.stretch) {
          const m=b.matrix,length=b.data.length*Math.hypot(m.a,m.b),distance=Math.hypot(target.x-m.x,target.y-m.y);
          if(length>1e-12 && (c.compress && distance<length || c.stretch && distance>length)) {
            const scale=1+(distance/length-1)*c.mix;b.applied.scaleX*=scale;if(c.uniform)b.applied.scaleY*=scale;
          }
        }
        this.updateBones();return;
      }
      const parent=this.bones[c.bones[0]],child=this.bones[c.bones[1]],pp=parent.applied,cp=child.applied;
      // Observed 4.2 IK behavior projects the child origin onto the parent's
      // x axis when the parent's two scales differ.
      const uniformScale=Math.abs(Math.abs(pp.scaleX)-Math.abs(pp.scaleY))<=0.0001;
      if(!uniformScale || c.stretch)cp.y=0;
      const grand=parent.data.parent>=0 ? this.bones[parent.data.parent].matrix : {a:this.scaleX,b:0,c:0,d:this.scaleY,x:this.x,y:this.y};
      const [tx,ty]=transform(inverse(grand),target.x,target.y);
      let dx=tx-pp.x,dy=ty-pp.y;
      const base=localMatrix({...pp,rotation:0,x:0,y:0,scaleY:uniformScale ? Math.abs(pp.scaleX)*(pp.scaleY<0 ? -1 : 1) : pp.scaleY},radians),ux=cp.x,uy=cp.y,length=child.data.length*cp.scaleX;
      const reach=Math.hypot(ux*pp.scaleX,uy*pp.scaleY)+Math.abs(length*pp.scaleX),distance=Math.hypot(dx,dy);
      const softness=c.softness*Math.abs(pp.scaleX)*(Math.abs(cp.scaleX)+1)/2;
      if(softness>0 && distance>reach-softness && distance>0) {
        const excess=distance-(reach-softness),effective=excess>=2*softness ? reach : distance-excess*excess/(4*softness);
        dx*=effective/distance;dy*=effective/distance;
      }
      const endpoint=angle=>transform(base,ux+Math.cos(angle+cp.shearX*radians)*length,uy+Math.sin(angle+cp.shearX*radians)*length);
      const distanceSquared=dx*dx+dy*dy,radial=angle=>{const [x,y]=endpoint(angle);return x*x+y*y-distanceSquared;};
      const roots=[];let previous=-Math.PI,previousValue=radial(previous),closest=previous,closestError=Math.abs(previousValue);
      for(let i=1;i<=128;i++) {
        const angle=-Math.PI+i*2*Math.PI/128,value=radial(angle);
        if(Math.abs(value)<closestError){closest=angle;closestError=Math.abs(value);}
        if(value===0 || value*previousValue<0) {
          let lo=previous,hi=angle,flo=previousValue;
          for(let j=0;j<48;j++){const mid=(lo+hi)/2,f=radial(mid);if(f*flo>0){lo=mid;flo=f;}else hi=mid;}
          roots.push((lo+hi)/2);
        }
        previous=angle;previousValue=value;
      }
      const unreachable=!roots.length;
      if(unreachable) {
        // Reachable distance extrema provide the fully extended/folded pose.
        let lo=closest-2*Math.PI/128,hi=closest+2*Math.PI/128;
        for(let j=0;j<48;j++) {
          const a=lo+(hi-lo)/3,b=hi-(hi-lo)/3;
          if(Math.abs(radial(a))<Math.abs(radial(b)))hi=b;else lo=a;
        }
        const closestAngle=(lo+hi)/2;roots.push(closestAngle);
        const orthogonal=Math.abs(base.a*base.c+base.b*base.d)<1e-6*Math.hypot(base.a,base.b)*Math.hypot(base.c,base.d);
        if(uy===0&&orthogonal)roots.push(wrap(-closestAngle-2*cp.shearX*radians));
        else if(Math.abs(radial(-closestAngle)-radial(closestAngle))<1e-6)roots.push(-closestAngle);
      }
      const det=base.a*base.d-base.b*base.c;
      const matching=roots.filter(angle=>(ux*Math.sin(angle+cp.shearX*radians)*length-uy*Math.cos(angle+cp.shearX*radians)*length)*(det<0 ? -1 : 1)*c.bendDirection>=-1e-8);
      const angle=(matching.length ? matching : roots).reduce((best,a)=>Math.abs(wrap(a))>Math.abs(wrap(best)) ? a : best);
      const [ex,ey]=endpoint(angle),rotation=wrap(Math.atan2(dy,dx)-Math.atan2(ey,ex));
      pp.rotation+=singleTurn(rotation*degrees-pp.rotation)*c.mix;
      cp.rotation+=singleTurn(angle*degrees-cp.rotation)*c.mix;
      if(uniformScale && c.stretch && !softness && reach>0 && distance>reach) {
        const factor=1+(distance/reach-1)*c.mix;pp.scaleX*=factor;if(c.uniform)pp.scaleY*=factor;
      }
      this.updateBones();
    }
    appliedFromWorld(b) {
      if(!b.matrixOverride)return b.applied;
      const parent=b.data.parent>=0 ? this.bones[b.data.parent].matrix : {a:this.scaleX,b:0,c:0,d:this.scaleY,x:this.x,y:this.y};
      let local=multiply(inverse(parent),b.matrix);
      // Translation-only constraint recovery retains the world linear axes in
      // its applied representation; position remains relative to its parent.
      if(b.transform==='onlyTranslation')local={...b.matrix,x:local.x,y:local.y};
      const sx=Math.hypot(local.a,local.b),det=local.a*local.d-local.b*local.c;
      const rotation=Math.atan2(local.b,local.a)*degrees,shearY=b.transform==='onlyTranslation' ? Math.atan2(local.a*local.c+local.b*local.d,det)*degrees : Math.atan2(local.d,local.c)*degrees-rotation-90;
      return {...b.applied,x:local.x,y:local.y,rotation,scaleX:sx,scaleY:sx>1e-12 ? det/sx : Math.hypot(local.c,local.d),shearX:0,shearY};
    }
    invalidateDescendants(index) {
      const changed=new Set([index]);
      for(let i=index+1;i<this.bones.length;i++)if(changed.has(this.bones[i].data.parent)) {
        const b=this.bones[i];changed.add(i);
        if(b.matrixOverride){b.applied=this.appliedFromWorld(b);b.matrixOverride=null;}
      }
    }
    applyTransform(c) {
      if(![c.mixRotate,c.mixX,c.mixY,c.mixScaleX,c.mixScaleY,c.mixShearY].some(v=>v)) {
        for(const index of c.bones)if(this.bones[index].active)this.invalidateDescendants(index);
        this.updateBones();return;
      }
      const target=this.bones[c.target],wrap=a=>((a+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI;
      if(c.local) {
        const t=this.appliedFromWorld(target);
        for(const index of c.bones) {
          const b=this.bones[index];if(!b.active)continue;
          this.invalidateDescendants(index);
          const a=this.appliedFromWorld(b);
          if(c.relative) {
            a.rotation+=(t.rotation+c.rotation)*c.mixRotate;
            a.x+=(t.x+c.x)*c.mixX;a.y+=(t.y+c.y)*c.mixY;
            a.scaleX*=1+(t.scaleX-1+c.scaleX)*c.mixScaleX;a.scaleY*=1+(t.scaleY-1+c.scaleY)*c.mixScaleY;
            a.shearY+=(t.shearY+c.shearY)*c.mixShearY;
          } else {
            a.rotation+=wrap((t.rotation-a.rotation+c.rotation)*radians)*c.mixRotate*degrees;
            a.x+=(t.x-a.x+c.x)*c.mixX;a.y+=(t.y-a.y+c.y)*c.mixY;
            if(c.mixScaleX && a.scaleX!==0)a.scaleX=(a.scaleX+(t.scaleX-a.scaleX+c.scaleX)*c.mixScaleX)/a.scaleX;
            if(c.mixScaleY && a.scaleY!==0)a.scaleY=(a.scaleY+(t.scaleY-a.scaleY+c.scaleY)*c.mixScaleY)/a.scaleY;
            a.shearY+=wrap((t.shearY-a.shearY+c.shearY)*radians)*c.mixShearY*degrees;
          }
          b.applied=a;b.matrixOverride=null;this.updateBones();
        }
        return;
      }
      const t=target.matrix,sign=t.a*t.d-t.b*t.c<0 ? -1 : 1,rotation=c.rotation*radians*sign,shearOffset=c.shearY*radians*sign;
      for(const index of c.bones) {
        const bone=this.bones[index];if(!bone.active)continue;
        this.invalidateDescendants(index);
        let b={...bone.matrix};
        if(c.mixRotate) {
          const delta=wrap(Math.atan2(t.b,t.a)-(c.relative ? 0 : Math.atan2(b.b,b.a))+rotation)*c.mixRotate,cos=Math.cos(delta),sin=Math.sin(delta);
          b={...b,a:cos*b.a-sin*b.b,b:sin*b.a+cos*b.b,c:cos*b.c-sin*b.d,d:sin*b.c+cos*b.d};
        }
        const [x,y]=transform(t,c.x,c.y);
        b.x+=(x-(c.relative ? 0 : b.x))*c.mixX;b.y+=(y-(c.relative ? 0 : b.y))*c.mixY;
        for(const [first,second,mix,offset,ta,tb] of [["a","b",c.mixScaleX,c.scaleX,t.a,t.b],["c","d",c.mixScaleY,c.scaleY,t.c,t.d]]) {
          const length=Math.hypot(b[first],b[second]);
          if(mix && length>1e-12) {
            const factor=c.relative ? 1+(Math.hypot(ta,tb)-1+offset)*mix : 1+(Math.hypot(ta,tb)-length+offset)*mix/length;
            b[first]*=factor;b[second]*=factor;
          }
        }
        if(c.mixShearY) {
          const length=Math.hypot(b.c,b.d),angle=Math.atan2(b.d,b.c),delta=wrap(Math.atan2(t.d,t.c)-Math.atan2(t.b,t.a)-(c.relative ? Math.PI/2 : angle-Math.atan2(b.b,b.a)));
          const next=angle+(delta+shearOffset)*c.mixShearY;b.c=Math.cos(next)*length;b.d=Math.sin(next)*length;
        }
        bone.matrixOverride=b;this.updateBones();
      }
    }
    applyPath(c) {
      const attachment=this.slots[c.target].attachment;
      if(attachment?.type!=="path" || !this.bones[c.bones[0]].active)return;
      const vertices=this.worldVertices(c.target),points=[];
      for(let i=0;i<vertices.length;i+=2)points.push([vertices[i],vertices[i+1]]);
      const curves=[],count=attachment.closed ? points.length/3 : points.length/3-1;
      for(let i=0;i<count;i++)curves.push([0,1,2,3].map(j=>points[(1+i*3+j)%points.length]));
      const point=(curve,t)=>[cubic(...curve.map(p=>p[0]),t),cubic(...curve.map(p=>p[1]),t)];
      const tangent=(curve,t)=>t<.001 ? Math.atan2(curve[1][1]-curve[0][1],curve[1][0]-curve[0][0]) : Math.atan2(3*(1-t)*(1-t)*(curve[1][1]-curve[0][1])+6*(1-t)*t*(curve[2][1]-curve[1][1])+3*t*t*(curve[3][1]-curve[2][1]),3*(1-t)*(1-t)*(curve[1][0]-curve[0][0])+6*(1-t)*t*(curve[2][0]-curve[1][0])+3*t*t*(curve[3][0]-curve[2][0]));
      const table=(curve,n)=>{
        const lengths=[0];let previous=curve[0],length=0;
        for(let i=1;i<=n;i++){const p=point(curve,i/n);length+=Math.hypot(p[0]-previous[0],p[1]-previous[1]);lengths.push(length);previous=p;}
        return lengths;
      };
      const tables=curves.map(curve=>table(curve,10)),lengths=[];
      let total=0;
      for(let i=0;i<curves.length;i++){total=attachment.constantSpeed ? total+table(curves[i],4).at(-1) : attachment.lengths[i];lengths.push(total);}
      if(!(total>0))return;
      const sample=position=>{
        if(attachment.closed)position=((position%total)+total)%total;
        if(position<0 || position>total) {
          const last=position>total,curve=curves[last ? curves.length-1 : 0],p=curve[last ? 3 : 0],angle=tangent(curve,last ? 1 : 0),distance=last ? position-total : position;
          return {x:p[0]+Math.cos(angle)*distance,y:p[1]+Math.sin(angle)*distance,angle};
        }
        let index=lengths.findIndex(length=>position<=length);if(index<0)index=curves.length-1;
        const start=index ? lengths[index-1] : 0,span=lengths[index]-start;
        let t=span>0 ? (position-start)/span : 0;
        if(attachment.constantSpeed) {
          const tab=tables[index],distance=t*tab.at(-1);let k=tab.findIndex((l,i)=>i>0 && l>=distance);if(k<0)k=10;
          t=(k-1+(tab[k]===tab[k-1] ? 0 : (distance-tab[k-1])/(tab[k]-tab[k-1])))/10;
        }
        const p=point(curves[index],t);return {x:p[0],y:p[1],angle:tangent(curves[index],t)};
      };
      const chain=c.rotateMode!==0,scale=c.rotateMode===2;
      const originalMatrices=c.bones.map(i=>({...this.bones[i].matrix}));
      const boneLengths=c.bones.map(i=>this.bones[i].data.length*Math.hypot(this.bones[i].matrix.a,this.bones[i].matrix.b));
      const spaceCount=chain ? c.bones.length : Math.max(0,c.bones.length-1),sum=boneLengths.slice(0,spaceCount).reduce((a,b)=>a+b,0);
      const spaces=Array.from({length:spaceCount},(_,i)=>{
        const bone=this.bones[c.bones[i]],length=bone.data.length,world=boneLengths[i];
        if(c.spacingMode===2)return c.spacing*total;
        if(c.spacingMode===3)return sum>0 ? c.spacing*total*world/sum : 0;
        return length>0 ? (c.spacing+(c.spacingMode===0 ? length : 0))*world/length : c.spacing;
      });
      let position=c.position*(c.positionMode===1 ? total : 1),next=sample(position);
      const target=this.bones[this.slots[c.target].data.bone].matrix,offset=c.rotation*radians*(target.a*target.d-target.b*target.c<0 ? -1 : 1);
      const wrap=a=>((a+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI;
      for(const index of c.bones)this.invalidateDescendants(index);
      for(let i=0;i<c.bones.length;i++) {
        const index=c.bones[i],bone=this.bones[index],current=next;
        if(i<spaces.length){position+=spaces[i];next=sample(position);}
        let b=originalMatrices[i];
        b.x+=(current.x-b.x)*c.mixX;b.y+=(current.y-b.y)*c.mixY;
        const dx=next.x-current.x,dy=next.y-current.y;
        if(scale && boneLengths[i]>1e-12){const factor=1+(Math.hypot(dx,dy)/boneLengths[i]-1)*c.mixRotate;b.a*=factor;b.b*=factor;}
        if(c.mixRotate) {
          const desired=(chain && spaces[i]!==0 ? Math.atan2(dy,dx) : current.angle)+offset,angle=wrap(desired-Math.atan2(b.b,b.a))*c.mixRotate,cos=Math.cos(angle),sin=Math.sin(angle);
          b={...b,a:cos*b.a-sin*b.b,b:sin*b.a+cos*b.b,c:cos*b.c-sin*b.d,d:sin*b.c+cos*b.d};
          if(c.rotateMode===1 && !offset){next={...next,x:next.x+(b.a*bone.data.length-dx)*c.mixRotate,y:next.y+(b.b*bone.data.length-dy)*c.mixRotate};}
        }
        bone.matrixOverride=b;
      }
      this.updateBones();
    }
    update(delta) {this.time+=delta;}
    applyPhysics(c,mode) {
      const bone=this.bones[c.bone];if(!bone.active || !c.mix)return;
      const b={...bone.matrix},length=Math.hypot(b.a,b.b),angle=Math.atan2(b.b,b.a);
      if(mode==="reset" || !c.simulation) {
        c.simulation={time:this.time,remaining:mode==="reset" ? 0 : this.time,baseX:b.x,baseY:b.y,originX:b.x,originY:b.y,angle,physicalAngle:angle,length,x:0,y:0,rotate:0,scale:0,vx:0,vy:0,vr:0,vs:0};
        // First activation during update also establishes a recoverable world
        // pose for a later ancestor constraint, just like explicit reset.
        if(bone.transform==='onlyTranslation')bone.matrixOverride=b;
        this.invalidateDescendants(c.bone);this.updateBones();return;
      }
      if(mode!=="update" && mode!=="pose")throw new FormatError(`Unknown physics mode: ${mode}`);
      const s=c.simulation,wrap=a=>{a%=2*Math.PI;if(a>Math.PI)a-=2*Math.PI;if(a<-Math.PI)a+=2*Math.PI;return a;};
      const elapsed=Math.max(0,this.time-s.time),limit=c.limit*elapsed,clamp=v=>Math.max(-limit,Math.min(limit,v));
      if(mode==="update") {
        s.remaining+=elapsed;s.time=this.time;
        const dx=clamp(s.baseX-b.x),dy=clamp(s.baseY-b.y);
        if(c.x)s.x+=clamp((s.baseX-b.x)*c.inertia);if(c.y)s.y+=clamp((s.baseY-b.y)*c.inertia);
        const damping=Math.pow(c.damping,c.step*60);
        const advance=(offset,velocity,external)=>{s[velocity]=s[velocity]*damping+(external-s[offset]*c.strength)*c.massInverse*c.step;s[offset]+=s[velocity]*c.step;};
        let steps=0;while(s.remaining>=c.step){s.remaining-=c.step;steps++;}
        for(let i=0;i<steps;i++){if(c.x)advance("x","vx",c.wind*(this.data.skeleton?.referenceScale || 100));if(c.y)advance("y","vy",-c.gravity*(this.data.skeleton?.referenceScale || 100));}
        const x=b.x+s.x*c.x*c.mix,y=b.y+s.y*c.y*c.mix;
        if(c.rotate || c.shearX) {
          const movementX=clamp(x-s.originX),movementY=clamp(y-s.originY),radius=bone.data.length*s.length;
          const previousAngle=s.physicalAngle;
          const translated=Math.atan2(Math.sin(previousAngle)*radius-movementY,Math.cos(previousAngle)*radius-movementX);
          s.rotate+=wrap(translated-angle-s.rotate*c.mix*(c.rotate+c.shearX))*c.inertia;
        }
        if(c.scaleX) {
          const direction=angle+s.rotate*c.mix*(c.rotate+c.shearX);
          if(bone.data.length>0)s.scale+=(dx*Math.cos(direction)+dy*Math.sin(direction))*c.inertia/bone.data.length;
        }
        for(let i=0;i<steps;i++) {
          const direction=angle+s.rotate*c.mix*(c.rotate+c.shearX);
          if(c.rotate||c.shearX)advance("rotate","vr",-(c.gravity*Math.cos(direction)+c.wind*Math.sin(direction))*bone.data.length/(this.data.skeleton?.referenceScale || 100));
          if(c.scaleX)advance("scale","vs",c.wind*Math.cos(direction)-c.gravity*Math.sin(direction));
        }
        s.baseX=b.x;s.baseY=b.y;s.originX=x;s.originY=y;s.angle=angle;s.physicalAngle=angle+s.rotate*c.mix*(c.rotate+c.shearX);s.length=length;
      }
      b.x+=s.x*c.x*c.mix;b.y+=s.y*c.y*c.mix;
      if(c.rotate || c.shearX) {
        const rotate=s.rotate*c.mix,ax=rotate*(c.rotate+c.shearX),ay=rotate*c.rotate,cosX=Math.cos(ax),sinX=Math.sin(ax),cosY=Math.cos(ay),sinY=Math.sin(ay);
        const a=b.a,bb=b.b,cc=b.c,d=b.d;b.a=cosX*a-sinX*bb;b.b=sinX*a+cosX*bb;b.c=cosY*cc-sinY*d;b.d=sinY*cc+cosY*d;
      }
      if(c.scaleX && length>1e-12){const factor=1+s.scale*c.scaleX*c.mix/length;b.a*=factor;b.b*=factor;}
      if(mode==='update')s.length=Math.hypot(b.a,b.b);
      this.invalidateDescendants(c.bone);bone.matrixOverride=b;this.updateBones();
    }
    worldVertices(slotIndex) {
      const slot=this.slots[slotIndex],a=slot.attachment;
      if(!a)return null;
      if(a.type==="region") {
        const index=slot.sequenceIndex<0 ? a.sequence?.setupIndex || 0 : slot.sequenceIndex,r=a.regions?.[Math.max(0,Math.min((a.regions?.length || 1)-1,index))];
        if(!r)throw new FormatError(`Atlas not bound for ${a.name}`);
        const minX=-a.width/2+r.offsetX*a.width/r.originalWidth,minY=-a.height/2+r.offsetY*a.height/r.originalHeight;
        const maxX=minX+r.width*a.width/r.originalWidth,maxY=minY+r.height*a.height/r.originalHeight;
        // Region corners have their own Float32 attachment-space representation
        // before the bone transform; attachment rotation uses exact pi.
        const local=localMatrix({...a,shearX:0,shearY:0},Math.PI/180),bone=this.bones[slot.data.bone].matrix;
        return [[minX,minY],[minX,maxY],[maxX,maxY],[maxX,minY]].flatMap(v=>transform(bone,...transform(local,...v).map(Math.fround)));
      }
      if(!a.vertexCount)return null;
      const out=[];
      if(a.weights) {
        let offset=0;
        for(const influences of a.weights) {
          let x=0,y=0;
          for(const v of influences) {
            const dx=slot.deform.length ? slot.deform[offset] : 0,dy=slot.deform.length ? slot.deform[offset+1] : 0;offset+=2;
            const w=transform(this.bones[v.bone].matrix,v.x+dx,v.y+dy);x+=w[0]*v.weight;y+=w[1]*v.weight;
          }
          out.push(x,y);
        }
      } else {
        const vertices=slot.deform.length ? slot.deform : a.vertices;
        for(let i=0;i<vertices.length;i+=2)out.push(...transform(this.bones[slot.data.bone].matrix,vertices[i],vertices[i+1]));
      }
      return out;
    }
  }
  function selectedRegion(slot) {
    const a=slot.attachment,index=slot.sequenceIndex<0 ? a.sequence?.setupIndex || 0 : slot.sequenceIndex;
    return a.regions?.[Math.max(0,Math.min(a.regions.length-1,index))];
  }
  function textureUV(region,x,y) {
    const r=region,w=r.page.width,h=r.page.height;
    if(r.rotate===90)return [(r.x+y)/w,(r.y+r.width-x)/h];
    if(r.rotate===180)return [(r.x+r.width-x)/w,(r.y+r.height-y)/h];
    if(r.rotate===270)return [(r.x+r.height-y)/w,(r.y+x)/h];
    return [(r.x+x)/w,(r.y+y)/h];
  }
  function timelineProperties(t) {
    if(t.bone!==undefined)return ({rotate:['rotation'],translate:['x','y'],translateX:['x'],translateY:['y'],scale:['scaleX','scaleY'],scaleX:['scaleX'],scaleY:['scaleY'],shear:['shearX','shearY'],shearX:['shearX'],shearY:['shearY'],inherit:['transform']}[t.type]||[]).map(k=>`bone/${t.bone}/${k}`);
    if(t.slot!==undefined)return ({attachment:['attachment'],rgba:['r','g','b','a'],rgb:['r','g','b'],alpha:['a'],rgba2:['r','g','b','a','dark'],rgb2:['r','g','b','dark'],deform:['deform/'+t.key],sequence:['sequence/'+t.key]}[t.type]||[]).map(k=>`slot/${t.slot}/${k}`);
    if(t.type==='drawOrder')return ['drawOrder'];
    if(t.type==='event')return [];
    const kind=t.ik!==undefined?'ik':t.transform!==undefined?'transform':t.path!==undefined?'path':'physics';
    return [`${kind}/${t[kind]}/${t.type}`];
  }
  class AnimationState {
    constructor(skeleton,{defaultMix=.25}={}) {this.skeleton=skeleton;this.defaultMix=defaultMix;this.timeScale=1;this.current=null;this.listeners=[];}
    entry(name,loop) {
      const animation=this.skeleton.data.animations.find(a=>a.name===name);if(!animation)throw new FormatError(`Unknown animation: ${name}`);
      return {animation,loop,trackTime:0,timeScale:1,lastTime:-1,next:null,delay:0,mixingFrom:null,mixDuration:this.defaultMix,mixTime:0,interruptAlpha:1,rotationAnchors:null,rotationWinding:new Map()};
    }
    track(index) {if(index!==0)throw new FormatError('Only replay track zero is supported');}
    setAnimation(index,name,loop=false) {
      this.track(index);const entry=this.entry(name,loop);entry.mixingFrom=this.current;
      if(entry.mixingFrom?.mixingFrom)entry.mixingFrom.interruptAlpha*=entry.mixingFrom.mixDuration>0 ? Math.min(1,entry.mixingFrom.mixTime/entry.mixingFrom.mixDuration) : 1;
      entry.mixingFrom?.rotationWinding.clear();
      if(!entry.mixingFrom)entry.mixDuration=0;this.current=entry;return entry;
    }
    addAnimation(index,name,loop=false,delay=0) {
      this.track(index);const entry=this.entry(name,loop);let tail=this.current;
      if(!tail){this.current=entry;entry.mixDuration=0;entry.delay=Math.max(0,delay);return entry;}
      while(tail.next)tail=tail.next;
      if(delay<=0) {
        const duration=tail.animation.duration,end=tail.loop&&duration>0 ? duration*(Math.floor(tail.trackTime/duration)+1) : duration;
        delay+=Math.max(0,end-entry.mixDuration);
      }
      entry.delay=delay;tail.next=entry;return entry;
    }
    getCurrent(index=0) {this.track(index);return this.current;}
    clearTracks() {this.current=null;}
    addListener(listener) {this.listeners.push(listener);}
    update(delta) {
      delta*=this.timeScale;
      const old=this.current;let transitioned=false;
      const advance=entry=>{
        if(!entry)return;
        entry.trackTime+=delta*entry.timeScale;
        if(entry.mixingFrom) {
          if(entry.mixTime>=entry.mixDuration) {
            if(entry===this.current){entry.mixingFrom=null;entry.rotationWinding.clear();}
          } else {entry.mixTime+=delta;if(!(transitioned&&entry===old))advance(entry.mixingFrom);}
        }
      };
      if(old?.next && old.lastTime>=old.next.delay) {
        if(old.mixingFrom)old.interruptAlpha*=old.mixDuration>0 ? Math.min(1,old.mixTime/old.mixDuration) : 1;
        this.current=old.next;old.next=null;this.current.trackTime=old.trackTime-this.current.delay;
        this.current.mixTime=0;this.current.mixingFrom=old;old.rotationWinding.clear();
        transitioned=true;
      }
      advance(this.current);
    }
    apply() {
      const skeleton=this.skeleton;
      if(!this.current){skeleton.setToSetupPose();return [];}
      // Timelines restore their own setup properties. Preserve the preceding
      // pose/deform directly instead of copying it, resetting it, then copying
      // it back. Draw order is the only whole-pose setup value retained by that
      // former reset/restore sequence.
      skeleton.drawOrder=skeleton.slots.map((_,i)=>i);
      const animatedAttachments=new Set(this.current.animation.timelines.filter(t=>t.type==='attachment').map(t=>t.slot));
      const activeProperties=entry=>{
        return new Set(entry.animation.timelines.flatMap(timelineProperties));
      };
      const apply=(entry,incoming=null)=>{
        const mix=entry.mixDuration>0 ? Math.min(1,entry.mixTime/entry.mixDuration) : 1;
        if(entry.mixingFrom)apply(entry.mixingFrom,{properties:activeProperties(entry),mix});
        const earlierProperties=new Set();
        for(let earlier=entry.mixingFrom;earlier;earlier=earlier.mixingFrom)for(const property of activeProperties(earlier))earlierProperties.add(property);
        const animationTime=entry.loop?entry.trackTime:Math.min(entry.trackTime,entry.animation.duration);
        const events=skeleton.applyAnimation(entry.animation.name,animationTime,{loop:entry.loop,lastTime:incoming?animationTime:entry.lastTime,
          timelineAlpha:t=>incoming ? entry.interruptAlpha*(timelineProperties(t).every(k=>earlierProperties.has(k)) ? 1-incoming.mix : timelineProperties(t).some(k=>incoming.properties.has(k)) ? 1 : 1-incoming.mix) : entry.mixingFrom?mix:1,
          discreteAlpha:incoming?0:1,mixOut:!!incoming,
          timelineSetup:t=>!timelineProperties(t).every(k=>earlierProperties.has(k)),
          rotationBase:t=>!earlierProperties.has(`bone/${t.bone}/rotation`) ? skeleton.bones[t.bone].data.rotation : null,
          rotationDifference:(timeline,raw,atEnd)=>{
            const wrap=value=>{value%=360;if(value>180)value-=360;if(value<-180)value+=360;return value;};
            let difference=wrap(raw);
            const previous=entry.rotationWinding.get(timeline);
            if(difference===0 && previous!==undefined)return previous;
            if(difference===0){entry.rotationWinding.set(timeline,0);return 0;}
            if(previous!==undefined) {
              const wrappedPrevious=wrap(previous);
              const crossing=Math.sign(wrappedPrevious)!==Math.sign(difference) && Math.abs(wrappedPrevious)>90;
              difference+=previous-wrappedPrevious+(crossing ? 360*Math.sign(wrappedPrevious) : 0);
            }
            entry.rotationWinding.set(timeline,difference);return difference;
          }});
        entry.lastTime=entry.trackTime;
        if(!incoming)for(const event of events)for(const listener of this.listeners)listener.event?.(entry,event);
        return events;
      };
      const events=apply(this.current);
      skeleton.slots.forEach((slot,i)=>{if(!animatedAttachments.has(i))skeleton.setAttachment(i,slot.data.attachment);});
      return events;
    }
  }
  function attachmentUVs(slot) {
    const a=slot.attachment,r=selectedRegion(slot);
    if(!r)throw new FormatError(`Missing texture for ${a.name}`);
    if(a.type==="region")return [0,r.height,0,0,r.width,0,r.width,r.height].flatMap((_,i,v)=>i%2 ? [] : textureUV(r,v[i],v[i+1]));
    return a.uvs.flatMap((_,i,v)=>i%2 ? [] : textureUV(r,v[i]*r.originalWidth-r.offsetX,v[i+1]*r.originalHeight-(r.originalHeight-r.height-r.offsetY)));
  }
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  function triangulatePolygon(points) {
    if(points.length<3)return [];
    let area=0;for(let i=0;i<points.length;i++){const p=points[i],q=points[(i+1)%points.length];area+=p[0]*q[1]-p[1]*q[0];}
    const indices=points.map((_,i)=>i);if(area<0)indices.reverse();const triangles=[];
    while(indices.length>3) {
      let found=false;
      for(let i=indices.length-1;i>=0;i--) {
        const prev=indices[(i+indices.length-1)%indices.length],next=indices[(i+1)%indices.length],curr=indices[i];
        const a=points[prev],b=points[curr],c=points[next];
        if(cross(a,b,c)<=1e-10)continue;
        if(indices.some(j=>j!==prev && j!==curr && j!==next && cross(a,b,points[j])>=0 && cross(b,c,points[j])>=0 && cross(c,a,points[j])>=0))continue;
        triangles.push([a,b,c]);indices.splice(i,1);found=true;break;
      }
      if(!found)throw new FormatError("Cannot triangulate clipping polygon");
    }
    triangles.push(indices.map(i=>points[i]));return triangles;
  }
  function convexPartitions(points) {
    // Clip against convex pieces rather than individual ears. Removing internal
    // edges avoids unnecessary interpolation seams and duplicate raster work.
    const polygons=triangulatePolygon(points);
    let merged=true;
    while(merged) {
      merged=false;
      search:for(let i=0;i<polygons.length;i++)for(let j=i+1;j<polygons.length;j++) {
        const a=polygons[i],b=polygons[j];
        for(let x=0;x<a.length;x++)for(let y=0;y<b.length;y++) {
          if(a[x]!==b[(y+1)%b.length] || a[(x+1)%a.length]!==b[y])continue;
          const joined=[];
          for(let k=1;k<=a.length;k++)joined.push(a[(x+k)%a.length]);
          for(let k=2;k<b.length;k++)joined.push(b[(y+k)%b.length]);
          if(joined.some((p,k)=>cross(p,joined[(k+1)%joined.length],joined[(k+2)%joined.length])<-1e-10))continue;
          polygons[i]=joined;polygons.splice(j,1);merged=true;break search;
        }
      }
    }
    return polygons;
  }
  function clipTriangle(vertices,polygon) {
    let out=vertices;
    for(let edge=0;edge<polygon.length;edge++) {
      const a=polygon[edge],b=polygon[(edge+1)%polygon.length],input=out;out=[];
      if(!input.length)break;
      let previous=input.at(-1),distance=cross(a,b,previous);
      for(const current of input) {
        const nextDistance=cross(a,b,current),inside=nextDistance>=0,previousInside=distance>=0;
        if(inside!==previousInside) {
          const t=distance/(distance-nextDistance);out.push(previous.map((v,i)=>v+(current[i]-v)*t));
        }
        if(inside)out.push(current);
        previous=current;distance=nextDistance;
      }
    }
    return out;
  }
  function drawCommands(skeleton) {
    const commands=[];let clipping=null,endSlot=null;
    for(const index of skeleton.drawOrder) {
      if(index===null)throw new FormatError("Animation has an invalid draw order");
      const slot=skeleton.slots[index],a=slot.attachment;
      if(!skeleton.bones[slot.data.bone].active)continue;
      if(a?.type==="clipping") {
        if(!clipping) {
          const vertices=skeleton.worldVertices(index),points=[];
          for(let i=0;i<vertices.length;i+=2)points.push(vertices.slice(i,i+2));
          clipping=convexPartitions(points);endSlot=a.end;
        }
        // A start marker does not itself terminate clipping. A marker whose
        // end points to its own slot therefore clips the remaining draw order.
        continue;
      } else if(a && ["region","mesh","linkedmesh"].includes(a.type)) {
        // Quantize incoming draw vertices before clipping, as they will be
        // uploaded as Float32 vertex attributes. Keep the clipping mask precise.
        let vertices=skeleton.worldVertices(index),uvs=attachmentUVs(slot);
        if(clipping){vertices=vertices.map(Math.fround);uvs=uvs.map(Math.fround);}
        const indices=a.type==="region" ? [0,1,2,2,3,0] : a.triangles,triangles=[];
        for(let i=0;i<indices.length;i+=3) {
          const triangle=indices.slice(i,i+3).map(v=>[vertices[v*2],vertices[v*2+1],uvs[v*2],uvs[v*2+1]]);
          if(clipping)for(const polygon of clipping) {
            const clipped=clipTriangle(triangle,polygon);
            for(let j=1;j<clipped.length-1;j++)triangles.push(clipped[0],clipped[j],clipped[j+1]);
          } else triangles.push(...triangle);
        }
        const attachmentColor=unpackColor(a.color),light=slot.color.map((v,i)=>v*attachmentColor[i]*(skeleton.color?.[i] ?? 1));
        commands.push({slot:index,page:selectedRegion(slot).page,vertices:triangles,blend:slot.data.blend,light,dark:slot.darkColor?.slice(0,3) || [0,0,0]});
      }
      if(clipping && index===endSlot){clipping=null;endSlot=null;}
    }
    return commands;
  }
  class Renderer {
    constructor(canvas,{mode="auto",viewport={x:-700,y:-100,width:1400,height:1400},background="26313bff",premultipliedAlpha=null}={}) {
      this.canvas=canvas;this.viewport=viewport;this.background=unpackColor(background.replace(/^#/,""));this.premultipliedAlpha=premultipliedAlpha;this.images=new Map();this.textures=new Map();this.tintCache=new Map();
      const contextOptions={alpha:true,premultipliedAlpha:true,antialias:true,preserveDrawingBuffer:true};
      const gl=mode!=="canvas2d" ? canvas.getContext('webgl2',contextOptions)||canvas.getContext("webgl",contextOptions) : null;
      if(!gl && mode==="webgl")throw new FormatError("WebGL unavailable");
      this.gl=gl;this.mode=gl ? "webgl" : "canvas2d";
      if(gl) {
        this.webgl2=typeof WebGL2RenderingContext!=='undefined'&&gl instanceof WebGL2RenderingContext;
        const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new FormatError(gl.getShaderInfoLog(s));return s;};
        const vertex=shader(gl.VERTEX_SHADER,(this.webgl2?'#version 300 es\nin vec2 position; in vec2 texcoord; in vec4 lightColor; in vec3 darkColor; out vec2 uv; out vec4 light; out vec3 dark;':'attribute vec2 position; attribute vec2 texcoord; attribute vec4 lightColor; attribute vec3 darkColor; varying vec2 uv; varying vec4 light; varying vec3 dark;')+" uniform mat4 projection; void main(){gl_Position=projection*vec4(position,0.0,1.0);uv=texcoord;light=lightColor;dark=darkColor;}");
        const fragment=shader(gl.FRAGMENT_SHADER,(this.webgl2?'#version 300 es\nprecision highp float; in vec2 uv; in vec4 light; in vec3 dark; out vec4 outColor;':'precision highp float; varying vec2 uv; varying vec4 light; varying vec3 dark;')+" uniform sampler2D image; uniform float pma; void main(){vec4 t="+(this.webgl2?'texture':'texture2D')+"(image,uv);vec3 rgb=t.rgb*light.rgb+(vec3(mix(1.0,t.a,pma))-t.rgb)*dark;"+(this.webgl2?'outColor':'gl_FragColor')+"=vec4(rgb*mix(1.0,light.a,pma),t.a*light.a);}");
        this.program=gl.createProgram();gl.attachShader(this.program,vertex);gl.attachShader(this.program,fragment);gl.linkProgram(this.program);
        gl.deleteShader(vertex);gl.deleteShader(fragment);
        if(!gl.getProgramParameter(this.program,gl.LINK_STATUS))throw new FormatError(gl.getProgramInfoLog(this.program));
        this.buffer=gl.createBuffer();this.locations={};
        for(const name of ["projection","image","pma"])this.locations[name]=gl.getUniformLocation(this.program,name);
        for(const name of ["position","texcoord","lightColor","darkColor"])this.locations[name]=gl.getAttribLocation(this.program,name);
      } else this.context=canvas.getContext("2d");
      if(!gl && !this.context)throw new FormatError("No canvas renderer available");
    }
    async loadTextures(atlas,atlasUrl,{signal=null}={}) {
      for(const page of atlas.pages) {
        if(signal?.aborted)throw new DOMException('Texture loading cancelled','AbortError');
        const img=await new Promise((resolve,reject)=>{
          const i=new Image();i.crossOrigin="anonymous";
          const cancel=()=>{i.onload=i.onerror=null;i.src='';reject(new DOMException('Texture loading cancelled','AbortError'));};
          const finish=(error)=>{signal?.removeEventListener('abort',cancel);i.onload=i.onerror=null;error ? reject(error) : resolve(i);};
          signal?.addEventListener('abort',cancel,{once:true});
          i.onload=()=>finish();i.onerror=()=>finish(new FormatError(`Texture load failed: ${page.name}`));i.src=new URL(page.name,atlasUrl).href;
        });
        if(signal?.aborted)throw new DOMException('Texture loading cancelled','AbortError');
        // Atlas coordinates use the declared logical page size. Exported images
        // may include padding; their physical dimensions only fill missing size.
        page.width ||= img.naturalWidth;page.height ||= img.naturalHeight;this.images.set(page,img);
        if(this.gl) {
          const gl=this.gl,t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
          gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,img);
          const powerOfTwo=n=>(n&(n-1))===0,mipmaps=this.webgl2||powerOfTwo(img.naturalWidth)&&powerOfTwo(img.naturalHeight);
          if(mipmaps)gl.generateMipmap(gl.TEXTURE_2D);
          // The site's reference renderer uses trilinear minification, including
          // atlas pages whose optional filter metadata says Linear,Linear.
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,mipmaps?gl.LINEAR_MIPMAP_LINEAR:gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
          const anisotropy=gl.getExtension('EXT_texture_filter_anisotropic');
          if(anisotropy)gl.texParameterf(gl.TEXTURE_2D,anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(8,gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);this.textures.set(page,t);
        }
      }
    }
    resize(width,height) {this.canvas.width=Math.max(1,Math.round(width));this.canvas.height=Math.max(1,Math.round(height));}
    render(skeleton) {
      return this.renderMany([skeleton]);
    }
    renderMany(skeletons) {
      const commands=skeletons.flatMap(drawCommands),{canvas,viewport:v}=this;
      if(this.gl) {
        const gl=this.gl;gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(...this.background);gl.clear(gl.COLOR_BUFFER_BIT);gl.enable(gl.BLEND);gl.disable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);
        gl.useProgram(this.program);gl.uniformMatrix4fv(this.locations.projection,false,new Float32Array([2/v.width,0,0,0,0,2/v.height,0,0,0,0,-.02,0,-1-2*v.x/v.width,-1-2*v.y/v.height,-1,1]));gl.uniform1i(this.locations.image,0);gl.activeTexture(gl.TEXTURE0);gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
        for(const [name,size,offset] of [["position",2,0],["texcoord",2,8],["lightColor",4,16],["darkColor",3,32]]){gl.enableVertexAttribArray(this.locations[name]);gl.vertexAttribPointer(this.locations[name],size,gl.FLOAT,false,44,offset);}
        let batch=null;
        const required=commands.reduce((n,c)=>n+c.vertices.length*11,0);
        if(!this.vertexData||this.vertexData.length<required){let capacity=this.vertexData?.length||4096;while(capacity<required)capacity*=2;this.vertexData=new Float32Array(capacity);}
        let used=0;
        const flush=()=>{if(!batch)return;gl.blendFuncSeparate(...batch.blend,gl.ONE,batch.additive?gl.ONE:gl.ONE_MINUS_SRC_ALPHA);gl.bindTexture(gl.TEXTURE_2D,this.textures.get(batch.page));gl.uniform1f(this.locations.pma,batch.pma?1:0);gl.bufferData(gl.ARRAY_BUFFER,this.vertexData.subarray(0,used),gl.DYNAMIC_DRAW);gl.drawArrays(gl.TRIANGLES,0,used/11);};
        for(const c of commands) {
          const pma=this.premultipliedAlpha??c.page.pma,source=pma ? gl.ONE : gl.SRC_ALPHA,blend={normal:[source,gl.ONE_MINUS_SRC_ALPHA],additive:[source,gl.ONE],multiply:[gl.DST_COLOR,gl.ONE_MINUS_SRC_ALPHA],screen:[gl.ONE,gl.ONE_MINUS_SRC_COLOR]}[c.blend];
          if(!batch||batch.page!==c.page||batch.mode!==c.blend||batch.pma!==pma){flush();used=0;batch={page:c.page,mode:c.blend,pma,blend,additive:c.blend==="additive"};}
          for(const vertex of c.vertices){
            this.vertexData[used++]=vertex[0];this.vertexData[used++]=vertex[1];this.vertexData[used++]=vertex[2];this.vertexData[used++]=vertex[3];
            this.vertexData[used++]=c.light[0];this.vertexData[used++]=c.light[1];this.vertexData[used++]=c.light[2];this.vertexData[used++]=c.light[3];
            this.vertexData[used++]=c.dark[0];this.vertexData[used++]=c.dark[1];this.vertexData[used++]=c.dark[2];
          }
        }
        flush();
      } else this.renderCanvas(commands);
    }
    tintedImage(command) {
      const {page,light,dark}=command,pma=this.premultipliedAlpha??page.pma,key=[page.name,pma,...light,...dark].join("|");
      if(this.tintCache.has(key))return this.tintCache.get(key);
      const canvas=document.createElement("canvas");canvas.width=page.width;canvas.height=page.height;const ctx=canvas.getContext("2d");ctx.drawImage(this.images.get(page),0,0);
      const image=ctx.getImageData(0,0,page.width,page.height),pixels=image.data;
      for(let i=0;i<pixels.length;i+=4) {
        const alpha=pixels[i+3]/255;
        for(let c=0;c<3;c++){const value=pma && alpha>0 ? pixels[i+c]/255/alpha : pixels[i+c]/255;pixels[i+c]=(value*light[c]+(1-value)*dark[c])*255;}
        pixels[i+3]*=light[3];
      }
      ctx.putImageData(image,0,0);this.tintCache.set(key,canvas);
      if(this.tintCache.size>24)this.tintCache.delete(this.tintCache.keys().next().value);
      return canvas;
    }
    renderCanvas(commands) {
      const ctx=this.context,v=this.viewport,w=this.canvas.width,h=this.canvas.height;
      ctx.setTransform(1,0,0,1,0,0);ctx.globalCompositeOperation="source-over";ctx.clearRect(0,0,w,h);
      ctx.fillStyle=`rgba(${this.background.slice(0,3).map(x=>Math.round(x*255)).join(",")},${this.background[3]})`;ctx.fillRect(0,0,w,h);
      for(const c of commands) {
        const image=this.tintedImage(c);ctx.globalCompositeOperation={normal:"source-over",additive:"lighter",multiply:"multiply",screen:"screen"}[c.blend];
        for(let i=0;i<c.vertices.length;i+=3) {
          const t=c.vertices.slice(i,i+3).map(p=>[(p[0]-v.x)/v.width*w,h-(p[1]-v.y)/v.height*h,p[2]*image.width,p[3]*image.height]);
          const [a,b,d]=t,source={a:b[2]-a[2],b:b[3]-a[3],c:d[2]-a[2],d:d[3]-a[3],x:a[2],y:a[3]};
          if(Math.abs(source.a*source.d-source.b*source.c)<1e-10)continue;
          const destination={a:b[0]-a[0],b:b[1]-a[1],c:d[0]-a[0],d:d[1]-a[1],x:a[0],y:a[1]},m=multiply(destination,inverse(source));
          ctx.save();ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.lineTo(d[0],d[1]);ctx.closePath();ctx.clip();ctx.setTransform(m.a,m.b,m.c,m.d,m.x,m.y);ctx.drawImage(image,0,0);ctx.restore();
        }
      }
    }
    readPixels() {
      if(!this.gl)return this.context.getImageData(0,0,this.canvas.width,this.canvas.height).data;
      const pixels=new Uint8Array(this.canvas.width*this.canvas.height*4);this.gl.readPixels(0,0,this.canvas.width,this.canvas.height,this.gl.RGBA,this.gl.UNSIGNED_BYTE,pixels);return pixels;
    }
    dispose() {
      if(this.gl){for(const t of this.textures.values())this.gl.deleteTexture(t);this.gl.deleteBuffer(this.buffer);this.gl.deleteProgram(this.program);this.gl.getExtension("WEBGL_lose_context")?.loseContext();}
      this.images.clear();this.textures.clear();this.tintCache.clear();this.vertexData=null;
    }
  }
  class Player {
    constructor(target,{mode='auto',viewport=null,background='00000000',premultipliedAlpha=false,defaultMix=.25,autoPlay=true,onError=null,onEvent=null,compatibilityProbe=null,onCompatibility=null}={}) {
      this.target=typeof target==='string' ? document.getElementById(target) : target;
      if(!this.target)throw new FormatError('Player target is missing');
      this.ownsCanvas=this.target.tagName!=='CANVAS';
      this.canvas=this.ownsCanvas ? document.createElement('canvas') : this.target;
      this.canvas.classList.add('skel-player');
      if(this.ownsCanvas){this.canvas.style.width='100%';this.canvas.style.height='100%';this.canvas.style.display='block';this.target.appendChild(this.canvas);}
      try {this.renderer=new Renderer(this.canvas,{mode,viewport:viewport||{x:0,y:0,width:1,height:1},background,premultipliedAlpha});}
      catch(error){if(this.ownsCanvas)this.canvas.remove();throw error;}
      this.options={defaultMix,autoPlay,onError,onEvent,compatibilityProbe,onCompatibility};this.disposed=false;this.running=false;this.frame=null;this.lastFrame=null;
      this.abort=new AbortController();this.viewport=viewport;
    }
    static async load(target,options) {
      const player=new Player(target,options);
      try {await player.load(options.skeleton,options.atlas);return player;}
      catch(error){player.dispose();throw error;}
    }
    async load(skeletonUrl,atlasUrl) {
      if(this.disposed)throw new FormatError('Player is disposed');
      const url=new URL(atlasUrl,document.baseURI).href,signal=this.abort.signal;
      const fetchData=async (path,binary)=>{
        const response=await fetch(path,{signal});if(!response.ok)throw new FormatError(`Asset request failed: ${response.status}`);
        return binary ? response.arrayBuffer() : response.text();
      };
      const [binary,text]=await Promise.all([fetchData(skeletonUrl,true),fetchData(url,false)]);
      if(this.disposed)throw new DOMException('Player loading cancelled','AbortError');
      if(this.options.compatibilityProbe){
        this.compatibility=this.options.compatibilityProbe({skeleton:binary,atlas:text,format:/\.json(?:[?#]|$)/i.test(skeletonUrl)?'json':'binary',renderer:this.renderer.mode});
        this.options.onCompatibility?.(this.compatibility);
        if(this.compatibility.status==='unsupported')throw new FormatError('Unsupported skeleton: '+this.compatibility.unsupported.map(r=>r.feature+': '+r.reason).join('; '));
      }
      this.data=parseBinary(binary);this.atlas=parseAtlas(text);this.skeleton=new Skeleton(this.data);this.skeleton.bindAtlas(this.atlas);
      this.animationState=new AnimationState(this.skeleton,{defaultMix:this.options.defaultMix});
      if(this.options.onEvent)this.animationState.addListener({event:(entry,event)=>this.options.onEvent(event,entry)});
      await this.renderer.loadTextures(this.atlas,url,{signal});
      if(this.disposed)throw new DOMException('Player loading cancelled','AbortError');
      this.skeleton.updateWorld({constraints:true});
      if(!this.viewport) {
        const {x,y,width,height}=this.data.skeleton;
        this.setViewport(width>0&&height>0 ? {x,y,width,height} : this.bounds());
      }
      this.resize();this.draw();if(this.options.autoPlay)this.start();return this;
    }
    setAnimation(name,loop=true) {return this.animationState.setAnimation(0,name,loop);}
    queueAnimation(name,loop=false,delay=0) {return this.animationState.addAnimation(0,name,loop,delay);}
    setSkin(name) {this.skeleton.setSkin(name);this.animationState.apply();this.skeleton.updateWorld({constraints:true});}
    setViewport(viewport) {
      if(![viewport.x,viewport.y,viewport.width,viewport.height].every(Number.isFinite)||viewport.width<=0||viewport.height<=0)throw new FormatError('Invalid viewport');
      this.viewport={...viewport};this.renderer.viewport=this.viewport;
    }
    resize(width=this.canvas.clientWidth||this.target.clientWidth||1,height=this.canvas.clientHeight||this.target.clientHeight||1,pixelRatio=globalThis.devicePixelRatio||1) {
      this.renderer.resize(width*pixelRatio,height*pixelRatio);if(this.skeleton)this.draw();
    }
    step(delta) {
      if(!this.skeleton||this.disposed)return [];
      if(!Number.isFinite(delta)||delta<0)throw new FormatError('Invalid animation delta');
      this.animationState.update(delta);this.skeleton.update(delta);const events=this.animationState.apply();
      this.skeleton.updateWorld({constraints:true,physics:'update'});return events;
    }
    draw() {if(this.skeleton&&!this.disposed)this.renderer.render(this.skeleton);}
    start() {
      if(this.running||this.disposed)return;this.running=true;this.lastFrame=null;
      const tick=time=>{
        if(!this.running||this.disposed)return;
        try {
          const delta=this.lastFrame===null ? 0 : (time-this.lastFrame)/1000;this.lastFrame=time;
          this.step(delta);this.draw();this.frame=requestAnimationFrame(tick);
        } catch(error){this.stop();this.options.onError?.(error);}
      };
      this.frame=requestAnimationFrame(tick);
    }
    stop() {this.running=false;if(this.frame!==null)cancelAnimationFrame(this.frame);this.frame=null;this.lastFrame=null;}
    bounds(skeleton=this.skeleton) {
      let x=Infinity,y=Infinity,right=-Infinity,top=-Infinity;
      for(const index of skeleton.drawOrder) {
        if(index===null)throw new FormatError('Invalid draw order');
        const slot=skeleton.slots[index];if(!skeleton.bones[slot.data.bone].active||!['region','mesh','linkedmesh'].includes(slot.attachment?.type))continue;
        const vertices=skeleton.worldVertices(index);
        for(let i=0;i<vertices.length;i+=2){x=Math.min(x,vertices[i]);y=Math.min(y,vertices[i+1]);right=Math.max(right,vertices[i]);top=Math.max(top,vertices[i+1]);}
      }
      return Number.isFinite(x)&&right>x&&top>y ? {x,y,width:right-x,height:top-y} : {x:0,y:0,width:1,height:1};
    }
    animationBounds(name,{step=1/30}={}) {
      const animation=this.data.animations.find(a=>a.name===name);if(!animation)throw new FormatError(`Unknown animation: ${name}`);
      if(!(step>0)||!Number.isFinite(step))throw new FormatError('Invalid sampling step');
      const s=new Skeleton(this.data);s.setSkin(this.skeleton.skin.name);s.bindAtlas(this.atlas);s.scaleX=this.skeleton.scaleX;s.scaleY=this.skeleton.scaleY;
      let combined=null,previous=0;
      for(let i=0,count=Math.ceil(animation.duration/step);i<=count;i++) {
        const time=Math.min(i*step,animation.duration);s.update(time-previous);previous=time;
        s.setToSetupPose();s.applyAnimation(name,time);s.updateWorld({constraints:true,physics:i?'update':'reset'});
        const b=this.bounds(s);
        if(!combined)combined=b;else {
          const right=Math.max(combined.x+combined.width,b.x+b.width),top=Math.max(combined.y+combined.height,b.y+b.height);
          combined.x=Math.min(combined.x,b.x);combined.y=Math.min(combined.y,b.y);combined.width=right-combined.x;combined.height=top-combined.y;
        }
      }
      return combined;
    }
    dispose() {
      if(this.disposed)return;this.disposed=true;this.abort.abort();this.stop();this.renderer.dispose();if(this.ownsCanvas)this.canvas.remove();
    }
  }
  return { FormatError, Reader, parseAtlas, parseBinarySetup,parseBinary,
    Skeleton, AnimationState, Renderer, Player, timelineValue,attachmentUVs,drawCommands,math: { localMatrix,multiply,transform,inverse,cubic,curveValue,triangulatePolygon,convexPartitions,clipTriangle } };
})();
if (typeof module !== "undefined" && module.exports) module.exports = SkelPlayer;
