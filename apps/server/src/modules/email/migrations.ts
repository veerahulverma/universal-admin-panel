import type { Migration } from '../../core/migrate.js';

export const emailMigrations: Migration[] = [
  {
    version: '001',
    name: 'email providers, templates, messages, suppressions, preferences',
    up: `
      CREATE TABLE email_providers (
        id text PRIMARY KEY,
        type text NOT NULL CHECK (type IN ('log', 'smtp', 'resend', 'postmark', 'sendgrid')),
        name text NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        priority int NOT NULL DEFAULT 0,
        from_email text NOT NULL,
        from_name text,
        reply_to text,
        config jsonb NOT NULL DEFAULT '{}',
        last_test_at timestamptz,
        last_test_ok boolean,
        last_test_message text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE email_templates (
        id text PRIMARY KEY,
        key text NOT NULL,
        locale text NOT NULL DEFAULT 'en',
        name text NOT NULL,
        description text NOT NULL DEFAULT '',
        category text NOT NULL CHECK (category IN ('transactional', 'security', 'billing', 'marketing')),
        subject text NOT NULL,
        html text NOT NULL,
        text text,
        variables jsonb NOT NULL DEFAULT '[]',
        sample_data jsonb NOT NULL DEFAULT '{}',
        is_system boolean NOT NULL DEFAULT false,
        edited boolean NOT NULL DEFAULT false,
        version int NOT NULL DEFAULT 1,
        updated_by text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        UNIQUE (key, locale)
      );

      CREATE TABLE email_messages (
        id text PRIMARY KEY,
        to_email text NOT NULL,
        user_id text,
        org_id text,
        template_key text,
        locale text,
        category text NOT NULL,
        subject text NOT NULL,
        html text,
        text text,
        headers jsonb NOT NULL DEFAULT '{}',
        status text NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'suppressed', 'bounced', 'complained')),
        suppression_reason text,
        attempts int NOT NULL DEFAULT 0,
        provider_id text,
        provider_type text,
        provider_message_id text,
        last_error text,
        campaign_id text,
        metadata jsonb NOT NULL DEFAULT '{}',
        sent_at timestamptz,
        delivered_at timestamptz,
        opened_at timestamptz,
        clicked_at timestamptz,
        bounced_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX email_messages_created_idx ON email_messages (created_at DESC);
      CREATE INDEX email_messages_status_idx ON email_messages (status, created_at DESC);
      CREATE INDEX email_messages_to_idx ON email_messages (lower(to_email), created_at DESC);
      CREATE INDEX email_messages_user_idx ON email_messages (user_id, created_at DESC);
      CREATE INDEX email_messages_campaign_idx ON email_messages (campaign_id) WHERE campaign_id IS NOT NULL;
      CREATE INDEX email_messages_template_idx ON email_messages (template_key, created_at DESC);
      CREATE INDEX email_messages_provider_msg_idx ON email_messages (provider_message_id) WHERE provider_message_id IS NOT NULL;

      CREATE TABLE email_suppressions (
        email text PRIMARY KEY,
        reason text NOT NULL CHECK (reason IN ('hard_bounce', 'complaint', 'unsubscribe', 'manual')),
        scope text NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'marketing')),
        source text,
        details jsonb NOT NULL DEFAULT '{}',
        created_by text,
        created_at timestamptz NOT NULL
      );

      CREATE TABLE email_preferences (
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category text NOT NULL,
        subscribed boolean NOT NULL,
        source text NOT NULL DEFAULT 'user',
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (user_id, category)
      );

      -- Once-only guard for automated sends (e.g. one recovery email per abandoned checkout).
      CREATE TABLE email_automation_log (
        key text PRIMARY KEY,
        message_id text,
        created_at timestamptz NOT NULL
      );
    `,
  },
  {
    version: '002',
    name: 'autoresponder sequences, steps, enrolments and sends',
    up: `
      CREATE TABLE email_sequences (
        id text PRIMARY KEY,
        name text NOT NULL,
        description text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
        trigger_type text NOT NULL CHECK (trigger_type IN ('signup', 'purchase', 'subscription_started', 'renewal_upcoming', 'subscription_ended')),
        product_ids jsonb NOT NULL DEFAULT '[]',
        days_before int CHECK (days_before BETWEEN 1 AND 365),
        created_by text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE email_sequence_steps (
        id text PRIMARY KEY,
        sequence_id text NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
        position int NOT NULL,
        delay_minutes int NOT NULL DEFAULT 0 CHECK (delay_minutes >= 0),
        template_key text,
        subject text NOT NULL DEFAULT '',
        html text NOT NULL DEFAULT '',
        text text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX email_sequence_steps_sequence_idx ON email_sequence_steps (sequence_id, position);

      -- One enrolment per person and trigger occurrence (a signup, an order, a subscription, a renewal date).
      CREATE TABLE email_sequence_enrollments (
        id text PRIMARY KEY,
        sequence_id text NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        trigger_ref text NOT NULL,
        context jsonb NOT NULL DEFAULT '{}',
        status text NOT NULL CHECK (status IN ('active', 'completed', 'stopped')),
        stop_reason text,
        last_position int NOT NULL DEFAULT -1,
        steps_sent int NOT NULL DEFAULT 0,
        next_run_at timestamptz,
        enrolled_at timestamptz NOT NULL,
        finished_at timestamptz,
        updated_at timestamptz NOT NULL,
        UNIQUE (sequence_id, user_id, trigger_ref)
      );
      CREATE INDEX email_sequence_enrollments_due_idx ON email_sequence_enrollments (next_run_at) WHERE status = 'active';
      CREATE INDEX email_sequence_enrollments_user_idx ON email_sequence_enrollments (user_id);

      -- Each step goes out at most once per enrolment, whatever retries or concurrent workers do.
      CREATE TABLE email_sequence_sends (
        enrollment_id text NOT NULL REFERENCES email_sequence_enrollments(id) ON DELETE CASCADE,
        step_id text NOT NULL,
        message_id text,
        status text NOT NULL,
        reason text,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (enrollment_id, step_id)
      );
      CREATE INDEX email_sequence_sends_step_idx ON email_sequence_sends (step_id);
    `,
  },
  {
    version: '003',
    name: 'Amazon SES, Mailgun and Mailjet providers',
    up: `
      ALTER TABLE email_providers DROP CONSTRAINT IF EXISTS email_providers_type_check;
      ALTER TABLE email_providers ADD CONSTRAINT email_providers_type_check CHECK (type IN ('log', 'smtp', 'ses', 'resend', 'postmark', 'sendgrid', 'mailgun', 'mailjet'));
    `,
  },
];
