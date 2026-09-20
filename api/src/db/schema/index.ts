// The tables campus OWNS, and only those. This is what `drizzle.config.ts`
// generates migrations from, what `db/client.ts` hands to `drizzle()`, and what
// `db/migrate.ts` derives the runtime grants from — so a table that is not
// listed here is a table nothing creates and nothing grants.
//
// `directory.ts` is deliberately absent and is imported from directly. It
// declares tic-auth's tables and views, which campus references and reads but
// does not own — and drizzle-kit generates a `CREATE TABLE` for anything it
// finds here, `schemaFilter` notwithstanding, so listing them would put
// `public."user"` in a campus migration.
export * from "./article.js";
export * from "./gradebook.js";
export * from "./offering-article.js";
export * from "./offering-home.js";
export * from "./official-grade.js";
export * from "./program-unit.js";
export * from "./result.js";
export * from "./session.js";
export * from "./upload.js";
