module.exports = {
  testEnvironment: "node",

  transform: {},

  // Anchored to <rootDir> so checkouts that live under a /tmp/ path still find their tests.
  testPathIgnorePatterns: [
    "/node_modules/",
    "<rootDir>/tmp/",
    "<rootDir>/tmp_test/",
    "<rootDir>/tmp_rag_test/",
    "<rootDir>/tmp_endpoints_test/",
    "<rootDir>/test-fixtures/",
  ],

  watchPathIgnorePatterns: ["<rootDir>/tmp/"],
};
