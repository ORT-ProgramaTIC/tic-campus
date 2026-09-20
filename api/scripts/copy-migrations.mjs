// Copies drizzle/migrations into dist/ as part of `pnpm build`.
//
// Load-bearing: the runtime stage of docker/api/Dockerfile copies `api/dist`
// and the production dependencies, and nothing else — so migrations left in
// `drizzle/` do not exist in the image, and `make migrate` dies on a deploy
// that typechecked, built and tested green.
import { cpSync, rmSync } from "node:fs";
import path from "node:path";

const root = path.dirname(import.meta.dirname);
const dest = path.join(root, "dist", "migrations");

rmSync(dest, { recursive: true, force: true });
cpSync(path.join(root, "drizzle", "migrations"), dest, { recursive: true });
console.log(`migrations copied to ${dest}`);
