'use strict';
// Mr.Chess 7.0 — zero-dependency HTTP + WebSocket server (Node >= 18).
const http=require('http');
const crypto=require('crypto');
const fs=require('fs');
const path=require('path');
const {setup,legal,moveState,sqName,outcome}=require('./rules.cjs');
const PORT=Number(process.env.PORT||3000);
const rooms=new Map();
const homepage=path.join(__dirname,'index.html');
function send(client,obj){
  if(!client || client.closed) return;
  const raw=Buffer.from(JSON.stringify(obj));
  if(raw.length>64000) return;
  const header=raw.length<126?Buffer.from([0x81,raw.length]):Buffer.from([0x81,126,raw.length>>>8,raw.length&255]);
  try{client.socket.write(Buffer.concat([header,raw]));}catch(_){}}
function sendRoom(room,obj,except){for(const c of [room.host,room.guest])if(c!==except)send(c,obj)}
function error(c,msg){send(c,{type:'error',message:msg})}
const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode(){let code;do{code='MR-'+Array.from(crypto.randomBytes(8),x=>alphabet[x%alphabet.length]).join('')}while(rooms.has(code));return code}
function leave(c){if(!c.room)return;const room=c.room;c.room=null;
  if(rooms.get(room.code)!==room)return;
  rooms.delete(room.code);
  sendRoom(room,{type:'disconnected'},c);
  for(const other of [room.host,room.guest])if(other!==c&&other){other.room=null}
}
function resetRoom(room){room.history=[setup()];room.clock={w:room.minutes*60000,b:room.minutes*60000};room.clockAt=0;room.finished=false;}
function roomTick(room){
  if(!room.guest||room.finished||room.history.length===1||!room.clockAt)return;
  const now=Date.now();let spent=Math.max(0,now-room.clockAt);
  room.clockAt=now;
  const c=room.history.at(-1).t===1?'w':'b';
  room.clock[c]=Math.max(0,room.clock[c]-spent);
  if(room.clock[c]===0){room.finished=true;sendRoom(room,{type:'result',winner:c==='w'?-1:1,message:'⏰ Vaqt tugadi.'});}
}
function action(c,msg){
  if(!msg||typeof msg!=='object'||typeof msg.type!=='string')return;
  if(msg.type==='create'){
    if(c.room){error(c,'Avvalgi xonadan chiqing.');return}
    const minutes=Number(msg.minutes), side=Number(msg.side);
    if(![1,5,10].includes(minutes)||![1,-1].includes(side)){error(c,'Tomon yoki vaqt noto‘g‘ri.');return}
    const code=newCode(); const room={code,host:c,guest:null,minutes,side};resetRoom(room);
    rooms.set(code,room);c.room=room;c.color=side;
    send(c,{type:'created',code});return;
  }
  if(msg.type==='join'){
    const code=String(msg.code||'').toUpperCase(),room=rooms.get(code);
    if(c.room){error(c,'Siz boshqa xonadasiz.');return}
    if(!room){error(c,'Bunday xona yo‘q yoki yopilgan. Kodni tekshiring.');return}
    if(room.guest){error(c,'Bu xona band.');return}
    room.guest=c;c.room=room;c.color=-room.side;resetRoom(room);
    send(room.host,{type:'ready',color:room.side,minutes:room.minutes});
    send(c,{type:'start',code,color:c.color,minutes:room.minutes});return;
  }
  const room=c.room;
  if(!room||!room.guest){error(c,'Do‘stingiz hali ulanmagan.');return}
  if(msg.type==='move'){
    if(room.finished){error(c,'Partiya tugagan.');return}
    const state=room.history.at(-1);
    if(state.t!==c.color){error(c,'Hozir sizning yurishingiz emas.');return}
    if(typeof msg.uci!=='string'||!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(msg.uci)){error(c,'Noto‘g‘ri yurish.');return}
    const chosen=legal(state).find(m=>sqName(m[0])+sqName(m[1])+m[2]===msg.uci);
    if(!chosen){error(c,'Qonunsiz yurish.');return}
    if(room.history.length>1)roomTick(room);
    if(room.finished)return;
    const next=moveState(state,chosen);room.history.push(next);
    room.clockAt=Date.now();
    const obj={type:'move',uci:msg.uci,ply:room.history.length-1,clock:{...room.clock}};
    sendRoom(room,obj,c);
    const result=outcome(next,room.history);
    if(result.done){room.finished=true;sendRoom(room,{type:'result',winner:result.winner,message:result.msg})}
    return;
  }
  if(msg.type==='restart'){resetRoom(room);sendRoom(room,{type:'restart'},c);return}
  if(msg.type==='resign'){room.finished=true;sendRoom(room,{type:'resign'},c);return}
  if(msg.type==='drawAsk'){sendRoom(room,{type:'drawAsk'},c);return}
  if(msg.type==='drawYes'){room.finished=true;sendRoom(room,{type:'drawYes'},c);return}
  if(msg.type==='drawNo'){sendRoom(room,{type:'drawNo'},c);return}
}
function socketClient(socket){
  const c={socket,closed:false,room:null,buffer:Buffer.alloc(0)};
  socket.on('data',chunk=>{
    if(c.closed)return;
    c.buffer=Buffer.concat([c.buffer,chunk]);
    if(c.buffer.length>262144){socket.destroy();return}
    while(c.buffer.length>=2){
      const b=c.buffer;const opcode=b[0]&15, mask=b[1]&128;let len=b[1]&127, at=2;
      if(!(b[0]&128)){socket.destroy();return} // no fragmentation in client messages
      if(len===126){if(b.length<4)return;len=b.readUInt16BE(2);at=4}
      else if(len===127){socket.destroy();return}
      if(!mask){socket.destroy();return} // browser frames are masked
      if(b.length<at+4+len)return;
      const mk=b.subarray(at,at+4),raw=b.subarray(at+4,at+4+len);
      const body=Buffer.allocUnsafe(len);for(let i=0;i<len;i++)body[i]=raw[i]^mk[i%4];
      c.buffer=b.subarray(at+4+len);
      if(opcode===8){socket.end();return}
      if(opcode===9){let n=body.length<126?Buffer.from([0x8a,body.length]):Buffer.from([0x8a,0]);socket.write(Buffer.concat([n,body]));continue}
      if(opcode!==1)continue;
      try{action(c,JSON.parse(body.toString('utf8')))}catch(e){console.error('message error',e.message);error(c,'Server xatosi.');}
    }
  });
  const closed=()=>{if(c.closed)return;c.closed=true;leave(c)};
  socket.on('close',closed);socket.on('error',closed);
}
const server=http.createServer((req,res)=>{
  const route=(req.url||'/').split('?')[0];
  if(route==='/health'){
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify({ok:true,rooms:rooms.size}));return;
  }
  if(route!=='/'&&route!=='/index.html'){
    res.writeHead(404,{'content-type':'text/plain;charset=utf-8'});res.end('Not found');return;
  }
  res.writeHead(200,{'content-type':'text/html;charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  fs.createReadStream(homepage).pipe(res);
});
server.on('upgrade',(req,socket)=>{
  if(req.url!=='/ws'){socket.destroy();return}
  const key=req.headers['sec-websocket-key'];
  if(!key||req.headers.upgrade?.toLowerCase()!=='websocket'){socket.destroy();return}
  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  socketClient(socket);
});
const timer=setInterval(()=>{for(const room of rooms.values())roomTick(room)},750);
timer.unref();
server.listen(PORT,'0.0.0.0',()=>console.log(`Mr.Chess online server ready: http://localhost:${PORT}`));
