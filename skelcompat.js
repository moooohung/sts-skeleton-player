"use strict";
/* Original compatibility gate: public export formats and first-party parser only.
 * A supported result means loadable by this player, not proven visual parity. */
const SkelCompatibility=(()=>{
  const runtime=typeof module!=='undefined'&&module.exports?require('./skelplayer.js'):SkelPlayer;
  const MAX_BYTES=64*1024*1024;
  const attachmentTypes=new Set(['region','mesh','linkedmesh','boundingbox','path','point','clipping']);
  function probe({skeleton,atlas,pages=null,format=null,renderer='webgl'}={}){
    const report={status:'unsupported',format:null,version:null,features:[],fallbacks:[],unsupported:[],warnings:[],action:'skip animation; retain other actors; static atlas image if available'};
    const fail=(feature,reason)=>{report.unsupported.push({feature,reason});};
    let data=null,parsedAtlas=null,binaryBytes=null;
    try{
      if(typeof skeleton==='string'){
        report.format='json';
        if(skeleton.length>MAX_BYTES)throw Error('Skeleton exceeds 64 MiB limit');
        data=JSON.parse(skeleton);
      }else if((skeleton&&ArrayBuffer.isView(skeleton))||skeleton instanceof ArrayBuffer){
        const bytes=skeleton instanceof ArrayBuffer?new Uint8Array(skeleton):new Uint8Array(skeleton.buffer,skeleton.byteOffset,skeleton.byteLength);
        if(bytes.length>MAX_BYTES)throw Error('Skeleton exceeds 64 MiB limit');
        report.format=format==='json'?'json':'binary';
        if(report.format==='json')data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
        else{
          binaryBytes=bytes;
          const reader=new runtime.Reader(bytes);reader.uint32();reader.uint32();report.version=reader.string();
          if(!/^4\.2\.\d+$/.test(report.version||''))fail('export-version:'+report.version,'Binary layout supported only for Spine 4.2 exports');
          else data=runtime.parseBinary(bytes);
        }
      }else throw Error('Skeleton input must be bytes or JSON text');
      if(report.format==='json'&&data){
        if(!data||typeof data!=='object'||Array.isArray(data)||!Array.isArray(data.bones))throw Error('JSON skeleton must contain a bones array');
        report.version=data.skeleton?.spine??data.skeleton?.version??null;
        if(!/^4\.2\.\d+$/.test(report.version||''))fail('export-version:'+report.version,'JSON export version is outside the verified 4.2 family');
        const skins=Array.isArray(data.skins)?data.skins:Object.entries(data.skins||{}).map(([name,attachments])=>({name,attachments}));
        for(const skin of skins)for(const map of Object.values(skin.attachments||{}))for(const a of Object.values(map||{})){
          const type=a.type||'region';report.features.push('attachment:'+type);
          if(!attachmentTypes.has(type))fail('attachment:'+type,'Unknown JSON attachment type');
        }
        for(const kind of ['ik','transform','path','physics'])if(data[kind]?.length)report.features.push('constraint:'+kind);
        // Detection is available now; JSON conversion into our pose model is an
        // explicit remaining implementation task, never claimed as supported.
        fail('format:json-playback','JSON feature inspection is available; player currently decodes binary skeletons only');
      }else if(data){
        report.version=data.skeleton.version;
        for(const bone of data.bones)report.features.push('inheritance:'+bone.transform);
        for(const slot of data.slots)report.features.push('blend:'+slot.blend);
        for(const skin of data.skins)for(const map of Object.values(skin.attachments))for(const attachment of Object.values(map)){
          report.features.push('attachment:'+attachment.type);
          if(attachment.weights)report.features.push('weighted-vertices');
          if(attachment.sequence)report.features.push('sequence');
        }
        for(const animation of data.animations)for(const timeline of animation.timelines){
          report.features.push('timeline:'+timeline.type);
          if(timeline.type==='event'&&timeline.frames.some(frame=>frame.audio))report.features.push('event:audio');
          if(timeline.type==='sequence')for(const frame of timeline.frames)if((frame.modeAndIndex&15)>6||!Number.isFinite(frame.delay)||frame.delay<0)fail('timeline:sequence:mode-delay','Sequence mode must be 0..6 and delay must be finite and nonnegative in '+animation.name);
          if(!timeline.frames.length)fail('timeline:'+timeline.type+':empty','Zero-length timeline in '+animation.name);
          for(let i=0;i<timeline.frames.length;i++)if(timeline.frames[i].time<0||(i&&timeline.frames[i].time<timeline.frames[i-1].time))fail('timeline:'+timeline.type+':time-order','Invalid frame clock in '+animation.name);
        }
        for(const kind of ['ik','transform','path','physics'])if(data[kind].length)report.features.push('constraint:'+kind);
        for(const diagnostic of data.diagnostics||[])if(diagnostic.type==='invalidDrawOrder')fail('timeline:drawOrder:index','Out-of-range draw order in '+diagnostic.animation+' at '+diagnostic.time+' s');
      }
    }catch(error){
      if(binaryBytes&&/^Unknown attachment type at byte /.test(error.message)&&Number.isSafeInteger(error.offset)&&error.offset>=0&&error.offset<binaryBytes.length){
        const type=binaryBytes[error.offset]&7;
        fail('attachment:binary-type:'+type,String(error.message)+' (type '+type+')');
      }else fail('skeleton:parse',String(error.message));
      data=null;
    }
    try{
      if(typeof atlas!=='string'||atlas.length>MAX_BYTES)throw Error('Atlas input must be text under 64 MiB');
      if(/\r\r\n/.test(atlas))report.fallbacks.push({feature:'atlas:duplicated-carriage-return',behavior:'Ignore duplicate carriage returns while parsing; source bytes are preserved. Re-export with byte-preserving atlas output.'});
      let afterSeparator=true,seen=false;
      for(const raw of atlas.replace(/\r/g,'').split('\n')){
        const line=raw.trim();if(!line){afterSeparator=true;continue;}
        if(line.includes(':')){
          if(afterSeparator&&seen)fail('atlas:property-after-page-separator','Blank line before atlas property: '+line);
        }else{afterSeparator=false;seen=true;}
      }
      parsedAtlas=runtime.parseAtlas(atlas);
      for(const page of parsedAtlas.pages){
        if(/^[a-z]+:|^[/\\]|(^|[/\\])\.\.([/\\]|$)/i.test(page.name))fail('atlas:page-path','Unsafe atlas page path: '+page.name);
        if(pages!==null&&!new Set(pages).has(page.name))fail('atlas:missing-page','Missing atlas page: '+page.name);
        if(page.repeat&&page.repeat!=='none')fail('atlas:repeat:'+page.repeat,'Texture wrap mode is not implemented by the player');
        if(page.format&&page.format!=='RGBA8888')fail('atlas:format:'+page.format,'Only RGBA8888 texture pages are verified');
      }
      if(data&&report.format==='binary'){
        const model=new runtime.Skeleton(data);model.bindAtlas(parsedAtlas);
        model.updateWorld({constraints:true,physics:'reset'});
        runtime.drawCommands(model);
      }
    }catch(error){fail('atlas:binding',String(error.message));}
    report.features=[...new Set(report.features)].sort();
    report.unsupported=report.unsupported.filter((r,i,a)=>a.findIndex(x=>x.feature===r.feature&&x.reason===r.reason)===i);
    if(!report.unsupported.length){
      if(renderer==='canvas2d')report.fallbacks.push({feature:'renderer:canvas2d',behavior:'Approximate Canvas2D rendering; WebGL pixel equivalence is not claimed'});
      if(report.features.includes('event:audio'))report.fallbacks.push({feature:'event:audio',behavior:'Event payloads are emitted; audio is not played by the skeleton player'});
      report.status=report.fallbacks.length?'supported with fallbacks':'supported';report.action='animate';
    }
    return report;
  }
  return {probe};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=SkelCompatibility;
