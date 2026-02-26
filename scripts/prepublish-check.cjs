#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

console.log('Pre-publish checks...\n');

// Check required files
const requiredFiles = ['cli.cjs', 'package.json', 'yoga.wasm', '.npmrc'];
const missingFiles = requiredFiles.filter(file => !fs.existsSync(file));

if (missingFiles.length > 0) {
  console.error('ERROR: Missing required files:', missingFiles.join(', '));
  console.error('   Run "npm run build" first');
  process.exit(1);
}

// Check cli.cjs is executable (skip on Windows where file mode bits are not meaningful)
if (process.platform !== 'win32') {
  const cliStats = fs.statSync('cli.cjs');
  if (!(cliStats.mode & 0o100)) {
    console.error('ERROR: cli.cjs is not executable');
    process.exit(1);
  }
}

// Check package.json
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

if (!pkg.bin || !pkg.bin.yuuka) {
  console.error('ERROR: Missing bin field in package.json');
  process.exit(1);
}

// Bundled dependencies check removed - not needed for this package structure

console.log('All checks passed!');
console.log('\nPackage info:');
console.log(`   Name: ${pkg.name}`);
console.log(`   Version: ${pkg.version}`);
console.log(`   Main: ${pkg.main}`);
console.log(`   Bin: yuuka -> ${pkg.bin.yuuka}`);
console.log('\nReady to publish!');
console.log('   Run: npm publish');
