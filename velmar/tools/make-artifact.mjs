// Превращает однофайловую сборку dist-single/index.html в страницу для артефакта:
// убирает обёртку <!doctype>/<html>/<head>/<body> (её добавляет хост), оставляя
// <title>, мета, стили, разметку и встроенный скрипт.
import fs from 'fs';
const src = fs.readFileSync('dist-single/index.html', 'utf8');
const head = src.match(/<head>([\s\S]*?)<\/head>/i)[1];
const body = src.match(/<body>([\s\S]*?)<\/body>/i)[1];
const title = head.match(/<title>[\s\S]*?<\/title>/i)[0];
const styles = [...head.matchAll(/<style[\s\S]*?<\/style>/gi)].map((m) => m[0]).join('\n');
const scripts = [...head.matchAll(/<script[\s\S]*?<\/script>/gi)].map((m) => m[0]);
const bodyNoScripts = body.replace(/<script[\s\S]*?<\/script>/gi, '');
const out = [
  title,
  '<meta name="claude:viewport-fit-sides" content="cover">',
  '<meta name="description" content="VELMAR: Ночной прилив — open-world криминальный экшен в процедурном городе.">',
  styles,
  bodyNoScripts.trim(),
  ...scripts,
].join('\n');
fs.mkdirSync('dist-artifact', { recursive: true });
fs.writeFileSync('dist-artifact/velmar.html', out);
console.log('artifact bytes', out.length, 'scripts', scripts.length, 'styles', styles.length);
