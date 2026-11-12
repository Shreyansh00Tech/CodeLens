module.exports = {
  testEnvironment: "node",

  transform: {},

  testPathIgnorePatterns: [
    "/node_modules/",
    "/tmp/",
    "/tmp_test/",
    "/tmp_rag_test/",
    "/tmp_endpoints_test/",
  ],

  watchPathIgnorePatterns: [
    "/tmp/",
  ],
};