require('dotenv').config();
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const XCEEDNET_BASE_URL = (process.env.XCEEDNET_BASE_URL || 'http://veyron.macrosignal.net').replace(/\/+$/, '');
const XCEEDNET_ADMIN_AUTH = process.env.XCEEDNET_ADMIN_AUTH || '';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

const DEFAULT_SETTINGS = {
  company: { name:'Veyron Networks', gstin:'', address:'', phone:'', email:'' },
  gateway: {
    provider:'cashfree', mode:'sandbox', enabled:false,
    appId:'', secretKey:'', webhookSecret:'',
    allowRenewal:true, allowPackageChange:true,
    allowOutstanding:false, addOutstanding:false, extraChargeRate:0,
    renewalCondition:'cover_price', paymentType:'standard', paymentMode:'UPI',
    checkTransaction:true
  },
  invoice: { enabled:true, autoGenerate:true, prefix:'VN', nextNumber:1 },
  packages: {}
};

function clone(x){ return JSON.parse(JSON.stringify(x)); }
function loadJson(file, fallback){ try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : clone(fallback); } catch { return clone(fallback); } }
function saveJson(file, value){ fs.writeFileSync(file, JSON.stringify(value,null,2)); }
function loadSettings(){
  const s=loadJson(SETTINGS_FILE,DEFAULT_SETTINGS);
  return {
    ...clone(DEFAULT_SETTINGS), ...s,
    company:{...DEFAULT_SETTINGS.company,...(s.company||{})},
    gateway:{...DEFAULT_SETTINGS.gateway,...(s.gateway||{})},
    invoice:{...DEFAULT_SETTINGS.invoice,...(s.invoice||{})},
    packages:{...(s.packages||{})}
  };
}
function saveSettings(s){ saveJson(SETTINGS_FILE,s); }
function loadOrders(){ return loadJson(ORDERS_FILE,{}); }
function saveOrders(x){ saveJson(ORDERS_FILE,x); }

const adminSessions = new Map();
const subscriberSessions = new Map();

