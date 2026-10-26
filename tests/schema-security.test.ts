import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const privateTables = [
  'user_data', 'command_history', 'tasks', 'prompts', 'conversations', 'facts',
  'reminders', 'pending_actions', 'credentials', 'health_probes', 'token_usage',
];

test('the real schema is repeatable and restricts every private table to the service role', async () => {
  const pg = new PGlite();
  try {
    // Model older Supabase projects where every new table inherits API grants.
    await pg.exec(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      GRANT USAGE ON SCHEMA public TO anon, authenticated;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
    `);
    const schema = await readFile(new URL('../docs/database-schema.sql', import.meta.url), 'utf8');
    await pg.exec(schema);
    await pg.exec(schema);

    const rls = await pg.query<{ relname: string; relrowsecurity: boolean }>(
      "SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'",
    );
    for (const table of privateTables) {
      assert.equal(rls.rows.find((row) => row.relname === table)?.relrowsecurity, true, `${table} must enforce RLS`);
      const grants = await pg.query<{ anon_read: boolean; authenticated_write: boolean; service_write: boolean }>(
        'SELECT has_table_privilege(\'anon\', $1, \'SELECT\') AS anon_read, has_table_privilege(\'authenticated\', $1, \'INSERT\') AS authenticated_write, has_table_privilege(\'service_role\', $1, \'INSERT\') AS service_write',
        [table],
      );
      assert.deepEqual(grants.rows[0], { anon_read: false, authenticated_write: false, service_write: true }, table);
    }

    await pg.exec(`SET ROLE service_role;
      INSERT INTO tasks (user_id, name, description) VALUES (1, 'Private task', 'Private details');
      INSERT INTO prompts (user_id, title, prompt, image_file_id) VALUES (1, 'Private prompt', 'Private text', 'file');
      INSERT INTO user_data (user_id, data) VALUES (1, '{"secret":"value"}');
      INSERT INTO command_history (user_id, command) VALUES (1, '/memory');
      INSERT INTO pending_actions (user_id, tool_name, requested_at, expires_at) VALUES (1, 'save_fact', '2026-10-26T15:59:50Z', '2026-10-26T16:09:50Z');
    `);
    assert.equal((await pg.query('SELECT * FROM tasks')).rows.length, 1, 'service role can insert and read with explicit grants');
    await pg.exec('UPDATE tasks SET completed = true; DELETE FROM tasks; RESET ROLE;');

    for (const role of ['anon', 'authenticated']) {
      await pg.exec(`SET ROLE ${role}`);
      for (const table of privateTables) {
        await assert.rejects(pg.query(`SELECT * FROM ${table}`), /permission denied/, `${role} must not read ${table}`);
      }
      await assert.rejects(pg.query("INSERT INTO prompts (user_id,title,prompt,image_file_id) VALUES (1,'x','x','x')"), /permission denied/);
      await pg.exec('RESET ROLE');
    }

    // RLS remains a second boundary even if a table grant is accidentally restored.
    await pg.exec('GRANT SELECT, INSERT ON TABLE user_data TO anon; SET ROLE anon;');
    assert.equal((await pg.query('SELECT * FROM user_data')).rows.length, 0);
    await assert.rejects(pg.query("INSERT INTO user_data (user_id) VALUES (2)"), /row-level security/);
    await pg.exec('RESET ROLE');

    // An older permissive policy must not defeat the migration's grant revocation.
    await pg.exec('CREATE POLICY legacy_public ON user_data FOR ALL TO PUBLIC USING (true) WITH CHECK (true);');
    await pg.exec(schema);
    await pg.exec('SET ROLE anon');
    await assert.rejects(pg.query('SELECT * FROM user_data'), /permission denied/);
    await pg.exec('RESET ROLE');
  } finally {
    await pg.close();
  }
});
