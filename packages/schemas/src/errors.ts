export class SchemaTooNewError extends Error {
  constructor(public schema: string, public docVersion: number, public knownVersion: number) {
    super(`${schema} v${docVersion} is newer than supported v${knownVersion}`);
    this.name = 'SchemaTooNewError';
  }
}

export class MissingMigrationError extends Error {
  constructor(public schema: string, public fromVersion: number) {
    super(`${schema}: no migration from v${fromVersion}`);
    this.name = 'MissingMigrationError';
  }
}
