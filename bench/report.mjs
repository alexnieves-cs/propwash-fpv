// Prints the last `vitest bench` run as a Markdown table, with the machine it ran on.
// Usage: node bench/report.mjs bench/last-run.json
import { readFileSync } from 'node:fs';
import os from 'node:os';

const file = process.argv[2] ?? 'bench/last-run.json';
const data = JSON.parse(readFileSync(file, 'utf8'));
const us = (ms) => (ms * 1000).toFixed(1);

const cpus = os.cpus();
console.log(`Machine: ${cpus[0]?.model ?? 'unknown CPU'}, ${cpus.length} logical CPUs, ${(os.totalmem() / 2 ** 30).toFixed(0)} GB RAM`);
console.log(`OS: ${os.type()} ${os.release()} (${os.arch()}), Node ${process.version}`);
console.log(`Load average at report time (1, 5, 15 min): ${os.loadavg().map((v) => v.toFixed(2)).join(', ')}`);
console.log('');
for (const f of data.files) {
  for (const g of f.groups) {
    console.log(`#### ${g.fullName.split(' > ').slice(1).join(' > ')}`);
    console.log('');
    console.log('| Case | Median, µs | p75, µs | p99, µs | Mean, µs | Samples |');
    console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const b of g.benchmarks) console.log(`| ${b.name} | ${us(b.median)} | ${us(b.p75)} | ${us(b.p99)} | ${us(b.mean)} | ${b.sampleCount} |`);
    console.log('');
  }
}
