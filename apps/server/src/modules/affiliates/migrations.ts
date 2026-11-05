import type { Migration } from '../../core/migrate.js';

export const affiliateMigrations: Migration[] = [
  {
    version: '001',
    name: 'affiliates, clicks, referrals, commissions, payouts',
    up: `
      CREATE TABLE affiliate_tiers (
        id text PRIMARY KEY,
        name text NOT NULL,
        metric text NOT NULL CHECK (metric IN ('revenue', 'conversions')),
        threshold bigint NOT NULL CHECK (threshold >= 0),
        rate_bps int NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
        created_at timestamptz NOT NULL
      );

      CREATE TABLE affiliates (
        id text PRIMARY KEY,
        user_id text REFERENCES users(id) ON DELETE SET NULL,
        email text NOT NULL,
        name text NOT NULL,
        code text NOT NULL,
        status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
        commission_type text CHECK (commission_type IN ('percent', 'fixed')),
        rate_bps int CHECK (rate_bps BETWEEN 0 AND 10000),
        fixed_amount bigint CHECK (fixed_amount >= 0),
        recurring boolean,
        recurring_months int CHECK (recurring_months >= 0),
        tier_id text REFERENCES affiliate_tiers(id) ON DELETE SET NULL,
        website text,
        promotion_method text,
        payout_method text,
        notes text,
        application_ip_hash text,
        terms_accepted_at timestamptz,
        status_reason text,
        approved_at timestamptz,
        approved_by text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX affiliates_code_uq ON affiliates (lower(code));
      CREATE UNIQUE INDEX affiliates_email_uq ON affiliates (lower(email));
      CREATE UNIQUE INDEX affiliates_user_uq ON affiliates (user_id) WHERE user_id IS NOT NULL;
      CREATE INDEX affiliates_status_idx ON affiliates (status, created_at DESC);

      CREATE TABLE affiliate_clicks (
        id text PRIMARY KEY,
        affiliate_id text NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
        visitor_id text NOT NULL,
        ip_hash text,
        user_agent text,
        landing_path text,
        referrer text,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX affiliate_clicks_affiliate_idx ON affiliate_clicks (affiliate_id, created_at DESC);
      CREATE INDEX affiliate_clicks_visitor_idx ON affiliate_clicks (visitor_id, created_at);

      CREATE TABLE referrals (
        id text PRIMARY KEY,
        affiliate_id text NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        click_id text,
        attribution text NOT NULL CHECK (attribution IN ('first_click', 'last_click', 'code', 'coupon', 'manual')),
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'converted', 'rejected')),
        ip_hash text,
        fraud_flags jsonb NOT NULL DEFAULT '[]',
        reviewed_at timestamptz,
        reviewed_by text,
        converted_at timestamptz,
        created_at timestamptz NOT NULL,
        UNIQUE (user_id)
      );
      CREATE INDEX referrals_affiliate_idx ON referrals (affiliate_id, created_at DESC);
      CREATE INDEX referrals_ip_idx ON referrals (affiliate_id, ip_hash, created_at);

      CREATE TABLE affiliate_payouts (
        id text PRIMARY KEY,
        affiliate_id text NOT NULL REFERENCES affiliates(id),
        amount bigint NOT NULL CHECK (amount > 0),
        currency text NOT NULL,
        status text NOT NULL CHECK (status IN ('pending', 'paid', 'canceled')),
        method text,
        reference text,
        approval_id text,
        created_by text,
        paid_by text,
        created_at timestamptz NOT NULL,
        paid_at timestamptz
      );
      CREATE INDEX affiliate_payouts_affiliate_idx ON affiliate_payouts (affiliate_id, created_at DESC);

      CREATE TABLE affiliate_commissions (
        id text PRIMARY KEY,
        affiliate_id text NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
        referral_id text REFERENCES referrals(id) ON DELETE SET NULL,
        kind text NOT NULL CHECK (kind IN ('sale', 'adjustment', 'clawback')),
        invoice_id text,
        payment_id text,
        order_id text,
        base_amount bigint,
        rate_bps int,
        amount bigint NOT NULL,
        reversed_amount bigint NOT NULL DEFAULT 0 CHECK (reversed_amount >= 0),
        currency text NOT NULL,
        status text NOT NULL CHECK (status IN ('pending', 'approved', 'paid', 'reversed', 'rejected')),
        flagged boolean NOT NULL DEFAULT false,
        hold_until timestamptz,
        payout_id text REFERENCES affiliate_payouts(id) ON DELETE SET NULL,
        reverses_id text,
        reason text,
        created_by text,
        approved_at timestamptz,
        paid_at timestamptz,
        created_at timestamptz NOT NULL,
        CHECK (kind <> 'sale' OR amount >= 0)
      );
      CREATE UNIQUE INDEX affiliate_commissions_invoice_uq ON affiliate_commissions (invoice_id) WHERE kind = 'sale' AND invoice_id IS NOT NULL;
      CREATE INDEX affiliate_commissions_affiliate_idx ON affiliate_commissions (affiliate_id, status, created_at DESC);
      CREATE INDEX affiliate_commissions_hold_idx ON affiliate_commissions (hold_until) WHERE status = 'pending';
      CREATE INDEX affiliate_commissions_payment_idx ON affiliate_commissions (payment_id);
    `,
  },
  {
    version: '002',
    name: 'affiliate uplines, groups, marketing materials, sub-IDs',
    up: `
      CREATE TABLE affiliate_groups (
        id text PRIMARY KEY,
        name text NOT NULL,
        description text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX affiliate_groups_name_uq ON affiliate_groups (lower(name));

      -- Multi-level commissions: the affiliate who recruited this one (their upline).
      ALTER TABLE affiliates
        ADD COLUMN parent_id text REFERENCES affiliates(id) ON DELETE SET NULL,
        ADD COLUMN parent_source text CHECK (parent_source IN ('referral', 'admin')),
        ADD COLUMN group_id text REFERENCES affiliate_groups(id) ON DELETE SET NULL,
        ADD CONSTRAINT affiliates_parent_not_self CHECK (parent_id <> id);
      CREATE INDEX affiliates_parent_idx ON affiliates (parent_id) WHERE parent_id IS NOT NULL;
      CREATE INDEX affiliates_group_idx ON affiliates (group_id) WHERE group_id IS NOT NULL;

      CREATE TABLE affiliate_materials (
        id text PRIMARY KEY,
        type text NOT NULL CHECK (type IN ('banner', 'text_link', 'file')),
        name text NOT NULL,
        description text,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        landing_path text,
        link_text text,
        image_url text,
        file_id text REFERENCES files(id) ON DELETE SET NULL,
        width int CHECK (width BETWEEN 1 AND 4000),
        height int CHECK (height BETWEEN 1 AND 4000),
        group_ids jsonb NOT NULL DEFAULT '[]',
        tier_ids jsonb NOT NULL DEFAULT '[]',
        sort_order int NOT NULL DEFAULT 0,
        created_by text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX affiliate_materials_status_idx ON affiliate_materials (status, sort_order, created_at DESC);

      -- Sub-ID tracking (and which material a click came from).
      ALTER TABLE affiliate_clicks
        ADD COLUMN sub_id text,
        ADD COLUMN material_id text REFERENCES affiliate_materials(id) ON DELETE SET NULL;
      CREATE INDEX affiliate_clicks_sub_idx ON affiliate_clicks (affiliate_id, sub_id) WHERE sub_id IS NOT NULL;
      CREATE INDEX affiliate_clicks_material_idx ON affiliate_clicks (material_id, created_at) WHERE material_id IS NOT NULL;
      ALTER TABLE referrals ADD COLUMN sub_id text;
      CREATE INDEX referrals_sub_idx ON referrals (affiliate_id, sub_id) WHERE sub_id IS NOT NULL;

      -- Upline commissions sit beside the direct sale commission of the same invoice, one per level.
      ALTER TABLE affiliate_commissions
        ADD COLUMN level int NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 10),
        ADD COLUMN source_commission_id text REFERENCES affiliate_commissions(id) ON DELETE SET NULL,
        ADD COLUMN sub_id text;
      ALTER TABLE affiliate_commissions DROP CONSTRAINT affiliate_commissions_kind_check;
      ALTER TABLE affiliate_commissions
        ADD CONSTRAINT affiliate_commissions_kind_check CHECK (kind IN ('sale', 'upline', 'adjustment', 'clawback')),
        ADD CONSTRAINT affiliate_commissions_upline_check CHECK (kind <> 'upline' OR (amount >= 0 AND level > 1));
      CREATE UNIQUE INDEX affiliate_commissions_upline_uq ON affiliate_commissions (invoice_id, level) WHERE kind = 'upline' AND invoice_id IS NOT NULL;
      CREATE INDEX affiliate_commissions_source_idx ON affiliate_commissions (source_commission_id) WHERE source_commission_id IS NOT NULL;
      CREATE INDEX affiliate_commissions_sub_idx ON affiliate_commissions (affiliate_id, sub_id) WHERE sub_id IS NOT NULL;
    `,
  },
];
