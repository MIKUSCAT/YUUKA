#!/usr/bin/env node

// Cross-platform CLI wrapper for YUUKA (Node.js)

const { spawn } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');

// Get the directory where this CLI script is installed
const yuukaDir = __dirname;
const distPath = path.join(yuukaDir, 'dist', 'index.js');

	// Check if we have a built version
	if (!existsSync(distPath)) {
	  console.error('ERROR: Built files not found. Run "npm run build" first.');
	  process.exit(1);
	}

const proc = spawn('node', [distPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd()  // Use current working directory, not installation directory
});

	proc.on('error', (err) => {
	  console.error('ERROR: Failed to start with Node.js:', err.message);
	  process.exit(1);
	});

proc.on('close', (code) => {
  process.exit(code);
});
