/** @type {import("jest").Config} **/
module.exports = {
  testEnvironment: "node",
  // swc strips the types; `npm run typecheck` checks them.
  transform: { "^.+\\.tsx?$": "@swc/jest" },
};
