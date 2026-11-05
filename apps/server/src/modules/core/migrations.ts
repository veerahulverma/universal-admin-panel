import type { Migration } from '../../core/migrate.js';

export const coreMigrations: Migration[] = [
  {
    version: '001',
    name: 'core tables',
    up: `
      CREATE TABLE settings (
        scope text NOT NULL DEFAULT 'global',
        key text NOT NULL,
        value jsonb NOT NULL DEFAULT '{}',
        updated_by text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (scope, key)
      );

      CREATE TABLE secrets (
        id text PRIMARY KEY,
        owner_type text NOT NULL,
        owner_id text NOT NULL,
        name text NOT NULL,
        ciphertext text NOT NULL,
        key_id text NOT NULL,
        last4 text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (owner_type, owner_id, name)
      );

      CREATE TABLE audit_logs (
        seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id text NOT NULL UNIQUE,
        actor_type text NOT NULL,
        actor_id text,
        actor_label text,
        action text NOT NULL,
        target_type text,
        target_id text,
        org_id text,
        ip text,
        user_agent text,
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL,
        prev_hash text NOT NULL,
        hash text NOT NULL
      );
      CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id, seq DESC);
      CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_type, actor_id, seq DESC);
      CREATE INDEX audit_logs_action_idx ON audit_logs (action, seq DESC);
      CREATE INDEX audit_logs_org_idx ON audit_logs (org_id, seq DESC);
      CREATE INDEX audit_logs_created_idx ON audit_logs (created_at);

      -- The audit log is append-only. Retention purges must opt in per transaction.
      CREATE FUNCTION audit_logs_guard() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND current_setting('steward.audit_retention', true) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'audit_logs is append-only';
      END
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION audit_logs_guard();

      CREATE TABLE events (
        id text PRIMARY KEY,
        type text NOT NULL,
        data jsonb NOT NULL,
        user_id text,
        org_id text,
        created_at timestamptz NOT NULL,
        dispatched_at timestamptz
      );
      CREATE INDEX events_pending_idx ON events (created_at, id) WHERE dispatched_at IS NULL;
      CREATE INDEX events_type_idx ON events (type, created_at DESC);
      CREATE INDEX events_user_idx ON events (user_id, created_at DESC);
      CREATE INDEX events_org_idx ON events (org_id, created_at DESC);
      CREATE INDEX events_created_idx ON events (created_at DESC);

      CREATE TABLE jobs (
        id text PRIMARY KEY,
        queue text NOT NULL DEFAULT 'default',
        type text NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}',
        status text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'dead')),
        attempts int NOT NULL DEFAULT 0,
        max_attempts int NOT NULL DEFAULT 5,
        priority int NOT NULL DEFAULT 0,
        run_at timestamptz NOT NULL,
        locked_at timestamptz,
        locked_by text,
        last_error text,
        idempotency_key text UNIQUE,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        completed_at timestamptz
      );
      CREATE INDEX jobs_due_idx ON jobs (priority DESC, run_at) WHERE status = 'pending';
      CREATE INDEX jobs_status_idx ON jobs (status, updated_at DESC);
      CREATE INDEX jobs_type_idx ON jobs (type, created_at DESC);

      CREATE TABLE scheduled_tasks (
        key text PRIMARY KEY,
        job_type text NOT NULL,
        interval_seconds int NOT NULL CHECK (interval_seconds >= 10),
        description text NOT NULL DEFAULT '',
        module text,
        payload jsonb NOT NULL DEFAULT '{}',
        enabled boolean NOT NULL DEFAULT true,
        last_run_at timestamptz,
        next_run_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE rate_limits (
        key text NOT NULL,
        window_start timestamptz NOT NULL,
        count int NOT NULL DEFAULT 0,
        expires_at timestamptz NOT NULL,
        PRIMARY KEY (key, window_start)
      );
      CREATE INDEX rate_limits_expiry_idx ON rate_limits (expires_at);

      CREATE TABLE modules (
        id text PRIMARY KEY,
        enabled boolean NOT NULL,
        version text NOT NULL,
        config jsonb NOT NULL DEFAULT '{}',
        installed_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE files (
        id text PRIMARY KEY,
        owner_type text NOT NULL,
        owner_id text NOT NULL,
        org_id text,
        filename text NOT NULL,
        content_type text NOT NULL,
        size int NOT NULL,
        sha256 text NOT NULL,
        storage_key text NOT NULL UNIQUE,
        uploaded_by_type text,
        uploaded_by_id text,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX files_owner_idx ON files (owner_type, owner_id);

      CREATE TABLE notifications (
        id text PRIMARY KEY,
        recipient_type text NOT NULL CHECK (recipient_type IN ('admin', 'user')),
        recipient_id text NOT NULL,
        type text NOT NULL,
        title text NOT NULL,
        body text,
        link text,
        severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'success', 'warning', 'critical')),
        data jsonb NOT NULL DEFAULT '{}',
        read_at timestamptz,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX notifications_recipient_idx ON notifications (recipient_type, recipient_id, created_at DESC);
      CREATE INDEX notifications_unread_idx ON notifications (recipient_type, recipient_id) WHERE read_at IS NULL;

      CREATE TABLE saved_views (
        id text PRIMARY KEY,
        admin_id text NOT NULL,
        resource text NOT NULL,
        name text NOT NULL,
        state jsonb NOT NULL DEFAULT '{}',
        shared boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX saved_views_admin_idx ON saved_views (admin_id, resource);
    `,
  },
];
