/**
 * Pure Node.js favicon generator — no external deps, uses built-in zlib.
 * Draws the MeatBiz drumstick icon programmatically.
 * Run from: frontend/  →  node scripts/generate-favicons.mjs
 */
import zlib from 'zlib';
import {writeFileSync,mkdirSync} from 'fs';
import {join,dirname} from 'path';
import {fileURLToPath} from 'url';
import {promisify} from 'util';

const deflate=promisify(zlib.deflate);
const __dir=dirname(fileURLToPath(import.meta.url));
const publicDir=join(__dir,'..','public');

// ─── Color helpers ────────────────────────────────────────────────────────────
const hex=(h)=>{
  const v=parseInt(h.replace('#',''),16);
  return [(v>>16)&255,(v>>8)&255,v&255,255];
};
const blend=(bg,fg,a)=>{  // alpha composite fg over bg
  const af=a/255, ab=(bg[3]??255)/255;
  const ao=af+ab*(1-af);
  if(ao===0) return [0,0,0,0];
  return [
    Math.round((fg[0]*af+bg[0]*ab*(1-af))/ao),
    Math.round((fg[1]*af+bg[1]*ab*(1-af))/ao),
    Math.round((fg[2]*af+bg[2]*ab*(1-af))/ao),
    Math.round(ao*255),
  ];
};

// ─── Rasterizer ──────────────────────────────────────────────────────────────
function makeCanvas(w,h){
  const data=new Uint8Array(w*h*4); // RGBA, transparent
  return {
    w,h,data,
    put(x,y,col,alpha=col[3]??255){
      x=Math.round(x); y=Math.round(y);
      if(x<0||x>=w||y<0||y>=h) return;
      const i=(y*w+x)*4;
      const bg=[data[i],data[i+1],data[i+2],data[i+3]];
      const out=blend(bg,col,alpha);
      data[i]=out[0]; data[i+1]=out[1]; data[i+2]=out[2]; data[i+3]=out[3];
    },
    // Anti-aliased pixel with fractional coverage
    putAA(x,y,col,coverage){
      this.put(Math.round(x),Math.round(y),col,Math.round((col[3]??255)*coverage));
    },
  };
}

// Filled circle with anti-aliasing
function fillCircle(cv,cx,cy,r,col,opacity=1){
  const x0=Math.floor(cx-r-1), x1=Math.ceil(cx+r+1);
  const y0=Math.floor(cy-r-1), y1=Math.ceil(cy+r+1);
  for(let y=y0;y<=y1;y++){
    for(let x=x0;x<=x1;x++){
      const d=Math.sqrt((x-cx)**2+(y-cy)**2);
      if(d<r+1){
        const cov=Math.min(1,Math.max(0,r+0.5-d));
        cv.put(x,y,col,Math.round((col[3]??255)*cov*opacity));
      }
    }
  }
}

// Stroked circle (ring) with anti-aliasing
function strokeCircle(cv,cx,cy,r,sw,col){
  const x0=Math.floor(cx-r-sw-1), x1=Math.ceil(cx+r+sw+1);
  const y0=Math.floor(cy-r-sw-1), y1=Math.ceil(cy+r+sw+1);
  const inner=r-sw/2, outer=r+sw/2;
  for(let y=y0;y<=y1;y++){
    for(let x=x0;x<=x1;x++){
      const d=Math.sqrt((x-cx)**2+(y-cy)**2);
      if(d>=inner-1&&d<=outer+1){
        const cov=Math.min(1,Math.max(0,Math.min(d-inner+0.5, outer-d+0.5)));
        cv.put(x,y,col,Math.round(255*cov));
      }
    }
  }
}

// Anti-aliased thick line using distance to segment
function strokeLine(cv,x1,y1,x2,y2,sw,col){
  const dx=x2-x1, dy=y2-y1, len=Math.sqrt(dx*dx+dy*dy);
  if(len===0) return;
  const nx=dy/len, ny=-dx/len; // normal
  const r=sw/2;
  const xMin=Math.floor(Math.min(x1,x2)-r-1);
  const xMax=Math.ceil(Math.max(x1,x2)+r+1);
  const yMin=Math.floor(Math.min(y1,y2)-r-1);
  const yMax=Math.ceil(Math.max(y1,y2)+r+1);
  for(let y=yMin;y<=yMax;y++){
    for(let x=xMin;x<=xMax;x++){
      // project point onto segment
      const t=Math.max(0,Math.min(1,((x-x1)*dx+(y-y1)*dy)/(len*len)));
      const px=x1+t*dx, py=y1+t*dy;
      const dist=Math.sqrt((x-px)**2+(y-py)**2);
      if(dist<r+1){
        const cov=Math.min(1,Math.max(0,r+0.5-dist));
        cv.put(x,y,col,Math.round(255*cov));
      }
    }
  }
}

