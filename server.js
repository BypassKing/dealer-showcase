import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createAdminAuth, AdminAuthError } from './lib/admin-auth.js';
import { cleanBrand, cloneDefaultBrands, defaultBrands, hasSlug, nextBrandId, normalizeBrands } from './lib/brands.js';
import {
  existingImages,
  isSafeImageReference,
  removeUploadedFiles,
  selectVehiclePhotos,
  uploadImageExtension,
  uploadedImagePaths,
} from './lib/vehicle-photos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] in process.env) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2').replace(/\s+#.*$/, '');
    process.env[match[1]] = value;
  }
}
const app = express();
app.set('trust proxy', 1);
const dataDir = path.join(__dirname, 'data');
const uploadDir = path.join(__dirname, 'public', 'uploads');
const dataFile = path.join(dataDir, 'site.json');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });
const secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const adminPassword = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const storage = multer.diskStorage({ destination: uploadDir, filename: (_req,file,cb) => cb(null, Date.now()+'-'+crypto.randomBytes(5).toString('hex')+uploadImageExtension(file.mimetype)) });
const upload = multer({ storage, limits: { fileSize: 12 * 1024 * 1024 }, fileFilter: (_req,file,cb) => cb(null, Boolean(uploadImageExtension(file.mimetype))) });
const defaultSalesLinks=[{slug:'a',name:'销售人员 A',phone:'+1 202 555 0101',whatsapp:'+1 202 555 0101',enabled:true},{slug:'b',name:'销售人员 B',phone:'+1 202 555 0102',whatsapp:'+1 202 555 0102',enabled:true},{slug:'c',name:'销售人员 C',phone:'+1 202 555 0103',whatsapp:'+1 202 555 0103',enabled:true}];
const seed = { vehicles:[{id:1,title:'2022 Toyota Camry SE',brand:'Toyota',year:'2022',mileage:'32,400 mi',price:'$24,800',transmission:'Automatic',fuel:'Gasoline',location:'Los Angeles, CA',description:'Clean title, one owner, full service history.',image:'https://images.unsplash.com/photo-1621007947382-bb3c3994e3fb?auto=format&fit=crop&w=1200&q=85',status:'Available',featured:true,contact_id:1}], contacts:[{id:1,name:'Alex Morgan',role:'Sales Consultant',phone:'+1 202 555 0188',whatsapp:'+1 202 555 0188',email:'sales@autohaven.com',avatar:''}], brands:defaultBrands, salesLinks:defaultSalesLinks, inquiries:[], settings:{name:'AutoHaven',phone:'+1 202 555 0188',whatsapp:'+1 202 555 0188',address:'Los Angeles, CA'} };
if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, JSON.stringify(seed,null,2));
const readData=()=>{const d=JSON.parse(fs.readFileSync(dataFile,'utf8'));if(!Array.isArray(d.brands))d.brands=cloneDefaultBrands();return d};
const writeData=d=>fs.writeFileSync(dataFile,JSON.stringify(d,null,2));
const adminAuth=createAdminAuth({readData,writeData,secret,adminPassword,resetPassword:process.env.ADMIN_PASSWORD_RESET==='true'&&Boolean(process.env.ADMIN_PASSWORD)});
if(process.env.ADMIN_PASSWORD_RESET==='true'&&process.env.ADMIN_PASSWORD)console.log('Admin password reset from ADMIN_PASSWORD; remove ADMIN_PASSWORD_RESET and restart the project.');
const adminToken=req=>req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('dealer_admin='))?.slice(13);
const requireAdmin=(req,res,next)=>{const account=adminAuth.authenticate(adminToken(req));if(!account)return res.status(401).json({error:'请先使用管理员账号登录'});req.admin=account;next()};
const requireSuperAdmin=(req,res,next)=>req.admin.role==='superadmin'?next():res.status(403).json({error:'只有超级管理员可以管理管理员账号'});
function adminCookie(req,token=''){const forwardedProto=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim();return `dealer_admin=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${token?28800:0}${req.secure||forwardedProto==='https'?'; Secure':''}`}
const sameOriginAdmin = (req, res, next) => {
  const origin = req.get('origin');
  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite === 'cross-site') return res.status(403).json({ error: '不允许跨站提交后台请求' });
  if (fetchSite === 'same-origin') return next();
  if (origin) {
    try {
      const source = new URL(origin);
      const peer = String(req.socket.remoteAddress || '').toLowerCase();
      const trustedLocalProxy = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
      const forwardedHost = trustedLocalProxy ? String(req.get('x-forwarded-host') || '').split(',')[0].trim() : '';
      const requestHost = (forwardedHost || req.get('host') || '').toLowerCase();
      if (!['http:', 'https:'].includes(source.protocol) || source.host.toLowerCase() !== requestHost) {
        return res.status(403).json({ error: '不允许跨站提交后台请求' });
      }
    } catch {
      return res.status(403).json({ error: '请求来源无效' });
    }
  }
  next();
};

