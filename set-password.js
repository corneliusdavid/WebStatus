'use strict';
// Run this once to set the login password: node set-password.js
const bcrypt = require('bcryptjs');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('Enter new password: ', (password) => {
  rl.close();
  if (!password || password.length < 4) {
    console.error('Password must be at least 4 characters.');
    process.exit(1);
  }
  const hash = bcrypt.hashSync(password, 12);
  const configPath = path.join(__dirname, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.auth.passwordHash = hash;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log('Password saved to config.json. Restart server.js to apply.');
});
