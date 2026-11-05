import type { Migration } from '../../core/migrate.js';

export const customerMigrations: Migration[] = [
  {
    version: '001',
    name: 'users and organizations',
    up: `
      CREATE TABLE users (
        id text PRIMARY KEY,
        external_id text,
        email text NOT NULL,
        email_verified_at timestamptz,
        name text,
        phone text,
        avatar_url text,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'banned', 'pending')),
        status_reason text,
        suspended_until timestamptz,
        password_hash text,
        failed_login_count int NOT NULL DEFAULT 0,
        locked_until timestamptz,
        locale text,
        timezone text,
        country text,
        registration_source text,
        utm jsonb NOT NULL DEFAULT '{}',
        referral_code text,
        custom_fields jsonb NOT NULL DEFAULT '{}',
        tags jsonb NOT NULL DEFAULT '[]',
        metadata jsonb NOT NULL DEFAULT '{}',
        marketing_consent boolean NOT NULL DEFAULT false,
        consent_updated_at timestamptz,
        lifetime_revenue bigint NOT NULL DEFAULT 0,
        last_active_at timestamptz,
        last_login_at timestamptz,
        last_login_ip text,
        deleted_at timestamptz,
        anonymized_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE deleted_at IS NULL;
      CREATE UNIQUE INDEX users_external_id_uq ON users (external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL;
      CREATE INDEX users_created_idx ON users (created_at DESC);
      CREATE INDEX users_status_idx ON users (status) WHERE deleted_at IS NULL;
      CREATE INDEX users_tags_idx ON users USING gin (tags);
      CREATE INDEX users_last_active_idx ON users (last_active_at DESC NULLS LAST);
      CREATE INDEX users_email_prefix_idx ON users (lower(email) text_pattern_ops);

      CREATE TABLE organizations (
        id text PRIMARY KEY,
        external_id text,
        name text NOT NULL,
        slug text NOT NULL,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
        owner_user_id text REFERENCES users(id) ON DELETE SET NULL,
        billing_email text,
        seat_limit int,
        custom_domain text,
        custom_fields jsonb NOT NULL DEFAULT '{}',
        tags jsonb NOT NULL DEFAULT '[]',
        metadata jsonb NOT NULL DEFAULT '{}',
        deleted_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX organizations_slug_uq ON organizations (slug) WHERE deleted_at IS NULL;
      CREATE UNIQUE INDEX organizations_external_uq ON organizations (external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL;
      CREATE UNIQUE INDEX organizations_domain_uq ON organizations (lower(custom_domain)) WHERE custom_domain IS NOT NULL AND deleted_at IS NULL;

      CREATE TABLE memberships (
        id text PRIMARY KEY,
        org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role text NOT NULL DEFAULT 'member',
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'pending_approval', 'suspended')),
        invited_by text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        UNIQUE (org_id, user_id)
      );
      CREATE INDEX memberships_user_idx ON memberships (user_id);

      CREATE TABLE org_roles (
        id text PRIMARY KEY,
        org_id text REFERENCES organizations(id) ON DELETE CASCADE,
        key text NOT NULL,
        name text NOT NULL,
        permissions jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX org_roles_key_uq ON org_roles (coalesce(org_id, ''), key);

      CREATE TABLE org_invitations (
        id text PRIMARY KEY,
        org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        email text NOT NULL,
        role text NOT NULL DEFAULT 'member',
        token_hash text NOT NULL UNIQUE,
        requires_approval boolean NOT NULL DEFAULT false,
        invited_by_user_id text,
        invited_by_admin_id text,
        expires_at timestamptz NOT NULL,
        accepted_at timestamptz,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX org_invitations_org_idx ON org_invitations (org_id);

      CREATE TABLE user_notes (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        admin_id text,
        body text NOT NULL,
        pinned boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX user_notes_user_idx ON user_notes (user_id, created_at DESC);

      CREATE TABLE custom_field_defs (
        id text PRIMARY KEY,
        entity text NOT NULL CHECK (entity IN ('user', 'organization')),
        key text NOT NULL,
        label text NOT NULL,
        type text NOT NULL CHECK (type IN ('text', 'number', 'boolean', 'select', 'date', 'url')),
        options jsonb NOT NULL DEFAULT '[]',
        required boolean NOT NULL DEFAULT false,
        show_in_list boolean NOT NULL DEFAULT false,
        position int NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL,
        UNIQUE (entity, key)
      );

      CREATE TABLE user_sessions (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash text UNIQUE,
        external_session_id text,
        ip text,
        user_agent text,
        country text,
        impersonator_admin_id text,
        created_at timestamptz NOT NULL,
        last_seen_at timestamptz NOT NULL,
        expires_at timestamptz,
        revoked_at timestamptz,
        revoked_reason text
      );
      CREATE INDEX user_sessions_user_idx ON user_sessions (user_id, created_at DESC);

      CREATE TABLE privacy_requests (
        id text PRIMARY KEY,
        user_id text NOT NULL,
        email text NOT NULL,
        type text NOT NULL CHECK (type IN ('export', 'delete')),
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'rejected')),
        source text NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'api', 'user')),
        requested_by text,
        notes text,
        file_id text,
        due_at timestamptz NOT NULL,
        completed_at timestamptz,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX privacy_requests_status_idx ON privacy_requests (status, due_at);

      CREATE TABLE impersonations (
        id text PRIMARY KEY,
        admin_id text NOT NULL,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason text NOT NULL,
        token_hash text NOT NULL UNIQUE,
        read_only boolean NOT NULL DEFAULT true,
        ip text,
        started_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        consumed_at timestamptz,
        ended_at timestamptz,
        ended_reason text
      );
      CREATE INDEX impersonations_admin_idx ON impersonations (admin_id, started_at DESC);
      CREATE INDEX impersonations_user_idx ON impersonations (user_id, started_at DESC);
    `,
  },
  {
    version: '002',
    name: 'archived and merged accounts',
    up: `
      ALTER TABLE users ADD COLUMN archived_at timestamptz;
      ALTER TABLE users ADD COLUMN archived_reason text;
      ALTER TABLE users ADD COLUMN merged_into_id text REFERENCES users(id);
      ALTER TABLE users ADD COLUMN merged_at timestamptz;
      CREATE INDEX users_archived_idx ON users (archived_at) WHERE archived_at IS NOT NULL;
      CREATE INDEX users_merged_into_idx ON users (merged_into_id) WHERE merged_into_id IS NOT NULL;

      -- One row per merge: what moved from the source account to the target, for the audit trail.
      CREATE TABLE user_merges (
        id text PRIMARY KEY,
        source_id text NOT NULL,
        target_id text NOT NULL,
        admin_id text,
        moved jsonb NOT NULL DEFAULT '[]',
        kept jsonb NOT NULL DEFAULT '[]',
        filled jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL
      );
      CREATE INDEX user_merges_target_idx ON user_merges (target_id, created_at DESC);
      CREATE INDEX user_merges_source_idx ON user_merges (source_id);
    `,
  },
  {
    version: '003',
    name: 'user imports',
    up: `
      CREATE TABLE user_imports (
        id text PRIMARY KEY,
        filename text NOT NULL,
        file_id text NOT NULL,
        status text NOT NULL CHECK (status IN ('uploaded', 'validated', 'queued', 'running', 'completed', 'failed', 'cancelled')),
        delimiter text NOT NULL,
        headers jsonb NOT NULL,
        row_count int NOT NULL,
        mapping jsonb,
        options jsonb,
        summary jsonb,
        errors jsonb NOT NULL DEFAULT '[]',
        processed int NOT NULL DEFAULT 0,
        created_count int NOT NULL DEFAULT 0,
        updated_count int NOT NULL DEFAULT 0,
        unchanged_count int NOT NULL DEFAULT 0,
        skipped_count int NOT NULL DEFAULT 0,
        failed_count int NOT NULL DEFAULT 0,
        error text,
        created_by text NOT NULL,
        actor_label text,
        org_scope jsonb,
        validated_at timestamptz,
        started_at timestamptz,
        completed_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX user_imports_created_idx ON user_imports (created_at DESC);

      CREATE TABLE user_import_rows (
        import_id text NOT NULL REFERENCES user_imports(id) ON DELETE CASCADE,
        row_number int NOT NULL,
        email text,
        result text NOT NULL CHECK (result IN ('created', 'updated', 'unchanged', 'skipped', 'failed')),
        user_id text,
        message text,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (import_id, row_number)
      );
    `,
  },
  {
    version: '004',
    name: 'agreements and signup forms',
    up: `
      CREATE TABLE agreements (
        id text PRIMARY KEY,
        key text NOT NULL UNIQUE,
        title text NOT NULL,
        description text NOT NULL DEFAULT '',
        required boolean NOT NULL DEFAULT false,
        archived_at timestamptz,
        created_by text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      -- Versions are immutable once they take effect or someone accepts them; publish a new version instead.
      CREATE TABLE agreement_versions (
        id text PRIMARY KEY,
        agreement_id text NOT NULL REFERENCES agreements(id),
        version int NOT NULL,
        title text NOT NULL,
        body text NOT NULL,
        summary text,
        effective_at timestamptz NOT NULL,
        created_by text,
        created_at timestamptz NOT NULL,
        UNIQUE (agreement_id, version)
      );
      CREATE INDEX agreement_versions_effective_idx ON agreement_versions (agreement_id, effective_at DESC);

      CREATE TABLE agreement_acceptances (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        agreement_id text NOT NULL REFERENCES agreements(id),
        version_id text NOT NULL REFERENCES agreement_versions(id),
        ip text,
        user_agent text,
        source text NOT NULL CHECK (source IN ('signup', 'client', 'api')),
        accepted_at timestamptz NOT NULL
      );
      CREATE INDEX agreement_acceptances_user_idx ON agreement_acceptances (user_id, agreement_id, accepted_at DESC);
      CREATE INDEX agreement_acceptances_version_idx ON agreement_acceptances (version_id, accepted_at DESC);

      CREATE TABLE signup_forms (
        id text PRIMARY KEY,
        key text NOT NULL UNIQUE,
        name text NOT NULL,
        description text NOT NULL DEFAULT '',
        active boolean NOT NULL DEFAULT true,
        fields jsonb NOT NULL DEFAULT '[]',
        agreement_id text REFERENCES agreements(id),
        plan_ids jsonb NOT NULL DEFAULT '[]',
        redirect_url text,
        tags jsonb NOT NULL DEFAULT '[]',
        created_by text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
    `,
  },
];