app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:true}));
app.use((_req,res,next)=>{res.set('X-Content-Type-Options','nosniff');res.set('X-Frame-Options','DENY');res.set('Referrer-Policy','strict-origin-when-cross-origin');next()});
app.use('/api/admin',(req,res,next)=>{res.set('Cache-Control','no-store');if(['POST','PUT','PATCH','DELETE'].includes(req.method))return sameOriginAdmin(req,res,next);next()});
app.use('/api/vehicles',(_req,res,next)=>{res.set('Cache-Control','no-store');next()});
app.use(express.static(path.join(__dirname,'public')));
app.get('/api/locale',(req,res)=>{const country=String(req.headers['cf-ipcountry']||'').toUpperCase();const countryLanguages={CN:'zh',NG:'ha',ID:'id',TH:'th',MY:'ms',PH:'fil',VN:'vi'};res.set('Cache-Control','no-store').json({country:country||null,language:countryLanguages[country]||'en'})});
app.post('/api/admin/login',(req,res)=>{const result=adminAuth.login(req.body?.username,req.body?.password,req.ip||req.socket.remoteAddress);adminAuth.logout(adminToken(req));res.setHeader('Set-Cookie',adminCookie(req,result.token));res.json({ok:true,admin:result.admin})});
app.put('/api/admin/password',requireAdmin,(req,res)=>{adminAuth.changePassword(req.admin.id,req.body||{});res.setHeader('Set-Cookie',adminCookie(req));res.json({ok:true,reauthenticate:true})});
app.post('/api/admin/logout',(req,res)=>{adminAuth.logout(adminToken(req));res.setHeader('Set-Cookie',adminCookie(req));res.json({ok:true})});
app.get('/api/admin/session',(req,res)=>{const account=adminAuth.authenticate(adminToken(req));res.json({authenticated:Boolean(account),admin:account})});
app.get('/api/admin/accounts',requireAdmin,requireSuperAdmin,(req,res)=>res.json({admins:adminAuth.list(req.admin.id)}));
app.post('/api/admin/accounts',requireAdmin,requireSuperAdmin,(req,res)=>res.status(201).json({ok:true,admin:adminAuth.create(req.admin.id,req.body||{})}));
app.put('/api/admin/accounts/:id',requireAdmin,requireSuperAdmin,(req,res)=>{const result=adminAuth.update(req.admin.id,req.params.id,req.body||{});if(result.reauthenticate)res.setHeader('Set-Cookie',adminCookie(req));res.json({ok:true,...result})});
app.get('/api/vehicles',(req,res)=>{const d=readData();res.json(d.vehicles.map(v=>({...v,...(d.contacts.find(c=>c.id===Number(v.contact_id))?{contact_name:d.contacts.find(c=>c.id===Number(v.contact_id)).name,phone:d.contacts.find(c=>c.id===Number(v.contact_id)).phone,whatsapp:d.contacts.find(c=>c.id===Number(v.contact_id)).whatsapp,email:d.contacts.find(c=>c.id===Number(v.contact_id)).email}:{})})).sort((a,b)=>Number(b.featured)-Number(a.featured)||b.id-a.id))});
app.get('/api/vehicles/:id',(req,res)=>{const v=readData().vehicles.find(x=>x.id===Number(req.params.id));if(!v)return res.status(404).json({error:'Not found'});const d=readData(),c=d.contacts.find(x=>x.id===Number(v.contact_id));res.json({...v,...(c?{contact_name:c.name,phone:c.phone,whatsapp:c.whatsapp,email:c.email}:{})})});
function vehicleUploadError(req, res, error) {
  removeUploadedFiles(req.files || [], fs);
  return res.status(400).json({ error: error.message || '车辆照片无效' });
}

