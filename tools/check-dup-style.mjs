import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
const files = [];
(function walk(d){for(const n of readdirSync(d)){if(n==="node_modules"||n==="unpackage"||n.startsWith(".git"))continue;const p=join(d,n);statSync(p).isDirectory()?walk(p):n.endsWith(".uvue")&&files.push(p);}})(".");
let bad=0;
for(const f of files){
  const src=readFileSync(f,"utf8");
  const a=src.indexOf("<script"),b=src.indexOf("<style");
  const cuts=[a,b].filter(x=>x>=0);
  const tpl=(cuts.length?src.slice(0,Math.min(...cuts)):src).replace(/<!--[\s\S]*?-->/g,"");
  const re=/<([a-zA-Z][\w-]*)/g; let m;
  while((m=re.exec(tpl))!==null){
    let i=m.index+m[0].length,quote="";
    while(i<tpl.length){const ch=tpl[i];if(quote){if(ch===quote)quote="";}else if(ch==='"'||ch==="'")quote=ch;else if(ch===">")break;i++;}
    const tag=tpl.slice(m.index,i+1);
    const styles=(tag.match(/(?<!:):style=/g)||[]).length;
    if(styles>1){const line=tpl.slice(0,m.index).split("\n").length;console.log("DUP-STYLE "+relative(".",f)+":"+line+" :: "+tag.replace(/\s+/g," ").slice(0,140));bad++;}
  }
}
console.log("duplicate :style tags: "+bad);
if(bad>0)process.exitCode=1;
