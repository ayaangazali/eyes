-- Ops event log in ClickHouse (optional; Postgres stays the source of truth). Applied by
-- scripts/clickhouse-migrate.ts into $CLICKHOUSE_DATABASE. Idempotent: every statement is IF NOT EXISTS.
-- detail is the redacted event ({level, summary, data}) as JSON text.
create table if not exists events (
  ts DateTime64(3, 'UTC'),
  kind LowCardinality(String),
  name String,
  status LowCardinality(String),
  ms UInt32,
  task_id Nullable(UUID),
  agent_id Nullable(UUID),
  worker_id Nullable(UUID),
  detail String
) engine = MergeTree
partition by toYYYYMM(ts)
order by (kind, ts)
ttl toDateTime(ts) + interval 180 day;

-- HTTP requests and webhooks per minute by route and status.
create table if not exists requests_per_minute (
  minute DateTime('UTC'),
  route String,
  status LowCardinality(String),
  requests UInt64
) engine = SummingMergeTree
partition by toYYYYMM(minute)
order by (minute, route, status)
ttl minute + interval 180 day;

create materialized view if not exists requests_per_minute_mv to requests_per_minute as
select toStartOfMinute(ts) as minute, name as route, status, count() as requests
from events where kind in ('http', 'webhook')
group by minute, route, status;

-- p50/p95 latency per route per minute: query with quantilesMerge(0.5, 0.95)(latency).
create table if not exists latency_per_minute (
  minute DateTime('UTC'),
  route String,
  latency AggregateFunction(quantiles(0.5, 0.95), UInt32)
) engine = AggregatingMergeTree
partition by toYYYYMM(minute)
order by (minute, route)
ttl minute + interval 180 day;

create materialized view if not exists latency_per_minute_mv to latency_per_minute as
select toStartOfMinute(ts) as minute, name as route, quantilesState(0.5, 0.95)(ms) as latency
from events where kind in ('http', 'webhook')
group by minute, route;

-- MCP tool and service calls per hour by outcome (ok or the error code).
create table if not exists calls_per_hour (
  hour DateTime('UTC'),
  tool String,
  outcome LowCardinality(String),
  calls UInt64
) engine = SummingMergeTree
partition by toYYYYMM(hour)
order by (hour, tool, outcome)
ttl hour + interval 180 day;

create materialized view if not exists calls_per_hour_mv to calls_per_hour as
select toStartOfHour(ts) as hour, name as tool, status as outcome, count() as calls
from events where kind = 'call'
group by hour, tool, outcome;

-- Task status transitions per hour (the status a task moved into).
create table if not exists tasks_per_hour (
  hour DateTime('UTC'),
  status LowCardinality(String),
  tasks UInt64
) engine = SummingMergeTree
partition by toYYYYMM(hour)
order by (hour, status)
ttl hour + interval 180 day;

create materialized view if not exists tasks_per_hour_mv to tasks_per_hour as
select toStartOfHour(ts) as hour, status, count() as tasks
from events where kind = 'task'
group by hour, status;
