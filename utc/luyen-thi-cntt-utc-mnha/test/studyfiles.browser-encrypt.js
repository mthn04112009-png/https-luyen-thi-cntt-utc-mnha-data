// Test: trình duyệt MÃ HOÁ khung (Web Crypto, public/js/studyFileForm.js) → server nhận/giải mã được, từ chối khung sai.
// Chạy: node test/studyfiles.browser-encrypt.js  (không cần Mongo/GitHub thật: các thư viện ngoài được giả lập)
process.env.ENCRYPTION_MASTER_KEY='cd'.repeat(32);
const Module=require('module'), path=require('path');
const stub=()=>new Proxy(function(){}, {get:(t,k)=>k==='__esModule'?false:stub(),apply:()=>stub(),construct:()=>stub()});
const real=Module._load;
const created=[];
Module._load=function(req,parent,isMain){
  if(/githubService$/.test(req)) return {isConfigured:true, createBlob:async(b)=>{created.push(b);return 'a'.repeat(40);}, repoFor:async()=>null};
  if(/(githubSyncService|userKeyService|models\/|pagination\.controller|utils\/search|config\/github)/.test(req)) return stub();
  try{return real.apply(this,arguments);}catch(e){ if(e.code==='MODULE_NOT_FOUND') return stub(); throw e; }
};
global.window={crypto:globalThis.crypto}; require('../public/js/studyFileForm.js');
const F=window.StudyFileForm, sc=require('../services/slideCryptoService.js'), crypto=require('crypto');
const cfg=require('../config/studyFileConfig.js');
const {createController}=require('../controllers/studyFile.controller.js');
const app=cfg.APPS.slides||Object.values(cfg.APPS)[0];
const ctrl=createController(app, {});
const call=async(fn,req)=>{let out={};const res={status(c){out.code=c;return this},set(){return this},json(b){out.body=b;out.code=out.code||200;return this}};await fn(req,res);return out;};
(async()=>{
  const salt=F.newSalt(), key=sc.deriveFrameKeys([F.toB64u(salt)])[0];
  const plain=Buffer.concat([Buffer.from('%PDF-1.4\n'),crypto.randomBytes(2000)]);
  const frame=Buffer.from(await F.encryptFrame(plain,0,3,salt,key));
  let r=await call(ctrl.uploadChunk,{query:{index:'0',total:'3',ext:'pdf'},body:frame});
  console.log('khung hợp lệ →',r.code,r.body.success, 'blob đã tạo:',created.length===1&&created[0].equals(frame));
  r=await call(ctrl.uploadChunk,{query:{index:'1',total:'3',ext:'pdf'},body:frame}); console.log('index lệch →',r.code);
  const trunc=frame.subarray(0,frame.length-5); r=await call(ctrl.uploadChunk,{query:{index:'0',total:'3',ext:'pdf'},body:trunc}); console.log('khung cụt →',r.code);
  const wk=Buffer.from(await F.encryptFrame(plain,0,3,salt,F.toB64u(crypto.randomBytes(32)))); r=await call(ctrl.uploadChunk,{query:{index:'0',total:'3',ext:'pdf'},body:wk}); console.log('khoá sai (khung 0) →',r.code);
  const notpdf=Buffer.from(await F.encryptFrame(Buffer.from('hello world'),0,3,salt,key)); r=await call(ctrl.uploadChunk,{query:{index:'0',total:'3',ext:'pdf'},body:notpdf}); console.log('không phải PDF →',r.code);
  r=await call(ctrl.uploadChunk,{query:{index:'0',total:'3',ext:'exe'},body:frame}); console.log('đuôi exe →',r.code);
  r=await call(ctrl.uploadChunk,{query:{index:'0',total:'3',ext:'pdf'},body:Buffer.alloc(cfg.LIMITS.FRAME_PLAIN_BYTES+cfg.LIMITS.FRAME_OVERHEAD+10,1)}); console.log('khung quá lớn →',r.code);
  r=await call(ctrl.uploadChunk,{body:{index:0,total:1,ext:'pdf',data:plain.toString('base64')}}); console.log('đường cũ (server mã hoá) mặc định →',r.code);
  process.env.ALLOW_SERVER_ENCRYPT='1'; r=await call(ctrl.uploadChunk,{body:{index:0,total:1,ext:'pdf',data:plain.toString('base64')}}); console.log('đường cũ khi bật cờ →',r.code);
  delete process.env.ALLOW_SERVER_ENCRYPT;
  // uploadKeys
  const s2=[F.toB64u(F.newSalt()),F.toB64u(F.newSalt())];
  r=await call(ctrl.uploadKeys,{body:{salts:s2}}); console.log('upload-keys →',r.code,r.body.keys&&r.body.keys.length===2);
  r=await call(ctrl.uploadKeys,{body:{salts:[s2[0],s2[0]]}}); console.log('salt trùng →',r.code);
  r=await call(ctrl.uploadKeys,{body:{salts:Array(17).fill(s2[0])}}); console.log('quá 16 salt →',r.code);
  r=await call(ctrl.uploadKeys,{body:{salts:['abc']}}); console.log('salt sai định dạng →',r.code);
})().catch(e=>{console.error('LỖI',e);process.exit(1)});
