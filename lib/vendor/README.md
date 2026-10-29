# lib/vendor — 第三方源码（vendored）

项目原则是**零 npm 依赖**（运行时不装 node_modules）。确实需要的小型库以源码形式内联，保留原许可证。

| 文件 | 来源 | 版本 | 许可证 | 用途 |
|---|---|---|---|---|
| `qrcode.js` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (Kazuhiko Arase) | 1.4.4 | MIT | 服务端生成下载二维码（`/d/<token>/qr.svg`），`require('./vendor/qrcode')` 直接可用 |

> 升级方式：`npm pack qrcode-generator@<ver>`，解包后把 `qrcode.js` 覆盖到这里，保留文件头版权声明。
> 重新生成前请用真实扫码或解码器验证一次。