// Fill entire canvas with a color
function fill(cv,col){
  for(let i=0;i<cv.w*cv.h*4;i+=4){
    cv.data[i]=col[0]; cv.data[i+1]=col[1];
    cv.data[i+2]=col[2]; cv.data[i+3]=col[3]??255;
  }
}

// ─── Draw the drumstick icon into a canvas of given size ─────────────────────
function drawIcon(size){
  const cv=makeCanvas(size,size);
  const s=size/32; // scale factor (design is in 32x32 space)

  const WHITE=[255,255,255,255];
  const BLUE=hex('#1A73E8');
  const RED=hex('#EA4335');
  const REDHI=[0xf0,0x6f,0x63,Math.round(0.55*255)];

  // White background circle
  fillCircle(cv,16*s,16*s,15*s,WHITE);

  // Blue border ring
  strokeCircle(cv,16*s,16*s,15*s,2*s,BLUE);

  // Bone line
  strokeLine(cv,10.5*s,22.5*s,21.5*s,11.5*s,2.5*s,RED);

  // Meat bulge circle (top-right)
  fillCircle(cv,21.5*s,11.5*s,5.5*s,RED);

  // Bone cap (bottom-left)
  fillCircle(cv,10.5*s,22.5*s,2.5*s,RED);

  // Subtle highlight
  fillCircle(cv,20*s,9.5*s,1.8*s,REDHI,1);

  return cv;
}

// ─── PNG encoder (pure JS) ────────────────────────────────────────────────────
function crc32(buf){
  let c=0xFFFFFFFF;
  const table=crc32.table||(crc32.table=(()=>{
    const t=new Uint32Array(256);
    for(let n=0;n<256;n++){
      let v=n;
      for(let k=0;k<8;k++) v=v&1?0xEDB88320^(v>>>1):v>>>1;
      t[n]=v;
    }
    return t;
  })());
  for(let i=0;i<buf.length;i++) c=table[(c^buf[i])&0xFF]^(c>>>8);
  return (c^0xFFFFFFFF)>>>0;
}

function chunk(type,data){
  const t=Buffer.from(type,'ascii');
  const len=Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crcInput=Buffer.concat([t,data]);
  const c=Buffer.alloc(4); c.writeUInt32BE(crc32(crcInput));
  return Buffer.concat([len,t,data,c]);
}

async function encodePNG(cv){
  const {w,h,data}=cv;
  // Filter: None (0) for each row
  const raw=Buffer.allocUnsafe(h*(1+w*4));
  for(let y=0;y<h;y++){
    const rowStart=y*(w*4+1);
    raw[rowStart]=0; // filter byte
    const slice=data.slice(y*w*4,(y+1)*w*4);
    Buffer.from(slice).copy(raw,rowStart+1);
  }
  const compressed=await deflate(raw,{level:9});

  const sig=Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdrData=Buffer.alloc(13);
  ihdrData.writeUInt32BE(w,0);
  ihdrData.writeUInt32BE(h,4);
  ihdrData[8]=8;  // bit depth
  ihdrData[9]=6;  // RGBA
  ihdrData[10]=0; ihdrData[11]=0; ihdrData[12]=0;
  const ihdr=chunk('IHDR',ihdrData);
  const idat=chunk('IDAT',compressed);
  const iend=chunk('IEND',Buffer.alloc(0));
  return Buffer.concat([sig,ihdr,idat,iend]);
}

// ─── ICO builder ─────────────────────────────────────────────────────────────
function buildIco(png16){
  const header=Buffer.alloc(6);
  header.writeUInt16LE(0,0);
  header.writeUInt16LE(1,2);
  header.writeUInt16LE(1,4);
  const entry=Buffer.alloc(16);
  entry.writeUInt8(16,0); entry.writeUInt8(16,1);
  entry.writeUInt8(0,2); entry.writeUInt8(0,3);
  entry.writeUInt16LE(1,4); entry.writeUInt16LE(32,6);
  entry.writeUInt32LE(png16.length,8);
  entry.writeUInt32LE(22,12);
  return Buffer.concat([header,entry,png16]);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
mkdirSync(publicDir,{recursive:true});

const sizes=[
  [16,'favicon-16x16.png'],
  [32,'favicon-32x32.png'],
  [64,'favicon-64x64.png'],
  [192,'favicon-192x192.png'],
  [180,'apple-touch-icon.png'],
];

let png16;
for(const[size,name] of sizes){
  const cv=drawIcon(size);
  const buf=await encodePNG(cv);
  writeFileSync(join(publicDir,name),buf);
  if(size===16) png16=buf;
  console.log(`✓ ${name} (${size}×${size}, ${buf.length} bytes)`);
}

writeFileSync(join(publicDir,'favicon.ico'),buildIco(png16));
console.log(`✓ favicon.ico`);
console.log('\nAll favicon assets generated.');
