#!/usr/bin/env node
// UserPromptSubmit hook: автоматическое извлечение релевантной памяти по запросу.
// По тексту запроса пробегает индексы Obsidian KB (_wiki/**.md, опционально) и Memory KB
// (per-project _index.md + шарды тем) и подкладывает указатели/выжимки на релевантные карты.
// Fail-safe: любая ошибка → exit 0 с пустым контекстом.
'use strict';
const fs = require('fs');
const path = require('path');
const HOME = process.env.HOME || '/root';
const CLAUDE_DIR = (process.env.MEMKIT_CLAUDE_DIR || HOME + '/.claude');
// Obsidian опционален: если MEMKIT_OBSIDIAN_DIR пуст — волт просто не индексируется.
const OBSIDIAN_WIKI = (process.env.MEMKIT_OBSIDIAN_DIR ? process.env.MEMKIT_OBSIDIAN_DIR + '/_wiki' : '');
const PROJECTS_DIR = (process.env.MEMKIT_PROJECTS_DIR || HOME + '/projects');
const ROOT_MEM = (process.env.MEMKIT_ROOT_MEM || CLAUDE_DIR + '/projects/-root/memory');
// Приватные проекты (comma-separated в MEMKIT_PRIVATE_PROJECTS): телом НЕ индексируем, только указатель.
const PRIVATE = new Set((process.env.MEMKIT_PRIVATE_PROJECTS || '').split(',').map(s => s.trim()).filter(Boolean));
const MAX_STDIN = 1024 * 1024;
// STEM=6: обрезка до 5 склеивала разное («транскрибатор» и «транспорт» → «транс») и запрос терялся.
// MIN_TOKEN=3: короткие имена продуктов («n8n», «gpt») — сильные сигналы, отбрасывать их нельзя.
const TOP_N = 5, STEM = 6, MIN_TOKEN = 3;
const INJECT_N = 2, SNIP_MAX = 700;   // сколько верхних тем цитировать телом и предел цитаты (символов)
const STOPWORDS = new Set(['этот','эта','тебе','твой','меня','моих','есть','быть','было','была','были','нужно','надо','можно','какой','какие','какую','когда','через','чтобы','потом','тогда','этого','этом','очень','просто','давай','сделай','смотри','пожалуйста','значит','который','которая','которые','вообще','сейчас','здесь','там','как','что','для','про','без','под','над','при','или','если','уже','еще','ещё','так','вот','все','всё','мне','моем','моём','мой','моя','его','её','них','нам',
  // вежливость и болтовня: редкие в корпусе → без этого «Привет!» ловил случайный шард
  'привет','здравствуйте','спасибо','пожалуй','ладно','понял','поняла','отлично','супер','круто','norm','okay','хорошо','пока','доброе','утро','вечер','дела','дело','продолжи','продолжай','дальше','далее','раз','разок','сделал','покажи','проверь','напиши','ответь']);
