#!/usr/bin/env node
'use strict';

/**
 * 重置面板登录密码
 *
 * 用法：
 *   node tests/reset-password.mjs            交互式输入新密码
 *   node tests/reset-password.mjs 新密码      直接指定
 *   node tests/reset-password.mjs --random   生成随机密码并打印
 *
 * 说明：
 *   - 只改写 config.json 中的 passwordHash，不动用户名与其他配置
 *   - 修改后需重启面板服务生效：
 *       systemctl --user restart server-panel
 */

const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const config = require(path.join(ROOT, 'lib', 'config.js'));

/* ---------------- 参数解析 ---------------- */

const args = process.argv.slice(2);
const wantRandom = args.includes('--random');
const explicit = args.find((a) => !a.startsWith('--'));

function generateReadablePassword(len = 16) {
  // 去掉易混淆字符 0/O/1/l/I
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** 交互式读取密码（不回显） */
function promptPassword(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (char) => {
      const s = char.toString();
      if (s === '\n' || s === '\r' || s === '\u0004') {
        process.stdin.removeListener('data', onData);
      } else if (s === '\u0003') {
        process.exit(1);
      } else {
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
    rl.question(question, (answer) => {
      rl.close();
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

/* ---------------- 主流程 ---------------- */

(async () => {
  if (!fs.existsSync(config.CONFIG_PATH)) {
    console.error(`❌ 配置文件不存在：${config.CONFIG_PATH}`);
    console.error('   请先启动一次面板以生成配置。');
    process.exit(1);
  }

  const cfg = JSON.parse(fs.readFileSync(config.CONFIG_PATH, 'utf8'));
  if (!cfg.panel) {
    console.error('❌ config.json 缺少 panel 配置段');
    process.exit(1);
  }

  let newPassword;
  if (wantRandom) {
    newPassword = generateReadablePassword(16);
  } else if (explicit) {
    newPassword = explicit;
  } else {
    if (!process.stdin.isTTY) {
      console.error('❌ 非交互环境请直接传入密码，或使用 --random');
      process.exit(1);
    }
    console.log(`当前用户名：${cfg.panel.username}`);
    const p1 = await promptPassword('请输入新密码（至少 8 位）: ');
    if (p1.length < 8) {
      console.error('❌ 密码至少 8 位');
      process.exit(1);
    }
    const p2 = await promptPassword('请再次输入确认: ');
    if (p1 !== p2) {
      console.error('❌ 两次输入不一致');
      process.exit(1);
    }
    newPassword = p1;
  }

  if (newPassword.length < 8) {
    console.error('❌ 密码至少 8 位');
    process.exit(1);
  }
  if (newPassword.length > 200) {
    console.error('❌ 密码过长（上限 200 字符）');
    process.exit(1);
  }

  // 重新生成盐并计算哈希
  const salt = crypto.randomBytes(16).toString('hex');
  cfg.panel.passwordSalt = salt;
  cfg.panel.passwordHash = config.hashPassword(newPassword, salt);
  cfg.panel.mustChangePassword = false; // 已经是用户主动设置的新密码

  config.saveConfig(cfg);

  console.log('');
  console.log('='.repeat(50));
  console.log('  ✅ 密码已重置');
  console.log('');
  console.log(`  用户名：${cfg.panel.username}`);
  if (wantRandom || explicit) {
    console.log(`  新密码：${newPassword}`);
  } else {
    console.log('  新密码：你刚才输入的那个');
  }
  console.log('');
  console.log('  重启面板以生效：');
  console.log('    systemctl --user restart server-panel');
  console.log('='.repeat(50));
  console.log('');
})();
