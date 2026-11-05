import type { Migration } from '../../core/migrate.js';

export const supportMigrations: Migration[] = [
  {
    version: '001',
    name: 'tickets, messages, attachments, categories, saved replies',
    up: `
      CREATE SEQUENCE ticket_number_seq START 1;

      CREATE TABLE ticket_categories (
        id text PRIMARY KEY,
        name text NOT NULL,
        description text NOT NULL DEFAULT '',
        default_priority text NOT NULL DEFAULT 'normal' CHECK (default_priority IN ('low', 'normal', 'high', 'urgent')),
        first_response_minutes int CHECK (first_response_minutes > 0),
        resolution_minutes int CHECK (resolution_minutes > 0),
        active boolean NOT NULL DEFAULT true,
        position int NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL
      );

      CREATE TABLE tickets (
        id text PRIMARY KEY,
        number text NOT NULL UNIQUE,
        user_id text REFERENCES users(id) ON DELETE SET NULL,
        org_id text REFERENCES organizations(id) ON DELETE SET NULL,
        requester_email text NOT NULL,
        requester_name text,
        subject text NOT NULL,
        status text NOT NULL CHECK (status IN ('open', 'pending', 'on_hold', 'solved', 'closed')),
        priority text NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        category_id text REFERENCES ticket_categories(id) ON DELETE SET NULL,
        assignee_id text REFERENCES admins(id) ON DELETE SET NULL,
        channel text NOT NULL CHECK (channel IN ('web', 'email', 'api', 'admin')),
        tags jsonb NOT NULL DEFAULT '[]',
        custom_fields jsonb NOT NULL DEFAULT '{}',
        email_thread_id text,
        first_response_due_at timestamptz,
        resolution_due_at timestamptz,
        first_responded_at timestamptz,
        solved_at timestamptz,
        closed_at timestamptz,
        sla_breached_at timestamptz,
        escalated_at timestamptz,
        csat_rating int CHECK (csat_rating BETWEEN 1 AND 5),
        csat_comment text,
        csat_at timestamptz,
        last_customer_message_at timestamptz,
        last_agent_message_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX tickets_queue_idx ON tickets (status, priority, created_at DESC);
      CREATE INDEX tickets_user_idx ON tickets (user_id, created_at DESC);
      CREATE INDEX tickets_org_idx ON tickets (org_id);
      CREATE INDEX tickets_assignee_idx ON tickets (assignee_id, status);
      CREATE INDEX tickets_requester_idx ON tickets (lower(requester_email));
      CREATE INDEX tickets_sla_idx ON tickets (first_response_due_at, resolution_due_at) WHERE status NOT IN ('solved', 'closed') AND escalated_at IS NULL;

      CREATE TABLE ticket_messages (
        id text PRIMARY KEY,
        ticket_id text NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        author_type text NOT NULL CHECK (author_type IN ('customer', 'admin', 'system')),
        author_id text,
        body text NOT NULL,
        is_internal boolean NOT NULL DEFAULT false,
        channel text NOT NULL DEFAULT 'web',
        email_message_id text,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX ticket_messages_ticket_idx ON ticket_messages (ticket_id, created_at);
      CREATE UNIQUE INDEX ticket_messages_email_uq ON ticket_messages (email_message_id) WHERE email_message_id IS NOT NULL;

      CREATE TABLE ticket_attachments (
        id text PRIMARY KEY,
        ticket_id text NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        message_id text REFERENCES ticket_messages(id) ON DELETE CASCADE,
        file_id text NOT NULL,
        is_internal boolean NOT NULL DEFAULT false,
        uploaded_by_type text NOT NULL,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX ticket_attachments_ticket_idx ON ticket_attachments (ticket_id);

      CREATE TABLE saved_replies (
        id text PRIMARY KEY,
        title text NOT NULL,
        body text NOT NULL,
        shortcut text,
        category_id text REFERENCES ticket_categories(id) ON DELETE SET NULL,
        created_by text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
    `,
  },
  {
    version: '002',
    name: 'knowledge base, custom ticket fields, automatic assignment and watchers',
    up: `
      CREATE TABLE kb_categories (
        id text PRIMARY KEY,
        name text NOT NULL,
        slug text NOT NULL UNIQUE,
        description text NOT NULL DEFAULT '',
        position int NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE kb_articles (
        id text PRIMARY KEY,
        category_id text REFERENCES kb_categories(id) ON DELETE SET NULL,
        title text NOT NULL,
        slug text NOT NULL UNIQUE,
        excerpt text NOT NULL DEFAULT '',
        body text NOT NULL DEFAULT '',
        body_text text NOT NULL DEFAULT '',
        tags jsonb NOT NULL DEFAULT '[]',
        status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
        visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'customers', 'products')),
        product_ids jsonb NOT NULL DEFAULT '[]',
        position int NOT NULL DEFAULT 0,
        search_vector tsvector,
        view_count int NOT NULL DEFAULT 0,
        helpful_count int NOT NULL DEFAULT 0,
        not_helpful_count int NOT NULL DEFAULT 0,
        published_at timestamptz,
        created_by text,
        updated_by text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX kb_articles_listing_idx ON kb_articles (status, category_id, position);
      CREATE INDEX kb_articles_search_idx ON kb_articles USING gin (search_vector);

      -- One vote per voter (a customer, or a hashed address for anonymous readers); a voter may change their mind.
      CREATE TABLE kb_article_votes (
        article_id text NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
        voter text NOT NULL,
        helpful boolean NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (article_id, voter)
      );
      CREATE INDEX kb_article_votes_voter_idx ON kb_article_votes (voter);

      ALTER TABLE ticket_categories
        ADD COLUMN fields jsonb NOT NULL DEFAULT '[]',
        ADD COLUMN default_assignee_id text REFERENCES admins(id) ON DELETE SET NULL,
        ADD COLUMN watcher_ids jsonb NOT NULL DEFAULT '[]';

      ALTER TABLE tickets ADD COLUMN watcher_ids jsonb NOT NULL DEFAULT '[]';
      CREATE INDEX tickets_watchers_idx ON tickets USING gin (watcher_ids);

      -- Round-robin state: the pool agent auto-assigned least recently gets the next ticket.
      CREATE TABLE ticket_assignment_rotation (
        admin_id text PRIMARY KEY REFERENCES admins(id) ON DELETE CASCADE,
        last_assigned_at timestamptz NOT NULL
      );
    `,
  },
];
