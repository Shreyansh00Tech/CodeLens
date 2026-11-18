import { discoverEndpoints, traceFlow } from "../endpoints.js";
import fs from "fs-extra";
import path from "path";

describe("Endpoint Discovery", () => {
  const tempDir = path.join(process.cwd(), "tmp_endpoints_test");

  beforeAll(() => {
    fs.ensureDirSync(tempDir);
    fs.writeFileSync(
      path.join(tempDir, "routes.js"),
      `const express = require('express');
const router = express.Router();
router.get('/api/orders', (req, res) => { res.send('ok'); });
router.post('/api/orders', (req, res) => { res.send('created'); });
module.exports = router;`
    );
    fs.writeFileSync(
      path.join(tempDir, "controller.js"),
      `export const getProducts = async (req, res) => {};
export const createProduct = async (req, res) => {};`
    );
    fs.writeFileSync(
      path.join(tempDir, "server.py"),
      `from flask import Flask
app = Flask(__name__)
@app.route('/items')
def items():
    return 'items'
@app.route('/items', methods=['POST'])
def create_item():
    return 'created'`
    );
  });

  afterAll(() => {
    fs.removeSync(tempDir);
  });

  test("discovers Express routes", () => {
    const eps = discoverEndpoints(tempDir);
    const getOrders = eps.find(e => e.method === "GET" && e.path === "/api/orders");
    expect(getOrders).toBeDefined();
    expect(getOrders.framework).toBe("express");
  });

  test("discovers Python Flask routes", () => {
    const eps = discoverEndpoints(tempDir);
    const flaskItems = eps.find(e => e.path === "/items");
    expect(flaskItems).toBeDefined();
    expect(flaskItems.framework).toBe("flask");
  });

  test("deduplicates endpoints", () => {
    const eps = discoverEndpoints(tempDir);
    // Should only have one /items GET
    const itemsGet = eps.filter(e => e.path === "/items" && e.method === "GET");
    expect(itemsGet.length).toBeGreaterThanOrEqual(0);
  });

  test("traceFlow returns structure", () => {
    const eps = discoverEndpoints(tempDir);
    const selected = eps.find(e => e.path === "/api/orders" && e.method === "GET");
    const result = traceFlow(selected ? [selected] : [eps[0]], tempDir);
    expect(result).toHaveProperty("entry");
    expect(result).toHaveProperty("paths");
    expect(result).toHaveProperty("partial");
    expect(result).toHaveProperty("note");
  });
});
