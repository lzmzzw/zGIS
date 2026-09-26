import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const command = 'pnpm licenses list --json';
const js=JSON.parse(execFileSync('cmd.exe',['/d','/s','/c',command],{encoding:'utf8',maxBuffer:20*1024*1024}));
const rust=JSON.parse(execFileSync('cargo',['metadata','--format-version','1','--locked','--manifest-path','src-tauri/Cargo.toml'],{encoding:'utf8',maxBuffer:20*1024*1024}));
const lines=['# zGIS 第三方依赖','', '以下清单从当前锁文件解析生成。项目来源链接用于获取原始许可证；交付前按分发要求复核许可证文本。','', '## JavaScript',''];
for(const [license,packages]of Object.entries(js))for(const pkg of packages)lines.push(`- ${pkg.name}@${pkg.version}: ${license} ${pkg.homepage??pkg.repository??''}`);
lines.push('','## Rust','');for(const pkg of rust.packages)if(pkg.name!=='zgis')lines.push(`- ${pkg.name}@${pkg.version}: ${pkg.license??'UNKNOWN'} ${pkg.repository??''}`);
writeFileSync('THIRD_PARTY_NOTICES.md',lines.map(line=>line.trimEnd()).join('\n')+'\n');console.log(`Collected JS and ${rust.packages.length} Rust package notices`);