function readStdin(){return new Promise(r=>{let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{if(raw.length<MAX_STDIN)raw+=c;});process.stdin.on('end',()=>r(raw));process.stdin.on('error',()=>r(raw));});}
function emit(ctx){process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:ctx||''}}));process.exit(0);}
function stem(t){return t.length>STEM?t.slice(0,STEM):t;}
const WORD_RE=new RegExp('[a-zа-яё0-9]{'+MIN_TOKEN+',}','gi');   // из MIN_TOKEN, а не зашитой длиной
function tokenize(text){const out=new Set();const words=String(text).toLowerCase().replace(/<[^>]+>/g,' ').match(WORD_RE)||[];for(const w of words){if(w.length<MIN_TOKEN||STOPWORDS.has(w))continue;out.add(stem(w));}return out;}
// Каждая карта несёт ДВА набора токенов: strong (имя, frontmatter-теги, ## заголовки) — это то,
// О ЧЁМ карта; weak (тело) — что в ней просто упомянуто. Совпадение по strong весит кратно больше:
// иначе слова-рамки вопроса, редко встречаясь в фактологичных шардах, набирали высокий IDF
// и топили семантическое ядро (ключевое слово стоит в теге профиля).
function fields(name,body){
  const fm=(body.match(/^---([\s\S]*?)---/)||[,''])[1];
  const tags=(fm.match(/tags:\s*\[(.*?)\]/i)||[,''])[1];
  const heads=(body.match(/^#{1,4}\s+.+$/gm)||[]).join(' ');
  return {strong:tokenize(name+' '+tags+' '+heads),weak:tokenize(body)};
}
function collectCards(){
  const cards=[];
  const walk=(dir,label)=>{let es;try{es=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}for(const e of es){const full=path.join(dir,e.name);if(e.isDirectory()){walk(full,label);continue;}if(!e.name.endsWith('.md'))continue;let body='';try{body=fs.readFileSync(full,'utf8');}catch{continue;}const fl=full.includes('/entities/')?'Хаб':label;cards.push({path:full,label:fl,...fields(e.name,body),name:e.name.replace(/\.md$/,'')});}};
  if(OBSIDIAN_WIKI)walk(OBSIDIAN_WIKI,'Obsidian');
  const memIdx=[];
  try{for(const p of fs.readdirSync(PROJECTS_DIR)){const idx=path.join(PROJECTS_DIR,p,'memory','_index.md');if(fs.existsSync(idx))memIdx.push([p,idx]);}}catch{}
  memIdx.push(['общее',ROOT_MEM+'/_index.md']);
  for(const [p,idx] of memIdx){if(!fs.existsSync(idx))continue;let body='';try{body=fs.readFileSync(idx,'utf8');}catch{}cards.push({path:idx,label:'Memory',...fields(p,body),name:p+' (память)'});}
  // Шарды памяти индексируются по СОДЕРЖИМОМУ, а не только по оглавлению в _index.md.
  // Иначе запрос про конкретный факт не находит ничего: слово живёт в теле темы, а в индекс
  // попадают лишь заголовок, первая строка и теги. Приватные контуры (MEMKIT_PRIVATE_PROJECTS)
  // телом НЕ индексируются: только указатель на _index.
  for(const [p,idx] of memIdx){
    if(PRIVATE.has(p))continue;
    const td=path.join(path.dirname(idx),'topics');
    let fl=[];try{fl=fs.readdirSync(td).filter(f=>f.endsWith('.md'));}catch{continue;}
    for(const f of fl){
      let body='';try{body=fs.readFileSync(path.join(td,f),'utf8');}catch{continue;}
      const title=(body.match(/^#\s+(.+)$/m)||[,f.replace(/\.md$/,'')])[1].trim();
      cards.push({path:path.join(td,f),label:'Тема',...fields(f,body),name:title+' ('+p+')'});
    }
  }
  return cards;
}
// Скоринг: вес = Σ по совпавшим словам от idf(слово) × (STRONG_MUL если слово в теге/заголовке, иначе 1).
// IDF (log(1+N/df)) поднимает редкие слова; множитель поля решает, что ключевое слово в теге профиля
// (карта ПРО него) бьёт слово-рамку, случайно мелькнувшее в теле чужой темы.
const STRONG_MUL=4;   // совпадение по тегу/заголовку весит вчетверо против упоминания в теле
function docFreq(cards){const df=new Map();for(const c of cards)for(const t of new Set([...c.strong,...c.weak]))df.set(t,(df.get(t)||0)+1);return df;}
function idf(t,df,N){return Math.log(1+N/((df.get(t)||0)+0.5));}
function score(q,c,df,N){let w=0,hits=0,strongHit=0,maxIdf=0,mt=[];for(const t of q){const s=c.strong.has(t),wk=c.weak.has(t);if(s||wk){const v=idf(t,df,N);w+=v*(s?STRONG_MUL:1);hits++;if(s)strongHit++;if(v>maxIdf)maxIdf=v;mt.push(t);}}return{w,hits,strongHit,maxIdf,mt};}
// Выжимка тела шарда: строки, где встретилось слово запроса, каждая — с ближайшим ### подзаголовком.
// Даёт модели конкретный факт, а не путь к файлу.
function extractSnippet(p,q){
  let body='';try{body=fs.readFileSync(p,'utf8');}catch{return '';}
  body=body.replace(/^---[\s\S]*?---\n/,'');
  const rows=body.split('\n'); let sub=''; const out=[]; const seen=new Set();
  for(const raw of rows){
    const l=raw.trim(); if(!l)continue;
    const h=l.match(/^#{2,4}\s+(.+)$/); if(h){sub=h[1].trim();continue;}
    const lt=[...tokenize(l)];
    if(lt.some(t=>q.has(t))){
      if(sub&&!seen.has(sub)){out.push('**'+sub+'**');seen.add(sub);}
      out.push(l.replace(/\*\*/g,'').slice(0,200));
    }
  }
  let s=out.join('\n'); if(s.length>SNIP_MAX)s=s.slice(0,SNIP_MAX)+'…'; return s;
}
async function main(){
  let input;try{const raw=await readStdin();if(!raw.trim())emit('');input=JSON.parse(raw);}catch{emit('');return;}
  const prompt=String(input?.prompt||'');
  const office=/\b(xlsx|xlsm|docx)\b|\.(xls|doc)\b|эксель|excel|\bword\b|ворд|openpyxl|python-docx|таблиц|смет[ауы]|бланк/i.test(prompt);
  const q=tokenize(prompt);
  const cards=q.size?collectCards():[];
  const df=docFreq(cards),N=cards.length;
  // ANCHOR: слово в ≤~3 картах — отличительное. Частое слово (df больше) в одиночку не проходит.
  const ANCHOR=Math.log(1+N/3.5);
  // Проходит: совпадение по тегу/заголовку (карта ПРО это) ИЛИ ≥2 совпадения в теле ИЛИ одно очень редкое слово.
  const ranked=cards.map(c=>({...c,...score(q,c,df,N)})).filter(c=>c.strongHit>=1||c.hits>=2||c.maxIdf>=ANCHOR).sort((a,b)=>b.w-a.w).slice(0,TOP_N);
  const lines=[];
  if(ranked.length){
    lines.push('## 🧠 Релевантная память по запросу','','Это твоя долговременная память по текущему вопросу. Блоки «из памяти» — установленные факты о пользователе и его проектах, учитывай их в ответе как известное (не переспрашивай то, что здесь есть). По ссылкам — полные темы, открой при необходимости.','');
    ranked.forEach((c,i)=>{
      lines.push('- ['+c.label+'] **'+c.name+'** → `'+c.path+'`');
      if(c.label==='Memory'){
        try{const body=fs.readFileSync(c.path,'utf8');const m=body.match(/## 📂 [^\n]*\n([\s\S]*?)(?=\n## |\n*$)/);
          if(m){const dirs=m[1].split('\n').filter(l=>l.trim().startsWith('- '));
            if(dirs.length){lines.push('  📂 Рабочие папки проекта:');for(const d of dirs)lines.push('  '+d.trim());}}}catch{}
      }
      if(c.label==='Тема'&&i<INJECT_N&&c.strongHit>=1){
        // Строки тащат только ОТЛИЧИТЕЛЬНЫЕ слова запроса (df ≤ N/10): частые
        // встречаются в половине шардов и раздували выжимку посторонними строками — токены на ветер.
        const qSel=new Set([...q].filter(t=>(df.get(t)||0)<=N/10));
        const snip=extractSnippet(c.path,qSel.size?qSel:q);
        if(snip){lines.push('  ┌ из памяти:');for(const s of snip.split('\n'))lines.push('  │ '+s);}
      }
    });
  }
  if(office){
    lines.push('','## 📄 Работа с Excel/Word — примени скилл `office-docs`','Ключевое: Excel — ВСЕГДА `openpyxl_safe` (иначе «битый файл»), чужой шаблон — ещё `clean_xlsx`; большие файлы — версионируй через next-excel-version.sh; Word — формат бланка + текст сначала в чат.','→ `'+CLAUDE_DIR+'/skills/office-docs/SKILL.md`');
  }
  if(!lines.length)emit('');
  if(ranked.length)lines.push('','_(Указатели авто-извлечения, открывай по релевантности.)_');
  emit(lines.join('\n'));
}
main().catch(()=>emit(''));
