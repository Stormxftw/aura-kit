// Port of the pattern in WeakAuras/Modernize.lua.
//
// Every saved document carries `internalVersion`. On load and on import,
// each migration step whose version is above the document's runs once, in
// order, and the document ends at the current version. WeakAuras has kept
// this up for 80+ versions since 2018, so imports from years ago still work.
//
// The other half matters as much: a document from a *newer* version is never
// "migrated". The importer shows it but refuses to run it, because guessing
// at a future shape corrupts data.

export interface Versioned {
  internalVersion?: number;
}

export interface MigrationStep<T> {
  version: number;
  /** One line on what changed and why, kept for the next maintainer. */
  note: string;
  up(doc: T): void;
}

export type ModernizeResult<T> =
  | { status: "current" | "migrated"; doc: T; applied: number[] }
  | { status: "too-new"; doc: T; docVersion: number; currentVersion: number }
  | { status: "too-old"; doc: T; docVersion: number; oldestSupported: number };

export class Migrator<T extends Versioned> {
  readonly current: number;
  private readonly steps: MigrationStep<T>[];

  constructor(steps: MigrationStep<T>[], private readonly oldestSupported = 0) {
    this.steps = [...steps].sort((a, b) => a.version - b.version);
    for (let i = 1; i < this.steps.length; i++) {
      if ((this.steps[i] as MigrationStep<T>).version === (this.steps[i - 1] as MigrationStep<T>).version) {
        throw new Error(`Duplicate migration version ${(this.steps[i] as MigrationStep<T>).version}`);
      }
    }
    this.current = this.steps.at(-1)?.version ?? 0;
  }

  /** Migrates `doc` in place. Copy it first if the caller needs the original. */
  modernize(doc: T): ModernizeResult<T> {
    const docVersion = doc.internalVersion ?? 0;
    if (docVersion > this.current) {
      return { status: "too-new", doc, docVersion, currentVersion: this.current };
    }
    if (docVersion < this.oldestSupported) {
      return { status: "too-old", doc, docVersion, oldestSupported: this.oldestSupported };
    }
    const applied: number[] = [];
    for (const step of this.steps) {
      if (step.version > docVersion) {
        step.up(doc);
        applied.push(step.version);
      }
    }
    doc.internalVersion = this.current;
    return { status: applied.length ? "migrated" : "current", doc, applied };
  }

  /** For a group: the highest version among a parent and its children decides. */
  highestVersion(docs: readonly T[]): number {
    return docs.reduce((max, d) => Math.max(max, d.internalVersion ?? 0), 0);
  }
}