app.post('/api/vehicles',requireAdmin,upload.array('photos',20),(req,res)=>{
  const d=readData();
  const files=req.files||[];
  const uploaded=uploadedImagePaths(files);
  const bodyImage=String(req.body.image||'').trim();
  try {
    if (bodyImage && !isSafeImageReference(bodyImage)) throw new Error('车辆照片地址无效');
    if (req.body.photo_order === undefined && req.body.main_image !== undefined && req.body.main_image !== '') throw new Error('新车辆请使用主图索引选择上传照片');
    const chosen=selectVehiclePhotos(bodyImage?[bodyImage]:[],uploaded,{main_image:req.body.main_image,main_photo_index:req.body.main_photo_index,photo_order:req.body.photo_order});
    const cleanBody={...req.body};
    delete cleanBody.images; delete cleanBody.main_image; delete cleanBody.main_photo_index; delete cleanBody.photos; delete cleanBody.photo_order;
    const v={...cleanBody,id:Date.now(),image:chosen.image,images:chosen.images,featured:req.body.featured==='true'||req.body.featured==='1'};
    d.vehicles.push(v);writeData(d);res.json({ok:true,id:v.id,image:chosen.image,images:chosen.images});
  } catch(error) { return vehicleUploadError(req,res,error); }
});
app.put('/api/vehicles/:id',requireAdmin,upload.array('photos',20),(req,res)=>{
  const d=readData(),i=d.vehicles.findIndex(v=>v.id===Number(req.params.id));
  if(i<0){removeUploadedFiles(req.files||[],fs);return res.status(404).json({error:'Not found'});}
  const old=d.vehicles[i],files=req.files||[],uploaded=uploadedImagePaths(files),oldImages=existingImages(old);
  // A legacy `image` URL is retained only as an additional image when it is a
  // safe reference; selection of a cover always goes through the helper.
  const imageUrl=String(req.body.image||'').trim();
  const additions=req.body.photo_order!==undefined?uploaded:(uploaded.length?uploaded:(imageUrl&&imageUrl!==old.image?[imageUrl]:[]));
  try {
    const chosen=selectVehiclePhotos(oldImages,additions,{main_image:req.body.main_image,main_photo_index:req.body.main_photo_index,photo_order:req.body.photo_order});
    const cleanBody={...req.body};
    delete cleanBody.images; delete cleanBody.main_image; delete cleanBody.main_photo_index; delete cleanBody.photos; delete cleanBody.image; delete cleanBody.photo_order;
    d.vehicles[i]={...old,...cleanBody,id:old.id,images:chosen.images,image:chosen.image,featured:req.body.featured===undefined?old.featured:(req.body.featured===true||req.body.featured==='true'||req.body.featured==='1')};
    delete d.vehicles[i].replace_images;writeData(d);res.json({ok:true,id:old.id,image:chosen.image,images:chosen.images});
  } catch(error) { return vehicleUploadError(req,res,error); }
});
app.post('/api/vehicles/:id/photos',requireAdmin,upload.array('photos',20),(req,res)=>{
  const d=readData(),i=d.vehicles.findIndex(v=>v.id===Number(req.params.id));
  if(i<0){removeUploadedFiles(req.files||[],fs);return res.status(404).json({error:'Not found'});}
  const files=req.files||[],added=uploadedImagePaths(files),old= d.vehicles[i],previous=existingImages(old);
  try {
    const chosen=selectVehiclePhotos(previous,added,{main_image:req.body.main_image,main_photo_index:req.body.main_photo_index,photo_order:req.body.photo_order});
    d.vehicles[i]={...old,images:chosen.images,image:chosen.image};writeData(d);
    res.json({ok:true,added:added.length,total:chosen.images.length});
  } catch(error) { return vehicleUploadError(req,res,error); }
});
app.delete('/api/vehicles/:id',requireAdmin,(req,res)=>{const d=readData();d.vehicles=d.vehicles.filter(v=>v.id!==Number(req.params.id));writeData(d);res.json({ok:true})});
app.get('/api/brands',(req,res)=>res.json(normalizeBrands(readData().brands)));
app.post('/api/brands',requireAdmin,(req,res)=>{
  const d=readData(),brands=normalizeBrands(d.brands);
  try {
    const clean=cleanBrand(req.body);
    if(hasSlug(brands,clean.slug))return res.status(400).json({error:'品牌标识已存在'});
    const brand={id:nextBrandId(brands),...clean};
    brands.push(brand);d.brands=brands;writeData(d);res.status(201).json({ok:true,brand});
  } catch(error) { return res.status(400).json({error:error.message||'品牌信息无效'}); }
});
app.put('/api/brands/:id',requireAdmin,(req,res)=>{
  const d=readData(),brands=normalizeBrands(d.brands),index=brands.findIndex(brand=>String(brand.id)===String(req.params.id));
  if(index<0)return res.status(404).json({error:'品牌不存在'});
  try {
    const previous=brands[index],clean=cleanBrand(req.body,previous);
    if(hasSlug(brands,clean.slug,brands[index].id))return res.status(400).json({error:'品牌标识已存在'});
    const brand={id:previous.id,...clean};
    d.vehicles=(d.vehicles||[]).map(vehicle=>{
      if(vehicle.brand===previous.name)return {...vehicle,brand:clean.name};
      if(previous.name_zh&&vehicle.brand===previous.name_zh)return {...vehicle,brand:clean.name_zh};
      return vehicle;
    });
    brands[index]=brand;d.brands=brands;writeData(d);res.json({ok:true,brand});
  } catch(error) { return res.status(400).json({error:error.message||'品牌信息无效'}); }
});
app.delete('/api/brands/:id',requireAdmin,(req,res)=>{
  const d=readData(),brands=normalizeBrands(d.brands),target=brands.find(brand=>String(brand.id)===String(req.params.id));
  if(!target)return res.status(404).json({error:'品牌不存在'});
  const used=(d.vehicles||[]).some(vehicle=>vehicle.brand===target.name||(target.name_zh&&vehicle.brand===target.name_zh));
  if(used)return res.status(400).json({error:'该品牌仍被车辆使用，请先修改或删除相关车辆后再删除品牌'});
  const remaining=brands.filter(brand=>String(brand.id)!==String(req.params.id));
  d.brands=remaining;writeData(d);res.json({ok:true});
});
app.get('/api/contacts',(req,res)=>res.json(readData().contacts));
app.post('/api/contacts',requireAdmin,(req,res)=>{const d=readData(),c={...req.body,id:Date.now()};d.contacts.push(c);writeData(d);res.json({id:c.id})});
app.put('/api/contacts/:id',requireAdmin,(req,res)=>{const d=readData(),i=d.contacts.findIndex(c=>c.id===Number(req.params.id));if(i<0)return res.status(404).json({error:'Not found'});const clean=k=>String(req.body[k]||'').trim().slice(0,160);d.contacts[i]={...d.contacts[i],name:clean('name'),role:clean('role'),phone:clean('phone'),whatsapp:clean('whatsapp'),email:clean('email')};if(!d.contacts[i].name)return res.status(400).json({error:'Name is required'});writeData(d);res.json({ok:true})});
app.delete('/api/contacts/:id',requireAdmin,(req,res)=>{const d=readData();d.contacts=d.contacts.filter(c=>c.id!==Number(req.params.id));writeData(d);res.json({ok:true})});
app.get('/api/settings',(req,res)=>res.json(readData().settings));
app.put('/api/settings',requireAdmin,(req,res)=>{const d=readData();d.settings={...d.settings,name:String(req.body.name||'').slice(0,80),phone:String(req.body.phone||'').slice(0,40),whatsapp:String(req.body.whatsapp||'').slice(0,40),address:String(req.body.address||'').slice(0,160)};writeData(d);res.json({ok:true})});
app.get('/api/sales-links',(req,res)=>{const d=readData();res.json((Array.isArray(d.salesLinks)?d.salesLinks:defaultSalesLinks).filter(x=>x.enabled!==false))});
app.get('/api/sales-links/:slug',(req,res)=>{const d=readData(),links=Array.isArray(d.salesLinks)?d.salesLinks:defaultSalesLinks,x=links.find(v=>v.slug===String(req.params.slug).toLowerCase()&&v.enabled!==false);if(!x)return res.status(404).json({error:'Sales link not found'});res.json(x)});
app.put('/api/sales-links',requireAdmin,(req,res)=>{const d=readData(),input=Array.isArray(req.body)?req.body:[];const used=new Set();const cleanSlug=(value,index)=>{let slug=String(value||'sales-'+(index+1)).toLowerCase().trim().replace(/[^a-z0-9-]/g,'-').replace(/^-+|-+$/g,'').slice(0,40)||('sales-'+(index+1));if(used.has(slug))slug=slug+'-'+(index+1);used.add(slug);return slug};d.salesLinks=input.map((x,i)=>({slug:cleanSlug(x.slug,i),name:String(x.name||'').trim().slice(0,60),phone:String(x.phone||'').trim().slice(0,40),whatsapp:String(x.whatsapp||'').trim().slice(0,40),enabled:x.enabled!==false}));writeData(d);res.json({ok:true,salesLinks:d.salesLinks})});
const inquiryAttempts=new Map();
app.post('/api/inquiries',(req,res)=>{const ip=req.socket.remoteAddress||'unknown',now=Date.now(),recent=(inquiryAttempts.get(ip)||[]).filter(t=>now-t<10*60*1000);if(recent.length>=10)return res.status(429).json({error:'Too many requests'});recent.push(now);inquiryAttempts.set(ip,recent);const clean=k=>String(req.body[k]||'').trim().slice(0,k==='message'?1000:100);const name=clean('name'),phone=clean('phone');if(!name||!phone)return res.status(400).json({error:'Name and phone are required'});const d=readData();d.inquiries=d.inquiries||[];d.inquiries.unshift({id:Date.now(),name,phone,vehicle:clean('vehicle'),yearMileage:clean('yearMileage'),message:clean('message'),createdAt:new Date().toISOString(),status:'New'});d.inquiries=d.inquiries.slice(0,500);writeData(d);res.json({ok:true})});
app.get('/api/inquiries',requireAdmin,(req,res)=>res.json(readData().inquiries||[]));
app.delete('/api/inquiries/:id',requireAdmin,(req,res)=>{const d=readData();d.inquiries=(d.inquiries||[]).filter(x=>x.id!==Number(req.params.id));writeData(d);res.json({ok:true})});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>{if(err instanceof AdminAuthError)return res.status(err.status).json({error:err.message});if(err instanceof multer.MulterError)return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'单张照片不能超过12MB':'最多上传20张照片，请检查上传字段'});next(err)});
app.listen(process.env.PORT||3000,()=>{console.log('Dealer showcase listening on '+(process.env.PORT||3000));console.log('Admin accounts loaded from data/site.json; initial username: admin')});
