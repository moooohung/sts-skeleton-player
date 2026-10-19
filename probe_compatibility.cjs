"use strict";
/* First-party CLI. Reads export data only; never opens a reference runtime. */
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const {probe}=require('./skelcompat.js');
const {parseAtlas}=require('./skelplayer.js');
function inspect(input){
  try{return probe({skeleton:input.format==='json'?input.json:Buffer.from(input.binary,'base64'),atlas:input.atlas,pages:input.pages??null,format:input.format});}
  catch(error){return {status:'unsupported',features:[],fallbacks:[],unsupported:[{feature:'probe:input',reason:String(error.message)}],warnings:[],action:'skip animation; keep other actors'};}
}
if(process.argv.includes('--stdin')){
  const lines=readline.createInterface({input:process.stdin});
  lines.on('line',line=>{try{process.stdout.write(JSON.stringify(inspect(JSON.parse(line)))+'\n');}catch(error){process.stdout.write(JSON.stringify({status:'unsupported',unsupported:[{feature:'probe:json',reason:String(error.message)}]})+'\n');}});
}else{
  const [skeleton,atlas]=process.argv.slice(2);if(!skeleton||!atlas)throw Error('Usage: node probe_compatibility.cjs <skeleton.skel|json> <atlas>');
  try{
    for(const file of [skeleton,atlas])if(fs.statSync(file).size>64*1024*1024){const error=Error('Export file exceeds 64 MiB limit: '+file);error.feature='probe:file:size-limit';throw error;}
    const bytes=fs.readFileSync(skeleton),text=fs.readFileSync(atlas,'utf8'),directory=path.dirname(path.resolve(atlas));
    const pages=[];
    for(const page of parseAtlas(text).pages){
      const target=path.resolve(directory,page.name),relative=path.relative(directory,target);
      if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))continue;
      try{if(fs.statSync(target).isFile())pages.push(page.name);}catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}
    }
    console.log(JSON.stringify(inspect({format:/\.json$/i.test(skeleton)?'json':'binary',json:/\.json$/i.test(skeleton)?bytes.toString('utf8'):null,binary:bytes.toString('base64'),atlas:text,pages}),null,2));
  }catch(error){console.log(JSON.stringify({status:'unsupported',features:[],fallbacks:[],unsupported:[{feature:error.feature||'probe:file',reason:String(error.message)}],action:'skip animation; keep other actors'},null,2));}
}
