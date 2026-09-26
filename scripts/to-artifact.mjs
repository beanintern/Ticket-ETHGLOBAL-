// Turns the single-file build into a body fragment for publishing as a claude.ai Artifact
// (the host supplies <html>/<head>/<body>).
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync('dist-artifact/index.html', 'utf8');
const pick = (re) => [...html.matchAll(re)].map((m) => m[0]).join('\n');
const title = pick(/<title>[\s\S]*?<\/title>/g);
const links = pick(/<link rel="(?:preconnect|stylesheet)"[^>]*>/g);
const styles = pick(/<style[^>]*>[\s\S]*?<\/style>/g);
const scripts = pick(/<script[^>]*>[\s\S]*?<\/script>/g);
const out = `${title}\n${links}\n${styles}\n<div id="root"></div>\n${scripts}\n`;
writeFileSync('dist-artifact/ticket.html', out);
console.log(`dist-artifact/ticket.html ${(out.length / 1024).toFixed(0)} kB`);
