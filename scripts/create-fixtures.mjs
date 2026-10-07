import { mkdirSync, writeFileSync } from 'node:fs';
import { zipSync } from 'fflate';
const root = 'output/smoke/fixtures';
mkdirSync(root, {recursive:true});
const points = [[116.4074,39.9042],[121.4737,31.2304]];
function header(bytes) {
  const data = Buffer.alloc(100);data.writeInt32BE(9994,0);data.writeInt32BE(bytes/2,24);data.writeInt32LE(1000,28);data.writeInt32LE(1,32);
  [116.4074,31.2304,121.4737,39.9042].forEach((v,i)=>data.writeDoubleLE(v,36+i*8));return data;
}
const records=points.map(([x,y],i)=>{const b=Buffer.alloc(28);b.writeInt32BE(i+1,0);b.writeInt32BE(10,4);b.writeInt32LE(1,8);b.writeDoubleLE(x,12);b.writeDoubleLE(y,20);return b;});
const shp=Buffer.concat([header(156),...records]);
const shxRecords=points.map((_,i)=>{const b=Buffer.alloc(8);b.writeInt32BE(50+14*i,0);b.writeInt32BE(10,4);return b;});
const shx=Buffer.concat([header(116),...shxRecords]);
const dbf=Buffer.alloc(97+25*2+1,0x20);dbf.fill(0,0,97);dbf[0]=3;dbf[1]=126;dbf[2]=9;dbf[3]=26;dbf.writeUInt32LE(2,4);dbf.writeUInt16LE(97,8);dbf.writeUInt16LE(25,10);
Buffer.from('name').copy(dbf,32);dbf[43]=67;dbf[48]=16;Buffer.from('code').copy(dbf,64);dbf[75]=67;dbf[80]=8;dbf[96]=13;
[['北京','001'],['上海','002']].forEach(([name,code],i)=>{Buffer.from(name).copy(dbf,98+i*25);Buffer.from(code).copy(dbf,114+i*25);});dbf[dbf.length-1]=26;
const prj='GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
const files={'cities.shp':shp,'cities.shx':shx,'cities.dbf':dbf,'cities.prj':Buffer.from(prj),'cities.cpg':Buffer.from('UTF-8')};
for(const [name,bytes] of Object.entries(files))writeFileSync(`${root}/${name}`,bytes);
writeFileSync(`${root}/cities.zip`,zipSync(files));
writeFileSync(`${root}/native.geojson`,JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',id:'native-1',geometry:{type:'Point',coordinates:points[0]},properties:{name:'原生文件测试',code:'001'}}]}));
writeFileSync(`${root}/editing.geojson`, JSON.stringify({type:'FeatureCollection',features:[
  ['北京',116.4074,39.9042],['上海',121.4737,31.2304],
  ['广州',113.2644,23.1291],['成都',104.0665,30.5723],
].map(([name,x,y],index)=>({type:'Feature',id:`editing-${index}`,geometry:{type:'Point',coordinates:[x,y]},properties:{城市:name,资料:'编辑回归数据'}}))}));
console.log('Created owned SHP/ZIP/GeoJSON smoke fixtures');
