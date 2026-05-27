#!/usr/bin/env node
/**
 * db/create-organiser.mjs
 *
 * Interactive CLI to create or reset an organiser account. Used
 * once at first deploy to create the bootstrap admin, and any
 * time afterwards to add a teammate or reset a forgotten
 * password.
 *
 * Run as:
 *   DATABASE_URL=... node db/create-organiser.mjs
 *
 * Or via:  npm run db:create-organiser
 *
 * Prompts for email, name, role (admin/organiser), and a password.
 * Password is hashed with scrypt and stored. If the email already
 * exists, you'll be asked whether to update the existing row.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout }    from 'node:process';
import pg                   from 'pg';
import {
  scrypt as scryptCb,
} from 'node:crypto';
import { randomBytes }      from 'node:crypto';
import { promisify }        from 'node:util';

const scrypt = promisify(scryptCb);
const { Client } = pg;

// Match the parameters in _lib/auth.mjs exactly — same hash format.
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_KEYLEN = 64;

async function hashPassword(plaintext) {
  const salt = randomBytes(16);
  const hash = await scrypt(plaintext, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set.');
  process.exit(1);
}

async function prompt(rl, q) {
  return (await rl.question(q)).trim();
}

// Linux/macOS hide the password as it's typed. We read raw bytes
// from stdin so input doesn't show on screen. (On Windows this
// degrades to plain visible input — fine for a dev tool.)
async function promptPassword(prompt) {
  process.stdout.write(prompt);
  const isTTY = stdin.isTTY;
  if (!isTTY) {
    // Non-interactive: read whole line. Useful for piping.
    return new Promise(resolve => {
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', d => buf += d);
      stdin.on('end',  () => resolve(buf.trim()));
    });
  }

  return new Promise(resolve => {
    let pwd = '';
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(wasRaw);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(pwd);
      } else if (ch === '\u0003') {        // Ctrl-C
        process.exit(1);
      } else if (ch === '\u007f') {        // backspace
        if (pwd.length) { pwd = pwd.slice(0, -1); process.stdout.write('\b \b'); }
      } else {
        pwd += ch;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

async function run() {
  const rl = createInterface({ input: stdin, output: stdout });
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  console.log('\n=== Create or update an organiser account ===\n');

  const email = (await prompt(rl, 'Email: ')).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('Invalid email.'); process.exit(1);
  }

  const existing = await client.query(
    `SELECT id, name, role FROM organisers WHERE email = $1`, [email]
  );
  const updating = existing.rows.length > 0;

  if (updating) {
    console.log(`\nAn organiser with this email already exists:`);
    console.log(`  Name: ${existing.rows[0].name}, Role: ${existing.rows[0].role}`);
    const yn = (await prompt(rl, 'Reset password and update? [y/N]: ')).toLowerCase();
    if (yn !== 'y' && yn !== 'yes') {
      console.log('Aborted.'); process.exit(0);
    }
  }

  const name = updating
    ? (await prompt(rl, `Name (blank to keep "${existing.rows[0].name}"): `)) || existing.rows[0].name
    : await prompt(rl, 'Name: ');
  if (!name) { console.error('Name is required.'); process.exit(1); }

  const role = updating
    ? (await prompt(rl, `Role admin|organiser (blank to keep "${existing.rows[0].role}"): `)) || existing.rows[0].role
    : (await prompt(rl, 'Role admin|organiser [organiser]: ')) || 'organiser';
  if (role !== 'admin' && role !== 'organiser') {
    console.error('Role must be admin or organiser.'); process.exit(1);
  }

  // Close readline before raw-mode password input.
  rl.close();

  const password = await promptPassword('Password: ');
  if (password.length < 12) {
    console.error('\nPassword must be at least 12 characters.'); process.exit(1);
  }
  const confirm = await promptPassword('Confirm: ');
  if (password !== confirm) {
    console.error('\nPasswords do not match.'); process.exit(1);
  }

  const hash = await hashPassword(password);

  await client.query(
    `INSERT INTO organisers (email, name, role, password_hash, active)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (email) DO UPDATE SET
       name           = EXCLUDED.name,
       role           = EXCLUDED.role,
       password_hash  = EXCLUDED.password_hash,
       active         = true,
       fail_count     = 0,
       fail_lockout_until = NULL`,
    [email, name, role, hash]
  );

  console.log(`\n✓ ${updating ? 'Updated' : 'Created'} organiser: ${email} (${role})`);
  await client.end();
}

run().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
