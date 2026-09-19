// SPDX-License-Identifier: Apache-2.0
import type Database from 'better-sqlite3';
import type { Run } from './model.ts';

export class Store {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS codeops_runs (id TEXT PRIMARY KEY, intent_key TEXT UNIQUE NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS codeops_environments (environment_id TEXT PRIMARY KEY, run_id TEXT UNIQUE NOT NULL)`);
  }
  get(id: string): Run {
    const row = this.db.prepare('SELECT body FROM codeops_runs WHERE id=?').get(id) as {body:string}|undefined;
    if (!row) throw new Error('Unknown run');
    return JSON.parse(row.body) as Run;
  }
  byKey(key: string): Run | null {
    const row = this.db.prepare('SELECT body FROM codeops_runs WHERE intent_key=?').get(key) as {body:string}|undefined;
    return row ? JSON.parse(row.body) as Run : null;
  }
  list(): Run[] {
    return (this.db.prepare('SELECT body FROM codeops_runs ORDER BY rowid DESC LIMIT 100').all() as {body:string}[]).map(row => JSON.parse(row.body) as Run);
  }
  /** Cursor pagination is independent of the UI's most-recent window. */
  pending(after=0): {cursor:number;runs:Run[]} {
    const rows=this.db.prepare(`SELECT rowid,body FROM codeops_runs WHERE rowid>? AND json_extract(body,'$.condition') IN ('Running','Waiting','Stopping') ORDER BY rowid LIMIT 100`).all(after) as {rowid:number;body:string}[];
    return {cursor:rows.at(-1)?.rowid??after,runs:rows.map(row=>JSON.parse(row.body) as Run)};
  }
  create(run: Run): void {
    this.db.transaction(()=>{
      this.db.prepare('INSERT INTO codeops_environments VALUES (?,?)').run(run.brief.environmentId,run.id);
      this.db.prepare('INSERT INTO codeops_runs VALUES (?,?,?,?)').run(run.id, `${run.brief.projectId}:${run.brief.key}`,run.revision,JSON.stringify(run));
    })();
  }
  /** Decisions, state, reservation release and outbound intent share one CAS transaction. */
  save(run: Run, expected: number): Run {
    run.revision = expected + 1; run.updatedAt = new Date().toISOString();
    this.db.transaction(()=>{
      const changed = this.db.prepare('UPDATE codeops_runs SET revision=?,body=? WHERE id=? AND revision=?').run(run.revision,JSON.stringify(run),run.id,expected);
      if (changed.changes !== 1) throw new Error('Stale run revision');
      if(run.condition==='Cancelled'||run.condition==='Completed') this.db.prepare('DELETE FROM codeops_environments WHERE run_id=?').run(run.id);
    })();
    return run;
  }
}
