const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const outputDirectory = path.resolve(projectRoot, "dist");
if (path.dirname(outputDirectory) !== projectRoot || path.basename(outputDirectory) !== "dist") {
  throw new Error(`Refusing to clean unexpected package output path: ${outputDirectory}`);
}

fs.rmSync(outputDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
fs.mkdirSync(outputDirectory, { recursive: true });
console.log(`Cleaned package output: ${outputDirectory}`);
