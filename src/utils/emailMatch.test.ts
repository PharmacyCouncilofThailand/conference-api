import assert from 'node:assert/strict';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { users } from '../database/schema.js';
import { loginBodySchema } from '../schemas/auth.schema.js';
import { backofficeLoginSchema } from '../schemas/backoffice.schema.js';
import { emailMatches, exactEmailFirst } from './emailMatch.js';

test('emailMatches compares emails case-insensitively', () => {
  const db = drizzle.mock();
  const query = db
    .select({ id: users.id })
    .from(users)
    .where(emailMatches(users.email, ' John@Mail.COM '))
    .orderBy(exactEmailFirst(users.email, ' John@Mail.COM '))
    .toSQL();
  assert.match(query.sql, /where lower\("users"\."email"\) = lower\(\$1\)/);
  assert.match(query.sql, /order by \("users"\."email" = \$2\) desc/);
  assert.deepEqual(query.params, ['John@Mail.COM', 'John@Mail.COM']);
});

test('login schemas trim surrounding spaces from the email', () => {
  assert.equal(loginBodySchema.parse({ email: ' A@B.co ', password: 'x' }).email, 'A@B.co');
  assert.equal(backofficeLoginSchema.parse({ email: ' A@B.co ', password: 'x' }).email, 'A@B.co');
});
