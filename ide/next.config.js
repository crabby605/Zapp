/** @type {import('next').NextConfig} */
module.exports = {
  // The compiler lives outside ide/, so Next needs the repo root as its file root.
  outputFileTracingRoot: require('path').join(__dirname, '..'),
};
