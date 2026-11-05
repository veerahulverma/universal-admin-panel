import type { Migration } from '../../core/migrate.js';

export const accessMigrations: Migration[] = [
  {
    version: '001',
    name: 'user groups, protected resources and rules, protected downloads, access log',
    up: `
      CREATE TABLE user_groups (
        id text PRIMARY KEY,
        name text NOT NULL,
        description text NOT NULL DEFAULT '',
        created_by text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX user_groups_name_uq ON user_groups (lower(name));

      -- Members added by hand or through the API.
      CREATE TABLE user_group_members (
        group_id text NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        added_by_type text NOT NULL,
        added_by_id text,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (group_id, user_id)
      );
      CREATE INDEX user_group_members_user_idx ON user_group_members (user_id);

      -- Automatic membership: whoever currently holds one of these products through an
      -- active subscription or grant. Computed when read, never copied into the members table.
      CREATE TABLE user_group_products (
        group_id text NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
        product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        PRIMARY KEY (group_id, product_id)
      );
      CREATE INDEX user_group_products_product_idx ON user_group_products (product_id);

      CREATE TABLE access_resources (
        id text PRIMARY KEY,
        kind text NOT NULL CHECK (kind IN ('url', 'folder', 'page', 'link', 'file')),
        title text NOT NULL,
        description text NOT NULL DEFAULT '',
        path text,
        body text,
        url text,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        show_locked boolean NOT NULL DEFAULT false,
        release_mode text NOT NULL DEFAULT 'immediate' CHECK (release_mode IN ('immediate', 'days', 'date')),
        release_days int CHECK (release_days >= 0),
        release_at timestamptz,
        window_days int CHECK (window_days > 0),
        position int NOT NULL DEFAULT 0,
        created_by text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CHECK ((kind IN ('url', 'folder')) = (path IS NOT NULL)),
        CHECK (kind <> 'page' OR body IS NOT NULL),
        CHECK (kind <> 'link' OR url IS NOT NULL),
        CHECK (release_mode <> 'days' OR release_days IS NOT NULL),
        CHECK (release_mode <> 'date' OR release_at IS NOT NULL)
      );
      CREATE UNIQUE INDEX access_resources_path_uq ON access_resources (kind, path) WHERE path IS NOT NULL;
      CREATE INDEX access_resources_list_idx ON access_resources (position, title);

      -- Who may open a resource: any matching rule grants access.
      CREATE TABLE access_rules (
        id text PRIMARY KEY,
        resource_id text NOT NULL REFERENCES access_resources(id) ON DELETE CASCADE,
        kind text NOT NULL CHECK (kind IN ('product', 'group', 'any_customer')),
        product_id text REFERENCES products(id) ON DELETE CASCADE,
        group_id text REFERENCES user_groups(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL,
        CHECK ((kind = 'product') = (product_id IS NOT NULL)),
        CHECK ((kind = 'group') = (group_id IS NOT NULL))
      );
      CREATE INDEX access_rules_resource_idx ON access_rules (resource_id);
      CREATE INDEX access_rules_group_idx ON access_rules (group_id) WHERE group_id IS NOT NULL;
      CREATE UNIQUE INDEX access_rules_product_uq ON access_rules (resource_id, product_id) WHERE product_id IS NOT NULL;
      CREATE UNIQUE INDEX access_rules_group_uq ON access_rules (resource_id, group_id) WHERE group_id IS NOT NULL;
      CREATE UNIQUE INDEX access_rules_any_uq ON access_rules (resource_id) WHERE kind = 'any_customer';

      -- Protected downloads. The bytes live in core storage, described by a files row.
      CREATE TABLE access_files (
        id text PRIMARY KEY,
        file_id text NOT NULL UNIQUE REFERENCES files(id),
        title text NOT NULL,
        description text NOT NULL DEFAULT '',
        download_limit int CHECK (download_limit > 0),
        limit_period text NOT NULL DEFAULT 'day' CHECK (limit_period IN ('day', 'week', 'month', 'year', 'lifetime')),
        created_by text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE access_resource_files (
        resource_id text NOT NULL REFERENCES access_resources(id) ON DELETE CASCADE,
        file_id text NOT NULL REFERENCES access_files(id) ON DELETE RESTRICT,
        position int NOT NULL DEFAULT 0,
        PRIMARY KEY (resource_id, file_id)
      );
      CREATE INDEX access_resource_files_file_idx ON access_resource_files (file_id);

      -- Signed, expiring download links issued to a customer for one file.
      CREATE TABLE access_download_links (
        id text PRIMARY KEY,
        file_id text NOT NULL REFERENCES access_files(id) ON DELETE CASCADE,
        resource_id text NOT NULL REFERENCES access_resources(id) ON DELETE CASCADE,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        org_id text,
        ip text,
        expires_at timestamptz NOT NULL,
        download_count int NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX access_download_links_expiry_idx ON access_download_links (expires_at);
      CREATE INDEX access_download_links_user_idx ON access_download_links (user_id);

      -- Completed downloads: the download log, and what per-customer limits count.
      CREATE TABLE access_downloads (
        id text PRIMARY KEY,
        file_id text NOT NULL REFERENCES access_files(id) ON DELETE CASCADE,
        resource_id text,
        link_id text,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        org_id text,
        ip text,
        user_agent text,
        bytes bigint NOT NULL,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX access_downloads_user_file_idx ON access_downloads (user_id, file_id, created_at DESC);
      CREATE INDEX access_downloads_file_idx ON access_downloads (file_id, created_at DESC);
      CREATE INDEX access_downloads_created_idx ON access_downloads (created_at DESC);

      -- Access checks, content views, link requests and downloads (allowed or refused).
      CREATE TABLE access_log (
        id text PRIMARY KEY,
        event text NOT NULL CHECK (event IN ('check', 'view', 'link', 'download')),
        source text NOT NULL CHECK (source IN ('api', 'client', 'public')),
        resource_id text,
        resource_title text,
        file_id text,
        path text,
        user_id text,
        org_id text,
        allowed boolean NOT NULL,
        reason text NOT NULL,
        ip text,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX access_log_created_idx ON access_log (created_at DESC);
      CREATE INDEX access_log_user_idx ON access_log (user_id, created_at DESC);
      CREATE INDEX access_log_resource_idx ON access_log (resource_id, created_at DESC);
    `,
  },
];
