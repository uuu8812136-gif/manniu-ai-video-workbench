const { createHash } = require("node:crypto");
const { createReadStream, readdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const outputDirectory = path.resolve(process.argv[2] || "dist");
const artifacts = readdirSync(outputDirectory)
  .filter((name) => /\.(?:exe|zip)$/i.test(name))
  .sort((left, right) => left.localeCompare(right));

if (artifacts.length === 0) throw new Error(`No release artifacts found in ${outputDirectory}`);

Promise.all(artifacts.map(async (name) => `${await sha256(path.join(outputDirectory, name))} *${name}`))
  .then((lines) => {
    const target = path.join(outputDirectory, "SHA256SUMS.txt");
    writeFileSync(target, `${lines.join("\n")}\n`, "utf8");
    console.log(`Wrote ${target} with ${lines.length} artifact checksum(s)`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
