# RLS setup and migration patterns

## Contents
- [Database roles](#database-roles)
- [Enabling RLS on a new table](#enabling-rls-on-a-new-table)
- [Session helpers](#session-helpers)
- [Expand/contract worked examples](#expandcontract-worked-examples)
- [Backfill patterns](#backfill-patterns)

## Database roles

Two roles, and the separation is the point.

```sql
-- Request handling. RLS applies. Used by gateway and all workers
-- that operate on behalf of one tenant.
CREATE ROLE app_user LOGIN PASSWORD :'app_password';
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;

-- Cross-tenant work only: outbox poller, metering rollups, sweeper.
CREATE ROLE app_admin LOGIN PASSWORD :'admin_password' BYPASSRLS;
GRANT ALL ON ALL TABLES IN SCHEMA public TO app_admin;
```

`app_user` must not be the table owner. Table owners bypass RLS by default in
PostgreSQL unless `FORCE ROW LEVEL SECURITY` is set, which is a quiet way to
have RLS enabled and doing nothing.

```sql
ALTER TABLE quotes FORCE ROW LEVEL SECURITY;
```

Set this on every tenant-scoped table. Belt and braces, and cheap.

## Enabling RLS on a new table

Always in the same migration as the `CREATE TABLE`:

```python
def upgrade() -> None:
    op.create_table("thing", ...)
    op.create_index("ix_thing_tenant", "thing", ["tenant_id"])
    op.execute("ALTER TABLE thing ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE thing FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY tenant_isolation ON thing
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    """)

def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS tenant_isolation ON thing")
    op.drop_table("thing")
```

The `true` second argument to `current_setting` makes it return NULL instead of
erroring when the variable is unset. With NULL, the comparison is NULL, the
policy denies everything, and an unscoped query returns zero rows rather than
crashing. Failing closed is the correct default here.

## Session helpers

```python
@asynccontextmanager
async def tenant_session(engine, tenant_id: UUID):
    """RLS-scoped session. Use for anything acting on behalf of one tenant."""
    async with AsyncSession(engine) as s:
        async with s.begin():
            await s.execute(text("SET LOCAL app.tenant_id = :t"),
                            {"t": str(tenant_id)})
            yield s

@asynccontextmanager
async def admin_session(engine):
    """BYPASSRLS. Outbox poller, metering rollups, sweeper only.
    If this appears in request handling, the design is wrong."""
    async with AsyncSession(admin_engine) as s:
        async with s.begin():
            yield s
```

`SET LOCAL` scopes to the transaction, so the variable cannot leak into a
pooled connection's next user. Never use `SET` without `LOCAL`.

## Expand/contract worked examples

### Renaming a column

Four deploys. Each one is independently safe to roll back.

```
D1  add `new_name`, nullable, no code change
D2  code writes both `old_name` and `new_name`, reads `old_name`
D3  backfill `new_name` from `old_name`; code reads `new_name`, still writes both
D4  drop `old_name`, code writes only `new_name`
```

Rolling back D3 is safe because D2's code still writes both. Rolling back D4
is not — which is why D4 waits until D3 has been stable for at least a day.

### Adding a NOT NULL column

```
D1  add nullable with a default
D2  backfill in batches
D3  add the NOT NULL constraint (validate separately on large tables)
```

On a large table, avoid the full-table lock:

```sql
ALTER TABLE quotes ADD CONSTRAINT quotes_x_not_null
    CHECK (x IS NOT NULL) NOT VALID;
ALTER TABLE quotes VALIDATE CONSTRAINT quotes_x_not_null;  -- no exclusive lock
```

### Changing a column type

Never in place on a table with traffic. Add a new column, dual-write,
backfill, switch reads, drop.

## Backfill patterns

Batched, resumable, and outside the migration:

```python
async def backfill(engine, batch=1000):
    while True:
        async with admin_session(engine) as s:
            n = await s.execute(text("""
                UPDATE quotes SET new_col = derive(old_col)
                WHERE id IN (
                    SELECT id FROM quotes
                    WHERE new_col IS NULL
                    ORDER BY id LIMIT :batch
                    FOR UPDATE SKIP LOCKED
                )
            """), {"batch": batch})
        if n.rowcount == 0:
            return
        await asyncio.sleep(0.1)   # leave headroom for real traffic
```

A backfill inside an Alembic migration blocks the deploy and holds a long
transaction. Ship it as a script, run it separately, and make it resumable —
it will be interrupted.
