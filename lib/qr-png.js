'use strict';

/**
 * qr-png.js — 零依赖生成二维码 PNG（二维码矩阵来自 lib/vendor/qrcode.js，
 * PNG 用 node:zlib 压缩 + 手写 IHDR/IDAT/IEND）。
 */

const zlib = require('node:zlib');
const path = require('node:path');
const QR = require(path.join(__dirname, 'vendor', 'qrcode.js'));



function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 生成二维码 PNG：深色模块 #0d1117，白底，带 4 模块静区 */
function qrPng(text, targetWidth = 420) {
  const qr = QR(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const margin = 4;
  const scale = Math.max(2, Math.floor(targetWidth / (count + margin * 2)));
  const size = (count + margin * 2) * scale;
  const rowBytes = size * 4 + 1;
  const raw = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowBytes] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - margin;
      const my = Math.floor(y / scale) - margin;
      const dark = mx >= 0 && my >= 0 && mx < count && my < count && qr.isDark(my, mx);
      const o = y * rowBytes + 1 + x * 4;
      if (dark) {
        raw[o] = 0x0d;
        raw[o + 1] = 0x11;
        raw[o + 2] = 0x17;
      } else {
        raw[o] = 0xff;
        raw[o + 1] = 0xff;
        raw[o + 2] = 0xff;
      }
      raw[o + 3] = 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { qrPng };
