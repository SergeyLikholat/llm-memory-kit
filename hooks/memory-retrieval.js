#!/usr/bin/env node
// UserPromptSubmit hook: автоматическое извлечение релевантной памяти по запросу.
// По тексту запроса пробегает индексы Obsidian KB (_wiki/**.md) и Memory KB
// (per-project _index.md) и подкладывает указатели на релевантные карты.
// Fail-safe: любая ошибка → exit 0 с пустым контекстом.
'use strict';
const fs = require('fs');
const path = require('path');
const OBSIDIAN_WIKI = '~/Obsidian/_wiki';
const PROJECTS_DIR = (process.env.MEMKIT_PROJECTS_DIR||(process.env.HOME||'/root')+'/projects');
const MAX_STDIN = 1024 * 1024;
const TOP_N = 5, STEM = 5, MIN_TOKEN = 4;
const STOPWORDS = new Set(['этот','эта','тебе','твой','меня','моих','есть','быть','было','была','были','нужно','надо','можно','какой','какие','когда','через','чтобы','потом','тогда','этого','этом','очень','просто','давай','сделай','смотри','пожалуйста','значит','который','которая','которые','вообще','сейчас','здесь','там','как','что','для','про','без','под','над','при','или','если','уже','еще','ещё','так','вот','все','всё']);
function readStdin(){return new Promise(r=>{let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{if(raw.length<MAX_STDIN)raw+=c;});process.stdin.on('end',()=>r(raw));process.stdin.on('error',()=>r(raw));});}
function emit(ctx){process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:ctx||''}}));process.exit(0);}
function stem(t){return t.length>STEM?t.slice(0,STEM):t;}
function tokenize(text){const out=new Set();const words=String(text).toLowerCase().replace(/<[^>]+>/g,' ').match(/[a-zа-яё0-9]{4,}/gi)||[];for(const w of words){if(w.length<MIN_TOKEN||STOPWORDS.has(w))continue;out.add(stem(w));}return out;}
function collectCards(){
  const cards=[];
  const walk=(dir,label)=>{let es;try{es=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}for(const e of es){const full=path.join(dir,e.name);if(e.isDirectory()){walk(full,label);continue;}if(!e.name.endsWith('.md'))continue;let body='';try{body=fs.readFileSync(full,'utf8');}catch{continue;}const headings=(body.match(/^#{1,3}\s+.+$/gm)||[]).join(' ');cards.push({path:full,label,tokens:tokenize(e.name+' '+headings),name:e.name.replace(/\.md$/,'')});}};
  walk(OBSIDIAN_WIKI,'Obsidian');
  const memIdx=[];
  try{for(const p of fs.readdirSync(PROJECTS_DIR)){const idx=path.join(PROJECTS_DIR,p,'memory','_index.md');if(fs.existsSync(idx))memIdx.push([p,idx]);}}catch{}
  memIdx.push(['общее','~/.claude/projects/-root/memory/_index.md']);
  for(const [p,idx] of memIdx){if(!fs.existsSync(idx))continue;let body='';try{body=fs.readFileSync(idx,'utf8');}catch{}cards.push({path:idx,label:'Memory',tokens:tokenize(p+' '+body),name:p+' (память)'});}
  return cards;
}
function score(q,c){let s=0;for(const t of q)if(c.tokens.has(t))s++;return s;}
async function main(){
  let input;try{const raw=await readStdin();if(!raw.trim())emit('');input=JSON.parse(raw);}catch{emit('');return;}
  const prompt=String(input?.prompt||'');
  const office=/\b(xlsx|xlsm|docx)\b|\.(xls|doc)\b|эксель|excel|\bword\b|ворд|openpyxl|python-docx|таблиц|смет[ауы]|бланк/i.test(prompt);
  const q=tokenize(prompt);
  const cards=q.size?collectCards():[];
  const ranked=cards.map(c=>({...c,s:score(q,c)})).filter(c=>c.s>=2).sort((a,b)=>b.s-a.s).slice(0,TOP_N);
  const lines=[];
  if(ranked.length){
    lines.push('## 🧠 Релевантная память по запросу','','Авто-поиск нашёл карты, возможно относящиеся к запросу. Если тема совпадает — прочитай нужную перед ответом:','');
    for(const c of ranked){
      lines.push('- ['+c.label+'] **'+c.name+'** → `'+c.path+'`');
      if(c.label==='Memory'){
        try{const body=fs.readFileSync(c.path,'utf8');const m=body.match(/## \uD83D\uDCC2 [^\n]*\n([\s\S]*?)(?=\n## |\n*$)/);
          if(m){const dirs=m[1].split('\n').filter(l=>l.trim().startsWith('- '));
            if(dirs.length){lines.push('  📂 Рабочие папки проекта:');for(const d of dirs)lines.push('  '+d.trim());}}}catch{}
      }
    }
  }
  if(office){
    lines.push('','## 📄 Работа с Excel/Word — примени скилл `office-docs`','Ключевое: Excel — ВСЕГДА `openpyxl_safe` (иначе «битый файл»), чужой шаблон — ещё `clean_xlsx`; большие файлы — версионируй через next-excel-version.sh; Word — формат бланка + текст сначала в чат.','→ `~/.claude/skills/office-docs/SKILL.md`');
  }
  if(!lines.length)emit('');
  if(ranked.length)lines.push('','_(Указатели авто-извлечения, открывай по релевантности.)_');
  emit(lines.join('\n'));
}
main().catch(()=>emit(''));
