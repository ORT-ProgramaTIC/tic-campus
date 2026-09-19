import { readFileSync } from "node:fs";

/**
 * Everything this process reads from its environment, validated once at boot.
 *
 * A missing or empty key throws here rather than at whichever query first needs
 * it: a container that refuses to start says what is wrong in its logs, while
 * one that starts and 500s says it in whoever's browser gets there first.
 */
export interface Config {
  port: number;
  /** `campus_svc`'s URL, **without** the password — see `db/client.ts`. */
  databaseUrl: string;
  /** Read from `DATABASE_PASSWORD_FILE`, the mounted secret. */
  databasePassword: string | undefined;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`falta ${key} en el entorno — mirá .env.example`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // The password is mounted as a FILE rather than passed as a variable, so it
  // does not show up in `docker inspect`. `.env` names the path; compose mounts
  // the secret at it, and renaming one side only fails here with ENOENT.
  const passwordFile = env.DATABASE_PASSWORD_FILE?.trim();
  let databasePassword: string | undefined;
  if (passwordFile) {
    try {
      databasePassword = readFileSync(passwordFile, "utf8").trim();
    } catch (cause) {
      throw new Error(
        `no se pudo leer DATABASE_PASSWORD_FILE (${passwordFile}): ${String(cause)}`,
      );
    }
    if (!databasePassword) throw new Error(`${passwordFile} está vacío`);
  }

  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: required(env, "DATABASE_URL"),
    databasePassword,
  };
}