function send(res,status,body,type='application/json; charset=utf-8',headers={}){
  res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store',...headers});
  if(type.startsWith('application/json')) res.end(JSON.stringify(body)); else res.end(body);
}
function readRaw(req){
  return new Promise((resolve,reject)=>{
    let raw='';
    req.on('data',c=>{ raw+=c; if(raw.length>2*1024*1024){ req.destroy(); reject(new Error('Request body too large')); }});
    req.on('end',()=>resolve(raw)); req.on('error',reject);
  });
}
async function readJson(req){ const raw=await readRaw(req); if(!raw)return {}; try{return JSON.parse(raw)}catch{throw new Error('Invalid JSON')} }
function bearer(req){ return (req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim(); }
function requireAdmin(req){ const t=bearer(req); return t ? adminSessions.get(t) || null : null; }
function requireSubscriber(req){ const t=bearer(req); return t ? subscriberSessions.get(t) || null : null; }
function today(){ return new Date().toISOString().slice(0,10); }
function addValidity(dateStr, n, unit){ const d=new Date(dateStr+'T00:00:00'); const u=String(unit||'day').toLowerCase(); if(u.startsWith('month')) d.setMonth(d.getMonth()+n); else if(u.startsWith('year')) d.setFullYear(d.getFullYear()+n); else d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }
function decodeJwtPayload(token){ try{ const p=token.split('.')[1]; return JSON.parse(Buffer.from(p,'base64url').toString('utf8')); }catch{return null;} }
function xceed(method,route,payload=null,auth=''){
  return new Promise((resolve,reject)=>{
    try{
      const url=new URL(XCEEDNET_BASE_URL+route);
      const transport=url.protocol==='https:'?https:http;
      const data=payload==null?'':JSON.stringify(payload);
      const headers={'Content-Type':'application/json','Accept':'application/json','Version':'HTTP/1.0'};
      if(auth) headers.Authentication=auth;
      const r=transport.request({hostname:url.hostname,port:url.port||(url.protocol==='https:'?443:80),path:url.pathname+url.search,method,headers,timeout:20000},resp=>{
        let out=''; resp.on('data',c=>out+=c); resp.on('end',()=>{let parsed={}; try{parsed=out?JSON.parse(out):{}}catch{parsed={raw:out}} resolve({status:resp.statusCode||502,data:parsed});});
      });
      r.on('timeout',()=>r.destroy(new Error('Xceednet request timed out'))); r.on('error',reject); if(data)r.write(data); r.end();
    }catch(e){reject(e)}
  });
}
function cashfreeRequest(method,route,payload=null){
  const g=loadSettings().gateway;
  const base=g.mode==='production'?'https://api.cashfree.com/pg':'https://sandbox.cashfree.com/pg';
  return new Promise((resolve,reject)=>{
    try{
      const url=new URL(base+route), data=payload==null?'':JSON.stringify(payload);
      const headers={'Content-Type':'application/json','Accept':'application/json','x-api-version':'2025-01-01','x-client-id':g.appId,'x-client-secret':g.secretKey,'x-request-id':crypto.randomUUID()};
      if(method==='POST')headers['x-idempotency-key']=crypto.randomUUID();
      const r=https.request({hostname:url.hostname,port:443,path:url.pathname+url.search,method,headers,timeout:20000},resp=>{let out='';resp.on('data',c=>out+=c);resp.on('end',()=>{let d={};try{d=out?JSON.parse(out):{}}catch{d={raw:out}}resolve({status:resp.statusCode||502,data:d})})});
      r.on('timeout',()=>r.destroy(new Error('Cashfree request timed out')));r.on('error',reject);if(data)r.write(data);r.end();
    }catch(e){reject(e)}
  });
}
function vyaparRequest(method,route,payload=null){
  const g=loadSettings().gateway;
  const apiKey=g.secretKey||'';
  return new Promise((resolve,reject)=>{
    try{
      const url=new URL('https://vyapargateway.com'+route);
      const data=payload==null?'':JSON.stringify(payload);
      const headers={'Content-Type':'application/json','Accept':'application/json','X-API-Key':apiKey};
      const r=https.request({hostname:url.hostname,port:443,path:url.pathname+url.search,method,headers,timeout:20000},resp=>{
        let out='';resp.on('data',c=>out+=c);resp.on('end',()=>{let d={};try{d=out?JSON.parse(out):{}}catch{d={raw:out}}resolve({status:resp.statusCode||502,data:d})})
      });
      r.on('timeout',()=>r.destroy(new Error('VyaparGateway request timed out')));r.on('error',reject);if(data)r.write(data);r.end();
    }catch(e){reject(e)}
  });
}
function verifyVyaparWebhook(raw,signature,timestamp,secret){
  if(!raw||!signature||!timestamp||!secret)return false;
  const input=String(timestamp)+'.'+raw;
  const expectedHex=crypto.createHmac('sha256',secret).update(input).digest('hex');
  const expectedB64=crypto.createHmac('sha256',secret).update(input).digest('base64');
  const provided=String(signature);
  const same=(x)=>{const a=Buffer.from(x,'utf8'),b=Buffer.from(provided,'utf8');return a.length===b.length&&crypto.timingSafeEqual(a,b)};
  return same(expectedHex)||same(expectedB64);
}

function invoiceNo(s){const n=Number(s.invoice.nextNumber||1);s.invoice.nextNumber=n+1;saveSettings(s);return `${s.invoice.prefix||'VN'}-${String(n).padStart(6,'0')}`;}

async function getSubscriber(username){
  const r=await xceed('GET','/subscribers/search_subscriber?username='+encodeURIComponent(username),null,XCEEDNET_ADMIN_AUTH);
  return r.status===200 ? (r.data?.data||r.data) : null;
}
async function getPackages(){
  const r=await xceed('GET','/location_packages',null,XCEEDNET_ADMIN_AUTH);
  if(r.status!==200) throw new Error(r.data?.error||r.data?.message||'Could not load Xceednet packages');
  return Array.isArray(r.data?.data)?r.data.data.map(p=>({...p,id:p.id??p.location_package_id})).filter(p=>p.id!=null):[];
}
async function getAdminUserId(){ const p=decodeJwtPayload(XCEEDNET_ADMIN_AUTH); return p?.user_id || p?.id || null; }

async function createXceedInvoice(sub,pkg,amount,s){
  if(!s.invoice.enabled) return null;
  const no=invoiceNo(s);
  const from=today();
  const to=addValidity(from,Number(pkg.valid_for||30),pkg.validity_unit||'day');
  const payload={subscriber_invoice:{
    subscriber_id:sub.id,invoice_no:no,invoice_date:from,due_by:from,period_from:from,period_to:to,
    location_package_name:pkg.name,amount:String(amount),status_event:'open',
    gst_applicable:!!s.company.gstin,gst_no:s.company.gstin||'',invoice_header_text:'Veyron Networks Broadband Invoice'
  }};
  const r=await xceed('POST','/subscriber_invoices',payload,XCEEDNET_ADMIN_AUTH);
  if(r.status!==201 && r.status!==200) throw new Error(r.data?.error||r.data?.message||'Xceednet invoice creation failed');
  return r.data?.data||r.data;
}
async function createXceedPayment(sub,invoice,amount,mode){
  const receivedBy=await getAdminUserId();
  if(!receivedBy) throw new Error('Could not determine Xceednet admin user id');
  const payload={subscriber_payment:{subscriber_id:sub.id,payment_date:today(),amount:String(amount),mode_of_payment:mode||'online_payment',received_by_id:receivedBy,description:'Veyron online recharge'},...(invoice?.id?{subscriber_invoice_id:invoice.id}: {})};
  const r=await xceed('POST','/subscriber_payments',payload,XCEEDNET_ADMIN_AUTH);
  if(r.status!==201 && r.status!==200) throw new Error(r.data?.error||r.data?.message||'Xceednet payment creation failed');
  return r.data?.data||r.data;
}
async function applyPackage(sub,pkg,renewOnly=false){
  const same=Number(sub.location_package_id)===Number(pkg.id);
  const event=renewOnly||same?'renew_package':'change_package';
  const body={subscriber:{status_event:event}};
  if(event==='change_package') body.subscriber.location_package_id=Number(pkg.id);
  const r=await xceed('PATCH','/subscribers/'+encodeURIComponent(sub.id),body,XCEEDNET_ADMIN_AUTH);
  if(r.status!==200) throw new Error(r.data?.error||r.data?.message||'Xceednet package update failed');
  return r.data?.data||r.data;
}
async function finalizeOrder(orderId){
  const orders=loadOrders(); const o=orders[orderId]; if(!o) throw new Error('Order not found');
  if(o.finalized) return o;
  const s=loadSettings();
  const provider=String(o.provider||s.gateway.provider||'cashfree').toLowerCase();
  let paid=false, gatewayStatus='UNKNOWN', gatewayData=null;
  if(provider==='vyapargateway'){
    const r=await vyaparRequest('POST','/api/v1/check_order_status',{key:s.gateway.secretKey,order_id:o.gateway_order_id||o.order_id,client_txn_id:o.client_txn_id});
    if(r.status!==200) throw new Error(r.data?.msg||r.data?.error||'Unable to verify VyaparGateway order');
    gatewayData=r.data?.data||r.data; gatewayStatus=String(gatewayData?.status||'').toLowerCase(); paid=gatewayStatus==='success';
    o.gateway_status=gatewayStatus; o.vyapar=gatewayData;
  }else{
    const cf=await cashfreeRequest('GET','/orders/'+encodeURIComponent(orderId));
    if(cf.status!==200) throw new Error(cf.data?.message||'Unable to verify Cashfree order');
    gatewayData=cf.data; gatewayStatus=String(cf.data?.order_status||'').toUpperCase(); paid=gatewayStatus==='PAID'; o.cashfree_status=gatewayStatus;
  }
  if(!paid){ orders[orderId]=o; saveOrders(orders); return o; }
  const sub=await getSubscriber(o.username); if(!sub) throw new Error('Xceednet subscriber not found');
  const pkgs=await getPackages(); const pkg=pkgs.find(p=>String(p.id)===String(o.package_id)); if(!pkg)throw new Error('Selected Xceednet package no longer exists');
  const amount=Number(o.amount);
  let inv=o.xceednet_invoice||null;
  if(!inv && s.invoice.enabled && s.invoice.autoGenerate!==false){
    inv=await createXceedInvoice(sub,pkg,amount,s);
    o.xceednet_invoice=inv; orders[orderId]=o; saveOrders(orders);
  }
  let payments=o.xceednet_payment||null;
  if(!payments){
    payments=await createXceedPayment(sub,inv,amount,o.payment_mode||'online_payment');
    o.xceednet_payment=payments; orders[orderId]=o; saveOrders(orders);
  }
  const updated=await applyPackage(sub,pkg,false);
  o.finalized=true; o.gateway_status=gatewayStatus; o.finalized_at=new Date().toISOString(); o.xceednet_subscriber_id=sub.id; o.xceednet_invoice=inv; o.xceednet_payment=payments; o.xceednet_updated_subscriber=updated; o.gateway_response=gatewayData;
  orders[orderId]=o;saveOrders(orders);return o;
}

const INDEX=fs.readFileSync(path.join(__dirname,'index.html'));

const server=http.createServer(async(req,res)=>{
  try{
    console.log(`${req.method} ${req.url}`);
    if(req.method==='GET' && (req.url==='/'||req.url==='/index.html')) return send(res,200,INDEX,'text/html; charset=utf-8');

    if(req.method==='POST' && req.url==='/api/admin/login'){
      const b=await readJson(req),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');
      if(!ADMIN_EMAIL||!ADMIN_PASSWORD)return send(res,500,{error:'Admin login is not configured.'});
      if(email!==ADMIN_EMAIL||password!==ADMIN_PASSWORD)return send(res,401,{error:'Invalid admin email or password'});
      const t=crypto.randomBytes(32).toString('hex');adminSessions.set(t,email);return send(res,200,{success:true,admin_token:t,email});
    }
    if(req.method==='GET' && req.url==='/api/admin/me'){const e=requireAdmin(req);return e?send(res,200,{success:true,email:e,role:'admin'}):send(res,401,{error:'Admin authentication required'});}
    if(req.method==='POST' && req.url==='/api/admin/logout'){const t=bearer(req);if(t)adminSessions.delete(t);return send(res,200,{success:true});}

    if(req.method==='POST' && req.url==='/api/xceednet/subscriber_login'){
      const b=await readJson(req);if(!b.username||!b.password)return send(res,400,{error:'Username and password are required'});
      const r=await xceed('POST','/api/v2/sessions/subscriber_login',{domain:'veyron.macrosignal.net',username:b.username,password:b.password});
      if(r.status===200&&r.data?.auth_token){subscriberSessions.set(r.data.auth_token,b.username);return send(res,200,{success:true,auth_token:r.data.auth_token});}
      return send(res,r.status,r.data);
    }
    if(req.method==='GET' && req.url==='/api/xceednet/me'){
      const u=requireSubscriber(req);if(!u)return send(res,401,{error:'Subscriber authentication required'});
      const r=await xceed('GET','/api/v2/subscribers/dashboard',null,bearer(req));return send(res,r.status,r.data);
    }
    if(req.method==='POST' && req.url==='/api/xceednet/payments'){
      const u=requireSubscriber(req);if(!u)return send(res,401,{error:'Subscriber authentication required'});
      const sub=await getSubscriber(u);if(!sub)return send(res,404,{error:'Subscriber not found'});
      const r=await xceed('POST','/subscriber_payments/search',{subscriber_id:sub.id},XCEEDNET_ADMIN_AUTH);return send(res,r.status,r.data);
    }
    if(req.method==='POST' && req.url==='/api/xceednet/reset_mac'){
      const u=requireSubscriber(req) || (await readJson(req)).username; if(!u)return send(res,401,{error:'Subscriber authentication required'});
      const sub=await getSubscriber(u);if(!sub)return send(res,404,{error:'Subscriber not found'});
      const r=await xceed('POST','/subscribers/update_multiple',{button:'Reset MAC',subscriber_ids:[sub.id]},XCEEDNET_ADMIN_AUTH);return send(res,r.status,r.data);
    }
    if(req.method==='GET' && req.url==='/api/xceednet/packages'){
      const u=requireSubscriber(req);if(!u)return send(res,401,{error:'Subscriber authentication required'});
      const pkgs=await getPackages(),s=loadSettings();return send(res,200,{data:pkgs.map(p=>({...p,selling_price:Number(s.packages[p.id]?.selling_price ?? p.price_after_tax ?? 0),enabled:s.packages[p.id]?.enabled!==false}))});
    }

    if(req.method==='POST' && req.url==='/api/payments/create-order'){
      const username=requireSubscriber(req);if(!username)return send(res,401,{error:'Subscriber authentication required'});
      const s=loadSettings();if(!s.gateway.enabled)return send(res,400,{error:'Payment gateway is not enabled in Admin → Payment Gateway'});
      const b=await readJson(req),pkgs=await getPackages(),pkg=pkgs.find(p=>String(p.id)===String(b.package_id));if(!pkg)return send(res,400,{error:'Invalid package'});
      const saved=s.packages[pkg.id];if(saved?.enabled===false)return send(res,400,{error:'This package is disabled'});
      let amount=Number(saved?.selling_price ?? pkg.price_after_tax ?? 0); if(!Number.isFinite(amount)||amount<1)return send(res,400,{error:'Package price is not configured'});
      amount=Math.round((amount*(1+Number(s.gateway.extraChargeRate||0)/100))*100)/100;
      const sub=await getSubscriber(username);if(!sub)return send(res,404,{error:'Subscriber not found'});
      const provider=String(s.gateway.provider||'cashfree').toLowerCase();
      const orderId='VN_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex');
      const phone=String(sub.mobile1||sub.phone1||'9999999999').replace(/\D/g,'').slice(-10)||'9999999999';
      const email=sub.email||sub.email1||undefined;
      const orders=loadOrders();
      if(provider==='vyapargateway'){
        if(!s.gateway.secretKey)return send(res,400,{error:'VyaparGateway API Key is required'});
        const vr=await vyaparRequest('POST','/api/v1/create_order',{key:s.gateway.secretKey,client_txn_id:orderId,amount,customer_name:sub.name||username,customer_mobile:phone,customer_email:email,p_info:'Veyron broadband recharge',callback_url:PUBLIC_BASE_URL+'/api/payments/vyapargateway/webhook',redirect_url:PUBLIC_BASE_URL+'/?payment=return&order_id='+encodeURIComponent(orderId),udf1:String(pkg.id).slice(0,25)});
        if(vr.status<200||vr.status>=300||vr.data?.status!==true)return send(res,vr.status||400,{error:vr.data?.msg||vr.data?.error||'VyaparGateway order creation failed',details:vr.data});
        const vd=vr.data?.data||{};orders[orderId]={order_id:orderId,client_txn_id:orderId,gateway_order_id:vd.order_id||orderId,provider,username,package_id:pkg.id,package_name:pkg.name,amount,payment_mode:'UPI',created_at:new Date().toISOString(),vyapar:vd};saveOrders(orders);
        return send(res,200,{success:true,order_id:orderId,client_txn_id:orderId,gateway_order_id:vd.order_id||orderId,amount,package:pkg.name,provider,expires_at:vd.expires_at||null,qr_code:vd.qr_code||null,upi_string:vd.upi_string||null,upi_intent:vd.upi_intent||{},payment_url:vd.payment_url||null});
      }
      if(provider!=='cashfree')return send(res,400,{error:`${s.gateway.provider} is selected, but live integration is not implemented yet.`});
      const cf=await cashfreeRequest('POST','/orders',{order_id:orderId,order_amount:amount,order_currency:'INR',customer_details:{customer_id:String(sub.id),customer_name:sub.name||username,customer_phone:phone,customer_email:email},order_meta:{return_url:PUBLIC_BASE_URL+'/?payment=return&order_id='+encodeURIComponent(orderId),notify_url:PUBLIC_BASE_URL+'/api/payments/cashfree/webhook'},order_note:'Veyron broadband recharge'});
      if(cf.status<200||cf.status>=300)return send(res,cf.status,{error:cf.data?.message||cf.data?.type||'Cashfree order creation failed',details:cf.data});
      orders[orderId]={order_id:orderId,username,package_id:pkg.id,package_name:pkg.name,amount,payment_mode:'online_payment',provider,created_at:new Date().toISOString(),cashfree:cf.data};saveOrders(orders);
      return send(res,200,{success:true,order_id:orderId,payment_session_id:cf.data.payment_session_id,amount,package:pkg.name,provider,mode:s.gateway.mode==='production'?'production':'sandbox'});
    }
    if(req.method==='GET' && req.url.startsWith('/api/payments/status')){
      const username=requireSubscriber(req);if(!username)return send(res,401,{error:'Subscriber authentication required'});
      const u=new URL(req.url,'http://127.0.0.1'),id=u.searchParams.get('order_id');if(!id)return send(res,400,{error:'order_id required'});
      const orders=loadOrders(),o=orders[id];if(!o||o.username!==username)return send(res,404,{error:'Order not found'});
      const provider=String(o.provider||'cashfree').toLowerCase();
      if(provider==='vyapargateway'){
        const s=loadSettings();const vr=await vyaparRequest('POST','/api/v1/check_order_status',{key:s.gateway.secretKey,order_id:o.gateway_order_id||id,client_txn_id:o.client_txn_id||id});
        if(vr.status!==200)return send(res,vr.status,{error:vr.data?.msg||vr.data?.error||'Unable to check VyaparGateway order'});
        const vd=vr.data?.data||{};o.gateway_status=vd.status||'unknown';o.vyapar=vd;orders[id]=o;saveOrders(orders);
        if(String(o.gateway_status).toLowerCase()==='success'&&!o.finalized){try{await finalizeOrder(id)}catch(e){console.error('FINALIZE',e.message);return send(res,500,{error:e.message,paid:true});}}
        return send(res,200,{success:true,order:loadOrders()[id]});
      }
      const cf=await cashfreeRequest('GET','/orders/'+encodeURIComponent(id));if(cf.status!==200)return send(res,cf.status,{error:cf.data?.message||'Unable to check order'});
      o.cashfree_status=cf.data?.order_status||'UNKNOWN';orders[id]=o;saveOrders(orders);
      if(o.cashfree_status==='PAID'&&!o.finalized){try{await finalizeOrder(id)}catch(e){console.error('FINALIZE',e.message);return send(res,500,{error:e.message,paid:true});}}
      return send(res,200,{success:true,order:loadOrders()[id]});
    }
    if(req.method==='POST' && req.url==='/api/payments/vyapargateway/webhook'){
      const raw=await readRaw(req),sig=req.headers['x-vyapargateway-signature'],ts=req.headers['x-vyapargateway-timestamp'],headerOrder=req.headers['x-vyapargateway-order-id'],secret=loadSettings().gateway.webhookSecret;
      if(!sig||!ts||!secret)return send(res,400,{error:'VyaparGateway webhook verification headers/configuration missing'});
      if(!verifyVyaparWebhook(raw,sig,ts,secret))return send(res,400,{error:'Invalid VyaparGateway webhook signature'});
      let payload;try{payload=JSON.parse(raw)}catch{return send(res,400,{error:'Invalid webhook JSON'})}
      const orderId=payload?.client_txn_id||headerOrder||payload?.order_id;
      const status=String(payload?.status||'').toLowerCase();
      if(orderId){const orders=loadOrders();if(orders[orderId]){orders[orderId].gateway_status=status;orders[orderId].vyapar_webhook=payload;saveOrders(orders);}}
      if(orderId&&status==='success'){try{await finalizeOrder(orderId)}catch(e){console.error('VYAPAR WEBHOOK FINALIZE',e.message);}}
      return send(res,200,{success:true});
    }
    if(req.method==='POST' && req.url==='/api/payments/cashfree/webhook'){
      const raw=await readRaw(req),sig=req.headers['x-webhook-signature'],ts=req.headers['x-webhook-timestamp'],secret=loadSettings().gateway.webhookSecret||loadSettings().gateway.secretKey;
      if(!sig||!ts||!secret)return send(res,400,{error:'Webhook verification headers/configuration missing'});
      const expected=crypto.createHmac('sha256',secret).update(String(ts)+raw).digest('base64');const eb=Buffer.from(expected),sb=Buffer.from(String(sig));if(eb.length!==sb.length||!crypto.timingSafeEqual(eb,sb))return send(res,400,{error:'Invalid webhook signature'});
      let payload;try{payload=JSON.parse(raw)}catch{return send(res,400,{error:'Invalid webhook JSON'})}
      const orderId=payload?.data?.order?.order_id || payload?.data?.order_id || payload?.order_id;
      const event=String(payload?.type||payload?.event_type||'').toUpperCase();
      if(orderId && (event.includes('SUCCESS') || event.includes('PAYMENT_SUCCESS') || payload?.data?.payment?.payment_status==='SUCCESS')){
        try{await finalizeOrder(orderId)}catch(e){console.error('WEBHOOK FINALIZE',e.message);}
      }
      return send(res,200,{success:true});
    }

    if(req.method==='GET' && req.url==='/api/admin/settings'){if(!requireAdmin(req))return send(res,401,{error:'Admin authentication required'});const s=loadSettings();return send(res,200,{...s,gateway:{...s.gateway,secretKey:'',webhookSecret:'',secretKeyConfigured:!!s.gateway.secretKey,webhookSecretConfigured:!!s.gateway.webhookSecret}});}
    if(req.method==='POST' && req.url==='/api/admin/settings'){
      if(!requireAdmin(req))return send(res,401,{error:'Admin authentication required'});const b=await readJson(req),s=loadSettings();
      const bg=b.gateway||{};const gateway={...s.gateway,...bg};if(!String(bg.secretKey||'').trim())gateway.secretKey=s.gateway.secretKey;if(!String(bg.webhookSecret||'').trim())gateway.webhookSecret=s.gateway.webhookSecret;const n={...s,...b,company:{...s.company,...(b.company||{})},gateway,invoice:{...s.invoice,...(b.invoice||{})},packages:{...s.packages,...(b.packages||{})}};saveSettings(n);return send(res,200,{success:true});
    }
    if(req.method==='GET' && req.url==='/api/admin/packages'){
      if(!requireAdmin(req))return send(res,401,{error:'Admin authentication required'});const pkgs=await getPackages(),s=loadSettings();return send(res,200,{data:pkgs.map(p=>({...p,selling_price:Number(s.packages[p.id]?.selling_price ?? p.price_after_tax ?? 0),enabled:s.packages[p.id]?.enabled!==false}))});
    }
    if(req.method==='POST' && req.url==='/api/admin/packages'){
      if(!requireAdmin(req))return send(res,401,{error:'Admin authentication required'});const b=await readJson(req),s=loadSettings();if(!b.package_id)return send(res,400,{error:'package_id required'});s.packages[b.package_id]={...(s.packages[b.package_id]||{}),selling_price:Number(b.selling_price),enabled:b.enabled!==false};saveSettings(s);return send(res,200,{success:true});
    }
    if(req.method==='GET' && req.url.startsWith('/api/admin/customers')){
      if(!requireAdmin(req))return send(res,401,{error:'Admin authentication required'});const u=new URL(req.url,'http://127.0.0.1'),username=u.searchParams.get('username')||'';if(!username)return send(res,400,{error:'username is required'});const sub=await getSubscriber(username);if(!sub)return send(res,404,{error:'Subscriber not found'});return send(res,200,{data:sub});
    }
    if(req.method==='POST' && req.url==='/api/admin/customers/reset_mac'){if(!requireAdmin(req))return send(res,401,{error:'Admin authentication required'});const b=await readJson(req),sub=await getSubscriber(b.username);if(!sub)return send(res,404,{error:'Subscriber not found'});const r=await xceed('POST','/subscribers/update_multiple',{button:'Reset MAC',subscriber_ids:[sub.id]},XCEEDNET_ADMIN_AUTH);return send(res,r.status,r.data);}
    if(req.method==='POST' && req.url==='/api/admin/customers/package'){
      if(!requireAdmin(req))return send(res,401,{error:'Admin authentication required'});const b=await readJson(req),sub=await getSubscriber(b.username);if(!sub)return send(res,404,{error:'Subscriber not found'});const pkgs=await getPackages(),pkg=pkgs.find(p=>String(p.id)===String(b.package_id));if(!pkg)return send(res,400,{error:'Package not found'});const updated=await applyPackage(sub,pkg,b.action==='renew');return send(res,200,{success:true,message:b.action==='renew'?'Package renewed':'Package changed',data:updated});
    }
    if(req.method==='GET' && req.url==='/api/admin/payments'){
      if(!requireAdmin(req))return send(res,401,{error:'Admin authentication required'});const r=await xceed('POST','/subscriber_payments/search',{},XCEEDNET_ADMIN_AUTH);return send(res,r.status,r.data);
    }
    if(req.method==='GET' && req.url==='/api/admin/invoices'){
      if(!requireAdmin(req))return send(res,401,{error:'Admin authentication required'});const r=await xceed('POST','/subscriber_invoices/search',{},XCEEDNET_ADMIN_AUTH);return send(res,r.status,r.data);
    }
    if(req.method==='POST' && req.url==='/api/admin/gateway/test'){
      if(!requireAdmin(req))return send(res,401,{error:'Admin authentication required'});
      const g=loadSettings().gateway;if(!g.enabled)return send(res,400,{error:'Gateway is disabled'});
      if(g.provider==='vyapargateway'){
        if(!g.secretKey)return send(res,400,{error:'VyaparGateway API Key is required'});
        const vr=await vyaparRequest('POST','/api/v1/check_order_status',{key:g.secretKey,client_txn_id:'VN_TEST_'+Date.now()});
        if(vr.status===401||vr.status===403)return send(res,502,{error:'VyaparGateway API Key was rejected'});
        return send(res,200,{success:true,message:`VyaparGateway API key accepted by the API endpoint (${vr.status}).`});
      }
      if(g.provider!=='cashfree')return send(res,200,{success:true,message:`${g.provider} selected. This build currently has live order integration for Cashfree and VyaparGateway.`});
      if(!g.appId||!g.secretKey)return send(res,400,{error:'Cashfree App ID and Secret Key are required'});const cf=await cashfreeRequest('GET','/orders/invalid-test-order');if(cf.status===401||cf.status===403)return send(res,502,{error:'Cashfree credentials were rejected'});return send(res,200,{success:true,message:`Cashfree ${g.mode} credentials accepted by the API endpoint.`});
    }

    return send(res,404,{error:'Not Found',path:req.url});
  }catch(e){console.error('SERVER ERROR',e);return send(res,500,{error:e.message||'Server error'});}
});

server.listen(PORT,'127.0.0.1',()=>console.log(`Veyron server: http://127.0.0.1:${PORT}`));
