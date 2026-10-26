/** @type {import('next').NextConfig} */
module.exports = {
  // The compiler lives outside ide/, so Next needs the repo root as its file root.
  outputFileTracingRoot: require('path').join(__dirname, '..'),
  turbopack: { root: require('path').join(__dirname, '..') },
  devIndicators: false,
  // Built on Vercel = the public site: files live in the browser, no board on the server.
  env: { NEXT_PUBLIC_ZAPP_HOSTED: process.env.VERCEL ? '1' : '' },
  // The routes read these at runtime by path, so tracing can't find them on its own.
  outputFileTracingIncludes: {
    '/api/emulate': ['../emulator/zapp-emu'],
    '/api/files': ['../examples/*.zap', '../modules/*.zappmod'],
    '/api/modules': ['../modules/*.zappmod'],
    '/api/board': ['../boards/*.zappboard'],
    '/api/firmware': ['../firmware/rp2040/build/zapp.uf2', '../firmware/rp2040/build-picow/zapp.uf2'],
  },
};
